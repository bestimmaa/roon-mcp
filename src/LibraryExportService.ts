import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { BrowseItem, BrowseOptions, BrowseResultBody } from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { RoonMcpError, type LibraryExportInput, type LibraryExportResult } from "./types.js";

// Page size for walking the Albums list. A 2.7k-album library pages in ~28 loads.
const PAGE = 100;

// An existing file larger than this is never read to check whether it is a
// snapshot; it is refused outright. A 2.7k-album snapshot is ~1 MB.
const MAX_REPLACEABLE_BYTES = 64 * 1024 * 1024;

// English container labels for the Library → Albums walk. Same localization
// caveat already documented for SearchService.GROUP_TITLE_TO_TYPE,
// TrackExpansionService.TRACK_SECTION_LABELS, and GenreService.CONTAINER_LABELS:
// a non-English Core needs locale-aware matching here (the browse root's
// "Library" and its "Albums" child).
const LIBRARY_LABEL = "library";
const ALBUMS_LABEL = "albums";

/** One album entry in the snapshot file. */
interface SnapshotAlbum {
  album: string;
  artist?: string;
  raw: { title: string; subtitle?: string; itemKey?: string; imageKey?: string };
}

/**
 * Exports the library's album catalog to a JSON snapshot on disk. Walks the
 * browse hierarchy Library → Albums under the session lock (a single long
 * browse sequence, like SearchService/TrackExpansionService) and writes the
 * file atomically.
 *
 * Album-granularity only, deliberately: no per-album track drill-down, which
 * would turn one walk into thousands of browse round-trips.
 *
 * The albums land in the FILE, never in the tool result — a large library is
 * far too big to hand back through an MCP response.
 */
export class LibraryExportService {
  constructor(
    private readonly browse: BrowseSessionManager,
    /** ISO-8601 UTC timestamp for `exportedAt`; injectable for deterministic tests. */
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {}

  async export(input: LibraryExportInput): Promise<LibraryExportResult> {
    const startedAt = Date.now();
    const limit = input.limit != null && input.limit > 0 ? input.limit : undefined;

    // Checked before the walk, so a refused path fails fast instead of after
    // holding the browse session for the whole library.
    assertReplaceable(input.path);

    // One exclusive browse sequence for the whole walk. Item keys are produced
    // inside it, so a stale session mid-walk — an INVALID_ITEM_KEY from a load,
    // or a drill that fails to open its list — is replayed once from the root.
    const { albums, expectedCount, stoppedAtLimit } = await this.browse.runExclusiveWithRetry(() =>
      this.walkAlbums(limit),
    );

    const snapshot = {
      schemaVersion: 1,
      exportedAt: this.nowIso(),
      source: "roon",
      kind: "albums",
      albumCount: albums.length,
      albums,
    };
    // Again right before the write: the walk can take tens of seconds, and a
    // file that appeared at `path` meanwhile gets the same protection.
    assertReplaceable(input.path);
    writeAtomic(input.path, JSON.stringify(snapshot, null, 2));

    // A walk that stopped because it reached `limit` is legitimately short; one
    // that ran out of pages first is a mismatch whether or not a limit was set.
    const warning = stoppedAtLimit ? undefined : countWarning(albums.length, expectedCount);

    return {
      status: "ok",
      path: input.path,
      albumCount: albums.length,
      durationMs: Date.now() - startedAt,
      ...(expectedCount !== undefined ? { expectedCount } : {}),
      ...(warning ? { warning } : {}),
    };
  }

  /** Navigate Library → Albums and page the whole list. Composed inside the lock. */
  private async walkAlbums(
    limit?: number,
  ): Promise<{ albums: SnapshotAlbum[]; expectedCount?: number; stoppedAtLimit: boolean }> {
    // The reset's own reply is not checked: a session already at the root may
    // answer a no-op `pop_all` with `action: "none"`, which is within contract
    // (SearchNavigator ignores it too), and a reset that silently failed is
    // caught by the Library lookup right below.
    await this.browse.browse({ hierarchy: "browse", pop_all: true });
    const root = await this.browse.load({ hierarchy: "browse", offset: 0, count: PAGE });
    const library = findByTitle(root.items, LIBRARY_LABEL);
    if (!library?.item_key) {
      throw new RoonMcpError("BROWSE_FAILED", 'No "Library" entry at the browse root.');
    }

    await this.descend({ hierarchy: "browse", item_key: library.item_key }, "Library");
    const libLevel = await this.browse.load({ hierarchy: "browse", offset: 0, count: PAGE });
    const albumsEntry = findByTitle(libLevel.items, ALBUMS_LABEL);
    if (!albumsEntry?.item_key) {
      throw new RoonMcpError("BROWSE_FAILED", 'No "Albums" entry under Library.');
    }

    const opened = await this.descend({ hierarchy: "browse", item_key: albumsEntry.item_key }, "Albums");
    // Roon reports the list total in the browse result's header and again on
    // every load; remember the first one that carries it.
    let expectedCount = opened.list?.count;

    const albums: SnapshotAlbum[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.browse.load({ hierarchy: "browse", offset, count: PAGE });
      // Roon echoes the offset it actually served. A Core that clamps an
      // out-of-range request back to 0 would otherwise hand the first page
      // back again — and the walk would append it forever when no total is
      // known, or pad the snapshot with duplicates up to the advertised one.
      // This check is also what bounds the loop, so it stays strict: `offset`
      // is required by the load contract, and a Core that omits it must fail
      // loudly here rather than be skipped, or a Core that both clamps and
      // omits it would loop again. BROWSE_FAILED is not retried.
      if (page.offset !== offset) {
        throw new RoonMcpError(
          "BROWSE_FAILED",
          `Roon served page offset ${page.offset} for requested offset ${offset}.`,
          { requested: offset, served: page.offset },
        );
      }
      expectedCount ??= page.list?.count;
      for (const item of page.items) {
        if (!isAlbumRow(item)) continue;
        albums.push(toSnapshotAlbum(item));
        if (limit !== undefined && albums.length >= limit) {
          return { albums, expectedCount, stoppedAtLimit: true };
        }
      }
      offset += page.items.length;
      // Stop at the end of the list, or on an empty page (which guards against
      // an off-by-one loop when the reported count is stale). An unknown total
      // keeps paging until that empty page. A short page is NOT an end marker:
      // the browse API never promises a full page mid-list, so stopping on one
      // would silently truncate a Core that serves fewer items than requested.
      const total = page.list?.count ?? expectedCount;
      if (page.items.length === 0 || (total !== undefined && offset >= total)) break;
    }
    return { albums, expectedCount, stoppedAtLimit: false };
  }

  /**
   * Drill into an item and confirm the session actually descended. A non-list
   * reply (`action: "message"` on a transient Core error, or `"none"`) leaves
   * the session where it was, so the next load would page the wrong level —
   * and the Library menu rows all pass `isAlbumRow`, so without this check a
   * hiccup exports ["Artists", "Albums", "Composers", ...] as the catalog
   * with `status: "ok"`. Surfaced as INVALID_ITEM_KEY, like SearchNavigator's
   * STALE(), so runExclusiveWithRetry replays the walk once. Only the
   * `item_key` drills come through here; the root reset is deliberately not
   * checked (see walkAlbums).
   */
  private async descend(options: BrowseOptions, where: string): Promise<BrowseResultBody> {
    const result = await this.browse.browse(options);
    if (result.action !== "list") {
      const detail = result.message ? `: ${result.message}` : "";
      throw new RoonMcpError(
        "INVALID_ITEM_KEY",
        `Browsing into ${where} did not open a list (action "${result.action}"${detail}).`,
        { options, action: result.action, isError: result.is_error },
      );
    }
    return result;
  }
}

/**
 * The count-mismatch warning. An unknown total is flagged too: it is exactly
 * the case where a short walk would otherwise go unnoticed.
 */
function countWarning(collected: number, expected: number | undefined): string | undefined {
  if (expected === undefined) {
    return `Roon reported no album total; collected ${collected} albums by paging until an empty page.`;
  }
  return collected !== expected ? `Collected ${collected} albums but Roon reported ${expected}.` : undefined;
}

/**
 * Refuse to overwrite an existing file unless it is an earlier snapshot from
 * this tool. `path` comes from the agent, so without this an export aimed at
 * the wrong place could clobber any file the user can write — a shell rc
 * file, or roon-mcp's own config.json with its pairing token. A path that
 * does not exist yet is fine, and so is a non-file (e.g. a directory): the
 * rename in writeAtomic fails on it without touching anything.
 */
function assertReplaceable(path: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return; // does not exist (or unreadable, which the write will surface)
  }
  if (!stats.isFile()) return;
  if (stats.size <= MAX_REPLACEABLE_BYTES && isSnapshot(path)) return;
  throw new RoonMcpError(
    "EXPORT_PATH_REFUSED",
    `Refusing to overwrite ${path}: a file already exists there and it is not a ` +
      "library_export snapshot (or it is one that has been damaged or hand-edited). " +
      "Nothing was written. To fix: retry with a path that does not exist yet, or " +
      "ask the user to check the file and delete it if it is safe to replace. Do not " +
      "retry the same path until then.",
    { path },
  );
}

function isSnapshot(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const snap = parsed as Record<string, unknown>;
    return snap.source === "roon" && snap.kind === "albums" && typeof snap.schemaVersion === "number";
  } catch {
    return false;
  }
}

/**
 * Write via a temp file + rename so a crash never leaves a truncated snapshot.
 * The temp name is unique per call (this runs outside the browse lock, so two
 * exports to the same path must not share one), and it is removed on any
 * failure so a bad `path` — an existing directory, say — leaves nothing behind.
 */
function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** An album row in the Albums list: a drillable `list` item with a key. */
function isAlbumRow(item: BrowseItem): boolean {
  return Boolean(item.item_key) && item.hint === "list";
}

/** Case-insensitive exact-title match among loaded browse items. */
function findByTitle(items: BrowseItem[], title: string): BrowseItem | undefined {
  return items.find((i) => i.title.trim().toLowerCase() === title);
}

function toSnapshotAlbum(item: BrowseItem): SnapshotAlbum {
  return {
    album: item.title,
    ...(item.subtitle !== undefined ? { artist: item.subtitle } : {}),
    raw: {
      title: item.title,
      ...(item.subtitle !== undefined ? { subtitle: item.subtitle } : {}),
      ...(item.item_key !== undefined ? { itemKey: item.item_key } : {}),
      ...(item.image_key !== undefined ? { imageKey: item.image_key } : {}),
    },
  };
}
