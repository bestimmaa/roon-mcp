import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { BrowseItem, BrowseResultBody, LoadResultBody } from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { LibraryExportService } from "./LibraryExportService.js";
import { RoonMcpError } from "./types.js";

function tempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "export-"));
  return { path: join(dir, "snapshot.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const album = (n: number): BrowseItem => ({
  title: `Album ${n}`,
  subtitle: `Artist ${n}`,
  image_key: `img-${n}`,
  item_key: `70:${n}`,
  hint: "list",
});

/**
 * A fake BrowseSessionManager that models Library → Albums navigation and pages
 * a synthetic album list of `total` albums (PAGE=100 in the service). Records
 * the load offsets it was asked for so paging can be asserted.
 */
function fakeBrowse(opts: { total: number; reportedCount?: number }) {
  const reported = opts.reportedCount ?? opts.total;
  const offsets: number[] = [];
  let level: "root" | "library" | "albums" = "root";

  const stub = {
    runExclusiveWithRetry: <T>(op: () => Promise<T>) => op(),
    async browse(o: { pop_all?: boolean; item_key?: string }): Promise<BrowseResultBody> {
      if (o.pop_all) {
        level = "root";
        return { action: "list", list: { title: "Explore", count: 6, level: 0 } };
      }
      if (o.item_key === "lib") {
        level = "library";
        return { action: "list", list: { title: "Library", count: 6, level: 1 } };
      }
      if (o.item_key === "alb") {
        level = "albums";
        return { action: "list", list: { title: "Albums", count: reported, level: 2 } };
      }
      return { action: "none" };
    },
    async load(o: { offset?: number; count?: number }): Promise<LoadResultBody> {
      if (level === "root") {
        return page([{ title: "Library", item_key: "lib", hint: "list" }], 6, 0);
      }
      if (level === "library") {
        return page(
          [
            { title: "Artists", item_key: "art", hint: "list" },
            { title: "Albums", item_key: "alb", hint: "list" },
          ],
          6,
          0,
        );
      }
      const offset = o.offset ?? 0;
      offsets.push(offset);
      const items: BrowseItem[] = [];
      for (let i = offset; i < Math.min(offset + (o.count ?? 100), opts.total); i++) items.push(album(i));
      return page(items, reported, offset);
    },
  };
  return { browse: stub as unknown as BrowseSessionManager, offsets: () => offsets };
}

function page(items: BrowseItem[], count: number, offset: number): LoadResultBody {
  return { items, offset, list: { title: "x", count, level: 2 } };
}

const svc = (browse: BrowseSessionManager) =>
  new LibraryExportService(browse, () => "2026-07-12T00:00:00.000Z", () => {});

test("exports every album across multiple pages, writing the contract snapshot", async () => {
  const { path, cleanup } = tempPath();
  try {
    const { browse, offsets } = fakeBrowse({ total: 250 });
    const result = await svc(browse).export({ path });

    // The service returns the full tool/CLI result shape — no frontend reshaping.
    assert.equal(result.status, "ok");
    assert.equal(result.path, path);
    assert.equal(typeof result.durationMs, "number");
    assert.equal(result.albumCount, 250);
    assert.equal(result.expectedCount, 250);
    assert.equal(result.warning, undefined);
    // Paged at 0, 100, 200 (PAGE=100).
    assert.deepEqual(offsets(), [0, 100, 200]);

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
    const { browse } = fakeBrowse({ total: 250 });
    const result = await svc(browse).export({ path, limit: 5 });
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
    const { browse } = fakeBrowse({ total: 3, reportedCount: 300 });
    const result = await svc(browse).export({ path });
    assert.equal(result.albumCount, 3);
    assert.equal(result.expectedCount, 300);
    assert.match(result.warning ?? "", /Collected 3 albums but Roon reported 300/);
  } finally {
    cleanup();
  }
});

test("writes atomically: no leftover temp file, valid final file", async () => {
  const { path, cleanup } = tempPath();
  try {
    const { browse } = fakeBrowse({ total: 10 });
    await svc(browse).export({ path });
    const dir = join(path, "..");
    const entries = readdirSync(dir);
    assert.deepEqual(entries, ["snapshot.json"], "only the final file remains (no .tmp)");
    JSON.parse(readFileSync(path, "utf8")); // parses = not truncated
  } finally {
    cleanup();
  }
});

test("throws BROWSE_FAILED when the Library entry is absent", async () => {
  const { path, cleanup } = tempPath();
  try {
    const stub = {
      runExclusiveWithRetry: <T>(op: () => Promise<T>) => op(),
      async browse() {
        return { action: "list", list: { title: "Explore", count: 0, level: 0 } } as BrowseResultBody;
      },
      async load() {
        return page([{ title: "Playlists", item_key: "p", hint: "list" }], 1, 0);
      },
    } as unknown as BrowseSessionManager;
    await assert.rejects(
      () => svc(stub).export({ path }),
      (e: unknown) => e instanceof RoonMcpError && e.code === "BROWSE_FAILED",
    );
  } finally {
    cleanup();
  }
});

test("omits artist/imageKey when the browse item lacks them", async () => {
  const { path, cleanup } = tempPath();
  try {
    let level = "root";
    const stub = {
      runExclusiveWithRetry: <T>(op: () => Promise<T>) => op(),
      async browse(o: { pop_all?: boolean; item_key?: string }) {
        level = o.pop_all ? "root" : o.item_key === "lib" ? "library" : o.item_key === "alb" ? "albums" : level;
        const count = level === "albums" ? 1 : 6;
        return { action: "list", list: { title: level, count, level: 0 } } as BrowseResultBody;
      },
      async load() {
        if (level === "root") return page([{ title: "Library", item_key: "lib", hint: "list" }], 6, 0);
        if (level === "library") return page([{ title: "Albums", item_key: "alb", hint: "list" }], 6, 0);
        return page([{ title: "Bare Album", item_key: "70:0", hint: "list" }], 1, 0);
      },
    } as unknown as BrowseSessionManager;

    await svc(stub).export({ path });
    const snap = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(snap.albums[0], {
      album: "Bare Album",
      raw: { title: "Bare Album", itemKey: "70:0" },
    });
  } finally {
    cleanup();
  }
});
