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

/** A node in the fake `genres` tree. */
interface GNode {
  title: string;
  key: string;
  subtitle?: string;
  hint?: BrowseItem["hint"];
  children?: GNode[];
}

function genre(title: string, key: string, subtitle: string, children: GNode[] = []): GNode {
  return { title, key, subtitle, hint: "list", children };
}

/**
 * Stateful model of Roon's `genres` hierarchy: a tree of nodes navigated by a
 * level stack, mirroring how GenreService drills (browse item_key → push,
 * pop_levels → pop). Counts root resets so we can assert the index is cached.
 */
class FakeGenres {
  private stack: GNode[][] = [];
  rootResets = 0;

  constructor(private readonly root: GNode[]) {}

  browse(o: BrowseOptions, cb: (e: string | false, b: BrowseResultBody) => void): void {
    if (o.pop_levels) {
      for (let i = 0; i < o.pop_levels; i++) this.stack.pop();
      return cb(false, { action: "list" });
    }
    if (o.pop_all) {
      this.rootResets++;
      this.stack = [this.root];
      return cb(false, { action: "list" });
    }
    if (o.item_key !== undefined) {
      const top = this.stack[this.stack.length - 1] ?? [];
      const node = top.find((n) => n.key === o.item_key);
      if (!node) return cb("InvalidItemKey", undefined as unknown as BrowseResultBody);
      this.stack.push(node.children ?? []);
      return cb(false, { action: "list" });
    }
    return cb(false, { action: "none" });
  }

  load(o: LoadOptions, cb: (e: string | false, b: LoadResultBody) => void): void {
    const top = this.stack[this.stack.length - 1] ?? [];
    const items: BrowseItem[] = top.map((n) => ({
      title: n.title,
      item_key: n.key,
      subtitle: n.subtitle,
      hint: n.hint ?? "list",
    }));
    cb(false, { items, offset: o.offset ?? 0, list: { title: "", count: items.length, level: 0 } });
  }
}

// Electronic → (Artists container, Trance → {Psytrance, Progressive Trance}, House); Jazz.
function buildTree(): GNode[] {
  return [
    {
      ...genre("Electronic", "g:elec", "229 Artists, 358 Albums", [
        // A within-genre container: list hint but no "N Artists" subtitle → not a genre.
        { title: "Artists", key: "c:elec-artists", hint: "list" },
        genre("Trance", "g:trance", "23 Artists, 22 Albums", [
          genre("Psytrance", "g:psy", "0 Artists, 4 Albums"),
          genre("Progressive Trance", "g:prog", "9 Artists, 4 Albums"),
        ]),
        genre("House", "g:house", "59 Artists, 40 Albums"),
      ]),
    },
    genre("Jazz", "g:jazz", "5 Artists, 3 Albums"),
  ];
}

function buildService(): { svc: GenreService; fake: FakeGenres } {
  const fake = new FakeGenres(buildTree());
  const stub = { waitForCore: async () => undefined, getBrowse: () => fake } as unknown as RoonClient;
  return { svc: new GenreService(new BrowseSessionManager(stub)), fake };
}

test("walks the genre tree and surfaces nested sub-genres with their path", async () => {
  const { svc } = buildService();
  const out = await svc.searchGenres("Psytrance", 10);

  const psy = out.find((c) => c.title === "Psytrance");
  assert.ok(psy, "Psytrance should be found");
  assert.equal(psy!.type, "genre");
  assert.equal(psy!.subtitle, "Electronic › Trance › Psytrance");
  assert.equal(psy!.sourceGroup, "Genres");
  assert.equal(psy!.score, 1); // exact title match

  // The itemKey is a genre locator carrying the node path.
  const loc = decodeLocator(psy!.itemKey ?? "");
  assert.ok(loc && isGenreLocator(loc));
  assert.deepEqual(loc.ge, ["Electronic", "Trance", "Psytrance"]);
});

test("the 'Artists'/'Albums' containers inside a genre page are not indexed", async () => {
  const { svc } = buildService();
  const out = await svc.searchGenres("Artists", 10);
  assert.ok(!out.some((c) => c.title === "Artists"));
});

test("a fuzzy query returns ranked near-matches (psychedelic trance → psytrance, trance)", async () => {
  const { svc } = buildService();
  const out = await svc.searchGenres("Psychedelic Trance", 10);

  const titles = out.map((c) => c.title);
  assert.ok(titles.includes("Psytrance"), "Psytrance should be a near-match");
  assert.ok(titles.includes("Trance"), "Trance should be a near-match");
  // Psytrance (shares the "trance" token and a "psy" prefix) outranks the bare
  // parent "Trance" (token-only match).
  const psyRank = titles.indexOf("Psytrance");
  const tranceRank = titles.indexOf("Trance");
  assert.ok(psyRank < tranceRank, "Psytrance should rank above Trance");
  // No exact node named "Psychedelic Trance": all scores are below 1.
  assert.ok(out.every((c) => c.score < 1));
});

test("an exact top-level genre matches with score 1", async () => {
  const { svc } = buildService();
  const out = await svc.searchGenres("Jazz", 10);
  assert.equal(out[0]?.title, "Jazz");
  assert.equal(out[0]?.score, 1);
});

test("a query that matches nothing returns no candidates", async () => {
  const { svc } = buildService();
  const out = await svc.searchGenres("Polka", 10);
  assert.deepEqual(out, []);
});

test("the genre index is built once and reused across searches", async () => {
  const { svc, fake } = buildService();
  await svc.searchGenres("Trance", 10);
  await svc.searchGenres("Jazz", 10);
  assert.equal(fake.rootResets, 1, "the tree should be walked only once (cached)");
});
