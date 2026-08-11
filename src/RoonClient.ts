import RoonApi, { type RoonCore } from "node-roon-api";
import RoonApiBrowse, {
  type RoonApiBrowse as RoonBrowseService,
} from "node-roon-api-browse";
import RoonApiStatus from "node-roon-api-status";
import RoonApiTransport, {
  type RoonApiTransport as RoonTransportService,
} from "node-roon-api-transport";

import { createConfigStore, resolveConfigPath } from "./configStore.js";
import {
  acquireInstanceLock,
  resolveLockPath,
  type InstanceLockHandle,
} from "./instanceLock.js";
import { RoonMcpError } from "./types.js";
import { ZoneSubscription, ZoneSubscriptionRegistry } from "./ZoneSubscription.js";
import pkg from "../package.json" with { type: "json" };

export interface RoonClientOptions {
  extensionId?: string;
  displayName?: string;
  displayVersion?: string;
  publisher?: string;
  email?: string;
  website?: string;
  /**
   * Absolute path to the file that holds Roon pairing state. Defaults to a
   * stable per-user location (see {@link resolveConfigPath}) so the pairing
   * token survives restarts instead of re-registering a new extension each
   * time the working directory changes (issue #4).
   */
  configPath?: string;
  /**
   * Absolute path to the single-owner lock file (see {@link acquireInstanceLock}).
   * Defaults to `instance.lock` next to `configPath`. Only one live process
   * per lock path will drive discovery/pairing (issue #40).
   */
  lockPath?: string;
  /**
   * Connect straight to a known Core instead of SOOD multicast discovery.
   * Useful when multicast is unreliable (VLANs, VPNs, containers) or the
   * Core's address is fixed. Reconnects automatically when the socket drops.
   */
  host?: string;
  /** WebSocket port of the Core's API when `host` is set (default 9330). */
  port?: number;
  /** Optional sink for diagnostics; defaults to stderr so stdout stays MCP-clean. */
  log?: (message: string) => void;
}

const DEFAULTS = {
  extensionId: "com.bestimmaa.roon-mcp",
  displayName: "Roon MCP",
  displayVersion: pkg.version,
  publisher: "Christoph Halang",
  email: "christoph.halang@gmail.com",
  website: "https://github.com/bestimmaa/roon-mcp",
};

/** Delay between direct-connect attempts after the socket closes. */
const RECONNECT_DELAY_MS = 5_000;

/**
 * Wraps node-roon-api setup, discovery, and pairing lifecycle, and exposes
 * typed accessors for the Transport service. Fails fast when no Core is paired.
 */
export class RoonClient {
  private readonly roon: RoonApi;
  private readonly status: RoonApiStatus;
  private readonly log: (message: string) => void;
  /**
   * Tracks `subscribe_zones` callbacks per paired Core. Read services pull
   * zone state from this registry's cache (when fresh) and wait on it after
   * a playback action so `now_playing` reflects the new track rather than
   * the pre-action one. See issue #1.
   */
  private readonly zones = new ZoneSubscriptionRegistry();

  private core: RoonCore | undefined;
  private readonly coreWaiters: Array<{
    resolve: (core: RoonCore) => void;
    reject: (err: unknown) => void;
  }> = [];

  private readonly directHost: string | undefined;
  private readonly directPort: number;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly lockPath: string;
  private lockHandle: InstanceLockHandle | undefined;
  /** Set when another live process already holds {@link lockPath}. */
  private lockConflict: { ownerPid: number; ownerStartedAt: string } | undefined;

  /** Timestamps of recent core_paired/core_unpaired transitions, for thrash detection. */
  private pairingTransitions: number[] = [];
  private static readonly THRASH_WINDOW_MS = 60_000;
  private static readonly THRASH_THRESHOLD = 4;

  constructor(options: RoonClientOptions = {}) {
    const cfg = { ...DEFAULTS, ...options };
    this.log = options.log ?? ((m) => process.stderr.write(`[roon] ${m}\n`));
    this.directHost = options.host?.trim() || undefined;
    this.directPort = options.port ?? 9330;

    this.roon = new RoonApi({
      extension_id: cfg.extensionId,
      display_name: cfg.displayName,
      display_version: cfg.displayVersion,
      publisher: cfg.publisher,
      email: cfg.email,
      website: cfg.website,
      core_paired: (core) => this.onCorePaired(core),
      core_unpaired: (core) => this.onCoreUnpaired(core),
    });

    // Persist pairing state to a stable absolute path. node-roon-api's own
    // save_config/load_config write `config.json` relative to the current
    // working directory; for an MCP server that CWD is unpredictable, so each
    // launch would look unpaired and Roon would register a duplicate extension
    // (issue #4). Overriding the instance methods redirects *all* persistence
    // (pairing token plus any service settings) to one fixed file, and the
    // default get/set_persisted_state read these lazily so this is sufficient.
    const configPath = cfg.configPath ?? resolveConfigPath();
    const store = createConfigStore(configPath, this.log);
    this.roon.load_config = ((key: string) => store.load(key)) as RoonApi["load_config"];
    this.roon.save_config = (key: string, value: unknown) => store.save(key, value);
    this.log(`pairing state persisted at ${configPath}`);
    this.lockPath = options.lockPath ?? resolveLockPath(configPath);

    this.status = new RoonApiStatus(this.roon);
  }

  /**
   * Acquire the single-owner lock, then initialize services and begin Core
   * discovery (or direct connect). When another live process already holds
   * the lock, discovery is skipped entirely — starting it would just steal
   * the pairing slot back and forth (issue #40) — and every call surfaces a
   * `CORE_PAIRING_HELD` error naming the owning pid instead.
   */
  start(): void {
    const lock = acquireInstanceLock(this.lockPath, this.log);
    if (!lock.acquired) {
      this.lockConflict = { ownerPid: lock.ownerPid, ownerStartedAt: lock.ownerStartedAt };
      this.log(
        `another roon-mcp instance (pid ${lock.ownerPid}, started ${lock.ownerStartedAt}) ` +
          `already holds the Core pairing lock at ${this.lockPath}; not starting discovery`,
      );
      this.status.set_status(`Blocked: pid ${lock.ownerPid} holds the Core pairing lock`, true);
      this.rejectWaiters(this.lockConflictError());
      return;
    }
    this.lockHandle = lock.handle;

    this.roon.init_services({
      required_services: [RoonApiTransport, RoonApiBrowse],
      provided_services: [this.status],
    });
    this.status.set_status("Waiting for Roon Core…", false);
    if (this.directHost) {
      this.connectDirect();
    } else {
      this.roon.start_discovery();
      this.log("discovery started; waiting for a Core to pair");
    }
  }

  /** Builds the error surfaced whenever another process holds the lock. */
  private lockConflictError(): RoonMcpError {
    const { ownerPid, ownerStartedAt } = this.lockConflict!;
    return new RoonMcpError(
      "CORE_PAIRING_HELD",
      `Another roon-mcp instance (pid ${ownerPid}, started ${ownerStartedAt}) already holds ` +
        "the Roon Core pairing lock — Roon pairs only one instance of this extension at a " +
        'time. Stop that instance (e.g. `pkill -f roon-mcp`) or wait for it to exit, then ' +
        "retry. Nothing needs enabling under Roon → Settings → Extensions; the extension is " +
        "already paired, just not to this process.",
    );
  }

  /**
   * Open a websocket straight to the configured Core and re-dial whenever it
   * closes. Registration/pairing rides on the same `ws_connect` path that
   * discovery uses, so `core_paired` fires identically.
   */
  private connectDirect(): void {
    if (this.stopped) return;
    this.log(`connecting directly to ${this.directHost}:${this.directPort}`);
    this.roon.ws_connect({
      host: this.directHost!,
      port: this.directPort,
      onclose: () => {
        if (this.stopped) return;
        this.log(
          `connection to ${this.directHost}:${this.directPort} closed; retrying in ${RECONNECT_DELAY_MS / 1000}s`,
        );
        this.reconnectTimer = setTimeout(() => this.connectDirect(), RECONNECT_DELAY_MS);
      },
    });
  }

  stop(): void {
    // node-roon-api has no clean teardown; drop references and reject waiters
    // so a pending waitForCore doesn't hang until its timeout during shutdown.
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.core) this.zones.stopFor(this.core.core_id);
    this.core = undefined;
    this.lockHandle?.release();
    this.lockHandle = undefined;
    this.rejectWaiters(
      new RoonMcpError("NO_CORE_PAIRED", "Roon MCP is shutting down."),
    );
  }

  isPaired(): boolean {
    return this.core !== undefined;
  }

  /** Resolve with the paired Core, waiting up to `timeoutMs` for pairing. */
  waitForCore(timeoutMs = 15_000): Promise<RoonCore> {
    if (this.core) return Promise.resolve(this.core);
    // Fail fast instead of burning the full timeout on a wait that can never
    // resolve — no discovery is running while another instance owns the lock.
    if (this.lockConflict) return Promise.reject(this.lockConflictError());

    return new Promise<RoonCore>((resolve, reject) => {
      // Wrap resolve/reject so the timer is cleared whichever path fires first:
      // paired, unpaired (rejected), or timeout. The wrapper is what we register
      // so onCorePaired/onCoreUnpaired/stop all clear the same timer.
      const waiter = {
        resolve: (core: RoonCore) => {
          clearTimeout(timer);
          resolve(core);
        },
        reject: (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        const idx = this.coreWaiters.indexOf(waiter);
        if (idx >= 0) this.coreWaiters.splice(idx, 1);
        reject(
          new RoonMcpError(
            "NO_CORE_PAIRED",
            `No Roon Core paired within ${timeoutMs}ms. ` +
              "Enable the extension under Roon → Settings → Extensions.",
          ),
        );
      }, timeoutMs);
      this.coreWaiters.push(waiter);
    });
  }

  /** Reject and clear every pending waitForCore waiter with `err`. */
  private rejectWaiters(err: unknown): void {
    const waiters = this.coreWaiters.splice(0, this.coreWaiters.length);
    for (const w of waiters) w.reject(err);
  }

  /**
   * Records a core_paired/core_unpaired transition and warns when too many
   * land in a short window — the signature of pairing thrash (issue #40),
   * e.g. from a second process contending for the same pairing slot.
   */
  private noteTransition(kind: "paired" | "unpaired"): void {
    const now = Date.now();
    this.pairingTransitions.push(now);
    this.pairingTransitions = this.pairingTransitions.filter(
      (t) => now - t <= RoonClient.THRASH_WINDOW_MS,
    );
    if (this.pairingTransitions.length > RoonClient.THRASH_THRESHOLD) {
      this.log(
        `warning: ${this.pairingTransitions.length} pairing transitions in the last ` +
          `${RoonClient.THRASH_WINDOW_MS / 1000}s (latest: ${kind}) — this usually means ` +
          "another process is contending for the same Core pairing",
      );
    }
  }

  /** Transport service of the currently paired Core. Throws if unpaired. */
  getTransport(): RoonTransportService {
    if (this.lockConflict) throw this.lockConflictError();
    if (!this.core) {
      throw new RoonMcpError("NO_CORE_PAIRED", "No Roon Core is currently paired.");
    }
    return this.core.services.RoonApiTransport;
  }

  /** Browse service of the currently paired Core. Throws if unpaired. */
  getBrowse(): RoonBrowseService {
    if (this.lockConflict) throw this.lockConflictError();
    if (!this.core) {
      throw new RoonMcpError("NO_CORE_PAIRED", "No Roon Core is currently paired.");
    }
    return this.core.services.RoonApiBrowse;
  }

  /**
   * The `subscribe_zones` registry, keyed by `core_id`. Read services use
   * this to read the cached zone snapshot and to wait for the next change
   * after a playback action. Returns `undefined` when no Core is paired.
   */
  zoneSubscriptions(): ZoneSubscriptionRegistry {
    return this.zones;
  }

  /**
   * The zone subscription for the currently paired Core, or `undefined` when
   * no Core is paired or the `Subscribed` event has not yet landed. The
   * subscription is the right place to read the latest zone snapshot and to
   * wait for the next change after a playback action — see issue #1.
   */
  getActiveSubscription(): ZoneSubscription | undefined {
    if (!this.core) return undefined;
    return this.zones.forCore(this.core.core_id);
  }

  private onCorePaired(core: RoonCore): void {
    this.core = core;
    this.log(`paired with Core "${core.display_name}" (${core.core_id})`);
    this.noteTransition("paired");
    this.status.set_status(`Paired with ${core.display_name}`, false);
    // Start a `subscribe_zones` subscription for this Core so the cached
    // snapshot is current before any service reads it. Re-pairs (same core
    // reappears) drop the prior subscription via the registry.
    const transport = core.services.RoonApiTransport as RoonTransportService;
    this.zones.startFor(core.core_id, transport);

    const waiters = this.coreWaiters.splice(0, this.coreWaiters.length);
    for (const waiter of waiters) waiter.resolve(core);
  }

  private onCoreUnpaired(core: RoonCore): void {
    this.log(`unpaired from Core "${core.display_name}" (${core.core_id})`);
    this.noteTransition("unpaired");
    this.zones.stopFor(core.core_id);
    if (this.core?.core_id === core.core_id) this.core = undefined;
    this.status.set_status("Waiting for Roon Core…", false);
    // A pending waitForCore must not hang until its timeout fires once the Core
    // it was waiting for has unpaired — reject it now (issue #16).
    this.rejectWaiters(
      new RoonMcpError(
        "NO_CORE_PAIRED",
        `The Roon Core "${core.display_name}" unpaired while waiting for it.`,
      ),
    );
  }
}
