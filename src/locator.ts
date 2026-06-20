// Roon browse item keys are *level-scoped*: the Core invalidates them as soon
// as you pop out of the list they belong to. `search_music` has to drill into
// several result groups (Artists, Albums, …) and pop back between them, so by
// the time it returns, every raw key it collected is already dead — unusable by
// a later `play_now` / `get_tracks_for` / `enqueue_and_play` call.
//
// To make the keys durable across MCP calls we hand back a *locator* instead: a
// self-describing token that records how to re-reach the item (the search query
// plus the indices to drill). Playback/expansion decode it and re-navigate from
// a fresh search in one uninterrupted browse session, where the live keys are
// valid at the moment they're used. This trades a re-search per action for
// correctness, and removes any dependence on fragile server-side session state.

const PREFIX = "rl1:";

/**
 * A path back to a search result:
 *   q  search query that produced the result
 *   g  index into the (selectable) top-level search groups
 *   i  index into that group's (selectable) child items
 *   t  optional index into the ordered tracks expanded from item (g,i)
 */
export interface Locator {
  q: string;
  g: number;
  i: number;
  t?: number;
}

/** Encode a locator as an opaque token suitable for an MCP itemKey field. */
export function encodeLocator(loc: Locator): string {
  const json = JSON.stringify(loc);
  return PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

/** Decode a locator token, or return null if it isn't one (e.g. a raw key). */
export function decodeLocator(token: string): Locator | null {
  if (!token.startsWith(PREFIX)) return null;
  try {
    const json = Buffer.from(token.slice(PREFIX.length), "base64url").toString("utf8");
    const obj = JSON.parse(json) as Partial<Locator>;
    if (typeof obj.q !== "string" || typeof obj.g !== "number" || typeof obj.i !== "number") {
      return null;
    }
    const loc: Locator = { q: obj.q, g: obj.g, i: obj.i };
    if (typeof obj.t === "number") loc.t = obj.t;
    return loc;
  } catch {
    return null;
  }
}

/** Derive a track locator by extending an item locator with a track index. */
export function withTrackIndex(loc: Locator, t: number): Locator {
  return { q: loc.q, g: loc.g, i: loc.i, t };
}
