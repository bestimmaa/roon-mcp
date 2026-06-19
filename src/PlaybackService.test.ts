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
import { PlaybackService } from "./PlaybackService.js";
import { RoonClient } from "./RoonClient.js";
import { RoonMcpError } from "./types.js";
import { ZoneService } from "./ZoneService.js";

/** A node the play drill lands on: either a child list or a terminal message. */
type DrillResult = BrowseItem[] | { message: string };

interface PlayOpts {
  failActionTimes?: number;
}

/** Minimal stateful model of the play drill: drill into keys, invoke actions. */
class FakeBrowse {
  private stack: BrowseItem[][] = [];
  readonly invocations: Array<{ itemKey: string; zone?: string }> = [];
  private failActionRemaining: number;

  constructor(
    private readonly drills: Record<string, DrillResult>,
    private readonly actionKeys: Set<string>,
    opts: PlayOpts = {},
  ) {
    this.failActionRemaining = opts.failActionTimes ?? 0;
  }

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
      if (this.actionKeys.has(o.item_key)) {
        if (this.failActionRemaining > 0) {
          this.failActionRemaining--;
          return cb(false, { action: "message", is_error: true, message: "ActionFailed" });
        }
        this.invocations.push({ itemKey: o.item_key, zone: o.zone_or_output_id });
        return cb(false, { action: "none" });
      }
      const target = this.drills[o.item_key];
      if (target === undefined) {
        return cb("InvalidItemKey", undefined as unknown as BrowseResultBody);
      }
      if (Array.isArray(target)) {
        this.stack.push(target);
        return cb(false, { action: "list" });
      }
      return cb(false, { action: "message", message: target.message });
    }
    return cb(false, { action: "none" });
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
  drills: Record<string, DrillResult>,
  actionKeys: string[],
  opts: { transport?: FakeTransport; playOpts?: PlayOpts } = {},
) {
  const browse = new FakeBrowse(drills, new Set(actionKeys), opts.playOpts);
  const transport = opts.transport ?? new FakeTransport([ZONE]);
  const stub = {
    waitForCore: async () => undefined,
    getBrowse: () => browse,
    getTransport: () => transport,
  } as unknown as RoonClient;
  const zones = new ZoneService(stub);
  const svc = new PlaybackService(new BrowseSessionManager(stub), zones, stub);
  return { svc, browse, transport };
}

test("play_now discovers and invokes the Play Now action against the zone", async () => {
  const { svc, browse } = build(
    { "album:1": [action("Play Now", "act:play"), action("Queue", "act:queue")] },
    ["act:play", "act:queue"],
  );

  const out = await svc.playNow({ zoneId: "z1", itemKey: "album:1" });

  assert.equal(out.ok, true);
  assert.equal(out.queued, 1);
  assert.deepEqual(out.skipped, []);
  assert.equal(out.nowPlaying, "Some Track");
  assert.deepEqual(browse.invocations, [{ itemKey: "act:play", zone: "z1" }]);
});

test("shuffle prefers a Shuffle action over Play Now and skips the Transport fallback", async () => {
  const { svc, browse, transport } = build(
    { "album:1": [action("Play Now", "act:play"), action("Shuffle", "act:shuffle")] },
    ["act:play", "act:shuffle"],
  );

  const out = await svc.playNow({ zoneId: "z1", itemKey: "album:1", shuffle: true });

  assert.equal(browse.invocations[0]?.itemKey, "act:shuffle");
  assert.deepEqual(transport.shuffleCalls, []);
  assert.doesNotMatch(out.message ?? "", /could not be applied/i);
});

test("shuffle falls back to the Transport setting when no shuffle action exists", async () => {
  const { svc, browse, transport } = build(
    { "album:1": [action("Play Now", "act:play")] },
    ["act:play"],
  );

  const out = await svc.playNow({ zoneId: "z1", itemKey: "album:1", shuffle: true });

  assert.equal(browse.invocations[0]?.itemKey, "act:play");
  assert.deepEqual(transport.shuffleCalls, [{ zone: "z1", shuffle: true }]);
  assert.doesNotMatch(out.message ?? "", /could not be applied/i);
});

test("shuffle reports when it cannot be applied (no action, Transport unsupported)", async () => {
  const transport = new FakeTransport([ZONE], false);
  const { svc } = build(
    { "album:1": [action("Play Now", "act:play")] },
    ["act:play"],
    { transport },
  );

  const out = await svc.playNow({ zoneId: "z1", itemKey: "album:1", shuffle: true });

  assert.equal(out.ok, true);
  assert.match(out.message ?? "", /could not be applied/i);
});

test("an unknown zone id is rejected with ZONE_NOT_FOUND", async () => {
  const { svc } = build({ "album:1": [action("Play Now", "act:play")] }, ["act:play"]);
  await assert.rejects(
    svc.playNow({ zoneId: "nope", itemKey: "album:1" }),
    (e) => e instanceof RoonMcpError && e.code === "ZONE_NOT_FOUND",
  );
});

test("an output id is accepted as the playback target", async () => {
  const { svc, browse } = build(
    { "album:1": [action("Play Now", "act:play")] },
    ["act:play"],
  );
  const out = await svc.playNow({ zoneId: "o1", itemKey: "album:1" });
  assert.equal(out.ok, true);
  assert.equal(browse.invocations[0]?.zone, "o1");
});

test("an item with no play action yields NO_PLAY_ACTION", async () => {
  const { svc } = build(
    { "album:1": [{ title: "Tracks", item_key: "x", hint: "list" }] },
    [],
  );
  await assert.rejects(
    svc.playNow({ zoneId: "z1", itemKey: "album:1" }),
    (e) => e instanceof RoonMcpError && e.code === "NO_PLAY_ACTION",
  );
});

test("a non-playable item (message action) yields NO_PLAY_ACTION", async () => {
  const { svc } = build({ "album:1": { message: "Not available." } }, []);
  await assert.rejects(
    svc.playNow({ zoneId: "z1", itemKey: "album:1" }),
    (e) =>
      e instanceof RoonMcpError &&
      e.code === "NO_PLAY_ACTION" &&
      /not available/i.test(e.message),
  );
});

test("actions nested under an action_list container are found", async () => {
  const { svc, browse } = build(
    {
      "album:1": [{ title: "More", item_key: "al:more", hint: "action_list" }],
      "al:more": [action("Play Now", "act:play")],
    },
    ["act:play"],
  );
  const out = await svc.playNow({ zoneId: "z1", itemKey: "album:1" });
  assert.equal(out.ok, true);
  assert.equal(browse.invocations[0]?.itemKey, "act:play");
});

test("a failed action invocation reopens the item and retries once", async () => {
  const { svc, browse } = build(
    { "album:1": [action("Play Now", "act:play")] },
    ["act:play"],
    { playOpts: { failActionTimes: 1 } },
  );
  const out = await svc.playNow({ zoneId: "z1", itemKey: "album:1" });
  assert.equal(out.ok, true);
  // Only the successful retry is recorded as an invocation.
  assert.deepEqual(browse.invocations, [{ itemKey: "act:play", zone: "z1" }]);
});
