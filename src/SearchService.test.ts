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
import { decodeLocator } from "./locator.js";
import { RoonClient } from "./RoonClient.js";
import { SearchService } from "./SearchService.js";

interface GroupDef {
  title: string;
  key: string;
  items: BrowseItem[];
  failDrill?: boolean;
}

interface FakeOpts {
  messageOnInput?: string;
  failInputTimes?: number;
}

/** Minimal stateful model of Roon's search hierarchy (levels + a stack). */
class FakeBrowse {
  private stack: BrowseItem[][] = [];
  private inputCalls = 0;

  constructor(
    private readonly groups: GroupDef[],
    private readonly opts: FakeOpts = {},
  ) {}

  browse(o: BrowseOptions, cb: (e: string | false, b: BrowseResultBody) => void): void {
    if (o.pop_levels) {
      for (let i = 0; i < o.pop_levels; i++) this.stack.pop();
      return cb(false, { action: "list" });
    }
    // Real Roon takes `input` together with `pop_all` in one call; the input
    // branch resets the stack itself, so check it before a bare `pop_all`.
    if (o.input !== undefined) {
      this.inputCalls++;
      if (this.opts.failInputTimes && this.inputCalls <= this.opts.failInputTimes) {
        return cb("InvalidItemKey", undefined as unknown as BrowseResultBody);
      }
      if (this.opts.messageOnInput) {
        return cb(false, { action: "message", message: this.opts.messageOnInput });
      }
      this.stack = [
        this.groups.map((g) => ({ title: g.title, item_key: g.key, hint: "list" as const })),
      ];
      return cb(false, { action: "list" });
    }
    if (o.pop_all) {
      this.stack = [];
      return cb(false, { action: "list" });
    }
    if (o.item_key !== undefined) {
      const g = this.groups.find((x) => x.key === o.item_key);
      if (!g || g.failDrill) return cb("InvalidItemKey", undefined as unknown as BrowseResultBody);
      this.stack.push(g.items);
      return cb(false, { action: "list" });
    }
    return cb(false, { action: "none" });
  }

  load(o: LoadOptions, cb: (e: string | false, b: LoadResultBody) => void): void {
    const top = this.stack[this.stack.length - 1] ?? [];
    const offset = o.offset ?? 0;
    const items = top.slice(offset, offset + (o.count ?? 100));
    cb(false, { items, offset, list: { title: "", count: top.length, level: this.stack.length - 1 } });
  }
}

function buildService(groups: GroupDef[], opts?: FakeOpts): SearchService {
  const fake = new FakeBrowse(groups, opts);
  const stub = { waitForCore: async () => undefined, getBrowse: () => fake } as unknown as RoonClient;
  return new SearchService(new BrowseSessionManager(stub));
}

function item(title: string, key: string): BrowseItem {
  return { title, item_key: key, hint: "list" };
}

const ARTISTS: GroupDef = {
  title: "Artists",
  key: "g:artists",
  items: [item("Tycho", "a:tycho"), item("Tycho Brahe", "a:brahe")],
};
const ALBUMS: GroupDef = {
  title: "Albums",
  key: "g:albums",
  items: [item("Dive", "al:dive")],
};
const GENRES: GroupDef = {
  title: "Genres",
  key: "g:genres",
  items: [item("Dark Ambient", "ge:dark")],
};

test("searchMusic returns ranked candidates keyed by re-navigable locators", async () => {
  const svc = buildService([ARTISTS]);
  const out = await svc.searchMusic({ query: "Tycho" });
  assert.equal(out.broadened, false);
  assert.equal(out.candidates[0]?.title, "Tycho");
  assert.equal(out.candidates[0]?.type, "artist");
  assert.equal(out.candidates[0]?.sourceGroup, "Artists");
  // The itemKey is a locator carrying the query + group/item indices, not the
  // raw (ephemeral) Roon key.
  const decoded = decodeLocator(out.candidates[0]?.itemKey ?? "");
  assert.equal(decoded?.q, "Tycho");
  assert.equal(typeof decoded?.g, "number");
  assert.equal(decoded?.i, 0);
  // Exact title match ranks above the prefix match.
  assert.ok((out.candidates[0]?.score ?? 0) > (out.candidates[1]?.score ?? 0));
});

test("a type filter collects only the matching category", async () => {
  const svc = buildService([ARTISTS, ALBUMS, GENRES]);
  const out = await svc.searchMusic({ query: "Tycho", type: "artist" });
  assert.equal(out.broadened, false);
  assert.ok(out.candidates.length > 0);
  assert.ok(out.candidates.every((c) => c.type === "artist"));
});

test("a typed search with no matching items broadens to all categories", async () => {
  // No Playlists group at all → typed selection is empty → broaden.
  const svc = buildService([ARTISTS, ALBUMS, GENRES]);
  const out = await svc.searchMusic({ query: "Dark Ambient", type: "playlist" });
  assert.equal(out.broadened, true);
  assert.match(out.message ?? "", /broadened/i);
  assert.equal(out.candidates[0]?.title, "Dark Ambient");
});

test("limit caps the number of returned candidates", async () => {
  const many: GroupDef = {
    title: "Tracks",
    key: "g:tracks",
    items: Array.from({ length: 20 }, (_, i) => item(`Track ${i}`, `t:${i}`)),
  };
  const svc = buildService([many]);
  const out = await svc.searchMusic({ query: "Track", limit: 5 });
  assert.equal(out.candidates.length, 5);
});

test("a message action yields an empty result without throwing", async () => {
  const svc = buildService([ARTISTS], { messageOnInput: "No results found." });
  const out = await svc.searchMusic({ query: "zzz" });
  assert.deepEqual(out.candidates, []);
  assert.equal(out.message, "No results found.");
});

test("a single failing group is skipped, others still return", async () => {
  const svc = buildService([{ ...ARTISTS, failDrill: true }, GENRES]);
  const out = await svc.searchMusic({ query: "Dark Ambient" });
  assert.ok(out.candidates.some((c) => c.title === "Dark Ambient"));
  assert.ok(out.candidates.every((c) => c.title !== "Tycho"));
});

test("an InvalidItemKey on submit triggers one reset-and-retry", async () => {
  const svc = buildService([ARTISTS], { failInputTimes: 1 });
  const out = await svc.searchMusic({ query: "Tycho" });
  assert.equal(out.candidates[0]?.title, "Tycho");
});
