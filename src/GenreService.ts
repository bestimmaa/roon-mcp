import type { BrowseItem } from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { encodeGenreLocator } from "./locator.js";
import type { MusicCandidate } from "./types.js";

// Roon's flat `search` hierarchy doesn't expose genres; they live in a dedicated
// `genres` hierarchy as a shallow tree (root parents → sub-genres →
// sub-sub-genres). We walk that tree once, cache a flat name→path index for the
// session, and resolve a genre query against it with fuzzy scoring — so
// "Psychedelic Trance" (which has no exact node) surfaces the real nearby nodes
// "Psytrance" and "Trance" as ranked candidates.

// The tree is shallow in practice (parent → sub → sub-sub). Cap the walk so a
// pathological library can't make the first genre search run unbounded.
const MAX_DEPTH = 3;
// Load generously; genre lists run to a few dozen entries (Electronic had 38).
const SCAN_COUNT = 200;

// English container labels that sit inside a genre page alongside its
// sub-genres. They are NOT genres themselves, so the walk skips them. Same
// English-Core caveat as SearchService.GROUP_TITLE_TO_TYPE and
// PlaybackService.PLAY_LABELS.
const CONTAINER_LABELS = new Set(["artists", "albums"]);

interface GenreEntry {
  /** Genre node titles from the root, e.g. ["Electronic", "Trance", "Psytrance"]. */
  path: string[];
  title: string;
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** Lowercased alphanumerics only — collapses "Psy-Trance"/"Psy Trance" alike. */
function collapse(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function sharedPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * A genre node in a `genres` page: a `list` row that isn't an "Artists"/"Albums"
 * container. Real genre rows carry a "N Artists, M Albums" subtitle, which the
 * containers lack — we use that as the positive signal, and the label set as a
 * belt-and-braces guard.
 */
function isGenreNode(item: BrowseItem): boolean {
  if (!item.item_key || item.hint !== "list") return false;
  if (CONTAINER_LABELS.has(normalize(item.title))) return false;
  return /\d+\s+artist/i.test(item.subtitle ?? "");
}

/** Fuzzy match of a free-text query to a genre node title; 0 = no match. */
export function scoreGenre(query: string, title: string): number {
  const q = normalize(query);
  const t = normalize(title);
  if (t === q) return 1.0;
  if (collapse(query) === collapse(title)) return 0.95;
  if (t.startsWith(q) || q.startsWith(t)) return 0.8;

  const qTokens = tokens(query);
  const tTokens = tokens(title);
  if (qTokens.length === 0 || tTokens.length === 0) return 0;

  let sum = 0;
  for (const qt of qTokens) {
    let best = 0;
    for (const tt of tTokens) {
      if (qt === tt) best = Math.max(best, 1);
      else if (tt.includes(qt) || qt.includes(tt)) best = Math.max(best, 0.7);
      else if (sharedPrefixLen(qt, tt) >= 3) best = Math.max(best, 0.4);
    }
    sum += best;
  }
  // Scale token matches below the structural tiers above so an exact/prefix
  // node always outranks a mere token overlap.
  return (sum / qTokens.length) * 0.7;
}

/** Resolves genre queries by walking and caching the `genres` hierarchy tree. */
export class GenreService {
  private index?: Promise<GenreEntry[]>;

  constructor(private readonly browse: BrowseSessionManager) {}

  /** Ranked genre candidates for a query (nearest real nodes first). */
  async searchGenres(query: string, limit: number): Promise<MusicCandidate[]> {
    const index = await this.getIndex();
    return index
      .map((entry) => ({ entry, score: scoreGenre(query, entry.title) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry, score }) => ({
        itemKey: encodeGenreLocator(entry.path),
        title: entry.title,
        subtitle: entry.path.join(" › "),
        type: "genre" as const,
        score: Number(score.toFixed(4)),
        available: true,
        sourceGroup: "Genres",
      }));
  }

  /** Build the index once per session; rebuild only if the build failed. */
  private getIndex(): Promise<GenreEntry[]> {
    if (!this.index) {
      this.index = this.buildIndex().catch((err) => {
        this.index = undefined; // let a later call retry a failed walk
        throw err;
      });
    }
    return this.index;
  }

  private buildIndex(): Promise<GenreEntry[]> {
    // The whole DFS runs in one exclusive session so the level-scoped browse
    // keys stay live as we drill and pop. Item keys at a level survive drilling
    // and popping a sibling (same pattern as SearchService.collectFromGroups).
    return this.browse.runExclusive(async () => {
      const entries: GenreEntry[] = [];
      await this.browse.browse({ hierarchy: "genres", pop_all: true });
      await this.walk([], entries, 0);
      return entries;
    });
  }

  /**
   * Depth-first walk of the level the session is currently positioned at.
   * Records each genre node and drills it (until MAX_DEPTH), popping back so the
   * parent's keys stay valid for the next sibling.
   */
  private async walk(path: string[], entries: GenreEntry[], depth: number): Promise<void> {
    const loaded = await this.browse.load({ hierarchy: "genres", offset: 0, count: SCAN_COUNT });
    const nodes = loaded.items.filter(isGenreNode);

    for (const node of nodes) {
      const childPath = [...path, node.title];
      entries.push({ path: childPath, title: node.title });
      if (depth + 1 >= MAX_DEPTH) continue;

      const into = await this.browse.browse({ hierarchy: "genres", item_key: node.item_key! });
      if (into.action !== "list") continue;
      await this.walk(childPath, entries, depth + 1);
      // Level-scoped keys: pop back to this level before the next sibling.
      await this.browse.browse({ hierarchy: "genres", pop_levels: 1 });
    }
  }
}
