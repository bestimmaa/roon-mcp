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

Later milestones add hardening (retries, structured logs, integration scripts) — see
the implementation plan.

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

## Develop

```bash
npm run dev        # tsc --watch
npm run typecheck
npm test           # builds, then runs node:test
```
