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
// How long the cached genre index stays fresh before a rebuild picks up
// library genre edits. Long enough to amortize the tree walk across a typical
// search session, short enough not to serve a stale tree indefinitely (#18).
export const INDEX_TTL_MS = 10 * 60 * 1000;

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

// Connector words carry no genre signal; dropping them keeps coverage fair
// (e.g. "Drum and Bass" is two meaningful tokens, not three).
const STOPWORDS = new Set(["and", "the", "of", "an"]);
// Tokens shorter than this are ignored for fuzzy (substring/prefix) matching:
// 1–2 char tokens like R&B's "r"/"b" or the "n" in "Drum'n'Bass" otherwise
// match almost anything and flood results with false positives.
const MIN_TOKEN_LEN = 3;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Query tokens worth scoring: long enough to be meaningful, not stopwords. */
function meaningfulTokens(text: string): string[] {
  const all = tokens(text);
  const kept = all.filter((tok) => tok.length >= MIN_TOKEN_LEN && !STOPWORDS.has(tok));
  return kept.length > 0 ? kept : all; // never wipe out an all-short query
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

// Token-overlap scores are scaled below the exact/collapsed tiers so a genuine
// node always outranks a partial match, while a full token-coverage match still
// scores well (≈0.85).
const TOKEN_WEIGHT = 0.85;
// Candidates below this are treated as noise (an absent genre), not a match.
// Tuned so a single shared word out of two query tokens (≈0.43) still surfaces
// as a "nearest", but a lone short/prefix coincidence does not.
export const MIN_GENRE_SCORE = 0.4;

/** Fuzzy match of a free-text query to a genre node title; 0 = no match. */
export function scoreGenre(query: string, title: string): number {
  const q = normalize(query);
  const t = normalize(title);
  if (t === q) return 1.0;
  if (collapse(query) === collapse(title)) return 0.95;

  // Per-query-token best overlap with the title's tokens. No blanket
  // prefix-of-the-whole-string tier: that gave a partial like "Psychedelic"
  // (covering only the first word of "Psychedelic Trance") an undeserved 0.8,
  // outranking the better "Psytrance".
  const qTokens = meaningfulTokens(query);
  const tTokens = tokens(title);
  if (qTokens.length === 0 || tTokens.length === 0) return 0;

  let sum = 0;
  for (const qt of qTokens) {
    let best = 0;
    for (const tt of tTokens) {
      if (qt === tt) {
        best = 1;
        break;
      }
      // Only meaningful (≥3 char) title tokens may fuzzy-match, so short tokens
      // like "r"/"b"/"n" can't spuriously match.
      if (tt.length >= MIN_TOKEN_LEN) {
        if (tt.includes(qt) || qt.includes(tt)) best = Math.max(best, 0.7);
        else if (sharedPrefixLen(qt, tt) >= 3) best = Math.max(best, 0.4);
      }
    }
    sum += best;
  }
  return (sum / qTokens.length) * TOKEN_WEIGHT;
}

/** Resolves genre queries by walking and caching the `genres` hierarchy tree. */
export class GenreService {
  private index?: Promise<GenreEntry[]>;
  /**
   * Wall-clock time (ms since epoch) the current index was started. Used to
   * expire the cache so genre edits in Roon (added/removed/renamed genres)
   * are picked up instead of serving a stale tree for the whole session
   * (issue #18). Set optimistically when a build begins so concurrent callers
   * reuse the in-flight build rather than racing a second one.
   */
  private indexedAt = 0;

  constructor(private readonly browse: BrowseSessionManager) {}

  /** Ranked genre candidates for a query (nearest real nodes first). */
  async searchGenres(query: string, limit: number): Promise<MusicCandidate[]> {
    const index = await this.getIndex();
    return index
      .map((entry) => ({ entry, score: scoreGenre(query, entry.title) }))
      .filter((s) => s.score >= MIN_GENRE_SCORE)
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

  /**
   * Build the index once and reuse it until {@link INDEX_TTL_MS} elapses, then
   * rebuild on the next call so library genre changes surface. A failed build
   * clears the cache so the next call retries. The clock is indirected via
   * {@link now} so tests can drive TTL expiry deterministically.
   */
  private getIndex(): Promise<GenreEntry[]> {
    const now = this.now();
    const fresh = this.index !== undefined && now - this.indexedAt <= INDEX_TTL_MS;
    if (!fresh) {
      // Mark in-flight so concurrent callers reuse this build, not start another.
      this.indexedAt = now;
      this.index = this.buildIndex()
        .then((entries) => {
          this.indexedAt = this.now(); // refresh to completion time
          return entries;
        })
        .catch((err) => {
          this.index = undefined; // let a later call retry a failed walk
          this.indexedAt = 0;
          throw err;
        });
    }
    return this.index!;
  }

  /** Wall clock, in ms. Indirected so tests can drive expiry deterministically. */
  protected now(): number {
    return Date.now();
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
