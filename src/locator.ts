import type { BrowseHierarchy } from "node-roon-api-browse";

// Roon browse item keys are *level-scoped*: the Core invalidates them as soon
// as you pop out of the list they belong to. `search_music` has to drill into
// several result groups (Artists, Albums, …) and pop back between them, so by
// the time it returns, every raw key it collected is already dead — unusable by
// a later `play_now` / `get_tracks_for` / `enqueue_and_play` call.
//
// To make the keys durable across MCP calls we hand back a *locator* instead: a
// self-describing token that records how to re-reach the item. Playback/
// expansion decode it and re-navigate from scratch in one uninterrupted browse
// session, where the live keys are valid at the moment they're used. This trades
// a re-navigation per action for correctness, and removes any dependence on
// fragile server-side session state.
//
// Two locator shapes exist:
//   - a *search* locator re-reached via the flat `search` hierarchy (a query
//     plus the indices to drill);
//   - a *genre* locator re-reached via the dedicated `genres` hierarchy (a path
//     of genre node titles to drill from the root). Genres don't appear in the
//     flat search, so they need their own navigation path (see GenreService).

const PREFIX = "rl1:";

/**
 * A path back to a flat-search result:
 *   q  search query that produced the result
 *   g  index into the (selectable) top-level search groups
 *   i  index into that group's (selectable) child items
 *   t  optional index into the ordered tracks expanded from item (g,i)
 */
export interface SearchLocator {
  q: string;
  g: number;
  i: number;
  t?: number;
}

/**
 * A path back to a genre node in the `genres` hierarchy:
 *   ge  ordered genre node titles from the root, e.g.
 *       ["Electronic", "Trance", "Psytrance"]
 *   t   optional index into the ordered tracks expanded from the genre
 */
export interface GenreLocator {
  ge: string[];
  t?: number;
}

export type Locator = SearchLocator | GenreLocator;

/** True for a genre locator (re-navigated via the `genres` hierarchy). */
export function isGenreLocator(loc: Locator): loc is GenreLocator {
  return Array.isArray((loc as GenreLocator).ge);
}

/** Which browse hierarchy a locator is re-navigated in. */
export function hierarchyForLocator(loc: Locator): BrowseHierarchy {
  return isGenreLocator(loc) ? "genres" : "search";
}

function encode(value: Locator): string {
  const json = JSON.stringify(value);
  return PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Encode a locator as an opaque token suitable for an MCP itemKey. Accepts
 * either shape so callers re-encoding a possibly-genre locator (e.g. adding a
 * track index) don't have to branch; `encodeGenreLocator` is a convenience for
 * building genre locators from a path.
 */
export function encodeLocator(loc: Locator): string {
  return encode(loc);
}

/** Encode a genre locator (a path of genre node titles) as an opaque token. */
export function encodeGenreLocator(path: string[], t?: number): string {
  const loc: GenreLocator = t === undefined ? { ge: path } : { ge: path, t };
  return encode(loc);
}

/** Decode a locator token, or return null if it isn't one (e.g. a raw key). */
export function decodeLocator(token: string): Locator | null {
  if (!token.startsWith(PREFIX)) return null;
  try {
    const json = Buffer.from(token.slice(PREFIX.length), "base64url").toString("utf8");
    const obj = JSON.parse(json) as Partial<SearchLocator & GenreLocator>;

    // Genre locator: a path of node titles.
    if (Array.isArray(obj.ge) && obj.ge.every((s) => typeof s === "string")) {
      const loc: GenreLocator = { ge: obj.ge };
      if (typeof obj.t === "number") loc.t = obj.t;
      return loc;
    }

    // Search locator: query + group/item indices.
    if (typeof obj.q === "string" && typeof obj.g === "number" && typeof obj.i === "number") {
      const loc: SearchLocator = { q: obj.q, g: obj.g, i: obj.i };
      if (typeof obj.t === "number") loc.t = obj.t;
      return loc;
    }

    return null;
  } catch {
    return null;
  }
}

/** Derive a track locator by extending an item locator with a track index. */
export function withTrackIndex(loc: Locator, t: number): Locator {
  return isGenreLocator(loc) ? { ge: loc.ge, t } : { q: loc.q, g: loc.g, i: loc.i, t };
}
