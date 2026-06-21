import RoonApi, { type RoonCore } from "node-roon-api";
import RoonApiBrowse, {
  type RoonApiBrowse as RoonBrowseService,
} from "node-roon-api-browse";
import RoonApiStatus from "node-roon-api-status";
import RoonApiTransport, {
  type RoonApiTransport as RoonTransportService,
} from "node-roon-api-transport";

import { RoonMcpError } from "./types.js";
import { ZoneSubscription, ZoneSubscriptionRegistry } from "./ZoneSubscription.js";

export interface RoonClientOptions {
  extensionId?: string;
  displayName?: string;
  displayVersion?: string;
  publisher?: string;
  email?: string;
  website?: string;
  /** Optional sink for diagnostics; defaults to stderr so stdout stays MCP-clean. */
  log?: (message: string) => void;
}

const DEFAULTS = {
  extensionId: "com.christophhalang.roon-mcp",
  displayName: "Roon MCP",
  displayVersion: "0.1.0",
  publisher: "Christoph Halang",
  email: "christoph.halang@gmail.com",
  website: "https://github.com/christophhalang/roon-mcp",
};

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
  private readonly coreWaiters: Array<(core: RoonCore) => void> = [];

  constructor(options: RoonClientOptions = {}) {
    const cfg = { ...DEFAULTS, ...options };
    this.log = options.log ?? ((m) => process.stderr.write(`[roon] ${m}\n`));

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

    this.status = new RoonApiStatus(this.roon);
  }

  /** Initialize services and begin Core discovery. */
  start(): void {
    this.roon.init_services({
      required_services: [RoonApiTransport, RoonApiBrowse],
      provided_services: [this.status],
    });
    this.status.set_status("Waiting for Roon Core…", false);
    this.roon.start_discovery();
    this.log("discovery started; waiting for a Core to pair");
  }

  stop(): void {
    // node-roon-api has no clean teardown; drop references and reject waiters.
    if (this.core) this.zones.stopFor(this.core.core_id);
    this.core = undefined;
    this.coreWaiters.length = 0;
  }

  isPaired(): boolean {
    return this.core !== undefined;
  }

  /** Resolve with the paired Core, waiting up to `timeoutMs` for pairing. */
  waitForCore(timeoutMs = 15_000): Promise<RoonCore> {
    if (this.core) return Promise.resolve(this.core);

    return new Promise<RoonCore>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.coreWaiters.indexOf(onPaired);
        if (idx >= 0) this.coreWaiters.splice(idx, 1);
        reject(
          new RoonMcpError(
            "NO_CORE_PAIRED",
            `No Roon Core paired within ${timeoutMs}ms. ` +
              "Enable the extension under Roon → Settings → Extensions.",
          ),
        );
      }, timeoutMs);

      const onPaired = (core: RoonCore) => {
        clearTimeout(timer);
        resolve(core);
      };
      this.coreWaiters.push(onPaired);
    });
  }

  /** Transport service of the currently paired Core. Throws if unpaired. */
  getTransport(): RoonTransportService {
    if (!this.core) {
      throw new RoonMcpError("NO_CORE_PAIRED", "No Roon Core is currently paired.");
    }
    return this.core.services.RoonApiTransport;
  }

  /** Browse service of the currently paired Core. Throws if unpaired. */
  getBrowse(): RoonBrowseService {
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
    this.status.set_status(`Paired with ${core.display_name}`, false);
    // Start a `subscribe_zones` subscription for this Core so the cached
    // snapshot is current before any service reads it. Re-pairs (same core
    // reappears) drop the prior subscription via the registry.
    const transport = core.services.RoonApiTransport as RoonTransportService;
    this.zones.startFor(core.core_id, transport);

    const waiters = this.coreWaiters.splice(0, this.coreWaiters.length);
    for (const waiter of waiters) waiter(core);
  }

  private onCoreUnpaired(core: RoonCore): void {
    this.log(`unpaired from Core "${core.display_name}" (${core.core_id})`);
    this.zones.stopFor(core.core_id);
    if (this.core?.core_id === core.core_id) this.core = undefined;
    this.status.set_status("Waiting for Roon Core…", false);
  }
}
