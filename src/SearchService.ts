import type { BrowseItem } from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
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

function isSelectable(item: BrowseItem): boolean {
  return Boolean(item.item_key) && item.hint !== "header";
}

/** Turns a text query into ranked browse candidates via the search hierarchy. */
export class SearchService {
  constructor(private readonly browse: BrowseSessionManager) {}

  async searchMusic(input: SearchMusicInput): Promise<SearchMusicOutput> {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    return this.browse.runExclusive(async () => {
      try {
        return await this.performSearch(input, limit);
      } catch (err) {
        // Stale session / invalid key: reset the hierarchy and retry once.
        if (err instanceof RoonMcpError && err.code === "INVALID_ITEM_KEY") {
          await this.browse.resetSearchHierarchy();
          return this.performSearch(input, limit);
        }
        throw err;
      }
    });
  }

  private async performSearch(
    input: SearchMusicInput,
    limit: number,
  ): Promise<SearchMusicOutput> {
    await this.browse.resetSearchHierarchy();

    const submitted = await this.browse.browse({
      hierarchy: "search",
      input: input.query,
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
      hierarchy: "search",
      offset: 0,
      count: GROUP_SCAN_COUNT,
    });
    const groups = groupsLoad.items.filter(isSelectable);
    if (groups.length === 0) {
      return { query: input.query, candidates: [], broadened: false, message: "No results." };
    }

    let broadened = false;
    let candidates = await this.collectFromGroups(this.selectGroups(groups, input.type), limit);

    // If a typed search came back empty, broaden to all categories.
    if (candidates.length === 0 && input.type) {
      broadened = true;
      candidates = await this.collectFromGroups(groups, limit);
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

  private selectGroups(groups: BrowseItem[], type?: MusicItemType): BrowseItem[] {
    if (!type) return groups;
    const matching = groups.filter((g) => groupTitleToType(g.title) === type);
    return matching.length > 0 ? matching : [];
  }

  private async collectFromGroups(
    groups: BrowseItem[],
    limit: number,
  ): Promise<MusicCandidate[]> {
    const out: MusicCandidate[] = [];
    for (const group of groups) {
      const type = groupTitleToType(group.title);
      try {
        await this.browse.browse({ hierarchy: "search", item_key: group.item_key });
        const loaded = await this.browse.load({
          hierarchy: "search",
          offset: 0,
          count: limit,
        });
        for (const item of loaded.items) {
          if (!isSelectable(item)) continue;
          out.push({
            itemKey: item.item_key!,
            title: item.title,
            subtitle: item.subtitle,
            type,
            score: 0,
            available: true,
            sourceGroup: group.title,
          });
        }
      } catch (err) {
        // A single bad group shouldn't sink the whole search.
        if (err instanceof RoonMcpError && err.code === "INVALID_ITEM_KEY") continue;
        throw err;
      } finally {
        // item_keys are level-scoped: pop back to the group list before the
        // next group so its keys stay valid.
        await this.browse.browse({ hierarchy: "search", pop_levels: 1 });
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
