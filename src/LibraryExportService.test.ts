import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
  BrowseItem,
  BrowseOptions,
  BrowseResultBody,
  LoadOptions,
  LoadResultBody,
} from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { LibraryExportService } from "./LibraryExportService.js";
import { RoonClient } from "./RoonClient.js";
import { RoonMcpError } from "./types.js";

function tempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "export-"));
  return { path: join(dir, "snapshot.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const album = (n: number, bare = false): BrowseItem => ({
  title: `Album ${n}`,
  ...(bare ? {} : { subtitle: `Artist ${n}`, image_key: `img-${n}` }),
  item_key: `70:${n}`,
  hint: "list",
});

interface FakeOpts {
  /** Albums the list actually serves. */
  total: number;
  /** Total Roon claims in the list header (defaults to `total`). */
  reportedCount?: number;
  /** Serve no `list` header anywhere, so the total is unknown. */
  noListHeader?: boolean;
  /** Album rows without subtitle/image_key. */
  bareAlbums?: boolean;
  /** Leave "Library" out of the browse root. */
  noLibrary?: boolean;
  /** Answer the first N drills into a level with `action: "message"` (a Core hiccup). */
  messageOn?: { lib?: number; alb?: number };
  /** Reject the first load at this offset with InvalidItemKey (a stale session mid-walk). */
  staleAtOffset?: number;
  /** Answer the root `pop_all` with `action: "none"` (a no-op reset; within contract). */
  rootResetNone?: boolean;
  /** Clamp an out-of-range load offset back to 0, echoing the served offset (a misbehaving Core). */
  clampOffsets?: boolean;
}

/**
 * Stateful model of Roon's `browse` hierarchy (root → Library → Albums) at the
 * node-roon-api-browse seam, driven through a REAL BrowseSessionManager like
 * the other browse tests, so the lock and the reset+replay path are exercised
 * rather than stubbed. Records load offsets and root resets so paging and
 * replays can be asserted.
 */
class FakeBrowse {
  level: "root" | "library" | "albums" = "root";
  offsets: number[] = [];
  rootResets = 0;
  searchResets = 0;
  private readonly messageOn: { lib: number; alb: number };
  private staleFired = false;

  constructor(private readonly opts: FakeOpts) {
    this.messageOn = { lib: opts.messageOn?.lib ?? 0, alb: opts.messageOn?.alb ?? 0 };
  }

  browse(o: BrowseOptions, cb: (e: string | false, b: BrowseResultBody) => void): void {
    if (o.hierarchy === "search") {
      this.searchResets++;
      return cb(false, { action: "list" });
    }
    if (o.pop_all) {
      this.rootResets++;
      this.level = "root";
      if (this.opts.rootResetNone) return cb(false, { action: "none" });
      return cb(false, this.list("Explore", 6, 0));
    }
    if (o.item_key === "lib") {
      if (this.messageOn.lib-- > 0) return cb(false, { action: "message", message: "Core busy", is_error: true });
      this.level = "library";
      return cb(false, this.list("Library", 6, 1));
    }
    if (o.item_key === "alb") {
      if (this.messageOn.alb-- > 0) return cb(false, { action: "message", message: "Core busy", is_error: true });
      this.level = "albums";
      return cb(false, this.list("Albums", this.reported, 2));
    }
    return cb(false, { action: "none" });
  }

  load(o: LoadOptions, cb: (e: string | false, b: LoadResultBody) => void): void {
    if (this.level === "root") {
      const rows: BrowseItem[] = this.opts.noLibrary
        ? [{ title: "Playlists", item_key: "p", hint: "list" }]
        : [{ title: "Library", item_key: "lib", hint: "list" }];
      return cb(false, this.page(rows, 6, 0));
    }
    if (this.level === "library") {
      // All drillable list rows with keys — exactly what `isAlbumRow` accepts.
      return cb(
        false,
        this.page(
          [
            { title: "Artists", item_key: "art", hint: "list" },
            { title: "Albums", item_key: "alb", hint: "list" },
            { title: "Composers", item_key: "cmp", hint: "list" },
            { title: "Genres", item_key: "gen", hint: "list" },
          ],
          6,
          0,
        ),
      );
    }
    const requested = o.offset ?? 0;
    this.offsets.push(requested);
    if (requested === this.opts.staleAtOffset && !this.staleFired) {
      this.staleFired = true;
      return cb("InvalidItemKey", undefined as unknown as LoadResultBody);
    }
    const offset = this.opts.clampOffsets && requested >= this.opts.total ? 0 : requested;
    const items: BrowseItem[] = [];
    for (let i = offset; i < Math.min(offset + (o.count ?? 100), this.opts.total); i++) {
      items.push(album(i, this.opts.bareAlbums));
    }
    // Echoes the offset actually served, as the real load result does.
    cb(false, this.page(items, this.reported, offset));
  }

  private get reported(): number {
    return this.opts.reportedCount ?? this.opts.total;
  }

  private list(title: string, count: number, level: number): BrowseResultBody {
    return this.opts.noListHeader ? { action: "list" } : { action: "list", list: { title, count, level } };
  }

  private page(items: BrowseItem[], count: number, offset: number): LoadResultBody {
    // `list` is typed as always present; the no-header case models a Core that
    // leaves it out, which the service must survive.
    if (this.opts.noListHeader) return { items, offset } as LoadResultBody;
    return { items, offset, list: { title: "x", count, level: 2 } };
  }
}

function build(opts: FakeOpts): { svc: LibraryExportService; fake: FakeBrowse } {
  const fake = new FakeBrowse(opts);
  const stub = { waitForCore: async () => undefined, getBrowse: () => fake } as unknown as RoonClient;
  return { svc: new LibraryExportService(new BrowseSessionManager(stub), () => "2026-07-12T00:00:00.000Z"), fake };
}

test("exports every album across multiple pages, writing the contract snapshot", async () => {
  const { path, cleanup } = tempPath();
  try {
    const { svc, fake } = build({ total: 250 });
    const result = await svc.export({ path });

    // The service returns the full tool result shape — no frontend reshaping.
    assert.equal(result.status, "ok");
    assert.equal(result.path, path);
    assert.equal(typeof result.durationMs, "number");
    assert.equal(result.albumCount, 250);
    assert.equal(result.expectedCount, 250);
    assert.equal(result.warning, undefined);
    // Paged at 0, 100, 200 (PAGE=100); one walk from the root.
    assert.deepEqual(fake.offsets, [0, 100, 200]);
    assert.equal(fake.rootResets, 1);

    const snap = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(snap.schemaVersion, 1);
    assert.equal(snap.exportedAt, "2026-07-12T00:00:00.000Z");
    assert.equal(snap.source, "roon");
    assert.equal(snap.kind, "albums");
    assert.equal(snap.albumCount, 250);
    assert.equal(snap.albums.length, 250);
    assert.deepEqual(snap.albums[0], {
      album: "Album 0",
      artist: "Artist 0",
      raw: { title: "Album 0", subtitle: "Artist 0", itemKey: "70:0", imageKey: "img-0" },
    });
  } finally {
    cleanup();
  }
});

test("limit caps the export and suppresses the count-mismatch warning", async () => {
  const { path, cleanup } = tempPath();
  try {
    const { svc } = build({ total: 250 });
    const result = await svc.export({ path, limit: 5 });
    assert.equal(result.albumCount, 5);
    assert.equal(result.warning, undefined, "a deliberate limit is not a mismatch");
    const snap = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(snap.albums.length, 5);
  } finally {
    cleanup();
  }
});

test("warns when the collected count differs from Roon's reported total", async () => {
  const { path, cleanup } = tempPath();
  try {
    // Roon claims 300 but only 3 albums actually stream in.
    const { svc } = build({ total: 3, reportedCount: 300 });
    const result = await svc.export({ path });
    assert.equal(result.albumCount, 3);
    assert.equal(result.expectedCount, 300);
    assert.match(result.warning ?? "", /Collected 3 albums but Roon reported 300/);
  } finally {
    cleanup();
  }
});

test("a missing list header keeps paging until an empty page, and warns that the total was unknown", async () => {
  const { path, cleanup } = tempPath();
  try {
    const { svc, fake } = build({ total: 250, noListHeader: true });
    const result = await svc.export({ path });
    // Not 100: an unknown total must not end the walk after the first page.
    assert.equal(result.albumCount, 250);
    assert.equal(result.expectedCount, undefined);
    assert.match(result.warning ?? "", /reported no album total/);
    // The short page at 200 ends the walk; no extra empty load.
    assert.deepEqual(fake.offsets, [0, 100, 200]);
    const snap = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(snap.albums.length, 250);
  } finally {
    cleanup();
  }
});

test("a drill that does not open a list never exports the menu it was left on", async () => {
  const { path, cleanup } = tempPath();
  try {
    // The Albums drill answers `action: "message"` on both the walk and its replay.
    const { svc, fake } = build({ total: 3, messageOn: { alb: 2 } });
    await assert.rejects(
      () => svc.export({ path }),
      (e: unknown) =>
        e instanceof RoonMcpError && e.code === "INVALID_ITEM_KEY" && /Albums did not open a list/.test(e.message),
    );
    // Retried exactly once (reset + replay), then given up. The reset pops the
    // `search` hierarchy (BrowseSessionManager.resetSearchHierarchy) although
    // this walk lives in `browse`; that is harmless only because walkAlbums
    // re-pops `browse` itself. Pinned so a change to the reset shows up here.
    assert.equal(fake.rootResets, 2);
    assert.equal(fake.searchResets, 1);
    assert.deepEqual(fake.offsets, [], "no album page was ever loaded");
    assert.deepEqual(readdirSync(join(path, "..")), [], "nothing was written");
  } finally {
    cleanup();
  }
});

test("a transient non-list drill is recovered by the reset+replay", async () => {
  const { path, cleanup } = tempPath();
  try {
    const { svc, fake } = build({ total: 3, messageOn: { lib: 1 } });
    const result = await svc.export({ path });
    assert.equal(result.albumCount, 3);
    assert.equal(fake.rootResets, 2, "the walk was replayed from the root");
    const snap = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(
      snap.albums.map((a: { album: string }) => a.album),
      ["Album 0", "Album 1", "Album 2"],
    );
  } finally {
    cleanup();
  }
});

test("an INVALID_ITEM_KEY mid-walk is recovered by the reset+replay", async () => {
  const { path, cleanup } = tempPath();
  try {
    const { svc, fake } = build({ total: 250, staleAtOffset: 100 });
    const result = await svc.export({ path });
    assert.equal(result.albumCount, 250);
    assert.equal(result.warning, undefined);
    // First walk dies at offset 100; the replay starts over from the root.
    assert.deepEqual(fake.offsets, [0, 100, 0, 100, 200]);
    assert.equal(fake.rootResets, 2);
    const snap = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(snap.albums.length, 250, "no duplicates from the abandoned first walk");
  } finally {
    cleanup();
  }
});

test("a Core that clamps an out-of-range offset cannot pad the snapshot with duplicates", async () => {
  const { path, cleanup } = tempPath();
  try {
    // Roon advertises 300 but serves 100; the request for offset 100 comes back as page 0.
    const { svc, fake } = build({ total: 100, reportedCount: 300, clampOffsets: true });
    await assert.rejects(
      () => svc.export({ path }),
      (e: unknown) =>
        e instanceof RoonMcpError &&
        e.code === "BROWSE_FAILED" &&
        /served page offset 0 for requested offset 100/.test(e.message),
    );
    assert.deepEqual(fake.offsets, [0, 100], "bails on the first mismatched page");
    assert.deepEqual(readdirSync(join(path, "..")), [], "nothing was written");
  } finally {
    cleanup();
  }
});

test("a clamping Core cannot page without limit when the total is unknown either", async () => {
  const { path, cleanup } = tempPath();
  try {
    const { svc, fake } = build({ total: 100, noListHeader: true, clampOffsets: true });
    await assert.rejects(
      () => svc.export({ path }),
      (e: unknown) => e instanceof RoonMcpError && e.code === "BROWSE_FAILED",
    );
    assert.deepEqual(fake.offsets, [0, 100], "bounded: the second load is the last");
  } finally {
    cleanup();
  }
});

test("an unknown total that is an exact multiple of the page size ends on the empty page", async () => {
  const { path, cleanup } = tempPath();
  try {
    const { svc, fake } = build({ total: 200, noListHeader: true });
    const result = await svc.export({ path });
    assert.equal(result.albumCount, 200);
    assert.deepEqual(fake.offsets, [0, 100, 200]);
  } finally {
    cleanup();
  }
});

test('a root reset answered with action "none" is tolerated', async () => {
  const { path, cleanup } = tempPath();
  try {
    const { svc, fake } = build({ total: 3, rootResetNone: true });
    const result = await svc.export({ path });
    assert.equal(result.albumCount, 3);
    assert.equal(fake.rootResets, 1, "no replay was needed");
  } finally {
    cleanup();
  }
});

test("an empty library exports an empty snapshot without a warning", async () => {
  const { path, cleanup } = tempPath();
  try {
    const { svc, fake } = build({ total: 0 });
    const result = await svc.export({ path });
    assert.equal(result.albumCount, 0);
    assert.equal(result.expectedCount, 0);
    assert.equal(result.warning, undefined);
    assert.deepEqual(fake.offsets, [0]);
    const snap = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(snap.albumCount, 0);
    assert.deepEqual(snap.albums, []);
  } finally {
    cleanup();
  }
});

test("writes atomically: no leftover temp file, valid final file", async () => {
  const { path, cleanup } = tempPath();
  try {
    const { svc } = build({ total: 10 });
    await svc.export({ path });
    const entries = readdirSync(join(path, ".."));
    assert.deepEqual(entries, ["snapshot.json"], "only the final file remains (no .tmp)");
    JSON.parse(readFileSync(path, "utf8")); // parses = not truncated
  } finally {
    cleanup();
  }
});

test("a failed write leaves no temp file behind", async () => {
  const { path, cleanup } = tempPath();
  try {
    mkdirSync(path); // `path` is now an existing directory, so the final rename fails
    const { svc } = build({ total: 3 });
    await assert.rejects(() => svc.export({ path }));
    assert.deepEqual(readdirSync(join(path, "..")), ["snapshot.json"], "no .tmp beside the target");
    assert.deepEqual(readdirSync(path), [], "nothing inside it either");
  } finally {
    cleanup();
  }
});

test("throws BROWSE_FAILED when the Library entry is absent", async () => {
  const { path, cleanup } = tempPath();
  try {
    const { svc } = build({ total: 0, noLibrary: true });
    await assert.rejects(
      () => svc.export({ path }),
      (e: unknown) => e instanceof RoonMcpError && e.code === "BROWSE_FAILED",
    );
  } finally {
    cleanup();
  }
});

test("omits artist/imageKey when the browse item lacks them", async () => {
  const { path, cleanup } = tempPath();
  try {
    const { svc } = build({ total: 1, bareAlbums: true });
    await svc.export({ path });
    const snap = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(snap.albums[0], {
      album: "Album 0",
      raw: { title: "Album 0", itemKey: "70:0" },
    });
  } finally {
    cleanup();
  }
});
