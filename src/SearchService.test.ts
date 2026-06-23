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
import { GenreService } from "./GenreService.js";
import { decodeLocator, isGenreLocator } from "./locator.js";
import { RoonClient } from "./RoonClient.js";
import { SearchService } from "./SearchService.js";
import { TrackExpansionService } from "./TrackExpansionService.js";

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
    // item_key → child rows, for drilling below the top groups (e.g. an album's
    // track list). Lets the streaming-genre path expand albums into tracks.
    private readonly drills: Record<string, BrowseItem[]> = {},
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
      if (g && !g.failDrill) {
        this.stack.push(g.items);
        return cb(false, { action: "list" });
      }
      const drilled = this.drills[o.item_key];
      if (drilled) {
        this.stack.push(drilled);
        return cb(false, { action: "list" });
      }
      return cb("InvalidItemKey", undefined as unknown as BrowseResultBody);
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

function buildService(
  groups: GroupDef[],
  opts?: FakeOpts,
  drills?: Record<string, BrowseItem[]>,
): SearchService {
  const fake = new FakeBrowse(groups, opts, drills);
  const stub = { waitForCore: async () => undefined, getBrowse: () => fake } as unknown as RoonClient;
  const browse = new BrowseSessionManager(stub);
  return new SearchService(browse, new GenreService(browse), new TrackExpansionService(browse));
}

function item(title: string, key: string): BrowseItem {
  return { title, item_key: key, hint: "list" };
}

/** A track leaf (no "list" hint, so it's a playable row, not a container). */
function leaf(title: string, key: string): BrowseItem {
  return { title, item_key: key };
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
  assert.ok(decoded && !isGenreLocator(decoded));
  assert.equal(decoded.q, "Tycho");
  assert.equal(typeof decoded.g, "number");
  assert.equal(decoded.i, 0);
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

test("type:genre is resolved via the genres tree, not broadened to artists", async () => {
  // The flat-search fake has no genres tree, so resolution yields no genres —
  // crucially it must NOT silently broaden back to the artist/album groups.
  const svc = buildService([ARTISTS, ALBUMS, GENRES]);
  const out = await svc.searchMusic({ query: "Dark Ambient", type: "genre" });
  assert.equal(out.broadened, false);
  assert.deepEqual(out.candidates, []);
  assert.match(out.message ?? "", /No results for/i);
});

test("includeStreaming samples a track mix across genre-relevant albums", async () => {
  const albums: GroupDef = {
    title: "Albums",
    key: "g:albums",
    items: [leaf("Selected Ambient Works", "al:saw"), leaf("Ambient Avenue", "al:ave")],
  };
  // Each album drills into its own track list.
  const drills = {
    "al:saw": [leaf("Xtal", "t:xtal"), leaf("Ageispolis", "t:age")],
    "al:ave": [leaf("Fire Ant", "t:fire"), leaf("Jealous", "t:jeal")],
  };
  const svc = buildService([albums], undefined, drills);
  const out = await svc.searchMusic({ query: "Ambient", type: "genre", includeStreaming: true });

  // No library genre tree in the fake, so the candidates are purely streaming.
  assert.ok(out.candidates.length > 0);
  assert.ok(out.candidates.every((c) => c.type === "track"));
  assert.ok(out.candidates.every((c) => c.sourceGroup === "Streaming"));

  // The mix spreads across both albums (locator `i` is the album index), not
  // just the first — that's the whole point versus returning one album.
  const albumIndices = new Set(
    out.candidates.map((c) => {
      const loc = decodeLocator(c.itemKey);
      assert.ok(loc && !isGenreLocator(loc) && typeof loc.t === "number");
      return loc.i;
    }),
  );
  assert.ok(albumIndices.size >= 2);
});

test("includeStreaming for type:artist appends streaming tracks by that artist", async () => {
  // Mirrors the live "Helene Fischer" scenario from issue #2: the artist
  // exists in the library with subtitle "0 Albums", and streaming-side tracks
  // for the same artist surface from a track search. The artist search
  // returns the (empty) library node; the streaming path runs a track search
  // filtered to that artist's subtitle.
  const artists: GroupDef = {
    title: "Artists",
    key: "g:artists",
    items: [{ ...item("Helene Fischer", "a:hf"), subtitle: "0 Albums" }],
  };
  const tracks: GroupDef = {
    title: "Tracks",
    key: "g:tracks",
    items: [
      { title: "Atemlos durch die Nacht", item_key: "tk:1", subtitle: "Helene Fischer" },
      { title: "Herzbeben", item_key: "tk:2", subtitle: "Helene Fischer" },
      { title: "Other Artist Song", item_key: "tk:3", subtitle: "Other Artist" },
    ],
  };
  const svc = buildService([artists, tracks]);
  const out = await svc.searchMusic({
    query: "Helene Fischer",
    type: "artist",
    includeStreaming: true,
  });

  // Library artist comes first, then streaming tracks by the same artist.
  // Other-artist entries are filtered out by the subtitle match in
  // collectStreamingArtistTracks.
  assert.equal(out.candidates[0]?.title, "Helene Fischer");
  assert.equal(out.candidates[0]?.sourceGroup, "Artists");
  const streaming = out.candidates.filter((c) => c.sourceGroup === "Streaming");
  assert.equal(streaming.length, 2);
  assert.ok(streaming.every((c) => c.type === "track"));
  assert.ok(streaming.every((c) => c.subtitle === "Helene Fischer"));
  assert.ok(streaming.every((c) => c.title !== "Other Artist Song"));
  assert.match(out.message ?? "", /no library albums/i);
  assert.match(out.message ?? "", /includeStreaming/i);
});

test("an artist with 0 Albums surfaces a hint to pass includeStreaming", async () => {
  const empty: GroupDef = {
    title: "Artists",
    key: "g:artists",
    items: [item("Helene Fischer", "a:hf")],
  };
  // The fake's `item()` doesn't set a subtitle; override to "0 Albums" so the
  // diagnostic in performSearch fires.
  empty.items[0]!.subtitle = "0 Albums";
  const svc = buildService([empty]);
  const out = await svc.searchMusic({ query: "Helene Fischer", type: "artist" });

  assert.equal(out.candidates[0]?.title, "Helene Fischer");
  assert.match(out.message ?? "", /no library albums/i);
  assert.match(out.message ?? "", /includeStreaming/i);
});

test("streaming-artist results are budgeted against limit so the total never exceeds it (issue #8)", async () => {
  const artists: GroupDef = {
    title: "Artists",
    key: "g:artists",
    items: [{ ...item("Tycho", "a:tycho"), subtitle: "0 Albums" }],
  };
  const tracks: GroupDef = {
    title: "Tracks",
    key: "g:tracks",
    items: Array.from({ length: 10 }, (_, i) => ({
      title: `Song ${i}`,
      item_key: `tk:${i}`,
      subtitle: "Tycho",
    })),
  };
  const svc = buildService([artists, tracks]);
  const out = await svc.searchMusic({ query: "Tycho", type: "artist", includeStreaming: true, limit: 3 });

  // 1 library artist + a streaming budget of (limit - 1) = 2 streaming tracks.
  // The combined result must respect `limit`, not return up to 2×limit.
  const streaming = out.candidates.filter((c) => c.sourceGroup === "Streaming");
  assert.equal(streaming.length, 2);
  assert.ok(out.candidates.length <= 3, `expected ≤3 total candidates, got ${out.candidates.length}`);
  assert.equal(out.candidates[0]?.sourceGroup, "Artists");
  assert.equal(out.candidates[0]?.title, "Tycho");
});

test("streaming-genre results are budgeted against limit so the total never exceeds it (issue #8)", async () => {
  // No library genre tree → libraryGenres is empty, so the full `limit` is the
  // streaming budget and the result must not exceed it.
  const albums: GroupDef = {
    title: "Albums",
    key: "g:albums",
    items: Array.from({ length: 5 }, (_, i) => leaf(`Album ${i}`, `al:${i}`)),
  };
  const drills: Record<string, BrowseItem[]> = {};
  for (let i = 0; i < 5; i++) {
    drills[`al:${i}`] = Array.from({ length: 5 }, (_, t) => leaf(`Track ${i}-${t}`, `t:${i}-${t}`));
  }
  const svc = buildService([albums], undefined, drills);
  const out = await svc.searchMusic({ query: "Album", type: "genre", includeStreaming: true, limit: 4 });
  assert.ok(out.candidates.length <= 4, `expected ≤4 total candidates, got ${out.candidates.length}`);
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
