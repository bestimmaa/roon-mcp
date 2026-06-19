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
import { RoonClient } from "./RoonClient.js";
import { TrackExpansionService } from "./TrackExpansionService.js";

/** A browse node: a child list (optionally an action menu) or a terminal message. */
type Node =
  | { title: string; items: BrowseItem[]; listHint?: "action_list" | null }
  | { title?: string; message: string };

/** Minimal stateful model of Roon's browse drill (levels + a stack). */
class FakeBrowse {
  private stack: Array<{ items: BrowseItem[]; hint?: "action_list" | null; title: string }> = [];

  constructor(private readonly nodes: Record<string, Node>) {}

  browse(o: BrowseOptions, cb: (e: string | false, b: BrowseResultBody) => void): void {
    if (o.pop_all) {
      this.stack = [];
      return cb(false, { action: "list" });
    }
    if (o.pop_levels) {
      for (let i = 0; i < o.pop_levels; i++) this.stack.pop();
      return cb(false, { action: "list" });
    }
    if (o.item_key !== undefined) {
      const node = this.nodes[o.item_key];
      if (node === undefined) {
        return cb("InvalidItemKey", undefined as unknown as BrowseResultBody);
      }
      if ("message" in node) {
        return cb(false, { action: "message", message: node.message });
      }
      this.stack.push({ items: node.items, hint: node.listHint, title: node.title });
      return cb(false, {
        action: "list",
        item: { title: node.title },
        list: { title: node.title, count: node.items.length, level: this.stack.length - 1, hint: node.listHint ?? null },
      });
    }
    return cb(false, { action: "none" });
  }

  load(o: LoadOptions, cb: (e: string | false, b: LoadResultBody) => void): void {
    const top = this.stack[this.stack.length - 1] ?? { items: [], hint: null, title: "" };
    const offset = o.offset ?? 0;
    const items = top.items.slice(offset, offset + (o.count ?? 100));
    cb(false, {
      items,
      offset,
      list: { title: top.title, count: top.items.length, level: this.stack.length - 1, hint: top.hint ?? null },
    });
  }
}

function buildService(nodes: Record<string, Node>): TrackExpansionService {
  const fake = new FakeBrowse(nodes);
  const stub = { waitForCore: async () => undefined, getBrowse: () => fake } as unknown as RoonClient;
  return new TrackExpansionService(new BrowseSessionManager(stub));
}

function track(title: string, key: string, subtitle?: string): BrowseItem {
  return { title, item_key: key, subtitle };
}
function nav(title: string, key: string): BrowseItem {
  return { title, item_key: key, hint: "list" };
}
function header(title: string): BrowseItem {
  return { title, hint: "header" };
}
function action(title: string, key: string): BrowseItem {
  return { title, item_key: key, hint: "action" };
}

test("an album expands directly into its track list", async () => {
  const svc = buildService({
    "album:1": { title: "Dive", items: [track("Awake", "t:1", "Tycho"), track("Daydream", "t:2", "Tycho")] },
  });

  const out = await svc.getTracksFor({ itemKey: "album:1" });

  assert.equal(out.sourceItemKey, "album:1");
  assert.deepEqual(out.skipped, []);
  assert.equal(out.tracks.length, 2);
  assert.equal(out.tracks[0]?.itemKey, "t:1");
  assert.equal(out.tracks[0]?.title, "Awake");
  assert.equal(out.tracks[0]?.artist, "Tycho");
});

test("a single track (action menu) returns itself as one track", async () => {
  const svc = buildService({
    "track:1": {
      title: "Awake",
      items: [action("Play Now", "a:p"), action("Add to Queue", "a:q")],
      listHint: "action_list",
    },
  });

  const out = await svc.getTracksFor({ itemKey: "track:1" });

  assert.equal(out.tracks.length, 1);
  assert.equal(out.tracks[0]?.itemKey, "track:1");
  assert.equal(out.tracks[0]?.title, "Awake");
});

test("an artist page with a 'Top Tracks' header returns those tracks, not albums", async () => {
  const svc = buildService({
    "artist:1": {
      title: "Tycho",
      items: [
        header("Top Tracks"),
        track("Awake", "t:1", "Tycho"),
        track("Montana", "t:2", "Tycho"),
        header("Top Albums"),
        nav("Dive", "al:1"),
      ],
    },
  });

  const out = await svc.getTracksFor({ itemKey: "artist:1" });

  assert.equal(out.tracks.length, 2);
  assert.deepEqual(out.tracks.map((t) => t.itemKey).sort(), ["t:1", "t:2"]);
  assert.ok(out.tracks.every((t) => t.itemKey !== "al:1"));
});

test("when no direct tracks exist, it drills into a 'Tracks' container", async () => {
  const svc = buildService({
    "mix:1": {
      title: "Daily Mix",
      items: [header("Featured"), nav("Daily Mix", "dm:1"), header("More"), nav("Tracks", "tc:1")],
    },
    "tc:1": { title: "Tracks", items: [track("Song A", "s:1", "VA"), track("Song B", "s:2", "VA")] },
  });

  const out = await svc.getTracksFor({ itemKey: "mix:1" });

  assert.deepEqual(out.tracks.map((t) => t.itemKey), ["s:1", "s:2"]);
  assert.deepEqual(out.skipped, []);
});

test("a non-expandable (message) item returns empty tracks with a skipped reason", async () => {
  const svc = buildService({ "bad:1": { message: "This item is not available." } });

  const out = await svc.getTracksFor({ itemKey: "bad:1" });

  assert.deepEqual(out.tracks, []);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0]?.reason ?? "", /NOT_EXPANDABLE/);
  assert.match(out.skipped[0]?.reason ?? "", /not available/i);
});

test("a stale/invalid item key is reported as skipped, not thrown", async () => {
  const svc = buildService({ "album:1": { title: "Dive", items: [track("Awake", "t:1")] } });

  const out = await svc.getTracksFor({ itemKey: "ghost" });

  assert.deepEqual(out.tracks, []);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0]?.itemKey, "ghost");
});

test("limit caps the number of returned tracks", async () => {
  const svc = buildService({
    "album:big": {
      title: "Big",
      items: Array.from({ length: 20 }, (_, i) => track(`Track ${i}`, `t:${i}`)),
    },
  });

  const out = await svc.getTracksFor({ itemKey: "album:big", limit: 5 });

  assert.equal(out.tracks.length, 5);
});
