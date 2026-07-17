import type { BrowseHierarchy, BrowseItem } from "node-roon-api-browse";

import type { GetZonesBody } from "node-roon-api-transport";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { RoonClient } from "./RoonClient.js";
import { silentLogger, type RoonCallLogger } from "./logger.js";
import { hierarchyForLocator } from "./locator.js";
import { SearchNavigator, requireLocator } from "./SearchNavigator.js";
import {
  fingerprintFor,
  ZoneSubscription,
} from "./ZoneSubscription.js";
import { TrackExpansionService } from "./TrackExpansionService.js";
import { ZoneService } from "./ZoneService.js";
import {
  RoonMcpError,
  type EnqueueAndPlayInput,
  type EnqueueAndPlayOutput,
  type PlaybackResult,
  type PlayNowInput,
} from "./types.js";

// Item keys handed to playback are locators; we drive the playback drill in the
// hierarchy that produced them (flat "search" for most items, "genres" for a
// genre), re-navigating to a live key via SearchNavigator.
const LOAD_COUNT = 100;

// How many container levels findAction may drill through before giving up.
// Covers the deepest known real shape: album-versions page (list) → track
// list ("Play Album" action_list) → the action menu itself.
const MAX_ACTION_DRILL_DEPTH = 3;

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
  private readonly navigator: SearchNavigator;

  constructor(
    private readonly browse: BrowseSessionManager,
    private readonly zones: ZoneService,
    private readonly roon: RoonClient,
    private readonly tracks: TrackExpansionService,
    private readonly logger: RoonCallLogger = silentLogger,
  ) {
    this.navigator = new SearchNavigator(browse);
  }

  /** Start a single search candidate playing immediately in the target zone. */
  async playNow(input: PlayNowInput): Promise<PlaybackResult> {
    const shuffle = input.shuffle ?? false;
    const addToQueue = input.addToQueue ?? false;
    const loc = requireLocator(input.itemKey);

    // Resolve the target up front (explicit id, configured default, or
    // heuristics) so a bad/missing zone fails clearly, not as a confusing
    // browse-action error.
    const { targetId } = await this.zones.resolveTarget(input.zoneId);

    return this.browse.runExclusive(async () => {
      try {
        return await this.performPlayNow(loc, targetId, shuffle, addToQueue);
      } catch (err) {
        // Per plan: if action invocation fails, reopen the item and retry once.
        // Re-navigating gives fresh live keys, so the retry is meaningful. (A
        // stale locator surfaces as INVALID_ITEM_KEY and is not retried.)
        if (err instanceof RoonMcpError && err.code === "ACTION_FAILED") {
          return this.performPlayNow(loc, targetId, shuffle, addToQueue);
        }
        throw err;
      }
    });
  }

  private async performPlayNow(
    loc: Parameters<SearchNavigator["openItem"]>[0],
    zoneId: string,
    shuffle: boolean,
    addToQueue: boolean = false,
  ): Promise<PlaybackResult> {
    const hierarchy = hierarchyForLocator(loc);

    // 1. Re-navigate to a live key for the located item and open it.
    const opened = await this.navigator.openItem(loc);
    if (opened.action === "message") {
      throw new RoonMcpError(
        "NO_PLAY_ACTION",
        opened.message ?? "Item is not playable.",
      );
    }

    // 2. Discover the appropriate action among the item's options.
    //    When queuing, use "Add to Queue" labels; otherwise look for "Play Now".
    const labels = addToQueue
      ? QUEUE_LABELS
      : shuffle
        ? [...SHUFFLE_LABELS, ...PLAY_LABELS]
        : PLAY_LABELS;
    const { action } = await this.findAction(hierarchy, labels);
    if (!action) {
      throw new RoonMcpError(
        "NO_PLAY_ACTION",
        addToQueue
          ? "No queue action is available for this item."
          : "No play action is available for this item.",
      );
    }

    if (addToQueue) {
      // Adding to queue does not change what's currently playing, so no
      // fingerprint tracking is needed.
      const result = await this.browse.browse({
        hierarchy,
        item_key: action.item_key!,
        zone_or_output_id: zoneId,
      });
      if (result.action === "message" && result.is_error) {
        throw new RoonMcpError("ACTION_FAILED", result.message ?? "Queue action failed.");
      }
      const nowPlaying = await this.zones.nowPlayingFor(zoneId);
      return {
        ok: true,
        zoneId,
        queued: 1,
        skipped: [],
        nowPlaying,
        message: `Added to queue via "${action.title}".`,
      };
    }

    const usedShuffleAction = normalize(action.title).includes("shuffle");

    // 3. Invoke the action against the target zone. Starting new content must
    //    go through a Browse action carrying zone_or_output_id (not Transport).
    // Capture the pre-action fingerprint so we can wait for Roon to push the
    // post-action snapshot. Reading `now_playing` immediately after the
    // browse action would still return the pre-action track (issue #1).
    const sub = this.roon.getActiveSubscription();
    const before = await this.captureFingerprint(sub, zoneId);

    const result = await this.browse.browse({
      hierarchy,
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

    const nowPlaying = await this.readNowPlayingLine(sub, zoneId, before);

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
    const { targetId } = await this.zones.resolveTarget(input.zoneId);

    const requested = input.itemKeys.length;
    if (requested === 0) {
      return {
        ok: false,
        zoneId: targetId,
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

      // Capture the pre-action fingerprint so we can wait for Roon to push
      // the post-action snapshot. Reading `now_playing` immediately after
      // the browse action would still return the pre-action track (issue #1).
      const sub = this.roon.getActiveSubscription();
      const before = await this.captureFingerprint(sub, targetId);

      // 1. Start the queue with the first item that can Play Now. If the first
      //    can't play, fall through to the next as the queue starter.
      let started = false;
      for (; index < input.itemKeys.length; index++) {
        const key = input.itemKeys[index]!;
        const outcome = await this.queueOne(key, targetId, PLAY_LABELS);
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
          zoneId: targetId,
          queued: 0,
          requested,
          skipped,
          message: "No provided item could start playback.",
        };
      }

      // 2. Append the remaining items in order.
      for (; index < input.itemKeys.length; index++) {
        const key = input.itemKeys[index]!;
        const outcome = await this.queueOne(key, targetId, QUEUE_LABELS);
        if (outcome.ok) queued++;
        else skipped.push({ itemKey: key, reason: outcome.reason });
      }

      // 3. Apply shuffle only when explicitly requested (leave the zone's
      //    setting untouched otherwise). Best-effort via Transport. Only warn
      //    when shuffle-on was requested and couldn't be applied; shuffle-off
      //    failing is silent — a queue built in order is already unshuffled,
      //    and an unavailable change_settings is the common cause (issue #11).
      let shuffleNote: string | undefined;
      if (input.shuffle !== undefined) {
        const applied = await this.trySetShuffle(targetId, input.shuffle);
        if (!applied && input.shuffle) {
          shuffleNote = " Shuffle was requested but could not be applied (Transport setting unavailable).";
        }
      }

      const nowPlaying = await this.readNowPlayingLine(sub, targetId, before);
      const message =
        `Queued ${queued} of ${requested} item(s)` +
        (skipped.length > 0 ? `, skipped ${skipped.length}.` : ".") +
        (shuffleNote ?? "");

      return { ok: queued > 0, zoneId: targetId, queued, requested, skipped, nowPlaying, message };
    });
  }

  /**
   * Re-navigate to one located item/track, find a matching action, and invoke
   * it against the zone. Each call re-navigates from a fresh search (so the keys
   * are live and no pop bookkeeping is needed); searching does not disturb the
   * zone's queue being built. Per-item Roon failures are returned (not thrown)
   * so the enqueue loop can skip and continue.
   */
  private async queueOne(
    itemKey: string,
    zoneId: string,
    labels: string[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const loc = requireLocator(itemKey);
      const hierarchy = hierarchyForLocator(loc);
      // A track locator (t set) resolves through the track list; an item
      // locator opens the candidate directly.
      const opened =
        loc.t !== undefined
          ? await this.tracks.openTrackForPlayback(loc)
          : await this.navigator.openItem(loc);
      if (opened.action === "message") {
        return { ok: false, reason: opened.message ?? "Item is not playable." };
      }

      const { action } = await this.findAction(hierarchy, labels);
      if (!action) return { ok: false, reason: "No matching play/queue action." };

      const result = await this.browse.browse({
        hierarchy,
        item_key: action.item_key!,
        zone_or_output_id: zoneId,
      });
      if (result.action === "message" && result.is_error) {
        return { ok: false, reason: result.message ?? "Action failed." };
      }
      return { ok: true };
    } catch (err) {
      // A stale locator or a transient per-item browse failure shouldn't abort
      // the whole queue; surface it as a skip reason. Fatal errors (e.g. no
      // Core) still propagate.
      if (
        err instanceof RoonMcpError &&
        (err.code === "INVALID_ITEM_KEY" || err.code === "BROWSE_FAILED")
      ) {
        return { ok: false, reason: err.message };
      }
      throw err;
    }
  }

  /**
   * Find an action (by label preference) for the currently-opened item.
   * Inspects the loaded list directly, and drills into containers when the
   * actions aren't exposed at the top level, preferring an `action_list`
   * container (e.g. "Play Album" / "More") over a plain `list` child.
   *
   * The plain-`list` fallback handles pass-through levels that hold no
   * actions at all — most notably the album-versions page the search
   * hierarchy returns when opening an album (a lone `list` item for the
   * album itself, with "Play Album" living one level deeper). It only fires
   * when every selectable item at the level is a `list`, so levels that mix
   * real actions with sub-lists are never mis-drilled.
   *
   * Reports how many extra levels it pushed so callers can pop back.
   */
  private async findAction(
    hierarchy: BrowseHierarchy,
    labels: string[],
  ): Promise<{ action: BrowseItem | null; extraLevelsPushed: number }> {
    let extraLevelsPushed = 0;

    for (let depth = 0; depth <= MAX_ACTION_DRILL_DEPTH; depth++) {
      const loaded = await this.browse.load({
        hierarchy,
        offset: 0,
        count: LOAD_COUNT,
      });

      const direct = pickAction(loaded.items, labels);
      if (direct) return { action: direct, extraLevelsPushed };

      if (depth === MAX_ACTION_DRILL_DEPTH) break;

      // Prefer an action-menu container; its children are the real actions.
      let container = loaded.items.find((i) => i.hint === "action_list" && i.item_key);

      if (!container) {
        // Pass-through level: nothing actionable, only sub-lists (e.g. the
        // album-versions page). Drill the first one — Roon lists the primary
        // version first — and look again a level deeper.
        const selectable = loaded.items.filter(
          (i) => Boolean(i.item_key) && i.hint !== "header",
        );
        const allLists =
          selectable.length > 0 && selectable.every((i) => i.hint === "list");
        if (allLists) container = selectable[0];
      }
      if (!container) break;

      // The drill is speculative discovery — if the Core rejects it, report
      // "no play action" rather than surfacing a confusing browse error.
      let drilled;
      try {
        drilled = await this.browse.browse({
          hierarchy,
          item_key: container.item_key!,
        });
      } catch {
        break;
      }
      if (drilled.action !== "list") break;
      extraLevelsPushed++;
    }

    return { action: null, extraLevelsPushed };
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

  /**
   * Snapshot a zone's `(state, title, artist, album)` fingerprint before a
   * playback action runs, so we can wait for the post-action change. Reads
   * via the active subscription (or `get_zones` cold-start fallback). Returns
   * `undefined` when no subscription is active and the zone isn't yet known
   * — the caller falls back to the legacy immediate read.
   */
  private async captureFingerprint(
    sub: ZoneSubscription | undefined,
    zoneId: string,
  ): Promise<ReturnType<typeof fingerprintFor>> {
    if (!sub) return undefined;
    const body = await sub.getSnapshot(() => this.coldStartGetZones());
    return fingerprintFor(body, zoneId);
  }

  /** One-shot `get_zones` RPC for the cold-start case (no subscription yet). */
  private coldStartGetZones(): Promise<GetZonesBody> {
    const transport = this.roon.getTransport();
    return new Promise<GetZonesBody>((resolve, reject) => {
      transport.get_zones((err, result) => {
        if (err) {
          reject(new RoonMcpError("BROWSE_FAILED", `get_zones failed: ${err}`));
          return;
        }
        resolve(result);
      });
    });
  }

  /**
   * Read the `now_playing` line for a zone after a playback action, waiting
   * for the subscription to push a snapshot that reflects the change.
   * Returns `undefined` when the zone isn't reported (e.g. Core unpaired).
   */
  private async readNowPlayingLine(
    sub: ZoneSubscription | undefined,
    zoneId: string,
    before: ReturnType<typeof fingerprintFor>,
  ): Promise<string | undefined> {
    try {
      if (!sub || !before) {
        return await this.zones.nowPlayingFor(zoneId);
      }
      const after = await sub.waitForZoneChange(zoneId, before);
      const z = (after.zones ?? []).find(
        (x) =>
          x.zone_id === zoneId ||
          (x.outputs ?? []).some((o) => o.output_id === zoneId),
      );
      const np = z?.now_playing;
      return np?.two_line?.line1 ?? np?.one_line?.line1 ?? np?.three_line?.line1;
    } catch {
      return undefined;
    }
  }
}
