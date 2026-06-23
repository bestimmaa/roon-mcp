// Public domain types shared across services and MCP tool boundaries.
// Kept aligned with the implementation plan's TypeScript interfaces.

export type MusicItemType =
  | "artist"
  | "album"
  | "track"
  | "genre"
  | "playlist"
  | "radio"
  | "unknown";

export type ZoneState = "playing" | "paused" | "stopped" | "loading" | "unknown";

export interface RoonZone {
  zoneId: string;
  displayName: string;
  state: ZoneState;
  outputIds: string[];
  isDefaultCandidate: boolean;
}

export interface SearchMusicInput {
  query: string;
  type?: MusicItemType;
  limit?: number;
  /** When true and type is "genre", also sample a track mix from streaming services (e.g. TIDAL). */
  includeStreaming?: boolean;
}

export interface MusicCandidate {
  itemKey: string;
  title: string;
  subtitle?: string;
  type: MusicItemType;
  score: number;
  available: boolean;
  sourceGroup?: string;
}

export interface SearchMusicOutput {
  query: string;
  candidates: MusicCandidate[];
  broadened: boolean;
  message?: string;
}

export interface GetTracksForInput {
  /** Opaque, session-scoped item key from a recent `search_music` result. */
  itemKey: string;
  limit?: number;
}

export interface TrackCandidate {
  itemKey: string;
  title: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  available: boolean;
}

export interface GetTracksForOutput {
  sourceItemKey: string;
  tracks: TrackCandidate[];
  skipped: Array<{ itemKey?: string; reason: string }>;
}

export interface PlayNowInput {
  /**
   * Zone id or any of its output ids (from `list_zones`). Optional: when
   * omitted the server falls back to the configured default zone
   * (`ROON_DEFAULT_ZONE`), then to the single/Office/playing heuristics.
   */
  zoneId?: string;
  /** Opaque, session-scoped item key from a recent `search_music` result. */
  itemKey: string;
  shuffle?: boolean;
  /** When true, append to the existing queue instead of replacing it. Default: false (replace). */
  addToQueue?: boolean;
}

export interface EnqueueAndPlayInput {
  /** Zone id or output id (from `list_zones`); see `PlayNowInput.zoneId`. */
  zoneId?: string;
  /** Ordered, session-scoped item keys (e.g. from `get_tracks_for`). */
  itemKeys: string[];
  shuffle?: boolean;
}

export interface PlaybackResult {
  ok: boolean;
  zoneId: string;
  /** Items started/queued by this call. `play_now` queues exactly one. */
  queued: number;
  skipped: Array<{ itemKey: string; reason: string }>;
  /** Current track line read after the action; waits for Roon's next zone
   * event so it reflects the new track rather than the previous one. */
  nowPlaying?: string;
  message?: string;
}

export interface EnqueueAndPlayOutput extends PlaybackResult {
  /** Number of item keys the caller asked to queue. */
  requested: number;
}

/** Verb for the `control_playback` tool. `resume` maps to Roon's `play`. */
export type TransportAction = "pause" | "resume" | "next" | "previous" | "stop";

export interface ControlPlaybackInput {
  /** Zone or output id from `list_zones`; resolves like `play_now` when omitted. */
  zoneId?: string;
  action: TransportAction;
}

export interface SetVolumeInput {
  zoneId?: string;
  /**
   * Target volume in percent (0 = silent, 100 = max). The server rescales
   * to each output's native range, so a single value works across mixed
   * devices in a grouped zone.
   */
  level: number;
}

export interface MuteInput {
  zoneId?: string;
  /** `true` to mute, `false` to unmute. */
  muted: boolean;
}

/**
 * Structured snapshot of a zone's current playback. Fields are populated
 * only when Roon reports them (e.g. `artist`/`album` are empty when only a
 * one-line display is available, or when nothing is playing at all).
 */
export interface NowPlayingInfo {
  zoneId: string;
  displayName: string;
  state: ZoneState;
  title?: string;
  artist?: string;
  album?: string;
  imageKey?: string;
  lengthSec?: number;
  seekPositionSec?: number;
  /**
   * Current volume of the zone's first numeric-range output as a 0–100
   * percent (the inverse of `set_volume`'s scaling). Undefined when no output
   * exposes a numeric range (e.g. IR blasters). Exposed so the agent can serve
   * relative "louder"/"softer" requests (issue #10).
   */
  volumePercent?: number;
  /** True when any output in the zone is muted. */
  isMuted?: boolean;
}

export type RoonMcpErrorCode =
  | "NO_CORE_PAIRED"
  | "ZONE_NOT_FOUND"
  | "ZONE_AMBIGUOUS"
  | "BROWSE_FAILED"
  | "INVALID_ITEM_KEY"
  | "NO_SEARCH_RESULTS"
  | "NO_PLAYABLE_ITEMS"
  | "NO_PLAY_ACTION"
  | "ACTION_FAILED"
  | "PARTIAL_QUEUE";

export class RoonMcpError extends Error {
  constructor(
    public readonly code: RoonMcpErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "RoonMcpError";
  }
}
