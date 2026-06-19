import type { BrowseHierarchy, BrowseItem } from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { RoonClient } from "./RoonClient.js";
import { silentLogger, type RoonCallLogger } from "./logger.js";
import { ZoneService } from "./ZoneService.js";
import {
  RoonMcpError,
  type EnqueueAndPlayInput,
  type EnqueueAndPlayOutput,
  type PlaybackResult,
  type PlayNowInput,
} from "./types.js";

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
// For curated, ordered queues we append to the end ("Add to Queue"/"Queue")
// rather than "Add Next", which would reverse the order on repeated calls.
const QUEUE_LABELS = ["add to queue", "queue", "add next"];

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** An action candidate has a key and is not a header/list/action-list node. */
function isActionItem(item: BrowseItem): boolean {
  return Boolean(item.item_key) && (item.hint === "action" || item.hint == null);
}

/** Pick the best-matching action by label preference (exact, then prefix). */
function pickAction(items: BrowseItem[], labels: string[]): BrowseItem | null {
  const actions = items.filter(isActionItem);

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
    private readonly logger: RoonCallLogger = silentLogger,
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
    const labels = shuffle ? [...SHUFFLE_LABELS, ...PLAY_LABELS] : PLAY_LABELS;
    const { action } = await this.findAction(labels);
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
      const applied = await this.trySetShuffle(zoneId, true);
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

  /**
   * Build an ad-hoc queue from curated item keys and start it playing. The
   * first playable item starts via "Play Now"; the rest append via "Queue" /
   * "Add to Queue". Items that can't be opened/queued are skipped and reported
   * so the agent can backfill, rather than failing the whole call.
   */
  async enqueueAndPlay(input: EnqueueAndPlayInput): Promise<EnqueueAndPlayOutput> {
    const zone = await this.zones.findZone(input.zoneId);
    if (!zone) {
      throw new RoonMcpError(
        "ZONE_NOT_FOUND",
        `No zone or output matches id "${input.zoneId}". Call list_zones for current ids.`,
      );
    }

    const requested = input.itemKeys.length;
    if (requested === 0) {
      return {
        ok: false,
        zoneId: input.zoneId,
        queued: 0,
        requested: 0,
        skipped: [],
        message: "No item keys were provided.",
      };
    }

    return this.browse.runExclusive(async () => {
      const skipped: Array<{ itemKey: string; reason: string }> = [];
      let queued = 0;
      let index = 0;

      // 1. Start the queue with the first item that can Play Now. If the first
      //    can't play, fall through to the next as the queue starter.
      let started = false;
      for (; index < input.itemKeys.length; index++) {
        const key = input.itemKeys[index]!;
        const outcome = await this.queueOne(key, input.zoneId, PLAY_LABELS);
        if (outcome.ok) {
          queued++;
          started = true;
          index++;
          break;
        }
        skipped.push({ itemKey: key, reason: outcome.reason });
      }

      if (!started) {
        return {
          ok: false,
          zoneId: input.zoneId,
          queued: 0,
          requested,
          skipped,
          message: "No provided item could start playback.",
        };
      }

      // 2. Append the remaining items in order.
      for (; index < input.itemKeys.length; index++) {
        const key = input.itemKeys[index]!;
        const outcome = await this.queueOne(key, input.zoneId, QUEUE_LABELS);
        if (outcome.ok) queued++;
        else skipped.push({ itemKey: key, reason: outcome.reason });
      }

      // 3. Apply shuffle only when explicitly requested (leave the zone's
      //    setting untouched otherwise). Best-effort via Transport.
      let shuffleNote: string | undefined;
      if (input.shuffle !== undefined) {
        const applied = await this.trySetShuffle(input.zoneId, input.shuffle);
        if (!applied) {
          shuffleNote = ` Shuffle ${input.shuffle ? "on" : "off"} could not be applied (Transport setting unavailable).`;
        }
      }

      const nowPlaying = await this.zones.nowPlayingFor(input.zoneId).catch(() => undefined);
      const message =
        `Queued ${queued} of ${requested} item(s)` +
        (skipped.length > 0 ? `, skipped ${skipped.length}.` : ".") +
        (shuffleNote ?? "");

      return { ok: queued > 0, zoneId: input.zoneId, queued, requested, skipped, nowPlaying, message };
    });
  }

  /**
   * Open one item, find a matching action, and invoke it against the zone.
   * Always pops back to the level the item key lives on, so the next curated
   * key still resolves. Per-item Roon failures are returned (not thrown) so the
   * enqueue loop can skip and continue.
   */
  private async queueOne(
    itemKey: string,
    zoneId: string,
    labels: string[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    let levelsPushed = 0;
    try {
      const opened = await this.openItem(itemKey);
      if (opened.action === "message") {
        return { ok: false, reason: opened.message ?? "Item is not playable." };
      }
      if (opened.action === "list") levelsPushed += 1;

      const { action, extraLevelsPushed } = await this.findAction(labels);
      levelsPushed += extraLevelsPushed;
      if (!action) return { ok: false, reason: "No matching play/queue action." };

      const result = await this.browse.browse({
        hierarchy: PLAY_HIERARCHY,
        item_key: action.item_key!,
        zone_or_output_id: zoneId,
      });
      if (result.action === "message" && result.is_error) {
        return { ok: false, reason: result.message ?? "Action failed." };
      }
      return { ok: true };
    } catch (err) {
      // A stale key or a transient per-item browse failure shouldn't abort the
      // whole queue; surface it as a skip reason. Fatal errors (e.g. no Core)
      // still propagate.
      if (
        err instanceof RoonMcpError &&
        (err.code === "INVALID_ITEM_KEY" || err.code === "BROWSE_FAILED")
      ) {
        return { ok: false, reason: err.message };
      }
      throw err;
    } finally {
      // Return to the curated item-key level for the next iteration.
      if (levelsPushed > 0) {
        await this.browse
          .browse({ hierarchy: PLAY_HIERARCHY, pop_levels: levelsPushed })
          .catch(() => undefined);
      }
    }
  }

  /** Drill into an item key within the play hierarchy. */
  private async openItem(itemKey: string) {
    return this.browse.browse({ hierarchy: PLAY_HIERARCHY, item_key: itemKey });
  }

  /**
   * Find an action (by label preference) for the currently-opened item.
   * Inspects the loaded list directly, and drills one level into an
   * `action_list` container if the actions aren't exposed at the top level.
   * Reports how many extra levels it pushed so callers can pop back.
   */
  private async findAction(
    labels: string[],
  ): Promise<{ action: BrowseItem | null; extraLevelsPushed: number }> {
    const loaded = await this.browse.load({
      hierarchy: PLAY_HIERARCHY,
      offset: 0,
      count: LOAD_COUNT,
    });

    const direct = pickAction(loaded.items, labels);
    if (direct) return { action: direct, extraLevelsPushed: 0 };

    const container = loaded.items.find((i) => i.hint === "action_list" && i.item_key);
    if (container) {
      await this.browse.browse({ hierarchy: PLAY_HIERARCHY, item_key: container.item_key! });
      const sub = await this.browse.load({
        hierarchy: PLAY_HIERARCHY,
        offset: 0,
        count: LOAD_COUNT,
      });
      return { action: pickAction(sub.items, labels), extraLevelsPushed: 1 };
    }
    return { action: null, extraLevelsPushed: 0 };
  }

  /** Best-effort shuffle via Transport; returns false if unsupported/failed. */
  private async trySetShuffle(zoneId: string, enabled: boolean): Promise<boolean> {
    let transport;
    try {
      transport = this.roon.getTransport();
    } catch {
      return false;
    }
    if (typeof transport.change_settings !== "function") return false;

    return this.logger.call(
      "change_settings",
      { zoneId, settings: { shuffle: enabled } },
      () =>
        new Promise<boolean>((resolve) => {
          transport.change_settings!(zoneId, { shuffle: enabled }, (error) => {
            resolve(!error);
          });
        }),
      (applied) => ({ applied }),
    );
  }
}
