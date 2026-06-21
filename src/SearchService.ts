import type { BrowseItem } from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { GenreService } from "./GenreService.js";
import { encodeLocator } from "./locator.js";
import { SEARCH_HIERARCHY, isSelectable } from "./SearchNavigator.js";
import { TrackExpansionService } from "./TrackExpansionService.js";
import {
  RoonMcpError,
  type MusicCandidate,
  type MusicItemType,
  type SearchMusicInput,
  type SearchMusicOutput,
} from "./types.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const GROUP_SCAN_COUNT = 50;
// Ensures a candidate of the requested type always outranks any other type,
// so "exact type matches" sort before broader matches.
const TYPE_BOOST = 1.0;

// English Roon search category titles → our item type.
const GROUP_TITLE_TO_TYPE: Record<string, MusicItemType> = {
  artists: "artist",
  albums: "album",
  tracks: "track",
  genres: "genre",
  playlists: "playlist",
  stations: "radio",
  "internet radio": "radio",
};

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** Strip a trailing count, e.g. "Albums (12)" → "albums". */
function groupTitleToType(title: string): MusicItemType {
  const cleaned = normalize(title).replace(/\s*\(\d+\)\s*$/, "");
  return GROUP_TITLE_TO_TYPE[cleaned] ?? "unknown";
}

/** Turns a text query into ranked browse candidates via the search hierarchy. */
export class SearchService {
  constructor(
    private readonly browse: BrowseSessionManager,
    private readonly genres: GenreService,
    private readonly tracks: TrackExpansionService,
  ) {}

  async searchMusic(input: SearchMusicInput): Promise<SearchMusicOutput> {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    // Genres don't appear in Roon's flat search; resolve them via the dedicated
    // `genres` hierarchy instead (GenreService), and never silently broaden to
    // artists/albums — that hid the failure before.
    if (input.type === "genre") {
      return this.searchGenres(input.query, limit, input.includeStreaming);
    }

    // Search builds its own item keys inside performSearch, so a stale-session
    // failure is recoverable with one reset-and-replay (see runExclusiveWithRetry).
    return this.browse.runExclusiveWithRetry(() => this.performSearch(input, limit));
  }

  private async searchGenres(
    query: string,
    limit: number,
    includeStreaming?: boolean,
  ): Promise<SearchMusicOutput> {
    const libraryGenres = await this.genres.searchGenres(query, limit);

    let streamingTracks: MusicCandidate[] = [];
    if (includeStreaming) {
      streamingTracks = await this.collectStreamingGenreTracks(query, limit);
    }

    const candidates = [...libraryGenres, ...streamingTracks];

    let message: string | undefined;
    if (candidates.length === 0) {
      message = `No results for "${query}".`;
    } else if (libraryGenres.length === 0) {
      message = `No library genres matched "${query}"; showing streaming tracks.`;
    } else if ((libraryGenres[0]?.score ?? 0) < 1) {
      const suffix = includeStreaming ? "; also showing streaming tracks" : "";
      message = `No genre exactly named "${query}"; showing nearest genres${suffix}.`;
    }
    return { query, candidates, broadened: false, message };
  }

  /**
   * Genre discovery beyond the library. Roon's flat search is text-based, not
   * genre-filtered, so a raw "tracks" search for a genre name returns noise
   * (tracks with the word in their title). Instead we take the genre-relevant
   * albums the flat search surfaces (album/artist metadata makes those genuinely
   * on-genre) and sample a few tracks across them — the same spread-across-albums
   * approach get_tracks_for uses for library genres — yielding a real cross-album
   * mix rather than whole albums. Each expansion re-navigates the flat search; an
   * opt-in cost we accept for the streaming path.
   */
  private async collectStreamingGenreTracks(
    query: string,
    limit: number,
  ): Promise<MusicCandidate[]> {
    const albumSearch = await this.browse.runExclusiveWithRetry(() =>
      this.performSearch({ query, type: "album" }, limit),
    );
    const albums = albumSearch.candidates.filter((c) => c.type === "album");
    if (albums.length === 0) return [];

    // Spread the budget so the mix draws from several albums, not just the first.
    const perAlbum = Math.max(1, Math.ceil(limit / Math.min(albums.length, limit)));

    const out: MusicCandidate[] = [];
    for (const album of albums) {
      if (out.length >= limit) break;
      const expanded = await this.tracks.getTracksFor({ itemKey: album.itemKey, limit: perAlbum });
      for (const track of expanded.tracks) {
        if (out.length >= limit) break;
        out.push({
          itemKey: track.itemKey,
          title: track.title,
          subtitle: track.artist ?? album.title,
          type: "track",
          // Inherit the album's relevance so on-genre albums sort their tracks up.
          score: album.score,
          available: track.available,
          sourceGroup: "Streaming",
        });
      }
    }
    return out;
  }

  private async performSearch(
    input: SearchMusicInput,
    limit: number,
  ): Promise<SearchMusicOutput> {
    // Roon only registers the search when `input` and `pop_all` ride in the
    // same browse call; submitting `input` after a separate reset yields a
    // "No Results" placeholder. Keep them together.
    const submitted = await this.browse.browse({
      hierarchy: SEARCH_HIERARCHY,
      input: input.query,
      pop_all: true,
    });
    if (submitted.action === "message") {
      return {
        query: input.query,
        candidates: [],
        broadened: false,
        message: submitted.message ?? "Search returned no results.",
      };
    }

    const groupsLoad = await this.browse.load({
      hierarchy: SEARCH_HIERARCHY,
      offset: 0,
      count: GROUP_SCAN_COUNT,
    });
    const groups = groupsLoad.items.filter(isSelectable);
    if (groups.length === 0) {
      return { query: input.query, candidates: [], broadened: false, message: "No results." };
    }

    let broadened = false;
    let candidates = await this.collectFromGroups(
      input.query,
      groups,
      this.selectGroupIndices(groups, input.type),
      limit,
    );

    // If a typed search came back empty, broaden to all categories.
    if (candidates.length === 0 && input.type) {
      broadened = true;
      candidates = await this.collectFromGroups(
        input.query,
        groups,
        groups.map((_, idx) => idx),
        limit,
      );
    }

    const ranked = this.rankCandidates(candidates, input.query, input.type).slice(0, limit);

    let message: string | undefined;
    if (broadened) {
      message = `No "${input.type}" matches; broadened to all categories.`;
    } else if (ranked.length === 0) {
      message = "No results.";
    }

    return { query: input.query, candidates: ranked, broadened, message };
  }

  /** Indices (into the top-level group list) to scan for the requested type. */
  private selectGroupIndices(groups: BrowseItem[], type?: MusicItemType): number[] {
    const all = groups.map((_, idx) => idx);
    if (!type) return all;
    return all.filter((idx) => groupTitleToType(groups[idx]!.title) === type);
  }

  private async collectFromGroups(
    query: string,
    groups: BrowseItem[],
    indices: number[],
    limit: number,
  ): Promise<MusicCandidate[]> {
    const out: MusicCandidate[] = [];
    for (const g of indices) {
      const group = groups[g]!;
      const type = groupTitleToType(group.title);
      try {
        const nav = await this.browse.browse({ hierarchy: SEARCH_HIERARCHY, item_key: group.item_key });
        // action:"none" means Roon didn't push a new level (e.g. a "No Results"
        // placeholder item) — nothing to load and nothing to pop.
        if (nav.action !== "list") continue;
        const loaded = await this.browse.load({
          hierarchy: SEARCH_HIERARCHY,
          offset: 0,
          count: limit,
        });
        // Encode each candidate as a locator (query + group index + item index)
        // rather than the raw Roon key: the raw key dies when we pop back below,
        // whereas a locator lets playback re-navigate to a live key later. The
        // item index is into the *selectable* children so it matches what
        // SearchNavigator re-derives.
        const children = loaded.items.filter(isSelectable);
        children.forEach((item, i) => {
          out.push({
            itemKey: encodeLocator({ q: query, g, i }),
            title: item.title,
            subtitle: item.subtitle,
            type,
            score: 0,
            available: true,
            sourceGroup: group.title,
          });
        });
        // item_keys are level-scoped: pop back to the group list before the
        // next group so its keys stay valid.
        await this.browse.browse({ hierarchy: SEARCH_HIERARCHY, pop_levels: 1 });
      } catch (err) {
        // A single bad group shouldn't sink the whole search.
        if (err instanceof RoonMcpError && err.code === "INVALID_ITEM_KEY") continue;
        throw err;
      }
    }
    return out;
  }

  private rankCandidates(
    candidates: MusicCandidate[],
    query: string,
    type?: MusicItemType,
  ): MusicCandidate[] {
    const q = normalize(query);
    for (const c of candidates) c.score = scoreCandidate(c, q, type);
    return [...candidates].sort((a, b) => b.score - a.score);
  }
}

function scoreCandidate(c: MusicCandidate, q: string, type?: MusicItemType): number {
  const title = normalize(c.title);
  let score: number;
  if (title === q) score = 1.0;
  else if (title.startsWith(q)) score = 0.7;
  else if (title.includes(q)) score = 0.5;
  else score = tokenOverlap(title, q) * 0.4 + 0.05;

  if (type && c.type === type) score += TYPE_BOOST;
  return Number(score.toFixed(4));
}

function tokenOverlap(title: string, query: string): number {
  const titleTokens = new Set(title.split(/\s+/).filter(Boolean));
  const queryTokens = query.split(/\s+/).filter(Boolean);
  if (queryTokens.length === 0) return 0;
  const hits = queryTokens.filter((t) => titleTokens.has(t)).length;
  return hits / queryTokens.length;
}
