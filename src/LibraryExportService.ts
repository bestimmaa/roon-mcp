import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { BrowseItem } from "node-roon-api-browse";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { RoonMcpError, type LibraryExportInput, type LibraryExportResult } from "./types.js";

// Page size for walking the Albums list. A 2.7k-album library pages in ~28 loads.
const PAGE = 100;

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
    private readonly log: (message: string) => void = (m) => process.stderr.write(`[export] ${m}\n`),
  ) {}

  async export(input: LibraryExportInput): Promise<LibraryExportResult> {
    const startedAt = Date.now();
    const limit = input.limit != null && input.limit > 0 ? input.limit : undefined;

    // One exclusive browse sequence for the whole walk; item keys are produced
    // inside it, so an INVALID_ITEM_KEY mid-walk recovers via the reset+replay.
    const { albums, expectedCount } = await this.browse.runExclusiveWithRetry(() =>
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
    this.writeAtomic(input.path, JSON.stringify(snapshot, null, 2));

    // Only meaningful for an un-capped export; a `limit` legitimately stops short.
    const warning =
      limit === undefined && expectedCount !== undefined && albums.length !== expectedCount
        ? `Collected ${albums.length} albums but Roon reported ${expectedCount}.`
        : undefined;
    if (warning) this.log(warning);

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
  private async walkAlbums(limit?: number): Promise<{ albums: SnapshotAlbum[]; expectedCount?: number }> {
    await this.browse.browse({ hierarchy: "browse", pop_all: true });
    const root = await this.browse.load({ hierarchy: "browse", offset: 0, count: PAGE });
    const library = findByTitle(root.items, LIBRARY_LABEL);
    if (!library?.item_key) {
      throw new RoonMcpError("BROWSE_FAILED", 'No "Library" entry at the browse root.');
    }

    await this.browse.browse({ hierarchy: "browse", item_key: library.item_key });
    const libLevel = await this.browse.load({ hierarchy: "browse", offset: 0, count: PAGE });
    const albumsEntry = findByTitle(libLevel.items, ALBUMS_LABEL);
    if (!albumsEntry?.item_key) {
      throw new RoonMcpError("BROWSE_FAILED", 'No "Albums" entry under Library.');
    }

    const opened = await this.browse.browse({ hierarchy: "browse", item_key: albumsEntry.item_key });
    const expectedCount = opened.list?.count;

    const albums: SnapshotAlbum[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.browse.load({ hierarchy: "browse", offset, count: PAGE });
      for (const item of page.items) {
        if (!isAlbumRow(item)) continue;
        albums.push(toSnapshotAlbum(item));
        if (limit !== undefined && albums.length >= limit) {
          this.log(`reached limit ${limit}`);
          return { albums, expectedCount };
        }
      }
      offset += page.items.length;
      const total = page.list?.count ?? expectedCount ?? 0;
      this.log(`paged ${Math.min(offset, total || offset)}/${total || "?"} albums`);
      // Stop at the end of the list, or if Roon returns an empty page (guards
      // against an off-by-one loop when the reported count is stale).
      if (page.items.length === 0 || offset >= total) break;
    }
    return { albums, expectedCount };
  }

  /** Write via a temp file + rename so a crash never leaves a truncated snapshot. */
  private writeAtomic(path: string, data: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
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
