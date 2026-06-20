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
import { decodeLocator, encodeLocator } from "./locator.js";
import { RoonClient } from "./RoonClient.js";
import { TrackExpansionService } from "./TrackExpansionService.js";

/** A browse node: a child list (optionally an action menu) or a terminal message. */
type Node =
  | { title: string; items: BrowseItem[]; listHint?: "action_list" | null }
  | { title?: string; message: string };

/** Locator for a single-group/single-item search keyed by `query`. */
const loc = (query: string) => encodeLocator({ q: query, g: 0, i: 0 });

// Synthetic keys for the canned search tree the navigator walks:
// search(input) → [group] → [item] → opened node (nodes[query]).
const GROUP_KEY = "__grp";
const ITEM_KEY = "__itm";

/**
 * Minimal stateful model of the search hierarchy the expander navigates. The
 * opened item for a query is `nodes[query]`; secondary containers (e.g. a
 * "Tracks" sub-list) are keyed by their own item_key, also in `nodes`.
 */
class FakeBrowse {
  private stack: Array<{ items: BrowseItem[]; hint?: "action_list" | null; title: string }> = [];
  private query = "";

  constructor(private readonly nodes: Record<string, Node>) {}

  browse(o: BrowseOptions, cb: (e: string | false, b: BrowseResultBody) => void): void {
    if (o.pop_all) {
      this.stack = [];
      if (o.input !== undefined) {
        this.query = o.input;
        this.stack = [
          { items: [{ title: "Group", item_key: GROUP_KEY, hint: "list" }], hint: null, title: "Search" },
        ];
      }
      return cb(false, { action: "list" });
    }
    if (o.pop_levels) {
      for (let i = 0; i < o.pop_levels; i++) this.stack.pop();
      return cb(false, { action: "list" });
    }
    if (o.item_key !== undefined) {
      if (o.item_key === GROUP_KEY) {
        this.stack.push({ items: [{ title: "Item", item_key: ITEM_KEY, hint: "list" }], hint: null, title: "Group" });
        return cb(false, { action: "list" });
      }
      const node = o.item_key === ITEM_KEY ? this.nodes[this.query] : this.nodes[o.item_key];
      if (node === undefined) {
        return cb("InvalidItemKey", undefined as unknown as BrowseResultBody);
      }
      if ("message" in node) {
        return cb(false, { action: "message", message: node.message });
      }
      this.stack.push({ items: node.items, hint: node.listHint, title: node.title });
      return cb(false, {
        action: "list",
        item: { title: node.title } as BrowseItem,
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
// A real Roon track row opens its Play/Queue menu when selected, so it carries
// hint "action_list" (unlike the bare-leaf `track()` model above). The leading
// "Play Album"/"Play Artist" shortcut shares that hint but is not a track.
function actionTrack(title: string, key: string, subtitle?: string): BrowseItem {
  return { title, item_key: key, subtitle, hint: "action_list" };
}
function playShortcut(title: string, key: string): BrowseItem {
  return { title, item_key: key, hint: "action_list" };
}

test("an album expands directly into its track list", async () => {
  const svc = buildService({
    album1: { title: "Dive", items: [track("Awake", "t:1", "Tycho"), track("Daydream", "t:2", "Tycho")] },
  });

  const out = await svc.getTracksFor({ itemKey: loc("album1") });

  assert.equal(out.sourceItemKey, loc("album1"));
  assert.deepEqual(out.skipped, []);
  assert.equal(out.tracks.length, 2);
  // Each track is keyed by a locator extending the source with its index.
  const first = decodeLocator(out.tracks[0]?.itemKey ?? "");
  assert.equal(first?.q, "album1");
  assert.equal(first?.t, 0);
  assert.equal(out.tracks[0]?.title, "Awake");
  assert.equal(out.tracks[0]?.artist, "Tycho");
  assert.equal(decodeLocator(out.tracks[1]?.itemKey ?? "")?.t, 1);
});

test("a single track (action menu) returns itself as one track", async () => {
  const svc = buildService({
    track1: {
      title: "Awake",
      items: [action("Play Now", "a:p"), action("Add to Queue", "a:q")],
      listHint: "action_list",
    },
  });

  const out = await svc.getTracksFor({ itemKey: loc("track1") });

  assert.equal(out.tracks.length, 1);
  // The candidate is itself the track, so it keeps its own (t-less) locator.
  assert.equal(out.tracks[0]?.itemKey, loc("track1"));
  assert.equal(out.tracks[0]?.title, "Awake");
});

test("an artist page with a 'Top Tracks' header returns those tracks, not albums", async () => {
  const svc = buildService({
    artist1: {
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

  const out = await svc.getTracksFor({ itemKey: loc("artist1") });

  assert.equal(out.tracks.length, 2);
  assert.deepEqual(out.tracks.map((t) => t.title).sort(), ["Awake", "Montana"]);
  assert.ok(out.tracks.every((t) => t.title !== "Dive"));
});

test("a local artist with no track section drills its top album into real tracks", async () => {
  // Purely-local artist page: a flat list of album containers, no streaming
  // "Top Tracks"/"Popular" section. The album must not be returned as a track;
  // we drill it into its own track list. (Reproduces the live "Tycho" bug.)
  const svc = buildService({
    artist2: { title: "Tycho", items: [nav("Dive (Deluxe Version)", "al:1")] },
    "al:1": {
      title: "Dive (Deluxe Version)",
      items: [track("Awake", "t:1", "Tycho"), track("Daydream", "t:2", "Tycho")],
    },
  });

  const out = await svc.getTracksFor({ itemKey: loc("artist2") });

  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.tracks.map((t) => t.title), ["Awake", "Daydream"]);
  assert.ok(out.tracks.every((t) => t.title !== "Dive (Deluxe Version)"));
  // Tracks are keyed by the artist locator extended with their drilled index.
  assert.deepEqual(out.tracks.map((t) => decodeLocator(t.itemKey)?.t), [0, 1]);
  assert.equal(out.tracks[0]?.artist, "Tycho");
});

test("a local artist drills its album past the leading 'Play' shortcuts (live shape)", async () => {
  // Mirrors the real Tycho Core: the artist page leads with a "Play Artist"
  // action_list shortcut + an album (hint "list"); the album leads with a
  // "Play Album" shortcut + action_list track rows. Only the real track must
  // come back — neither the album nor the "Play …" shortcuts.
  const svc = buildService({
    artist4: {
      title: "Tycho",
      items: [playShortcut("Play Artist", "pa:0"), nav("Dive (Deluxe Version)", "al:1")],
    },
    "al:1": {
      title: "Dive (Deluxe Version)",
      items: [playShortcut("Play Album", "pl:0"), actionTrack("Hours", "tk:1", "Tycho, Zac Brown")],
    },
  });

  const out = await svc.getTracksFor({ itemKey: loc("artist4") });

  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.tracks.map((t) => t.title), ["Hours"]);
  assert.ok(out.tracks.every((t) => !/^play /i.test(t.title) && t.title !== "Dive (Deluxe Version)"));
  assert.equal(out.tracks[0]?.artist, "Tycho, Zac Brown");
  assert.equal(decodeLocator(out.tracks[0]?.itemKey ?? "")?.t, 0);
});

test("an artist page with album sections (headers, no track label) drills the top album", async () => {
  const svc = buildService({
    artist3: {
      title: "Tycho",
      items: [header("Main Albums"), nav("Dive", "al:1"), nav("Awake", "al:2")],
    },
    "al:1": { title: "Dive", items: [track("A1", "t:1"), track("A2", "t:2")] },
    "al:2": { title: "Awake", items: [track("B1", "t:3")] },
  });

  const out = await svc.getTracksFor({ itemKey: loc("artist3") });

  // The first (top) album is drilled; its tracks come back, not the album names.
  assert.deepEqual(out.tracks.map((t) => t.title), ["A1", "A2"]);
  assert.deepEqual(out.skipped, []);
});

test("a located artist track re-resolves to a live key for playback", async () => {
  const svc = buildService({
    artist2: { title: "Tycho", items: [nav("Dive (Deluxe Version)", "al:1")] },
    "al:1": { title: "Dive (Deluxe Version)", items: [track("Awake", "t:1"), track("Daydream", "t:2")] },
    // Browsing into a track yields its action menu (the "self" shape).
    "t:1": { title: "Awake", items: [action("Play Now", "a:p")], listHint: "action_list" },
    "t:2": { title: "Daydream", items: [action("Play Now", "a:p")], listHint: "action_list" },
  });

  const out = await svc.getTracksFor({ itemKey: loc("artist2") });
  const second = decodeLocator(out.tracks[1]?.itemKey ?? "");
  assert.equal(second?.t, 1);

  // PlaybackService re-navigates a track locator through openTrackForPlayback;
  // it must re-drill the album and open entry t, landing on that track.
  const opened = await svc.openTrackForPlayback(second!);
  assert.equal(opened.action, "list");
  assert.equal(opened.item?.title, "Daydream");
});

test("when no direct tracks exist, it drills into a 'Tracks' container", async () => {
  const svc = buildService({
    mix1: {
      title: "Daily Mix",
      items: [header("Featured"), nav("Daily Mix", "dm:1"), header("More"), nav("Tracks", "tc:1")],
    },
    "tc:1": { title: "Tracks", items: [track("Song A", "s:1", "VA"), track("Song B", "s:2", "VA")] },
  });

  const out = await svc.getTracksFor({ itemKey: loc("mix1") });

  assert.deepEqual(out.tracks.map((t) => t.title), ["Song A", "Song B"]);
  assert.deepEqual(out.tracks.map((t) => decodeLocator(t.itemKey)?.t), [0, 1]);
  assert.deepEqual(out.skipped, []);
});

test("a non-expandable (message) item returns empty tracks with a skipped reason", async () => {
  const svc = buildService({ bad1: { message: "This item is not available." } });

  const out = await svc.getTracksFor({ itemKey: loc("bad1") });

  assert.deepEqual(out.tracks, []);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0]?.reason ?? "", /NOT_EXPANDABLE/);
  assert.match(out.skipped[0]?.reason ?? "", /not available/i);
});

test("a stale/invalid locator is reported as skipped, not thrown", async () => {
  const svc = buildService({ album1: { title: "Dive", items: [track("Awake", "t:1")] } });

  // A valid locator that no longer resolves (no such query in the tree).
  const out = await svc.getTracksFor({ itemKey: loc("ghost") });

  assert.deepEqual(out.tracks, []);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0]?.itemKey, loc("ghost"));
});

test("limit caps the number of returned tracks", async () => {
  const svc = buildService({
    albumbig: {
      title: "Big",
      items: Array.from({ length: 20 }, (_, i) => track(`Track ${i}`, `t:${i}`)),
    },
  });

  const out = await svc.getTracksFor({ itemKey: loc("albumbig"), limit: 5 });

  assert.equal(out.tracks.length, 5);
});
