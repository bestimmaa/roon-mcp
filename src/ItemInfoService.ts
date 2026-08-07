import type { BrowseItem } from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { hierarchyForLocator } from "./locator.js";
import { SearchNavigator, requireLocator } from "./SearchNavigator.js";
import { splitByHeaders } from "./TrackExpansionService.js";
import type {
  GetItemInfoInput,
  GetItemInfoOutput,
  ItemInfoEntry,
  ItemInfoSection,
} from "./types.js";

// Roon pages can be long (album track lists); load generously.
const SCAN_COUNT = 100;

// How many pass-through levels to drill (same shape playback handles: the
// album-versions page the search hierarchy inserts above the real album page).
const MAX_PASSTHROUGH_DRILL = 2;

/**
 * Returns a browsed item's page as data instead of drilling it for playback:
 * the item's own title/subtitle/image plus its child rows grouped by header
 * section. For an album that's the track list — with per-track performer
 * credits in the subtitles; for an artist, the Albums/Top Tracks sections.
 * The Browse API exposes no bio/overview text anywhere, so this page dump is
 * as rich as Roon's metadata gets for an extension (issue #39).
 *
 * Rows are display data only — Roon's raw child keys are level-scoped and
 * would be dead by the time the agent used them, so none are returned. To act
 * on something found here, resolve it via search_music/get_tracks_for.
 */
export class ItemInfoService {
  private readonly navigator: SearchNavigator;

  constructor(private readonly browse: BrowseSessionManager) {
    this.navigator = new SearchNavigator(browse);
  }

  async getItemInfo(input: GetItemInfoInput): Promise<GetItemInfoOutput> {
    const loc = requireLocator(input.itemKey);
    return this.browse.runExclusive(async () => {
      const hierarchy = hierarchyForLocator(loc);
      let opened = await this.navigator.openItem(loc);
      if (opened.action !== "list") {
        return {
          sourceItemKey: input.itemKey,
          title: stripRoonLinks(opened.item?.title ?? "Unknown item"),
          sections: [],
          message: opened.message ?? "Roon returned no page for this item.",
        };
      }

      let loaded = await this.browse.load({ hierarchy, offset: 0, count: SCAN_COUNT });

      // Pass-through levels (issue #33): when a page holds nothing but
      // sub-lists — the album-versions page — the interesting content lives
      // one level down. Same rule and depth cap as playback's findAction, so
      // mixed pages (artist pages with albums AND actions) are never drilled.
      for (let depth = 0; depth < MAX_PASSTHROUGH_DRILL; depth++) {
        const selectable = loaded.items.filter(
          (i) => Boolean(i.item_key) && i.hint !== "header",
        );
        const first = selectable[0];
        if (first === undefined || !selectable.every((i) => i.hint === "list")) break;
        let drilled;
        try {
          drilled = await this.browse.browse({
            hierarchy,
            item_key: first.item_key!,
          });
        } catch {
          break;
        }
        if (drilled.action !== "list") break;
        opened = drilled;
        loaded = await this.browse.load({ hierarchy, offset: 0, count: SCAN_COUNT });
      }

      const sections: ItemInfoSection[] = splitByHeaders(loaded.items).map((s) => ({
        ...(s.header !== undefined ? { title: stripRoonLinks(s.header) } : {}),
        items: s.items.map(toEntry),
      }));

      const subtitle = opened.item?.subtitle ?? loaded.list.subtitle;
      const imageKey = opened.item?.image_key ?? loaded.list.image_key;
      return {
        sourceItemKey: input.itemKey,
        title: stripRoonLinks(opened.item?.title ?? loaded.list.title),
        ...(subtitle ? { subtitle: stripRoonLinks(subtitle) } : {}),
        ...(imageKey ? { imageKey } : {}),
        sections,
      };
    });
  }
}

/**
 * Roon titles/subtitles embed link markup — `[[1481082|Tycho]]` renders as
 * "Tycho" in Roon's own UI. The ids are useless outside Roon; keep the text.
 */
function stripRoonLinks(text: string): string {
  return text.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1");
}

function toEntry(item: BrowseItem): ItemInfoEntry {
  return {
    title: stripRoonLinks(item.title),
    ...(item.subtitle ? { subtitle: stripRoonLinks(item.subtitle) } : {}),
    ...(item.image_key ? { imageKey: item.image_key } : {}),
  };
}
