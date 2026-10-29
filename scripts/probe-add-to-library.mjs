#!/usr/bin/env node
//
// Experiment: does a TIDAL track expose an "Add to Library" browse action?
//
// This drives the Roon Browse API directly (search → Tracks group → open a
// track → dump its action menu) to show EXACTLY which actions Roon surfaces on
// a track, including any "Add to Library" entry. It is strictly READ-ONLY: it
// only ever calls `browse`/`load` to navigate and read — it never invokes an
// action (no item_key is ever fired), so it cannot change your library or
// start playback.
//
//   npm run build
//   ROON_QUERY="Some track only on TIDAL" node scripts/probe-add-to-library.mjs
//   ROON_PROBE_TRACKS=5 node scripts/probe-add-to-library.mjs   # how many tracks to dump (default 3)
//
// On the first run, enable "Roon MCP" under Roon → Settings → Extensions.
// Pick a ROON_QUERY that is NOT in your local library, so the only matches are
// streaming (TIDAL) tracks — those are the ones that would carry "Add to
// Library". Output streams to stderr; stdout is unused.
//
// What you're looking for in the output: an action row titled "Add to Library"
// (or the localized equivalent) in a track's action menu. If it's there, the
// feature is reachable via the Browse action mechanism; if no track shows it,
// it isn't exposed for tracks on your Core.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { RoonClient } from "../dist/RoonClient.js";
import { BrowseSessionManager } from "../dist/BrowseSessionManager.js";
import { SearchNavigator, SEARCH_HIERARCHY, isSelectable } from "../dist/SearchNavigator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
void repoRoot;

const QUERY = process.env.ROON_QUERY ?? "Atemlos durch die Nacht";
const PROBE_TRACKS = Number(process.env.ROON_PROBE_TRACKS ?? 3) || 3;

function log(...args) {
  process.stderr.write(args.map(String).join(" ") + "\n");
}
function section(title) {
  log(`\n=== ${title} ===`);
}

// English search category titles → our item type (mirrors SearchService).
const GROUP_TYPE = {
  artists: "artist",
  albums: "album",
  tracks: "track",
  genres: "genre",
  playlists: "playlist",
  stations: "radio",
  "internet radio": "radio",
};
function groupType(title) {
  const cleaned = title.trim().toLowerCase().replace(/\s*\(\d+\)\s*$/, "");
  return GROUP_TYPE[cleaned] ?? "unknown";
}

async function waitForCore(roon, timeoutMs = 60_000) {
  roon.start();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (roon.isPaired()) return;
    log("⏳ Waiting for a paired Roon Core… enable Roon → Settings → Extensions → Roon MCP");
    try {
      await roon.waitForCore(5_000);
      return;
    } catch {
      // keep polling until paired or timeout
    }
  }
  throw new Error("No Roon Core paired in time.");
}

/** Dump the items at the session's current level, returning them. */
async function dumpLevel(browse, label) {
  const loaded = await browse.load({ hierarchy: SEARCH_HIERARCHY, offset: 0, count: 200 });
  const items = loaded.items ?? [];
  log(`\n--- ${label} (${items.length} item(s)) ---`);
  for (const it of items) {
    log(
      `  [${it.hint ?? "—"}] ${it.title}` +
        (it.subtitle ? `  · ${it.subtitle}` : "") +
        (it.item_key ? `  · key=${it.item_key}` : ""),
    );
  }
  return items;
}

/** Heuristic: does an action title look like an "add to library" action? */
function looksLikeAddToLibrary(title) {
  return /add(?: to| to the)?\s*library|\blibrary\b|^\+|add to (my )?music/i.test(title);
}

async function main() {
  log(`Probe: "Add to Library" availability for tracks (query="${QUERY}", ${PROBE_TRACKS} track(s))`);
  const roon = new RoonClient();
  await waitForCore(roon);
  log("✓ Paired with a Roon Core.");

  const browse = new BrowseSessionManager(roon);
  const nav = new SearchNavigator(browse);

  // Phase 1 — search, locate the Tracks group, list candidate track rows.
  const tracksIndex = await browse.runExclusive(async () => {
    section(`search "${QUERY}" — top-level groups`);
    await browse.browse({ hierarchy: SEARCH_HIERARCHY, input: QUERY, pop_all: true });
    const groups = (await browse.load({ hierarchy: SEARCH_HIERARCHY, offset: 0, count: 200 })).items ?? [];
    for (const g of groups) {
      log(`  [group] ${g.title}  · type=${groupType(g.title)}  · key=${g.item_key ?? "—"}`);
    }
    // openItem re-navigates by *selectable* index (it filters headers out before
    // indexing into the groups), so locate the Tracks group within the
    // selectable subset — otherwise a header before it would shift loc.g.
    const selectableGroups = groups.filter(isSelectable);
    const tracksIdx = selectableGroups.findIndex((g) => groupType(g.title) === "track");
    if (tracksIdx < 0) {
      log("\nNo 'Tracks' group in the search results — nothing to probe.");
      return -1;
    }
    log(`\n→ Tracks group is selectable index ${tracksIdx} ("${selectableGroups[tracksIdx].title}")`);

    // Open the Tracks group and dump its rows so the user can see what's there.
    const gnav = await browse.browse({ hierarchy: SEARCH_HIERARCHY, item_key: selectableGroups[tracksIdx].item_key });
    if (gnav.action !== "list") {
      log("Tracks group didn't open as a list.");
      return -1;
    }
    await dumpLevel(browse, "Tracks group rows");
    return tracksIdx;
  });

  if (tracksIndex < 0) return;

  // Phase 2 — open each of the first N track rows and dump its action menu.
  // Each openItem re-navigates from a fresh search, so it runs in its own
  // exclusive session (level-scoped keys wouldn't survive across tracks).
  // NOTE: pass a decoded locator OBJECT to openItem — it indexes loc.q/loc.g/
  // loc.i directly. Encoding to a token string is only for MCP itemKey transport;
  // handing the string to openItem leaves loc.q undefined, the search never
  // re-registers, and load returns "No Results".
  section(`action menus for the first ${PROBE_TRACKS} track(s)`);
  let anyAddToLibrary = false;
  for (let i = 0; i < PROBE_TRACKS; i++) {
    const loc = { q: QUERY, g: tracksIndex, i };
    await browse.runExclusive(async () => {
      const opened = await nav.openItem(loc);
      log(`\n--- track #${i} (opened, action=${opened.action}) ---`);
      const items = await dumpLevel(browse, "track action menu");

      // Some Roon items nest actions under an "action_list" container; drill
      // one level into it if present.
      const container = items.find((it) => it.hint === "action_list" && it.item_key);
      if (container) {
        await browse.browse({ hierarchy: SEARCH_HIERARCHY, item_key: container.item_key });
        const sub = await browse.load({ hierarchy: SEARCH_HIERARCHY, offset: 0, count: 200 });
        log(`\n  (nested under "${container.title}"):`);
        for (const it of sub.items ?? []) {
          log(
            `    [${it.hint ?? "—"}] ${it.title}` +
              (it.subtitle ? `  · ${it.subtitle}` : "") +
              (it.item_key ? `  · key=${it.item_key}` : ""),
          );
          if (looksLikeAddToLibrary(it.title)) anyAddToLibrary = true;
        }
      }
      for (const it of items) {
        if (looksLikeAddToLibrary(it.title)) anyAddToLibrary = true;
      }
    });
  }

  section("verdict");
  log(
    anyAddToLibrary
      ? "✓ At least one track exposed an 'Add to Library'-style action → it IS reachable via the Browse action mechanism."
      : "✗ No 'Add to Library'-style action appeared on any probed track → not exposed for tracks on this Core (it may still exist on albums/artists).",
  );
  roon.stop();
}

main().catch((err) => {
  process.stderr.write(`\n[probe] fatal: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});