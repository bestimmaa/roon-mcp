import type {
  GetZonesBody,
  RoonApiTransport,
  RoonApiZone,
  RoonOutput,
  RoonZoneState,
} from "node-roon-api-transport";

import { RoonClient } from "./RoonClient.js";
import { silentLogger, type RoonCallLogger } from "./logger.js";
import { fingerprintFor, ZoneSubscription } from "./ZoneSubscription.js";
import { RoonMcpError, type NowPlayingInfo, type ZoneState } from "./types.js";
import { ZoneService } from "./ZoneService.js";

/**
 * Roon `control` verbs accepted by `transport.control(zone, control, cb)`.
 * `resume` is the LLM-friendly verb that maps to Roon's `play`.
 */
type RoonControlVerb = "play" | "pause" | "next" | "previous" | "stop";

/** Result of a transport control call (pause/resume/next/previous/stop). */
export interface ControlResult {
  ok: true;
  zoneId: string;
  action: string;
  state: ZoneState;
}

/** Result of `setVolume`. */
export interface SetVolumeResult {
  ok: true;
  zoneId: string;
  /** The requested percent (echoed for caller convenience). */
  level: number;
  /**
   * Outputs whose volume was actually changed. Incremental outputs (IR
   * blasters and the like) have no `min`/`max` and are listed here as
   * skipped so the caller knows the level wasn't applied there.
   */
  applied: string[];
  skipped: string[];
}

/** Result of `mute`/`unmute`. */
export interface MuteResult {
  ok: true;
  zoneId: string;
  muted: boolean;
}

/**
 * Transport controls: read now-playing state, run pause/resume/next/previous/
 * stop, and set volume or mute state. All zone-targeting follows the same
 * resolution rules as `PlaybackService` (explicit id → `ROON_DEFAULT_ZONE` →
 * single/Office/playing heuristics → `ZONE_AMBIGUOUS`).
 */
export class TransportService {
  constructor(
    private readonly roon: RoonClient,
    private readonly zones: ZoneService,
    private readonly logger: RoonCallLogger = silentLogger,
  ) {}

  /**
   * Return a structured snapshot of a zone's current playback. The snapshot
   * is always returned for a resolved zone; `title`/`artist`/`album` are
   * `undefined` when nothing is playing. Throws on a missing zone id or
   * ambiguous resolution, so callers can distinguish "no track" (snapshot
   * with `title: undefined`) from "no such zone" (`ZONE_NOT_FOUND`).
   */
  async getNowPlaying(zoneId?: string): Promise<NowPlayingInfo | undefined> {
    const { targetId } = await this.zones.resolveTarget(zoneId);
    const raw = await this.findRawZone(targetId);
    if (!raw) return undefined;
    return mapNowPlaying(raw);
  }

  /** Run a transport verb against the resolved zone. */
  async control(zoneId: string | undefined, action: string): Promise<ControlResult> {
    if (!isTransportAction(action)) {
      throw new RoonMcpError(
        "BROWSE_FAILED",
        `Unknown action "${action}". Use one of: pause, resume, next, previous, stop.`,
      );
    }
    const { targetId } = await this.zones.resolveTarget(zoneId);
    const raw = await this.findRawZone(targetId);
    if (!raw) {
      throw new RoonMcpError("ZONE_NOT_FOUND", `Zone "${targetId}" disappeared.`);
    }
    const verb = mapControlVerb(action);

    // Best-effort precheck: the Core reports is_<verb>_allowed on its zone
    // state snapshot. `stop` has no corresponding flag and is always allowed.
    // If the flag is explicitly false, refuse rather than rely on Roon to error.
    if (verb !== "stop" && raw.state === "playing") {
      const flag = allowedFlagFor(verb);
      if (raw[flag] === false) {
        throw new RoonMcpError(
          "BROWSE_FAILED",
          `Action "${action}" is not available on this zone.`,
        );
      }
    }

    const transport = this.roon.getTransport();
    const sub = this.roon.getActiveSubscription();
    // Capture the pre-action fingerprint from the zone we just resolved, so
    // we can wait for Roon to push a snapshot reflecting the new state.
    // Reading `get_zones` immediately after the action would still return
    // the pre-action state (issue #1).
    const before = sub
      ? fingerprintFor({ zones: [raw] }, targetId)
      : undefined;
    await this.logger.call(
      "control",
      { zoneId: targetId, control: verb },
      () =>
        new Promise<void>((resolve, reject) => {
          transport.control!(targetId, verb, (error) => {
            if (error) {
              reject(new RoonMcpError("BROWSE_FAILED", `control(${verb}) failed: ${error}`));
              return;
            }
            resolve();
          });
        }),
    );

    // Wait for the next subscription event that reflects the new state, so
    // the returned `state` matches what the agent would read from
    // `now_playing` right after. Times out fast on a slow Core.
    const after = sub && before
      ? await sub.waitForZoneChange(targetId, before)
      : await this.readZonesBody(transport, sub);
    const zoneAfter = (after.zones ?? []).find(
      (z) =>
        z.zone_id === targetId ||
        (z.outputs ?? []).some((o) => o.output_id === targetId),
    );
    const state = zoneAfter ? mapState(zoneAfter.state) : mapState(raw.state);
    return { ok: true, zoneId: targetId, action, state };
  }

  /**
   * Set a zone's volume to a 0–100 percent level. Rescales to each output's
   * native range and applies independently (grouped zones may mix dB and
   * numeric scales). Outputs without a numeric range (incremental IR-style
   * controls) are reported as `skipped` rather than guessed at.
   */
  async setVolume(zoneId: string | undefined, level: number): Promise<SetVolumeResult> {
    if (!Number.isFinite(level) || level < 0 || level > 100) {
      throw new RoonMcpError(
        "BROWSE_FAILED",
        `level must be between 0 and 100 (got ${level}).`,
      );
    }
    const { targetId, zone } = await this.zones.resolveTarget(zoneId);
    const raw = await this.findRawZone(targetId);
    if (!raw) {
      throw new RoonMcpError("ZONE_NOT_FOUND", `Zone "${targetId}" disappeared.`);
    }

    const transport = this.roon.getTransport();
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const output of raw.outputs ?? []) {
      const v = output.volume;
      if (!v || !hasNumericRange(v)) {
        skipped.push(output.output_id);
        continue;
      }
      const value = scaleToRange(level, v);
      await this.logger.call(
        "change_volume",
        { outputId: output.output_id, how: "absolute", value },
        () =>
          new Promise<void>((resolve, reject) => {
            transport.change_volume!(output, "absolute", value, (error) => {
              if (error) {
                reject(
                  new RoonMcpError("BROWSE_FAILED", `change_volume failed: ${error}`),
                );
                return;
              }
              resolve();
            });
          }),
        (result) => ({ value }),
      );
      applied.push(output.output_id);
    }

    if (applied.length === 0 && skipped.length > 0) {
      throw new RoonMcpError(
        "BROWSE_FAILED",
        "Zone has no numeric-range volume outputs (only incremental controls like IR blasters).",
      );
    }

    return { ok: true, zoneId: targetId, level, applied, skipped };
  }

  /** Mute or unmute every output in the resolved zone. */
  async mute(zoneId: string | undefined, muted: boolean): Promise<MuteResult> {
    const { targetId } = await this.zones.resolveTarget(zoneId);
    const raw = await this.findRawZone(targetId);
    if (!raw) {
      throw new RoonMcpError("ZONE_NOT_FOUND", `Zone "${targetId}" disappeared.`);
    }

    const transport = this.roon.getTransport();
    const how = muted ? "mute" : "unmute";
    for (const output of raw.outputs ?? []) {
      await this.logger.call(
        "mute",
        { outputId: output.output_id, how },
        () =>
          new Promise<void>((resolve, reject) => {
            transport.mute!(output, how, (error) => {
              if (error) {
                reject(new RoonMcpError("BROWSE_FAILED", `${how} failed: ${error}`));
                return;
              }
              resolve();
            });
          }),
      );
    }

    return { ok: true, zoneId: targetId, muted };
  }

  private async findRawZone(idOrOutput: string): Promise<RoonApiZone | undefined> {
    const body = await this.getZonesBody();
    return (body.zones ?? []).find(
      (z) =>
        z.zone_id === idOrOutput ||
        (z.outputs ?? []).some((o) => o.output_id === idOrOutput),
    );
  }

  private async getZonesBody(): Promise<GetZonesBody> {
    await this.roon.waitForCore();
    const transport: RoonApiTransport = this.roon.getTransport();
    const sub = this.roon.getActiveSubscription();
    return this.readZonesBody(transport, sub);
  }

  /**
   * Read a zone snapshot, preferring the subscription cache (kept current by
   * Roon's `Subscribed`/`Changed` events) and falling back to a one-shot
   * `get_zones` RPC when the cache is empty (cold start, post-reconnect).
   * The fallback is wrapped in the service's logger so a stderr line still
   * records the read.
   */
  private async readZonesBody(
    transport: RoonApiTransport,
    sub: ZoneSubscription | undefined,
  ): Promise<GetZonesBody> {
    if (sub) {
      return sub.getSnapshot(() => this.fallbackGetZones(transport));
    }
    return this.fallbackGetZones(transport);
  }

  private fallbackGetZones(transport: RoonApiTransport): Promise<GetZonesBody> {
    return this.logger.call(
      "get_zones",
      {},
      () =>
        new Promise<GetZonesBody>((resolve, reject) => {
          transport.get_zones((error, result) => {
            if (error) {
              reject(new RoonMcpError("BROWSE_FAILED", `get_zones failed: ${error}`));
              return;
            }
            resolve(result);
          });
        }),
      (body) => ({ zones: body.zones?.length ?? 0 }),
    );
  }
}

function isTransportAction(s: string): s is "pause" | "resume" | "next" | "previous" | "stop" {
  return s === "pause" || s === "resume" || s === "next" || s === "previous" || s === "stop";
}

function mapControlVerb(action: "pause" | "resume" | "next" | "previous" | "stop"): RoonControlVerb {
  // `resume` reads naturally to a user; Roon's API uses `play` for the same effect.
  return action === "resume" ? "play" : action;
}

type ControlAllowedFlag =
  | "is_pause_allowed"
  | "is_play_allowed"
  | "is_next_allowed"
  | "is_previous_allowed";

/** Map a non-`stop` Roon control verb to its `is_*_allowed` zone-state flag. */
function allowedFlagFor(verb: Exclude<RoonControlVerb, "stop">): ControlAllowedFlag {
  switch (verb) {
    case "pause":
      return "is_pause_allowed";
    case "play":
      return "is_play_allowed";
    case "next":
      return "is_next_allowed";
    case "previous":
      return "is_previous_allowed";
  }
}

/**
 * Roon volume outputs report a native `min`/`max`/`step` in their own units.
 * Returns false for "incremental" outputs (IR blasters) which expose only
 * +/− buttons with no numeric state, and false for any output missing min/max.
 */
function hasNumericRange(
  v: NonNullable<RoonOutput["volume"]>,
): v is NonNullable<RoonOutput["volume"]> & { min: number; max: number } {
  return typeof v.min === "number" && typeof v.max === "number" && v.max > v.min;
}

interface NumericVolume {
  min: number;
  max: number;
  step?: number;
  type?: string;
}

function scaleToRange(percent: number, v: NumericVolume): number {
  const span = v.max - v.min;
  const raw = v.min + (span * percent) / 100;
  if (typeof v.step === "number" && v.step > 0) {
    return Math.round(raw / v.step) * v.step;
  }
  return raw;
}

function mapState(state: RoonZoneState | undefined): ZoneState {
  switch (state) {
    case "playing":
    case "paused":
    case "loading":
    case "stopped":
      return state;
    default:
      return "unknown";
  }
}

/** Map a Roon zone (with `now_playing`) to the public `NowPlayingInfo` shape. */
function mapNowPlaying(raw: RoonApiZone): NowPlayingInfo {
  const np = raw.now_playing;
  // Prefer three-line (artist + album), fall back to two-line (artist only),
  // then one-line. Mirrors how ZoneService.nowPlayingFor picks a label.
  const three = np?.three_line;
  const two = np?.two_line;
  const one = np?.one_line;
  return {
    zoneId: raw.zone_id,
    displayName: raw.display_name,
    state: mapState(raw.state),
    title: three?.line1 ?? two?.line1 ?? one?.line1,
    artist: three?.line2 ?? two?.line2,
    album: three?.line3,
    imageKey: np?.image_key,
    lengthSec: np?.length,
    seekPositionSec: np?.seek_position,
    volumePercent: zoneVolumePercent(raw),
    isMuted: (raw.outputs ?? []).some((o) => o.volume?.is_muted === true),
  };
}

/**
 * Volume of the zone's first numeric-range output, rescaled to 0–100 percent
 * (the inverse of {@link scaleToRange}). Undefined when no output has a usable
 * min/max/value (e.g. incremental IR controls).
 */
function zoneVolumePercent(raw: RoonApiZone): number | undefined {
  for (const o of raw.outputs ?? []) {
    const v = o.volume;
    if (
      v &&
      typeof v.min === "number" &&
      typeof v.max === "number" &&
      typeof v.value === "number" &&
      v.max > v.min
    ) {
      return Math.round(((v.value - v.min) / (v.max - v.min)) * 100);
    }
  }
  return undefined;
}
