import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  BrowseItem,
  BrowseOptions,
  BrowseResultBody,
  LoadOptions,
  LoadResultBody,
} from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { ItemInfoService } from "./ItemInfoService.js";
import { encodeLocator } from "./locator.js";
import { RoonClient } from "./RoonClient.js";
import { RoonMcpError } from "./types.js";

/** A browse node: a child list or a terminal message. */
type Node =
  | { title: string; subtitle?: string; image_key?: string; items: BrowseItem[] }
  | { title?: string; message: string };

/** Locator for a single-group/single-item search keyed by `query`. */
const loc = (query: string) => encodeLocator({ q: query, g: 0, i: 0 });

// Synthetic keys for the canned search tree the navigator walks:
// search(input) → [group] → [item] → opened node (nodes[query]).
const GROUP_KEY = "__grp";
const ITEM_KEY = "__itm";

/** Minimal stateful model of the search hierarchy (same shape as the expander tests). */
class FakeBrowse {
  private stack: Array<{ items: BrowseItem[]; title: string }> = [];
  private query = "";

  constructor(private readonly nodes: Record<string, Node>) {}

  browse(o: BrowseOptions, cb: (e: string | false, b: BrowseResultBody) => void): void {
    if (o.pop_all) {
      this.stack = [];
      if (o.input !== undefined) {
        this.query = o.input;
        this.stack = [
          { items: [{ title: "Group", item_key: GROUP_KEY, hint: "list" }], title: "Search" },
        ];
      }
      return cb(false, { action: "list" });
    }
    if (o.item_key !== undefined) {
      if (o.item_key === GROUP_KEY) {
        this.stack.push({
          items: [{ title: "Item", item_key: ITEM_KEY, hint: "list" }],
          title: "Group",
        });
        return cb(false, { action: "list" });
      }
      // ITEM_KEY opens the queried node; any other key drills a child node.
      const node =
        o.item_key === ITEM_KEY ? this.nodes[this.query] : this.nodes[o.item_key];
      if (node === undefined) {
        return cb("InvalidItemKey", undefined as unknown as BrowseResultBody);
      }
      if ("message" in node) {
        return cb(false, { action: "message", message: node.message });
      }
      this.stack.push({ items: node.items, title: node.title });
      return cb(false, {
        action: "list",
        item: {
          title: node.title,
          ...(node.subtitle ? { subtitle: node.subtitle } : {}),
          ...(node.image_key ? { image_key: node.image_key } : {}),
        },
        list: { title: node.title, count: node.items.length, level: this.stack.length - 1 },
      });
    }
    return cb(false, { action: "none" });
  }

  load(o: LoadOptions, cb: (e: string | false, b: LoadResultBody) => void): void {
    const top = this.stack[this.stack.length - 1] ?? { items: [], title: "" };
    const offset = o.offset ?? 0;
    const items = top.items.slice(offset, offset + (o.count ?? 100));
    cb(false, {
      items,
      offset,
      list: { title: top.title, count: top.items.length, level: this.stack.length - 1 },
    });
  }
}

function buildService(nodes: Record<string, Node>): ItemInfoService {
  const fake = new FakeBrowse(nodes);
  const stub = { waitForCore: async () => undefined, getBrowse: () => fake } as unknown as RoonClient;
  return new ItemInfoService(new BrowseSessionManager(stub));
}

function header(title: string): BrowseItem {
  return { title, hint: "header" };
}
function row(title: string, subtitle?: string, image_key?: string): BrowseItem {
  return { title, item_key: `k-${title}`, subtitle, image_key, hint: "action_list" };
}
function listRow(title: string, subtitle?: string): BrowseItem {
  return { title, item_key: `k-${title}`, subtitle, hint: "list" };
}

test("an album page returns its own info plus track rows with credit subtitles", async () => {
  const service = buildService({
    Suddenly: {
      title: "Suddenly",
      subtitle: "Caribou",
      image_key: "img-suddenly",
      items: [
        row("Play Album"),
        row("Sister", "Caribou, Dan Snaith", "img-sister"),
        row("You and I", "Caribou, Dan Snaith, Colin Fisher"),
      ],
    },
  });

  const info = await service.getItemInfo({ itemKey: loc("Suddenly") });
  assert.equal(info.title, "Suddenly");
  assert.equal(info.subtitle, "Caribou");
  assert.equal(info.imageKey, "img-suddenly");
  assert.equal(info.message, undefined);
  assert.deepEqual(info.sections, [
    {
      items: [
        { title: "Play Album" },
        { title: "Sister", subtitle: "Caribou, Dan Snaith", imageKey: "img-sister" },
        { title: "You and I", subtitle: "Caribou, Dan Snaith, Colin Fisher" },
      ],
    },
  ]);
});

test("header rows split the page into titled sections", async () => {
  const service = buildService({
    Caribou: {
      title: "Caribou",
      items: [
        header("Albums"),
        row("Suddenly", "2020", "img-suddenly"),
        row("Our Love", "2014"),
        header("Top Tracks"),
        row("Odessa", "Caribou"),
      ],
    },
  });

  const info = await service.getItemInfo({ itemKey: loc("Caribou") });
  assert.deepEqual(
    info.sections.map((s) => ({ title: s.title, count: s.items.length })),
    [
      { title: "Albums", count: 2 },
      { title: "Top Tracks", count: 1 },
    ],
  );
});

test("an album-versions page (all-list rows) is drilled to the real album page", async () => {
  const service = buildService({
    Dive: {
      title: "Dive",
      items: [listRow("Dive", "[[1481082|Tycho]]")],
    },
    "k-Dive": {
      title: "Dive",
      subtitle: "Tycho",
      image_key: "img-dive",
      items: [row("Play Album"), row("A Walk", "Tycho")],
    },
  });

  const info = await service.getItemInfo({ itemKey: loc("Dive") });
  assert.equal(info.title, "Dive");
  assert.equal(info.subtitle, "Tycho");
  assert.equal(info.imageKey, "img-dive");
  assert.deepEqual(info.sections, [
    { items: [{ title: "Play Album" }, { title: "A Walk", subtitle: "Tycho" }] },
  ]);
});

test("Roon [[id|text]] link markup is stripped from titles and subtitles", async () => {
  const service = buildService({
    Dive: {
      title: "Dive",
      subtitle: "[[1481082|Tycho]]",
      items: [row("A Walk", "[[1481082|Tycho]], [[99|Scott Hansen]]")],
    },
  });

  const info = await service.getItemInfo({ itemKey: loc("Dive") });
  assert.equal(info.subtitle, "Tycho");
  assert.deepEqual(info.sections[0]?.items, [
    { title: "A Walk", subtitle: "Tycho, Scott Hansen" },
  ]);
});

test("a message page is reported as a message, not an error", async () => {
  const service = buildService({
    Nothing: { message: "No results." },
  });

  const info = await service.getItemInfo({ itemKey: loc("Nothing") });
  assert.equal(info.message, "No results.");
  assert.deepEqual(info.sections, []);
});

test("a stale locator surfaces INVALID_ITEM_KEY", async () => {
  const service = buildService({});
  await assert.rejects(
    service.getItemInfo({ itemKey: loc("Gone") }),
    (err: unknown) => err instanceof RoonMcpError && err.code === "INVALID_ITEM_KEY",
  );
});

test("a non-locator itemKey is rejected without touching the session", async () => {
  const service = buildService({});
  await assert.rejects(
    service.getItemInfo({ itemKey: "raw-roon-key" }),
    (err: unknown) => err instanceof RoonMcpError && err.code === "INVALID_ITEM_KEY",
  );
});
