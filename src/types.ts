// Public domain types shared across services and MCP tool boundaries.
// Kept aligned with the implementation plan's TypeScript interfaces.

export type ZoneState = "playing" | "paused" | "stopped" | "loading" | "unknown";

export interface RoonZone {
  zoneId: string;
  displayName: string;
  state: ZoneState;
  outputIds: string[];
  isDefaultCandidate: boolean;
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
