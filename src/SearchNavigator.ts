import type { BrowseHierarchy, BrowseItem, BrowseResultBody } from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { decodeLocator, type Locator } from "./locator.js";
import { RoonMcpError } from "./types.js";

// All search results live in the "search" hierarchy; we re-navigate there.
export const SEARCH_HIERARCHY: BrowseHierarchy = "search";
// Load generously when re-resolving so a locator index is never cut off by a
// short page (search itself may have collected with a small `limit`).
const RESOLVE_COUNT = 100;

/** A selectable browse entry: has a key and isn't a header. */
export function isSelectable(item: BrowseItem): boolean {
  return Boolean(item.item_key) && item.hint !== "header";
}

const STALE = () =>
  new RoonMcpError(
    "INVALID_ITEM_KEY",
    "That search result is no longer available; re-run search_music to refresh it.",
  );

/**
 * Re-navigates the search hierarchy to reach an item by *locator* (query +
 * group index + item index). Because every step runs in one uninterrupted
 * browse session, the keys are live at the moment they're used — unlike the raw
 * keys `search_music` collects and then strands by popping back. See
 * `locator.ts` for the why.
 */
export class SearchNavigator {
  constructor(private readonly browse: BrowseSessionManager) {}

  /**
   * Drill to the item at (loc.g, loc.i) and browse *into* it, leaving the
   * session positioned at the item's child/action level. Returns that browse
   * result. Throws INVALID_ITEM_KEY if the indices no longer resolve.
   *
   * Compose inside `runExclusive` — this issues a multi-step browse sequence.
   */
  async openItem(loc: Locator): Promise<BrowseResultBody> {
    await this.browse.browse({ hierarchy: SEARCH_HIERARCHY, input: loc.q, pop_all: true });

    const top = await this.browse.load({
      hierarchy: SEARCH_HIERARCHY,
      offset: 0,
      count: RESOLVE_COUNT,
    });
    const group = top.items.filter(isSelectable)[loc.g];
    if (!group?.item_key) throw STALE();

    const gnav = await this.browse.browse({ hierarchy: SEARCH_HIERARCHY, item_key: group.item_key });
    if (gnav.action !== "list") throw STALE();

    const children = await this.browse.load({
      hierarchy: SEARCH_HIERARCHY,
      offset: 0,
      count: RESOLVE_COUNT,
    });
    const item = children.items.filter(isSelectable)[loc.i];
    if (!item?.item_key) throw STALE();

    return this.browse.browse({ hierarchy: SEARCH_HIERARCHY, item_key: item.item_key });
  }

  /** Load the children of the currently-opened item (its actions or sub-list). */
  async loadCurrent(count = RESOLVE_COUNT): Promise<BrowseItem[]> {
    const loaded = await this.browse.load({ hierarchy: SEARCH_HIERARCHY, offset: 0, count });
    return loaded.items;
  }
}

/** Decode an MCP itemKey to a locator, or throw if it isn't a valid locator. */
export function requireLocator(itemKey: string): Locator {
  const loc = decodeLocator(itemKey);
  if (!loc) {
    throw new RoonMcpError(
      "INVALID_ITEM_KEY",
      "itemKey is not a valid search_music locator; pass a key from a recent search_music/get_tracks_for result.",
    );
  }
  return loc;
}
