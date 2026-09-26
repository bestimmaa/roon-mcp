import type {
  QueueSubscription,
  RoonApiTransport,
  RoonApiZone,
  RoonControlVerb,
  RoonOutput,
  RoonQueueItem,
} from "node-roon-api-transport";

import { RoonClient } from "./RoonClient.js";
import { silentLogger, type RoonCallLogger } from "./logger.js";
import { findZone, fingerprintFor, trackLines } from "./ZoneSubscription.js";
import {
  RoonMcpError,
  TRANSPORT_ACTIONS,
  type LoopMode,
  type NowPlayingInfo,
  type SeekResult,
  type SetLoopResult,
  type TransportAction,
  type ZoneState,
} from "./types.js";
import { mapState, ZoneService } from "./ZoneService.js";

/** User-friendly loop modes → Roon's native `loop` change_settings values. */
const LOOP_TO_ROON: Record<LoopMode, "disabled" | "loop" | "loop_one"> = {
  off: "disabled",
  all: "loop",
  one: "loop_one",
};

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

/** Result of `pauseAll`. */
export interface PauseAllResult {
  ok: true;
  action: "pause_all";
}

/** Result of `muteAll`. */
export interface MuteAllResult {
  ok: true;
  muted: boolean;
}

/** Result of `setAutoRadio`. */
export interface SetAutoRadioResult {
  ok: true;
  zoneId: string;
  autoRadio: boolean;
}

/** Result of `transferZone`. */
export interface TransferZoneResult {
  ok: true;
  fromZoneId: string;
  toZoneId: string;
}

/** Result of `groupOutputs`. */
export interface GroupResult {
  ok: true;
  action: "group" | "ungroup";
  /** The resolved output ids the operation was applied to. */
  outputIds: string[];
}

/** One entry in a zone's play queue (1-based position). */
export interface QueueEntry {
  position: number;
  /** Opaque id for `playFromHere` — jump the queue to this item. */
  queueItemId: number;
  title?: string;
  artist?: string;
  album?: string;
  lengthSec?: number;
  imageKey?: string;
}

/** Result of `getQueue`. */
export interface GetQueueResult {
  zoneId: string;
  entries: QueueEntry[];
  message?: string;
}

/** Result of `playFromHere`. */
export interface PlayFromHereResult {
  ok: true;
  zoneId: string;
  queueItemId: number;
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
   * `undefined` when nothing is playing. Throws `ZONE_NOT_FOUND` on a missing
   * or ambiguous zone, so callers can distinguish "no track" (snapshot with
   * `title: undefined`) from "no such zone" (`ZONE_NOT_FOUND`) — and the tool
   * layer never has to serialize an `undefined` payload (issue #9).
   */
  async getNowPlaying(zoneId?: string): Promise<NowPlayingInfo> {
    const { raw } = await this.resolveRaw(zoneId);
    return mapNowPlaying(raw);
  }

  /** Run a transport verb against the resolved zone. */
  async control(zoneId: string | undefined, action: string): Promise<ControlResult> {
    if (!isTransportAction(action)) {
      throw new RoonMcpError(
        "BROWSE_FAILED",
        `Unknown action "${action}". Use one of: ${TRANSPORT_ACTIONS.join(", ")}.`,
      );
    }
    const { targetId, raw } = await this.resolveRaw(zoneId);
    const verb = mapControlVerb(action);

    // `resume` on a zone that's already playing is a no-op, not an error: Roon
    // reports is_play_allowed === false while playing, so the precheck below
    // would otherwise refuse it. Skip the transport call and return the current
    // state (issue #7).
    if (verb === "play" && raw.state === "playing") {
      return { ok: true, zoneId: targetId, action, state: mapState(raw.state) };
    }

    // Best-effort precheck: the Core reports is_<verb>_allowed on its zone
    // state snapshot. `stop` and `playpause` have no corresponding flag (the
    // latter is a toggle Roon accepts in either state) and are always allowed.
    // If the flag is explicitly false, refuse rather than rely on Roon to error.
    if (verb !== "stop" && verb !== "playpause" && raw.state === "playing") {
      const flag = allowedFlagFor(verb);
      if (raw[flag] === false) {
        throw new RoonMcpError(
          "BROWSE_FAILED",
          `Action "${action}" is not available on this zone.`,
        );
      }
    }

    const sub = this.roon.getActiveSubscription();
    // Capture the pre-action fingerprint from the zone we just resolved, so
    // we can wait for Roon to push a snapshot reflecting the new state.
    // Reading `get_zones` immediately after the action would still return
    // the pre-action state (issue #1).
    const before = sub
      ? fingerprintFor({ zones: [raw] }, targetId)
      : undefined;
    await this.transportCall(
      "control",
      { zoneId: targetId, control: verb },
      (t, cb) => t.control!(targetId, verb, cb),
      `control(${verb})`,
    );

    // Wait for the next subscription event that reflects the new state, so
    // the returned `state` matches what the agent would read from
    // `now_playing` right after. Times out fast on a slow Core.
    const after = sub && before
      ? await sub.waitForZoneChange(targetId, before)
      : await this.zones.getZonesBody();
    const zoneAfter = findZone(after, targetId);
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
    const { targetId, raw } = await this.resolveRaw(zoneId);

    const applied: string[] = [];
    const skipped: string[] = [];

    // When the caller targeted a specific output (targetId is an output id, not
    // the zone id), restrict to that output — otherwise setting volume on one
    // member of a grouped zone would change every output in the group (#14).
    for (const output of targetOutputs(raw, targetId)) {
      const v = output.volume;
      if (!v || !hasNumericRange(v)) {
        skipped.push(output.output_id);
        continue;
      }
      const value = scaleToRange(level, v);
      await this.transportCall(
        "change_volume",
        { outputId: output.output_id, how: "absolute", value },
        (t, cb) => t.change_volume!(output, "absolute", value, cb),
        "change_volume",
        () => ({ value }),
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
    const { targetId, raw } = await this.resolveRaw(zoneId);
    const how = muted ? "mute" : "unmute";
    // Restrict to the named output when an output id was targeted (issue #14);
    // otherwise mute/unmute every output in the zone.
    for (const output of targetOutputs(raw, targetId)) {
      await this.transportCall(
        "mute",
        { outputId: output.output_id, how },
        (t, cb) => t.mute!(output, how, cb),
        how,
      );
    }

    return { ok: true, zoneId: targetId, muted };
  }

  /**
   * Seek within the current track. `mode: "absolute"` (default) sets the
   * position to `seconds` (0 = start); `"relative"` moves by `seconds` (negative
   * skips backward). Refuses up front when the zone reports `is_seek_allowed`
   * as false.
   */
  async seek(
    zoneId: string | undefined,
    seconds: number,
    mode: "absolute" | "relative" = "absolute",
  ): Promise<SeekResult> {
    if (!Number.isFinite(seconds) || (mode === "absolute" && seconds < 0)) {
      throw new RoonMcpError(
        "BROWSE_FAILED",
        `seconds must be a finite non-negative number in absolute mode (got ${seconds}).`,
      );
    }
    const { targetId, raw } = await this.resolveRaw(zoneId);
    if (raw.is_seek_allowed === false) {
      throw new RoonMcpError(
        "BROWSE_FAILED",
        "Seek is not available on this zone right now.",
      );
    }

    await this.transportCall(
      "seek",
      { zoneId: targetId, how: mode, seconds },
      (t, cb) => t.seek!(targetId, mode, seconds, cb),
      "seek",
      () => ({ seconds }),
    );

    return { ok: true, zoneId: targetId, mode, seconds };
  }

  /**
   * Set the loop/repeat mode for a zone via `change_settings`. Maps the
   * user-friendly mode to Roon's native `loop` value. Refuses when the
   * transport doesn't expose `change_settings` (older Cores).
   */
  async setLoop(zoneId: string | undefined, mode: LoopMode): Promise<SetLoopResult> {
    const { targetId } = await this.resolveRaw(zoneId);
    const roonMode = LOOP_TO_ROON[mode];
    await this.changeSettings(targetId, { loop: roonMode }, "loop", "Loop/repeat settings are");

    return { ok: true, zoneId: targetId, mode };
  }

  /** Pause every zone on the Core. */
  async pauseAll(): Promise<PauseAllResult> {
    await this.roon.waitForCore();
    this.requireTransport("pause_all", "Whole-house pause is");
    await this.transportCall("pause_all", {}, (t, cb) => t.pause_all!(cb));
    return { ok: true, action: "pause_all" };
  }

  /** Mute or unmute every mutable zone on the Core. */
  async muteAll(muted: boolean): Promise<MuteAllResult> {
    await this.roon.waitForCore();
    this.requireTransport("mute_all", "Whole-house mute is");
    const how = muted ? "mute" : "unmute";
    await this.transportCall("mute_all", { how }, (t, cb) => t.mute_all!(how, cb));
    return { ok: true, muted };
  }

  /** Turn Roon Radio (auto-radio queue continuation) on or off for a zone. */
  async setAutoRadio(zoneId: string | undefined, enabled: boolean): Promise<SetAutoRadioResult> {
    const { targetId } = await this.resolveRaw(zoneId);
    await this.changeSettings(
      targetId,
      { auto_radio: enabled },
      "auto_radio",
      "Roon Radio settings are",
    );
    return { ok: true, zoneId: targetId, autoRadio: enabled };
  }

  /**
   * Read a zone's upcoming play queue via a one-shot `subscribe_queue`:
   * subscribe, take the `Subscribed` snapshot, unsubscribe immediately.
   * Returns 1-based positions plus the `queueItemId` each entry needs for
   * `playFromHere`.
   */
  async getQueue(zoneId: string | undefined, limit = 25): Promise<GetQueueResult> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RoonMcpError("BROWSE_FAILED", `limit must be a positive integer (got ${limit}).`);
    }
    const { targetId } = await this.zones.resolveTarget(zoneId);
    const transport = this.requireTransport("subscribe_queue", "Queue read-back is");

    const items = await this.logger.call(
      "subscribe_queue",
      { zoneId: targetId, limit },
      () =>
        new Promise<RoonQueueItem[]>((resolve, reject) => {
          let handle: QueueSubscription | undefined;
          let settled = false;
          const finish = () => {
            // Best-effort teardown; the snapshot is already in hand.
            try {
              handle?.unsubscribe();
            } catch {
              /* connection may already be gone */
            }
          };
          handle = transport.subscribe_queue!(targetId, limit, (response, body) => {
            if (settled) return;
            if (response === "Subscribed") {
              settled = true;
              finish();
              resolve(body?.items ?? []);
            } else if (response !== "Changed") {
              // An error name ("NetworkError", "InvalidRequest", …) or an
              // unexpected Unsubscribed before the snapshot landed.
              settled = true;
              finish();
              reject(new RoonMcpError("BROWSE_FAILED", `subscribe_queue failed: ${response}`));
            }
          });
          // The callback can fire synchronously (e.g. in tests); make sure a
          // snapshot taken before `handle` was assigned still unsubscribes.
          if (settled) finish();
        }),
      (queue) => ({ items: queue.length }),
    );

    const entries = items.map(mapQueueItem);
    return {
      zoneId: targetId,
      entries,
      ...(entries.length === 0 ? { message: "The queue is empty." } : {}),
    };
  }

  /** Jump playback to a queue item (id from `getQueue`) without rebuilding the queue. */
  async playFromHere(zoneId: string | undefined, queueItemId: number): Promise<PlayFromHereResult> {
    const { targetId } = await this.zones.resolveTarget(zoneId);
    const transport = this.requireTransport("play_from_here", "Queue jumping is");
    await this.logger.call(
      "play_from_here",
      { zoneId: targetId, queueItemId },
      () =>
        new Promise<void>((resolve, reject) => {
          // Unlike the other transport verbs, play_from_here hands back the raw
          // moo message: success is msg.name === "Success".
          transport.play_from_here!(targetId, queueItemId, (msg) => {
            if (msg?.name === "Success") {
              resolve();
              return;
            }
            reject(
              new RoonMcpError(
                "BROWSE_FAILED",
                `play_from_here failed: ${msg?.name ?? "NetworkError"} (stale queueItemId? re-read the queue).`,
              ),
            );
          });
        }),
    );
    return { ok: true, zoneId: targetId, queueItemId };
  }

  /** Move what's playing (queue and all) from one zone to another. */
  async transferZone(fromZoneId: string | undefined, toZoneId: string): Promise<TransferZoneResult> {
    const { targetId: fromId } = await this.zones.resolveTarget(fromZoneId);
    const { targetId: toId } = await this.zones.resolveTarget(toZoneId);
    if (fromId === toId) {
      throw new RoonMcpError(
        "BROWSE_FAILED",
        "Source and destination resolve to the same zone — nothing to transfer.",
      );
    }
    this.requireTransport("transfer_zone", "Zone transfer is");
    await this.transportCall(
      "transfer_zone",
      { from: fromId, to: toId },
      (t, cb) => t.transfer_zone!(fromId, toId, cb),
    );
    return { ok: true, fromZoneId: fromId, toZoneId: toId };
  }

  /**
   * Group outputs into one synchronized zone, or break a group apart. Each
   * entry resolves like any zone target (id or name substring); an entry that
   * resolves to a whole zone expands to all of that zone's outputs. Grouping
   * preserves the FIRST entry's queue.
   */
  async groupOutputs(zonesOrOutputs: string[], action: "group" | "ungroup"): Promise<GroupResult> {
    const minimum = action === "group" ? 2 : 1;
    if (zonesOrOutputs.length < minimum) {
      throw new RoonMcpError(
        "BROWSE_FAILED",
        `${action} needs at least ${minimum} zone(s)/output(s) (got ${zonesOrOutputs.length}).`,
      );
    }

    // Resolve every entry to concrete output ids, preserving order (the first
    // output's queue survives a group) and dropping duplicates.
    const outputIds: string[] = [];
    for (const entry of zonesOrOutputs) {
      const { targetId, raw } = await this.resolveRaw(entry);
      const ids =
        raw.zone_id === targetId
          ? (raw.outputs ?? []).map((o) => o.output_id)
          : [targetId];
      for (const id of ids) {
        if (!outputIds.includes(id)) outputIds.push(id);
      }
    }
    if (action === "group" && outputIds.length < 2) {
      throw new RoonMcpError(
        "BROWSE_FAILED",
        "The entries resolve to fewer than two distinct outputs — nothing to group.",
      );
    }

    const method = action === "group" ? "group_outputs" : "ungroup_outputs";
    this.requireTransport(method, "Output grouping is");
    await this.transportCall(method, { outputIds }, (t, cb) => t[method]!(outputIds, cb));
    return { ok: true, action, outputIds };
  }

  /**
   * Resolve a zone target and re-read its raw Roon zone, so a zone that
   * vanished between the two reads surfaces as `ZONE_NOT_FOUND` rather than
   * an `undefined` payload (issue #9).
   */
  private async resolveRaw(zoneId?: string): Promise<{ targetId: string; raw: RoonApiZone }> {
    const { targetId } = await this.zones.resolveTarget(zoneId);
    const raw = await this.zones.findRawZone(targetId);
    if (!raw) {
      throw new RoonMcpError("ZONE_NOT_FOUND", `Zone "${targetId}" is no longer available.`);
    }
    return { targetId, raw };
  }

  /**
   * The transport, or `BROWSE_FAILED` when this Core lacks `method`.
   * `feature` completes "… not available on this Core", e.g. "Zone transfer is".
   */
  private requireTransport(method: OptionalTransportMethod, feature: string): RoonApiTransport {
    const transport = this.roon.getTransport();
    if (typeof transport[method] !== "function") {
      throw new RoonMcpError(
        "BROWSE_FAILED",
        `${feature} not available on this Core (${method} unsupported).`,
      );
    }
    return transport;
  }

  /**
   * Run a callback-style transport call as a logged promise. A Roon error
   * rejects with `BROWSE_FAILED`, labelled `label` (defaults to `op`).
   */
  private transportCall(
    op: string,
    params: Record<string, unknown>,
    invoke: (transport: RoonApiTransport, cb: (error: string | false) => void) => void,
    label: string = op,
    summarize?: () => Record<string, unknown>,
  ): Promise<void> {
    const transport = this.roon.getTransport();
    return this.logger.call(
      op,
      params,
      () =>
      new Promise<void>((resolve, reject) => {
        invoke(transport, (error) => {
          if (error) {
            reject(new RoonMcpError("BROWSE_FAILED", `${label} failed: ${error}`));
            return;
          }
          resolve();
        });
      }),
      summarize,
    );
  }

  /** Apply zone settings via `change_settings` (refused on older Cores). */
  private async changeSettings(
    targetId: string,
    settings: { loop?: "disabled" | "loop" | "loop_one"; auto_radio?: boolean },
    name: string,
    feature: string,
  ): Promise<void> {
    this.requireTransport("change_settings", feature);
    await this.transportCall(
      "change_settings",
      { zoneId: targetId, settings },
      (t, cb) => t.change_settings!(targetId, settings, cb),
      `change_settings(${name})`,
      () => settings,
    );
  }
}

/** Transport methods older Cores may not expose. */
type OptionalTransportMethod =
  | "change_settings"
  | "pause_all"
  | "mute_all"
  | "subscribe_queue"
  | "play_from_here"
  | "transfer_zone"
  | "group_outputs"
  | "ungroup_outputs";

function isTransportAction(s: string): s is TransportAction {
  return (TRANSPORT_ACTIONS as readonly string[]).includes(s);
}

function mapControlVerb(action: TransportAction): RoonControlVerb {
  // `resume` reads naturally to a user; Roon's API uses `play` for the same
  // effect. `playpause` is a native Roon toggle verb and passes through.
  return action === "resume" ? "play" : action;
}

type ControlAllowedFlag =
  | "is_pause_allowed"
  | "is_play_allowed"
  | "is_next_allowed"
  | "is_previous_allowed";

/** Map a Roon control verb (one with an `is_*_allowed` flag) to that flag. */
function allowedFlagFor(
  verb: Exclude<RoonControlVerb, "stop" | "playpause">,
): ControlAllowedFlag {
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

function scaleToRange(percent: number, v: { min: number; max: number; step?: number }): number {
  const span = v.max - v.min;
  const raw = v.min + (span * percent) / 100;
  if (typeof v.step === "number" && v.step > 0) {
    return Math.round(raw / v.step) * v.step;
  }
  return raw;
}

/**
 * The outputs a volume/mute operation should touch. When the caller targeted a
 * specific output (targetId is an output id, not the zone id), return only
 * that output so a grouped zone isn't changed wholesale (issue #14). Otherwise
 * return every output in the zone.
 */
function targetOutputs(raw: RoonApiZone, targetId: string): RoonOutput[] {
  const outputs = raw.outputs ?? [];
  if (raw.zone_id === targetId) return outputs;
  return outputs.filter((o) => o.output_id === targetId);
}

/** Map a queue item to the public entry shape (same line-picking as now-playing). */
function mapQueueItem(item: RoonQueueItem, index: number): QueueEntry {
  return {
    position: index + 1,
    queueItemId: item.queue_item_id,
    ...trackLines(item),
    lengthSec: item.length,
    imageKey: item.image_key,
  };
}

/** Map a Roon zone (with `now_playing`) to the public `NowPlayingInfo` shape. */
function mapNowPlaying(raw: RoonApiZone): NowPlayingInfo {
  const np = raw.now_playing;
  return {
    zoneId: raw.zone_id,
    displayName: raw.display_name,
    state: mapState(raw.state),
    ...trackLines(np),
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
    if (v && hasNumericRange(v) && typeof v.value === "number") {
      return Math.round(((v.value - v.min) / (v.max - v.min)) * 100);
    }
  }
  return undefined;
}
