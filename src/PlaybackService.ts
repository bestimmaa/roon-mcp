import type { BrowseHierarchy, BrowseItem } from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { RoonClient } from "./RoonClient.js";
import { ZoneService } from "./ZoneService.js";
import { RoonMcpError, type PlaybackResult, type PlayNowInput } from "./types.js";

// Item keys handed to playback originate from `search_music`, so we drive the
// playback drill in the same hierarchy that produced them.
const PLAY_HIERARCHY: BrowseHierarchy = "search";
const LOAD_COUNT = 100;

// English Roon action labels, ordered by preference (highest first). The plan
// flags localization as an open item; non-English Cores need locale-aware
// matching here, mirroring SearchService's GROUP_TITLE_TO_TYPE caveat.
const PLAY_LABELS = [
  "play now",
  "play album",
  "play artist",
  "play genre",
  "play playlist",
  "play track",
  "play",
  "start radio",
];
const SHUFFLE_LABELS = ["shuffle"];

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** An action candidate has a key and is not a header/list/action-list node. */
function isActionItem(item: BrowseItem): boolean {
  return Boolean(item.item_key) && (item.hint === "action" || item.hint == null);
}

/** Pick the best-matching action by label preference (exact, then prefix). */
function pickAction(items: BrowseItem[], shuffle: boolean): BrowseItem | null {
  const actions = items.filter(isActionItem);
  const labels = shuffle ? [...SHUFFLE_LABELS, ...PLAY_LABELS] : PLAY_LABELS;

  for (const label of labels) {
    const hit = actions.find((a) => normalize(a.title) === label);
    if (hit) return hit;
  }
  for (const label of labels) {
    const hit = actions.find((a) => normalize(a.title).startsWith(label));
    if (hit) return hit;
  }
  return null;
}

/** Executes Browse actions that build and start queues. */
export class PlaybackService {
  constructor(
    private readonly browse: BrowseSessionManager,
    private readonly zones: ZoneService,
    private readonly roon: RoonClient,
  ) {}

  /** Start a single search candidate playing immediately in the given zone. */
  async playNow(input: PlayNowInput): Promise<PlaybackResult> {
    const shuffle = input.shuffle ?? false;

    // Validate the target up front so a stale zone id fails clearly, not as a
    // confusing browse-action error.
    const zone = await this.zones.findZone(input.zoneId);
    if (!zone) {
      throw new RoonMcpError(
        "ZONE_NOT_FOUND",
        `No zone or output matches id "${input.zoneId}". Call list_zones for current ids.`,
      );
    }

    return this.browse.runExclusive(async () => {
      try {
        return await this.performPlayNow(input.itemKey, input.zoneId, shuffle);
      } catch (err) {
        // Per plan: if action invocation fails, reopen the item and retry once.
        // (A stale item key surfaces as INVALID_ITEM_KEY and is not retried —
        // re-running performPlayNow with the same key cannot help.)
        if (err instanceof RoonMcpError && err.code === "ACTION_FAILED") {
          return this.performPlayNow(input.itemKey, input.zoneId, shuffle);
        }
        throw err;
      }
    });
  }

  private async performPlayNow(
    itemKey: string,
    zoneId: string,
    shuffle: boolean,
  ): Promise<PlaybackResult> {
    // 1. Open the item. Item keys are session-scoped; a stale key fails here.
    const opened = await this.openItem(itemKey);
    if (opened.action === "message") {
      throw new RoonMcpError(
        "NO_PLAY_ACTION",
        opened.message ?? "Item is not playable.",
      );
    }

    // 2. Discover a play (or shuffle) action among the item's options.
    const action = await this.findPlayAction(shuffle);
    if (!action) {
      throw new RoonMcpError(
        "NO_PLAY_ACTION",
        "No play action is available for this item.",
      );
    }
    const usedShuffleAction = normalize(action.title).includes("shuffle");

    // 3. Invoke the action against the target zone. Starting new content must
    //    go through a Browse action carrying zone_or_output_id (not Transport).
    const result = await this.browse.browse({
      hierarchy: PLAY_HIERARCHY,
      item_key: action.item_key!,
      zone_or_output_id: zoneId,
    });
    if (result.action === "message" && result.is_error) {
      throw new RoonMcpError("ACTION_FAILED", result.message ?? "Play action failed.");
    }

    // 4. If shuffle was requested but the chosen action wasn't a shuffle, try
    //    the Transport setting as a best-effort fallback.
    let shuffleNote: string | undefined;
    if (shuffle && !usedShuffleAction) {
      const applied = await this.trySetShuffle(zoneId);
      if (!applied) {
        shuffleNote =
          " Shuffle was requested but could not be applied (no shuffle action and Transport setting unavailable).";
      }
    }

    const nowPlaying = await this.zones.nowPlayingFor(zoneId).catch(() => undefined);

    return {
      ok: true,
      zoneId,
      queued: 1,
      skipped: [],
      nowPlaying,
      message: `Started "${action.title}".${shuffleNote ?? ""}`,
    };
  }

  /** Drill into an item key within the play hierarchy. */
  private async openItem(itemKey: string) {
    return this.browse.browse({ hierarchy: PLAY_HIERARCHY, item_key: itemKey });
  }

  /**
   * Find a play/shuffle action for the currently-opened item. Inspects the
   * loaded list directly, and drills one level into an `action_list` container
   * if the actions aren't exposed at the top level.
   */
  private async findPlayAction(shuffle: boolean): Promise<BrowseItem | null> {
    const loaded = await this.browse.load({
      hierarchy: PLAY_HIERARCHY,
      offset: 0,
      count: LOAD_COUNT,
    });

    const direct = pickAction(loaded.items, shuffle);
    if (direct) return direct;

    const container = loaded.items.find((i) => i.hint === "action_list" && i.item_key);
    if (container) {
      await this.browse.browse({ hierarchy: PLAY_HIERARCHY, item_key: container.item_key! });
      const sub = await this.browse.load({
        hierarchy: PLAY_HIERARCHY,
        offset: 0,
        count: LOAD_COUNT,
      });
      return pickAction(sub.items, shuffle);
    }
    return null;
  }

  /** Best-effort shuffle via Transport; returns false if unsupported/failed. */
  private async trySetShuffle(zoneId: string): Promise<boolean> {
    let transport;
    try {
      transport = this.roon.getTransport();
    } catch {
      return false;
    }
    if (typeof transport.change_settings !== "function") return false;

    return new Promise<boolean>((resolve) => {
      transport.change_settings!(zoneId, { shuffle: true }, (error) => {
        resolve(!error);
      });
    });
  }
}
