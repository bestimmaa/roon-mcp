# Roon MCP

A minimal [MCP](https://modelcontextprotocol.io) server to control the **Roon** music player, so an AI agent can pick music and start playback.

Built on the official Roon Extension API (`node-roon-api` + `node-roon-api-transport`).

## Status

**Milestone 1 — connection & zone read** ✅
- [x] MCP server shell (stdio transport)
- [x] Pair with a Roon Core (`RoonClient`)
- [x] Read zones (`ZoneService`)
- [x] `list_zones()` tool

**Milestone 2 — search** ✅
- [x] Serialized `BrowseSessionManager` (one lock over all browse work)
- [x] `search_music()` with type filtering and broadening
- [x] Candidate ranking by title relevance + type

**Milestone 3 — single-item playback** ✅
- [x] Action discovery (find a Play Now / Shuffle action, incl. nested action lists)
- [x] `play_now()` against a zone or output id
- [x] Shuffle via a Shuffle action, with a best-effort Transport `change_settings` fallback

**Milestone 4 — track expansion & curated queue** ✅
- [x] `get_tracks_for()` expands artist/album/genre/playlist candidates into tracks
- [x] `enqueue_and_play()` starts the first item (Play Now) and appends the rest (Queue)
- [x] Partial-failure handling: skipped items are reported with reasons, not fatal

**Milestone 5 — hardening** ✅
- [x] Retry stale browse/session states once (`BrowseSessionManager.runExclusiveWithRetry`)
- [x] Structured per-call logs around every Roon API call (`src/logger.ts`)
- [x] Integration smoke-test script against a live Core (`scripts/integration.mjs`)
- [x] `save_playlist` decision: **not exposed in v1** (no official Roon write API — see below)

### `save_playlist` — deferred

Roon exposes no official playlist-write service; there is no `create_playlist` /
`add_to_playlist` in the Extension API. Durable playlists would mean reverse-
engineering an unsupported flow, which contradicts the v1 non-goals. **Decision:**
omit `save_playlist` from v1. Curated playback is delivered by `enqueue_and_play`
(an ad-hoc, in-the-moment queue), which covers the mood/focus use cases without a
persistence API. Revisit only if a supported browse-action path to save a queue is
found on a live Core.

## Setup

```bash
npm install   # pulls node-roon-api packages from RoonLabs' GitHub
npm run build
```

> The `node-roon-api*` packages are published on GitHub, not npm, so `npm install`
> fetches them via `github:RoonLabs/...` git URLs.

## Run

```bash
npm start
```

On first launch, open **Roon → Settings → Extensions** and enable **Roon MCP** to
pair. The server logs pairing status to stderr; stdout is reserved for the MCP
protocol.

### Register with an MCP client

```json
{
  "mcpServers": {
    "roon": { "command": "node", "args": ["/absolute/path/to/roon-mcp/dist/index.js"] }
  }
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `list_zones()` | List playable zones/outputs (id, name, state, output ids). |
| `search_music({ query, type?, limit? })` | Resolve a text query into ranked browse candidates (opaque, session-scoped item keys). |
| `get_tracks_for({ itemKey, limit? })` | Expand an artist/album/genre/playlist candidate into concrete playable tracks. |
| `play_now({ zoneId, itemKey, shuffle? })` | Immediately play one search candidate in a zone/output; optional shuffle. |
| `enqueue_and_play({ zoneId, itemKeys, shuffle? })` | Build an ad-hoc queue from curated item keys and start it; reports queued/skipped. |

## Logging

Every Roon API call (`browse`, `load`, `get_zones`, `change_settings`) emits one
structured line to **stderr** (stdout stays reserved for MCP JSON-RPC):

```
[roon-call] {"t":"2026-06-19T18:00:00.000Z","lvl":"info","op":"browse","ms":12,"params":{"hierarchy":"search","item_key":"…"},"result":{"action":"list","count":7}}
```

Failures log `lvl:"error"` with the mapped error code, and retries surface as
repeated lines for the same `op`. Grep stderr for `[roon-call]` to trace a flow.

## Develop

```bash
npm run dev              # tsc --watch
npm run typecheck
npm test                 # builds, then runs node:test
npm run test:integration # smoke-test against a LIVE Roon Core (see below)
```

### Integration smoke test

`scripts/integration.mjs` spawns the built server over stdio (like a real MCP
client) and runs list → search → expand against your Core. Audible steps are
opt-in so it never blasts music by accident:

```bash
npm run build
node scripts/integration.mjs                 # list_zones + search only (read-only)
ROON_PLAY=1 node scripts/integration.mjs     # also play_now a shuffled genre
ROON_ENQUEUE=1 node scripts/integration.mjs  # also enqueue a few curated tracks
# overrides: ROON_ZONE="Office"  ROON_QUERY="Tycho"
```

Enable **Roon MCP** under Roon → Settings → Extensions on the first run (the
script retries `list_zones` for ~45s while it waits to pair).
