import type { BrowseHierarchy, BrowseItem, BrowseList } from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import {
  RoonMcpError,
  type GetTracksForInput,
  type GetTracksForOutput,
  type TrackCandidate,
} from "./types.js";

// Item keys handed here come from `search_music`, so we drill in the same
// hierarchy that produced them. (We do not reset it: a reset would invalidate
// the very key we were given — same posture as PlaybackService.)
const EXPAND_HIERARCHY: BrowseHierarchy = "search";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
// Roon track lists can be long; scan generously so a track section isn't cut.
const SCAN_COUNT = 100;

// English section/container titles that hold tracks. Localization is an open
// plan item (mirrors SearchService's GROUP_TITLE_TO_TYPE / PlaybackService's
// PLAY_LABELS caveat): non-English Cores need locale-aware matching here.
const TRACK_SECTION_LABELS = ["top tracks", "tracks", "popular", "songs"];

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** A selectable, navigable leaf (not a header or action). */
function isTrackLeaf(item: BrowseItem): boolean {
  return (
    Boolean(item.item_key) &&
    item.hint !== "header" &&
    item.hint !== "action" &&
    item.hint !== "action_list"
  );
}

/**
 * True when the opened item is itself a single playable leaf: drilling into a
 * track yields its action menu (Play Now, Queue, …) rather than a child list.
 */
function looksLikeActionList(list: BrowseList | undefined, items: BrowseItem[]): boolean {
  if (list?.hint === "action_list") return true;
  const selectable = items.filter((i) => i.item_key && i.hint !== "header");
  return selectable.length > 0 && selectable.every((i) => i.hint === "action");
}

/** Roon track subtitles are typically the artist (sometimes "Artist / Album"). */
function toTrack(item: BrowseItem): TrackCandidate {
  const artist = item.subtitle?.split(" / ")[0]?.trim() || undefined;
  // Duration is not exposed in browse item metadata, so it stays undefined.
  return { itemKey: item.item_key!, title: item.title, artist, available: true };
}

/** Expands a browse item (artist/album/genre/playlist/track) into tracks. */
export class TrackExpansionService {
  constructor(private readonly browse: BrowseSessionManager) {}

  async getTracksFor(input: GetTracksForInput): Promise<GetTracksForOutput> {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    return this.browse.runExclusive(async () => {
      try {
        return await this.expand(input.itemKey, limit);
      } catch (err) {
        // A stale/invalid key can't be retried against the same key; report it
        // as skipped so the agent can re-search instead of throwing.
        if (err instanceof RoonMcpError && err.code === "INVALID_ITEM_KEY") {
          return {
            sourceItemKey: input.itemKey,
            tracks: [],
            skipped: [{ itemKey: input.itemKey, reason: err.message }],
          };
        }
        throw err;
      }
    });
  }

  private async expand(itemKey: string, limit: number): Promise<GetTracksForOutput> {
    const opened = await this.browse.browse({ hierarchy: EXPAND_HIERARCHY, item_key: itemKey });
    if (opened.action === "message") {
      return notExpandable(itemKey, opened.message);
    }

    const loaded = await this.browse.load({
      hierarchy: EXPAND_HIERARCHY,
      offset: 0,
      count: SCAN_COUNT,
    });

    // Case A: the item is itself a single playable track (its children are the
    // action menu). Represent it as one track, keyed by the original key.
    if (looksLikeActionList(loaded.list, loaded.items)) {
      const title = opened.item?.title ?? loaded.list?.title ?? "Unknown track";
      return { sourceItemKey: itemKey, tracks: [{ itemKey, title, available: true }], skipped: [] };
    }

    // Case B: track items directly under the item (album track list, playlist
    // entries, a genre's track list).
    const direct = this.extractTracks(loaded.items, limit);
    if (direct.length > 0) {
      return { sourceItemKey: itemKey, tracks: direct, skipped: [] };
    }

    // Case C: drill one level into a track container (an artist's "Top Tracks",
    // or — as a last resort — the first navigable child, e.g. a top album).
    const container = this.findTrackContainer(loaded.items);
    if (container) {
      await this.browse.browse({ hierarchy: EXPAND_HIERARCHY, item_key: container.item_key! });
      const sub = await this.browse.load({
        hierarchy: EXPAND_HIERARCHY,
        offset: 0,
        count: SCAN_COUNT,
      });
      const tracks = this.extractTracks(sub.items, limit);
      if (tracks.length > 0) {
        return { sourceItemKey: itemKey, tracks, skipped: [] };
      }
    }

    return notExpandable(itemKey, "No playable tracks were found for this item.");
  }

  /**
   * Pull track candidates out of a loaded list. When the list is split into
   * header sections, prefer a "Top Tracks"/"Tracks" section. When there are no
   * headers at all, treat the children as tracks (correct for album/playlist
   * track lists). When several sections exist but none is clearly a track
   * section, return nothing rather than guess albums as tracks — the caller
   * then drills via findTrackContainer.
   */
  private extractTracks(items: BrowseItem[], limit: number): TrackCandidate[] {
    const sections = splitByHeaders(items);
    const trackSection = sections.find(
      (s) => s.header && TRACK_SECTION_LABELS.some((l) => normalize(s.header!).startsWith(l)),
    );
    const chosen = trackSection ?? (sections.length === 1 ? sections[0] : undefined);
    if (!chosen) return [];

    const out: TrackCandidate[] = [];
    for (const item of chosen.items) {
      if (!isTrackLeaf(item)) continue;
      out.push(toTrack(item));
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Find a child to drill into for tracks: a "Top Tracks"-like list, else the first leaf. */
  private findTrackContainer(items: BrowseItem[]): BrowseItem | null {
    const navigable = items.filter(isTrackLeaf);
    for (const label of TRACK_SECTION_LABELS) {
      const hit = navigable.find((c) => normalize(c.title).startsWith(label));
      if (hit) return hit;
    }
    return navigable[0] ?? null;
  }
}

function splitByHeaders(items: BrowseItem[]): Array<{ header?: string; items: BrowseItem[] }> {
  const sections: Array<{ header?: string; items: BrowseItem[] }> = [];
  let current: { header?: string; items: BrowseItem[] } = { items: [] };
  for (const item of items) {
    if (item.hint === "header") {
      if (current.header !== undefined || current.items.length > 0) sections.push(current);
      current = { header: item.title, items: [] };
    } else {
      current.items.push(item);
    }
  }
  if (current.header !== undefined || current.items.length > 0) sections.push(current);
  return sections;
}

function notExpandable(itemKey: string, reason?: string): GetTracksForOutput {
  return {
    sourceItemKey: itemKey,
    tracks: [],
    skipped: [{ itemKey, reason: `NOT_EXPANDABLE: ${reason ?? "item cannot be expanded into tracks."}` }],
  };
}
