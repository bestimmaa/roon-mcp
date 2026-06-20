import type { BrowseItem, BrowseList, BrowseResultBody } from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { encodeLocator, withTrackIndex, type Locator } from "./locator.js";
import { SearchNavigator, SEARCH_HIERARCHY, requireLocator } from "./SearchNavigator.js";
import {
  RoonMcpError,
  type GetTracksForInput,
  type GetTracksForOutput,
  type TrackCandidate,
} from "./types.js";

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
function toTrackMeta(item: BrowseItem): Pick<TrackCandidate, "title" | "artist"> {
  const artist = item.subtitle?.split(" / ")[0]?.trim() || undefined;
  return { title: item.title, artist };
}

/**
 * Outcome of resolving an opened search item to its tracks. `self` means the
 * item is itself one playable track; `list` carries the ordered track items
 * with the session left positioned at the list that holds them (so their keys
 * are live for an immediate browse-into).
 */
type TrackResolution =
  | { kind: "self"; title: string }
  | { kind: "list"; items: BrowseItem[] }
  | { kind: "none"; reason: string };

/** Expands a search candidate (artist/album/genre/playlist/track) into tracks. */
export class TrackExpansionService {
  private readonly navigator: SearchNavigator;

  constructor(private readonly browse: BrowseSessionManager) {
    this.navigator = new SearchNavigator(browse);
  }

  async getTracksFor(input: GetTracksForInput): Promise<GetTracksForOutput> {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const loc = requireLocator(input.itemKey);

    return this.browse.runExclusive(async () => {
      try {
        const opened = await this.navigator.openItem(loc);
        if (opened.action === "message") return notExpandable(input.itemKey, opened.message);

        const resolved = await this.resolveTracks(opened);
        if (resolved.kind === "none") return notExpandable(input.itemKey, resolved.reason);
        if (resolved.kind === "self") {
          // The candidate is a single track; key it by its own (t-less) locator.
          return {
            sourceItemKey: input.itemKey,
            tracks: [{ itemKey: input.itemKey, title: resolved.title, available: true }],
            skipped: [],
          };
        }

        const tracks: TrackCandidate[] = resolved.items.slice(0, limit).map((item, t) => ({
          itemKey: encodeLocator(withTrackIndex(loc, t)),
          ...toTrackMeta(item),
          available: true,
        }));
        return { sourceItemKey: input.itemKey, tracks, skipped: [] };
      } catch (err) {
        // A stale/invalid locator can't be retried; report it as skipped so the
        // agent can re-search instead of throwing.
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

  /**
   * Navigate to a single track for playback and browse *into* it, returning its
   * action menu. For a track locator (`t` set) this re-derives the same ordered
   * track list `get_tracks_for` produced and opens entry `t`. Compose inside
   * `runExclusive`. Throws INVALID_ITEM_KEY if the track no longer resolves.
   */
  async openTrackForPlayback(loc: Locator): Promise<BrowseResultBody> {
    const opened = await this.navigator.openItem(loc);
    if (loc.t === undefined) return opened; // candidate is itself the track
    if (opened.action === "message") {
      throw new RoonMcpError("INVALID_ITEM_KEY", opened.message ?? "Track is no longer available.");
    }

    const resolved = await this.resolveTracks(opened);
    if (resolved.kind !== "list" || !resolved.items[loc.t]?.item_key) {
      throw new RoonMcpError(
        "INVALID_ITEM_KEY",
        "That track is no longer available; re-run get_tracks_for to refresh it.",
      );
    }
    return this.browse.browse({
      hierarchy: SEARCH_HIERARCHY,
      item_key: resolved.items[loc.t]!.item_key!,
    });
  }

  /**
   * Classify an opened item and locate its tracks. Leaves the session at the
   * track list for the `list` case. Mirrors the three shapes Roon returns:
   *   A. a single playable track (children are its action menu)
   *   B. tracks directly under the item (album/playlist track list)
   *   C. tracks one level down a "Top Tracks"-style container (artist page)
   */
  private async resolveTracks(opened: BrowseResultBody): Promise<TrackResolution> {
    const loaded = await this.browse.load({
      hierarchy: SEARCH_HIERARCHY,
      offset: 0,
      count: SCAN_COUNT,
    });

    if (looksLikeActionList(loaded.list, loaded.items)) {
      return { kind: "self", title: opened.item?.title ?? loaded.list?.title ?? "Unknown track" };
    }

    const direct = this.extractTracks(loaded.items);
    if (direct.length > 0) return { kind: "list", items: direct };

    const container = this.findTrackContainer(loaded.items);
    if (container?.item_key) {
      await this.browse.browse({ hierarchy: SEARCH_HIERARCHY, item_key: container.item_key });
      const sub = await this.browse.load({
        hierarchy: SEARCH_HIERARCHY,
        offset: 0,
        count: SCAN_COUNT,
      });
      const tracks = this.extractTracks(sub.items);
      if (tracks.length > 0) return { kind: "list", items: tracks };
    }

    return { kind: "none", reason: "No playable tracks were found for this item." };
  }

  /**
   * Pull ordered track items out of a loaded list. When the list is split into
   * header sections, prefer a "Top Tracks"/"Tracks" section. When there are no
   * headers at all, treat the children as tracks (correct for album/playlist
   * track lists). When several sections exist but none is clearly a track
   * section, return nothing rather than guess albums as tracks — the caller
   * then drills via findTrackContainer.
   */
  private extractTracks(items: BrowseItem[]): BrowseItem[] {
    const sections = splitByHeaders(items);
    const trackSection = sections.find(
      (s) => s.header && TRACK_SECTION_LABELS.some((l) => normalize(s.header!).startsWith(l)),
    );
    const chosen = trackSection ?? (sections.length === 1 ? sections[0] : undefined);
    if (!chosen) return [];
    return chosen.items.filter(isTrackLeaf);
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
