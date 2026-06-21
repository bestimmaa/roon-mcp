import type {
  GetZonesBody,
  RoonApiTransport,
  RoonApiZone,
} from "node-roon-api-transport";

/**
 * Default upper bound (ms) for {@link ZoneSubscription.waitForZoneChange}.
 * Kept short so a slow Core never turns a `play_now` call into a multi-second
 * hang; the result still returns the latest snapshot on timeout.
 */
export const DEFAULT_ZONE_CHANGE_TIMEOUT_MS = 2000;

/**
 * A snapshot fingerprint used to detect a meaningful state change for a zone.
 * Compares state plus the now_playing identity (title/artist/album), so a
 * high-frequency `seek_position` tick doesn't satisfy a wait.
 */
export interface ZoneFingerprint {
  state: string;
  title?: string;
  artist?: string;
  album?: string;
}

interface PendingWaiter {
  idOrOutput: string;
  before: ZoneFingerprint;
  resolve: (body: GetZonesBody) => void;
  timer: NodeJS.Timeout;
}

/**
 * Resolves a zone from a snapshot by id or by any of its output ids — same
 * predicate the read services use, kept here so waiters don't have to know
 * about output ids.
 */
function findZone(
  body: GetZonesBody,
  idOrOutput: string,
): RoonApiZone | undefined {
  return (body.zones ?? []).find(
    (z) =>
      z.zone_id === idOrOutput ||
      (z.outputs ?? []).some((o) => o.output_id === idOrOutput),
  );
}

/** Build a fingerprint for the named zone in the given snapshot. */
export function fingerprintFor(
  body: GetZonesBody,
  idOrOutput: string,
): ZoneFingerprint | undefined {
  const z = findZone(body, idOrOutput);
  if (!z) return undefined;
  const np = z.now_playing;
  return {
    state: z.state,
    title: np?.three_line?.line1 ?? np?.two_line?.line1 ?? np?.one_line?.line1,
    artist: np?.three_line?.line2 ?? np?.two_line?.line2,
    album: np?.three_line?.line3,
  };
}

function fingerprintEquals(a: ZoneFingerprint, b: ZoneFingerprint): boolean {
  return (
    a.state === b.state &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.album === b.album
  );
}

/**
 * Wraps `RoonApiTransport.subscribe_zones` and keeps the latest full snapshot
 * in memory. Reads (via {@link getSnapshot}) hit the cache when fresh and fall
 * back to a one-shot `get_zones` request otherwise. Waiters
 * ({@link waitForZoneChange}) subscribe to in-memory change notifications and
 * resolve as soon as the named zone's fingerprint moves — typically well
 * before a `get_zones` round-trip would.
 */
export class ZoneSubscription {
  private snapshot: GetZonesBody | undefined;
  private waiters: PendingWaiter[] = [];

  constructor(
    private readonly transport: RoonApiTransport,
    private readonly coreId: string,
  ) {}

  /** Subscribe and start receiving zone updates from the Core. */
  start(): void {
    if (typeof this.transport.subscribe_zones !== "function") return;
    this.transport.subscribe_zones((response, body) => {
      if (response === "Subscribed") {
        const b = body as { zones?: RoonApiZone[] };
        this.snapshot = { zones: b.zones ?? [] };
        this.notifyWaiters();
        return;
      }
      if (response === "Changed") {
        const b = body as {
          zones_added?: RoonApiZone[];
          zones_changed?: RoonApiZone[];
          zones_removed?: string[];
        };
        if (!this.snapshot) this.snapshot = { zones: [] };
        const current = new Map(
          (this.snapshot.zones ?? []).map((z) => [z.zone_id, z]),
        );
        for (const id of b.zones_removed ?? []) current.delete(id);
        for (const z of b.zones_added ?? []) current.set(z.zone_id, z);
        for (const z of b.zones_changed ?? []) current.set(z.zone_id, z);
        this.snapshot = { zones: Array.from(current.values()) };
        this.notifyWaiters();
        return;
      }
      if (response === "Unsubscribed") {
        this.snapshot = undefined;
        return;
      }
    });
  }

  /** Drop the cache and any pending waiters. Called on Core unpair. */
  stop(): void {
    this.snapshot = undefined;
    // Resolve pending waiters with the last known (or empty) snapshot so
    // callers don't hang forever when the Core disappears.
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(this.snapshot ?? { zones: [] });
    }
  }

  /**
   * Return the latest zone snapshot, falling back to a one-shot `get_zones`
   * request when no `Subscribed` event has landed yet (cold start, reconnect).
   * The fallback is wrapped in the supplied logger so a stderr line still
   * records the read.
   */
  async getSnapshot(
    fallback: () => Promise<GetZonesBody>,
  ): Promise<GetZonesBody> {
    if (this.snapshot) return this.snapshot;
    const body = await fallback();
    this.snapshot = body;
    return body;
  }

  /**
   * Resolve with the next snapshot whose fingerprint for `idOrOutput` differs
   * from `before`, or with the latest snapshot once `timeoutMs` has elapsed
   * (whichever comes first). The pre-action snapshot should be taken via
   * {@link fingerprintFor} right before the Roon action runs.
   */
  waitForZoneChange(
    idOrOutput: string,
    before: ZoneFingerprint,
    timeoutMs: number = DEFAULT_ZONE_CHANGE_TIMEOUT_MS,
  ): Promise<GetZonesBody> {
    return new Promise<GetZonesBody>((resolve) => {
      const timer = setTimeout(() => {
        this.removeWaiter(w);
        resolve(this.snapshot ?? { zones: [] });
      }, timeoutMs);
      const w: PendingWaiter = { idOrOutput, before, resolve, timer };
      this.waiters.push(w);

      // Check synchronously: the change may have already landed between the
      // caller's pre-read and the wait.
      const current = this.snapshot;
      if (current) {
        const fp = fingerprintFor(current, idOrOutput);
        if (fp && !fingerprintEquals(fp, before)) {
          this.removeWaiter(w);
          resolve(current);
        }
      }
    });
  }

  private notifyWaiters(): void {
    if (this.waiters.length === 0) return;
    const current = this.snapshot;
    if (!current) return;

    // Resolve waiters whose zone's fingerprint has changed; keep the rest
    // pending until their timer fires or a future event matches.
    const remaining: PendingWaiter[] = [];
    for (const w of this.waiters) {
      const fp = fingerprintFor(current, w.idOrOutput);
      if (fp && !fingerprintEquals(fp, w.before)) {
        clearTimeout(w.timer);
        w.resolve(current);
      } else {
        remaining.push(w);
      }
    }
    this.waiters = remaining;
  }

  private removeWaiter(w: PendingWaiter): void {
    const idx = this.waiters.indexOf(w);
    if (idx >= 0) this.waiters.splice(idx, 1);
    clearTimeout(w.timer);
  }
}

/**
 * Registry that pairs a {@link ZoneSubscription} with each paired Core. Roon
 * can pair with multiple Cores over a session (only one is ever paired at a
 * time on a single extension), so this is keyed by `core_id`. The current
 * subscription is exposed via {@link forCore} for read services.
 */
export class ZoneSubscriptionRegistry {
  private readonly byCore = new Map<string, ZoneSubscription>();

  startFor(coreId: string, transport: RoonApiTransport): ZoneSubscription {
    // Drop any prior subscription for this core (re-pair path).
    this.byCore.get(coreId)?.stop();
    const sub = new ZoneSubscription(transport, coreId);
    sub.start();
    this.byCore.set(coreId, sub);
    return sub;
  }

  stopFor(coreId: string): void {
    this.byCore.get(coreId)?.stop();
    this.byCore.delete(coreId);
  }

  forCore(coreId: string | undefined): ZoneSubscription | undefined {
    if (!coreId) return undefined;
    return this.byCore.get(coreId);
  }
}
