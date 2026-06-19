#!/usr/bin/env node
// Integration smoke test against a LIVE Roon Core (Milestone 5).
//
// Spawns the built MCP server (dist/index.js) over stdio, the same way a real
// MCP client would, and exercises the tool surface end-to-end. Read-only steps
// (list_zones, search_music, get_tracks_for) run by default. Audible steps that
// actually start music are gated behind env flags so this never surprises you:
//
//   node scripts/integration.mjs                 # list + search + expand only
//   ROON_PLAY=1 node scripts/integration.mjs     # also play_now a genre
//   ROON_ENQUEUE=1 node scripts/integration.mjs  # also enqueue a few tracks
//
// Useful overrides:
//   ROON_ZONE="Office"   pick a zone by id or display-name substring
//   ROON_QUERY="Tycho"   override the genre search query
//
// Prereq: `npm run build` first (this script runs the compiled server). On the
// first run, enable "Roon MCP" under Roon → Settings → Extensions within ~45s.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const serverPath = resolve(repoRoot, "dist/index.js");

const truthy = (v) => v != null && v !== "" && v !== "0" && v.toLowerCase?.() !== "false";
const PLAY = truthy(process.env.ROON_PLAY);
const ENQUEUE = truthy(process.env.ROON_ENQUEUE);
const ZONE_PREF = process.env.ROON_ZONE;
const GENRE_QUERY = process.env.ROON_QUERY ?? "Dark Ambient";
const ARTISTS = ["Tycho", "Bonobo", "Nils Frahm"];

function log(...args) {
  console.log(...args);
}
function section(title) {
  log(`\n=== ${title} ===`);
}

/** Call a tool and return its structuredContent, throwing a readable error. */
async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) {
    const text = res.content?.find((c) => c.type === "text")?.text ?? "";
    throw new Error(`${name} failed: ${text}`);
  }
  return res.structuredContent ?? {};
}

/** Retry list_zones a few times so there's time to enable the extension. */
async function resolveZones(client) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return (await call(client, "list_zones")).zones ?? [];
    } catch (err) {
      if (!/NO_CORE_PAIRED/.test(String(err)) || attempt === 3) throw err;
      log(
        `\n⏳ No Core paired yet (attempt ${attempt}/3). ` +
          "Open Roon → Settings → Extensions and enable 'Roon MCP'…",
      );
    }
  }
  return [];
}

function pickZone(zones) {
  if (ZONE_PREF) {
    const needle = ZONE_PREF.toLowerCase();
    const hit = zones.find(
      (z) => z.zoneId === ZONE_PREF || z.displayName.toLowerCase().includes(needle),
    );
    if (hit) return hit;
    log(`⚠️  No zone matches ROON_ZONE="${ZONE_PREF}"; falling back.`);
  }
  return zones.find((z) => z.state === "playing") ?? zones[0];
}

function topCandidate(result) {
  return result.candidates?.[0];
}

async function main() {
  if (!existsSync(serverPath)) {
    throw new Error(`Server not built: ${serverPath} is missing. Run \`npm run build\` first.`);
  }

  log(`Spawning MCP server: node ${serverPath}`);
  log("(server logs — pairing + [roon-call] lines — stream to stderr below)\n");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: repoRoot,
    stderr: "inherit",
  });
  const client = new Client({ name: "roon-mcp-integration", version: "0.1.0" });
  await client.connect(transport);

  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    log(`Connected. Tools advertised: ${tools.join(", ")}`);

    section("list_zones");
    const zones = await resolveZones(client);
    if (zones.length === 0) {
      log("No zones available on the paired Core. Nothing more to test.");
      return;
    }
    for (const z of zones) {
      log(`  • ${z.displayName}  [${z.state}]  zoneId=${z.zoneId}  outputs=${z.outputIds.join(",")}`);
    }
    const zone = pickZone(zones);
    log(`→ target zone: "${zone.displayName}" (${zone.zoneId})`);

    section(`search_music genre "${GENRE_QUERY}"`);
    const genreResult = await call(client, "search_music", {
      query: GENRE_QUERY,
      type: "genre",
      limit: 5,
    });
    if (genreResult.broadened) log(`(broadened: ${genreResult.message})`);
    for (const c of genreResult.candidates ?? []) {
      log(`  • [${c.type}] ${c.title}  (score ${c.score}, ${c.sourceGroup ?? "?"})`);
    }

    section("search_music artists");
    for (const artist of ARTISTS) {
      const r = await call(client, "search_music", { query: artist, type: "artist", limit: 2 });
      const top = topCandidate(r);
      log(`  ${artist} → ${top ? `${top.title} [${top.type}]` : "(no match)"}`);
    }

    if (PLAY) {
      section(`play_now (shuffle) — ROON_PLAY set`);
      const seed = topCandidate(genreResult);
      if (!seed) {
        log("No genre candidate to play.");
      } else {
        const out = await call(client, "play_now", {
          zoneId: zone.zoneId,
          itemKey: seed.itemKey,
          shuffle: true,
        });
        log(`  → ok=${out.ok} queued=${out.queued} nowPlaying=${out.nowPlaying ?? "?"}`);
        log(`    ${out.message ?? ""}`);
      }
    } else {
      log("\n(skip play_now — set ROON_PLAY=1 to start a shuffled genre queue)");
    }

    if (ENQUEUE) {
      section("get_tracks_for + enqueue_and_play — ROON_ENQUEUE set");
      const artistResult = await call(client, "search_music", {
        query: ARTISTS[0],
        type: "artist",
        limit: 1,
      });
      const artist = topCandidate(artistResult);
      if (!artist) {
        log(`No "${ARTISTS[0]}" artist candidate to expand.`);
      } else {
        const expanded = await call(client, "get_tracks_for", { itemKey: artist.itemKey, limit: 5 });
        const keys = (expanded.tracks ?? []).slice(0, 4).map((t) => t.itemKey);
        log(`  expanded "${artist.title}" → ${keys.length} track(s)`);
        for (const t of expanded.tracks ?? []) log(`    - ${t.title}${t.artist ? ` — ${t.artist}` : ""}`);
        if (keys.length > 0) {
          const out = await call(client, "enqueue_and_play", {
            zoneId: zone.zoneId,
            itemKeys: keys,
            shuffle: false,
          });
          log(
            `  → ok=${out.ok} queued=${out.queued}/${out.requested} skipped=${out.skipped?.length ?? 0}`,
          );
          log(`    ${out.message ?? ""}`);
          for (const s of out.skipped ?? []) log(`    skipped ${s.itemKey}: ${s.reason}`);
        }
      }
    } else {
      log("\n(skip enqueue_and_play — set ROON_ENQUEUE=1 to build a curated queue)");
    }

    section("done");
    log("Integration smoke test completed.");
    if (PLAY || ENQUEUE) {
      log("Tip: verify shuffle on/off by re-running with the shuffle flags and watching Roon.");
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`\n❌ integration failed: ${err?.stack ?? err}`);
  process.exit(1);
});
