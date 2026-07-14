import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  BrowseItem,
  BrowseOptions,
  BrowseResultBody,
  LoadOptions,
  LoadResultBody,
} from "node-roon-api-browse";
import type { GetZonesBody, RoonApiZone } from "node-roon-api-transport";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { encodeLocator } from "./locator.js";
import { PlaybackService } from "./PlaybackService.js";
import { RoonClient } from "./RoonClient.js";
import { TrackExpansionService } from "./TrackExpansionService.js";
import { RoonMcpError } from "./types.js";
import { ZoneService } from "./ZoneService.js";
import { ZoneSubscription } from "./ZoneSubscription.js";

/** A node the play drill lands on: either a child list or a terminal message. */
type DrillResult = BrowseItem[] | { message: string };

interface PlayOpts {
  failActionTimes?: number;
}

/** Locator for a single-group/single-item search keyed by `query`. */
const loc = (query: string) => encodeLocator({ q: query, g: 0, i: 0 });

// Synthetic keys for the canned search tree the navigator walks:
// search(input) → [group] → [item] → opened content (items[query]).
const GROUP_KEY = "__grp";
const ITEM_KEY = "__itm";

/**
 * Minimal stateful model of the search hierarchy the playback navigator walks.
 * `items` maps a search query to the *opened item* content (its action menu or
 * a terminal message); `drills` holds secondary keys (e.g. an action_list
 * container); invoking an action key records an invocation.
 */
class FakeBrowse {
  private stack: BrowseItem[][] = [];
  private query = "";
  readonly invocations: Array<{ itemKey: string; zone?: string }> = [];
  private failActionRemaining: number;

  constructor(
    private readonly items: Record<string, DrillResult>,
    private readonly actionKeys: Set<string>,
    private readonly drills: Record<string, DrillResult> = {},
    opts: PlayOpts = {},
  ) {
    this.failActionRemaining = opts.failActionTimes ?? 0;
  }

  browse(o: BrowseOptions, cb: (e: string | false, b: BrowseResultBody) => void): void {
    if (o.pop_all) {
      this.stack = [];
      if (o.input !== undefined) {
        this.query = o.input;
        this.stack = [[{ title: "Group", item_key: GROUP_KEY, hint: "list" }]];
      }
      return cb(false, { action: "list" });
    }
    if (o.pop_levels) {
      for (let i = 0; i < o.pop_levels; i++) this.stack.pop();
      return cb(false, { action: "list" });
    }
    if (o.item_key !== undefined) {
      const key = o.item_key;

      if (this.actionKeys.has(key)) {
        if (this.failActionRemaining > 0) {
          this.failActionRemaining--;
          return cb(false, { action: "message", is_error: true, message: "ActionFailed" });
        }
        this.invocations.push({ itemKey: key, zone: o.zone_or_output_id });
        return cb(false, { action: "none" });
      }

      if (key === GROUP_KEY) {
        this.stack.push([{ title: "Item", item_key: ITEM_KEY, hint: "list" }]);
        return cb(false, { action: "list" });
      }
      if (key === ITEM_KEY) {
        return this.land(this.items[this.query], cb);
      }
      return this.land(this.drills[key], cb);
    }
    return cb(false, { action: "none" });
  }

  /** Push a child list, surface a terminal message, or reject an unknown key. */
  private land(target: DrillResult | undefined, cb: (e: string | false, b: BrowseResultBody) => void) {
    if (target === undefined) {
      return cb("InvalidItemKey", undefined as unknown as BrowseResultBody);
    }
    if (Array.isArray(target)) {
      this.stack.push(target);
      return cb(false, { action: "list", item: { title: this.query } as BrowseItem });
    }
    return cb(false, { action: "message", message: target.message });
  }

  load(_o: LoadOptions, cb: (e: string | false, b: LoadResultBody) => void): void {
    const top = this.stack[this.stack.length - 1] ?? [];
    cb(false, { items: top, offset: 0, list: { title: "", count: top.length, level: 0 } });
  }
}

class FakeTransport {
  readonly shuffleCalls: Array<{ zone: string; shuffle?: boolean }> = [];
  change_settings?: (
    zone: string,
    settings: { shuffle?: boolean },
    cb?: (e: string | false) => void,
  ) => void;

  constructor(
    private readonly zones: RoonApiZone[],
    supportsChangeSettings = true,
  ) {
    if (supportsChangeSettings) {
      this.change_settings = (zone, settings, cb) => {
        this.shuffleCalls.push({ zone, shuffle: settings.shuffle });
        cb?.(false);
      };
    }
  }

  get_zones(cb: (e: string | false, b: GetZonesBody) => void): void {
    cb(false, { zones: this.zones });
  }
}

const ZONE: RoonApiZone = {
  zone_id: "z1",
  display_name: "Office",
  state: "stopped",
  outputs: [{ output_id: "o1", zone_id: "z1", display_name: "Office" }],
  now_playing: { two_line: { line1: "Some Track", line2: "Some Artist" } },
};

function action(title: string, key: string): BrowseItem {
  return { title, item_key: key, hint: "action" };
}

function build(
  items: Record<string, DrillResult>,
  actionKeys: string[],
  opts: { transport?: FakeTransport; playOpts?: PlayOpts; drills?: Record<string, DrillResult> } = {},
) {
  const browse = new FakeBrowse(items, new Set(actionKeys), opts.drills ?? {}, opts.playOpts);
  const transport = opts.transport ?? new FakeTransport([ZONE]);
  const stub = {
    waitForCore: async () => undefined,
    getBrowse: () => browse,
    getTransport: () => transport,
    getActiveSubscription: () => undefined,
  } as unknown as RoonClient;
  const mgr = new BrowseSessionManager(stub);
  const zones = new ZoneService(stub);
  const tracks = new TrackExpansionService(mgr);
  const svc = new PlaybackService(mgr, zones, stub, tracks);
  return { svc, browse, transport };
}

test("play_now discovers and invokes the Play Now action against the zone", async () => {
  const { svc, browse } = build(
    { album: [action("Play Now", "act:play"), action("Queue", "act:queue")] },
    ["act:play", "act:queue"],
  );

  const out = await svc.playNow({ zoneId: "z1", itemKey: loc("album") });

  assert.equal(out.ok, true);
  assert.equal(out.queued, 1);
  assert.deepEqual(out.skipped, []);
  assert.equal(out.nowPlaying, "Some Track");
  assert.deepEqual(browse.invocations, [{ itemKey: "act:play", zone: "z1" }]);
});

test("shuffle prefers a Shuffle action over Play Now and skips the Transport fallback", async () => {
  const { svc, browse, transport } = build(
    { album: [action("Play Now", "act:play"), action("Shuffle", "act:shuffle")] },
    ["act:play", "act:shuffle"],
  );

  const out = await svc.playNow({ zoneId: "z1", itemKey: loc("album"), shuffle: true });

  assert.equal(browse.invocations[0]?.itemKey, "act:shuffle");
  assert.deepEqual(transport.shuffleCalls, []);
  assert.doesNotMatch(out.message ?? "", /could not be applied/i);
});

test("shuffle falls back to the Transport setting when no shuffle action exists", async () => {
  const { svc, browse, transport } = build({ album: [action("Play Now", "act:play")] }, ["act:play"]);

  const out = await svc.playNow({ zoneId: "z1", itemKey: loc("album"), shuffle: true });

  assert.equal(browse.invocations[0]?.itemKey, "act:play");
  assert.deepEqual(transport.shuffleCalls, [{ zone: "z1", shuffle: true }]);
  assert.doesNotMatch(out.message ?? "", /could not be applied/i);
});

test("shuffle reports when it cannot be applied (no action, Transport unsupported)", async () => {
  const transport = new FakeTransport([ZONE], false);
  const { svc } = build({ album: [action("Play Now", "act:play")] }, ["act:play"], { transport });

  const out = await svc.playNow({ zoneId: "z1", itemKey: loc("album"), shuffle: true });

  assert.equal(out.ok, true);
  assert.match(out.message ?? "", /could not be applied/i);
});

test("an unknown zone id is rejected with ZONE_NOT_FOUND", async () => {
  const { svc } = build({ album: [action("Play Now", "act:play")] }, ["act:play"]);
  await assert.rejects(
    svc.playNow({ zoneId: "nope", itemKey: loc("album") }),
    (e) => e instanceof RoonMcpError && e.code === "ZONE_NOT_FOUND",
  );
});

test("play_now without a zoneId resolves the only available zone", async () => {
  const { svc, browse } = build({ album: [action("Play Now", "act:play")] }, ["act:play"]);
  const out = await svc.playNow({ itemKey: loc("album") });
  assert.equal(out.ok, true);
  assert.equal(out.zoneId, "z1");
  assert.equal(browse.invocations[0]?.zone, "z1");
});

test("an output id is accepted as the playback target", async () => {
  const { svc, browse } = build({ album: [action("Play Now", "act:play")] }, ["act:play"]);
  const out = await svc.playNow({ zoneId: "o1", itemKey: loc("album") });
  assert.equal(out.ok, true);
  assert.equal(browse.invocations[0]?.zone, "o1");
});

test("a non-locator itemKey is rejected with INVALID_ITEM_KEY", async () => {
  const { svc } = build({ album: [action("Play Now", "act:play")] }, ["act:play"]);
  await assert.rejects(
    svc.playNow({ zoneId: "z1", itemKey: "raw-key" }),
    (e) => e instanceof RoonMcpError && e.code === "INVALID_ITEM_KEY",
  );
});

test("an item with no play action yields NO_PLAY_ACTION", async () => {
  const { svc } = build({ album: [{ title: "Tracks", item_key: "x", hint: "list" }] }, []);
  await assert.rejects(
    svc.playNow({ zoneId: "z1", itemKey: loc("album") }),
    (e) => e instanceof RoonMcpError && e.code === "NO_PLAY_ACTION",
  );
});

test("a non-playable item (message action) yields NO_PLAY_ACTION", async () => {
  const { svc } = build({ album: { message: "Not available." } }, []);
  await assert.rejects(
    svc.playNow({ zoneId: "z1", itemKey: loc("album") }),
    (e) =>
      e instanceof RoonMcpError &&
      e.code === "NO_PLAY_ACTION" &&
      /not available/i.test(e.message),
  );
});

test("actions nested under an action_list container are found", async () => {
  const { svc, browse } = build(
    { album: [{ title: "More", item_key: "al:more", hint: "action_list" }] },
    ["act:play"],
    { drills: { "al:more": [action("Play Now", "act:play")] } },
  );
  const out = await svc.playNow({ zoneId: "z1", itemKey: loc("album") });
  assert.equal(out.ok, true);
  assert.equal(browse.invocations[0]?.itemKey, "act:play");
});

test("an album behind a versions page (lone list item) is drilled to Play Album", async () => {
  // Mirrors the real search shape for an album: opening the candidate lands on
  // a pass-through page whose only item is the album version (hint "list");
  // the track list with its "Play Album" action_list container is one level
  // deeper, and the concrete actions a level below that.
  const { svc, browse } = build(
    { album: [{ title: "Kind Of Blue", item_key: "ver:0", hint: "list" }] },
    ["act:play"],
    {
      drills: {
        "ver:0": [
          { title: "Play Album", item_key: "al:play", hint: "action_list" },
          { title: "1. So What", item_key: "trk:0", hint: "action_list" },
        ],
        "al:play": [action("Play Now", "act:play"), action("Queue", "act:queue")],
      },
    },
  );

  const out = await svc.playNow({ zoneId: "z1", itemKey: loc("album") });

  assert.equal(out.ok, true);
  assert.deepEqual(browse.invocations, [{ itemKey: "act:play", zone: "z1" }]);
});

test("a versions page is drilled for queueing too (Add to Queue found deep)", async () => {
  const { svc, browse } = build(
    { album: [{ title: "Kind Of Blue", item_key: "ver:0", hint: "list" }] },
    ["act:queue"],
    {
      drills: {
        "ver:0": [{ title: "Play Album", item_key: "al:play", hint: "action_list" }],
        "al:play": [action("Play Now", "act:x"), action("Add to Queue", "act:queue")],
      },
    },
  );

  const out = await svc.playNow({ zoneId: "z1", itemKey: loc("album"), addToQueue: true });

  assert.equal(out.ok, true);
  assert.deepEqual(browse.invocations, [{ itemKey: "act:queue", zone: "z1" }]);
});

test("a level mixing lists with non-list items is not speculatively drilled", async () => {
  // Only pure pass-through levels (every selectable item a `list`) may be
  // drilled without an action_list; mixed levels yield NO_PLAY_ACTION.
  const { svc } = build(
    {
      album: [
        { title: "Tracks", item_key: "x", hint: "list" },
        { title: "Some input", item_key: "y", hint: undefined, input_prompt: { prompt: "p", action: "a", is_password: false } },
      ],
    },
    [],
  );
  await assert.rejects(
    svc.playNow({ zoneId: "z1", itemKey: loc("album") }),
    (e) => e instanceof RoonMcpError && e.code === "NO_PLAY_ACTION",
  );
});

test("a failed action invocation reopens the item and retries once", async () => {
  const { svc, browse } = build({ album: [action("Play Now", "act:play")] }, ["act:play"], {
    playOpts: { failActionTimes: 1 },
  });
  const out = await svc.playNow({ zoneId: "z1", itemKey: loc("album") });
  assert.equal(out.ok, true);
  // Only the successful retry is recorded as an invocation.
  assert.deepEqual(browse.invocations, [{ itemKey: "act:play", zone: "z1" }]);
});

test("enqueue starts the first item with Play Now and appends the rest with Queue", async () => {
  const { svc, browse } = build(
    {
      t1: [action("Play Now", "p1"), action("Add to Queue", "q1")],
      t2: [action("Play Now", "p2"), action("Add to Queue", "q2")],
      t3: [action("Play Now", "p3"), action("Add to Queue", "q3")],
    },
    ["p1", "q1", "p2", "q2", "p3", "q3"],
  );

  const out = await svc.enqueueAndPlay({
    zoneId: "z1",
    itemKeys: [loc("t1"), loc("t2"), loc("t3")],
  });

  assert.equal(out.ok, true);
  assert.equal(out.queued, 3);
  assert.equal(out.requested, 3);
  assert.deepEqual(out.skipped, []);
  // First via Play Now, the rest appended via Add to Queue (order preserved).
  assert.deepEqual(
    browse.invocations.map((i) => i.itemKey),
    ["p1", "q2", "q3"],
  );
});

test("enqueue skips a non-playable middle item and queues the rest", async () => {
  const { svc } = build(
    {
      t1: [action("Play Now", "p1")],
      bad: { message: "Unavailable." },
      t3: [action("Play Now", "p3"), action("Queue", "q3")],
    },
    ["p1", "p3", "q3"],
  );

  const out = await svc.enqueueAndPlay({
    zoneId: "z1",
    itemKeys: [loc("t1"), loc("bad"), loc("t3")],
  });

  assert.equal(out.ok, true);
  assert.equal(out.queued, 2);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0]?.itemKey, loc("bad"));
  assert.match(out.skipped[0]?.reason ?? "", /unavailable/i);
});

test("enqueue falls through to the next item as the queue starter", async () => {
  const { svc, browse } = build(
    {
      bad: { message: "Nope." },
      t2: [action("Play Now", "p2"), action("Queue", "q2")],
      t3: [action("Play Now", "p3"), action("Queue", "q3")],
    },
    ["p2", "q2", "p3", "q3"],
  );

  const out = await svc.enqueueAndPlay({
    zoneId: "z1",
    itemKeys: [loc("bad"), loc("t2"), loc("t3")],
  });

  assert.equal(out.ok, true);
  assert.equal(out.queued, 2);
  assert.equal(out.skipped[0]?.itemKey, loc("bad"));
  assert.deepEqual(
    browse.invocations.map((i) => i.itemKey),
    ["p2", "q3"],
  );
});

test("enqueue with no startable items reports ok:false and queued 0", async () => {
  const { svc } = build({ bad1: { message: "No." }, bad2: { message: "No." } }, []);

  const out = await svc.enqueueAndPlay({ zoneId: "z1", itemKeys: [loc("bad1"), loc("bad2")] });

  assert.equal(out.ok, false);
  assert.equal(out.queued, 0);
  assert.equal(out.skipped.length, 2);
});

test("enqueue skips a stale (invalid) item key instead of failing the call", async () => {
  const { svc } = build({ t1: [action("Play Now", "p1")] }, ["p1"]);

  const out = await svc.enqueueAndPlay({ zoneId: "z1", itemKeys: [loc("t1"), loc("ghost")] });

  assert.equal(out.ok, true);
  assert.equal(out.queued, 1);
  assert.equal(out.skipped[0]?.itemKey, loc("ghost"));
});

test("enqueue applies shuffle via Transport only when requested", async () => {
  const transport = new FakeTransport([ZONE]);
  const { svc } = build({ t1: [action("Play Now", "p1")] }, ["p1"], { transport });

  await svc.enqueueAndPlay({ zoneId: "z1", itemKeys: [loc("t1")], shuffle: true });
  assert.deepEqual(transport.shuffleCalls, [{ zone: "z1", shuffle: true }]);
});

test("enqueue leaves the zone's shuffle setting untouched when shuffle is omitted", async () => {
  const transport = new FakeTransport([ZONE]);
  const { svc } = build({ t1: [action("Play Now", "p1")] }, ["p1"], { transport });

  await svc.enqueueAndPlay({ zoneId: "z1", itemKeys: [loc("t1")] });
  assert.deepEqual(transport.shuffleCalls, []);
});

test("enqueue with shuffle:false stays silent when change_settings is unavailable (issue #11)", async () => {
  // A queue built in order is already unshuffled; an unavailable change_settings
  // (old transport) must not append a noisy "could not be applied" warning.
  const transport = new FakeTransport([ZONE], false);
  const { svc } = build({ t1: [action("Play Now", "p1")] }, ["p1"], { transport });

  const out = await svc.enqueueAndPlay({ zoneId: "z1", itemKeys: [loc("t1")], shuffle: false });
  assert.equal(out.ok, true);
  assert.deepEqual(transport.shuffleCalls, []);
  assert.doesNotMatch(out.message ?? "", /could not be applied/i);
});

test("enqueue with shuffle:true still warns when change_settings is unavailable", async () => {
  // The silent path is only for shuffle:false — actively requested shuffle
  // that can't be applied must still be reported.
  const transport = new FakeTransport([ZONE], false);
  const { svc } = build({ t1: [action("Play Now", "p1")] }, ["p1"], { transport });

  const out = await svc.enqueueAndPlay({ zoneId: "z1", itemKeys: [loc("t1")], shuffle: true });
  assert.equal(out.ok, true);
  assert.match(out.message ?? "", /could not be applied/i);
});

test("enqueue rejects an unknown zone id with ZONE_NOT_FOUND", async () => {
  const { svc } = build({ t1: [action("Play Now", "p1")] }, ["p1"]);
  await assert.rejects(
    svc.enqueueAndPlay({ zoneId: "nope", itemKeys: [loc("t1")] }),
    (e) => e instanceof RoonMcpError && e.code === "ZONE_NOT_FOUND",
  );
});

/**
 * Subscription-backed playback stub. The pre-loaded snapshot reports the
 * previous track; the test fires a `Changed` event after the action so the
 * service reads the new track (not the pre-action one) — issue #1.
 */
function buildWithSubscription(): {
  svc: PlaybackService;
  push: (response: string, body: unknown) => void;
} {
  const browse = new FakeBrowse(
    { album: [action("Play Now", "act:play")] },
    new Set(["act:play"]),
  );
  const transport = new FakeTransport([ZONE]);
  let cb: ((response: string, body: unknown) => void) | undefined;
  const transportWithSub = {
    ...transport,
    subscribe_zones: (callback: (response: string, body: unknown) => void) => {
      cb = callback;
    },
  };
  const sub = new ZoneSubscription(
    transportWithSub as unknown as ConstructorParameters<typeof ZoneSubscription>[0],
    "core-1",
  );
  sub.start();
  // Pre-load the cache so the pre-fingerprint read comes from the
  // subscription, not a cold-start RPC.
  cb?.("Subscribed", { zones: [ZONE] });

  const stub = {
    waitForCore: async () => undefined,
    getBrowse: () => browse,
    getTransport: () => transport,
    getActiveSubscription: () => sub,
  } as unknown as RoonClient;
  const mgr = new BrowseSessionManager(stub);
  const zones = new ZoneService(stub);
  const tracks = new TrackExpansionService(mgr);
  const svc = new PlaybackService(mgr, zones, stub, tracks);
  return { svc, push: (r, b) => cb?.(r, b) };
}

test("play_now returns the new track in nowPlaying (issue #1)", async () => {
  // Reproduces the bug: the previous test pre-loaded "Some Track" into
  // ZONE. The subscription will push a Changed event with "Brand New Track"
  // before the service reads the post-action snapshot. With the wait-for-
  // change fix, nowPlaying should reflect the new track.
  const { svc, push } = buildWithSubscription();
  const newZone: RoonApiZone = {
    ...ZONE,
    state: "playing",
    now_playing: { two_line: { line1: "Brand New Track", line2: "Brand New Artist" } },
  };

  const out = await Promise.all([
    svc.playNow({ zoneId: "z1", itemKey: loc("album") }),
    new Promise<void>((r) =>
      setTimeout(() => {
        push("Changed", { zones_changed: [newZone] });
        r();
      }, 5),
    ),
  ]).then(([res]) => res);

  assert.equal(out.nowPlaying, "Brand New Track");
});

test("play_now still reports the previous track when no Changed event arrives", async () => {
  // On a slow Core where the subscription never pushes the new state,
  // the service should time out and return whatever is in the cache —
  // matching the legacy "may be stale" behavior. This pins the timeout
  // fallback so a misbehaving subscription can't hang the call.
  const { svc } = buildWithSubscription();
  const out = await svc.playNow({ zoneId: "z1", itemKey: loc("album") });
  assert.equal(out.nowPlaying, "Some Track");
});
