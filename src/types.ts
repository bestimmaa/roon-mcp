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
