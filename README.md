# roon-mcp

An [MCP](https://modelcontextprotocol.io) server to control the **Roon** music
player, so an AI agent can find music and start playback. Built on the official
Roon Extension API (`node-roon-api` + `node-roon-api-transport` /
`node-roon-api-browse`).

---

> **"Play a female vocal trance mix on Roon (Zone: This Computer) — 2000s Dutch trance vibes, the kind of set you'd hear at Amnesia in its prime. Start with something like 4 Strings' Take Me Away."**
>
> *Claude searches across your library and streaming, hand-picks the tracks, and queues them — all from a single natural-language prompt.*

---

## Requirements

- Node.js 20+
- A running **Roon Core** on the local network to pair with
- **git** on the install host — the `node-roon-api*` dependencies are published
  on GitHub (not npm) and are fetched via git URLs during install

## MCP Client Configuration

Add this to your MCP client config. `npx` fetches the package on first run:

```json
{
  "mcpServers": {
    "roon": {
      "command": "npx",
      "args": ["-y", "roon-mcp"],
      "env": { "ROON_DEFAULT_ZONE": "Office" }
    }
  }
}
```

On first launch, open **Roon → Settings → Extensions** and enable **Roon MCP**
to pair. Pairing status is logged to stderr; stdout is reserved for the MCP
protocol.

### Global install (optional)

```bash
npm install -g roon-mcp
```

```json
{
  "mcpServers": {
    "roon": {
      "command": "roon-mcp",
      "env": { "ROON_DEFAULT_ZONE": "Office" }
    }
  }
}
```

## Configuration

| Env var | Purpose |
| --- | --- |
| `ROON_DEFAULT_ZONE` | Optional fallback target for `play_now` / `enqueue_and_play` when no `zoneId` is given — a zone/output id or a display-name substring. If unset, the server falls back to the only zone, an `Office` zone, or the currently-playing zone; if it still can't decide it returns `ZONE_AMBIGUOUS` so the agent can ask. |

## Tools

| Tool | Purpose |
| --- | --- |
| `list_zones()` | List playable zones/outputs (id, name, state, output ids). |
| `search_music({ query, type?, limit?, includeStreaming? })` | Resolve a text query into ranked browse candidates (opaque, session-scoped item keys). `type` (`artist`/`album`/`track`/`genre`/`playlist`/`radio`) restricts the category; for non-genre types an empty typed search broadens to all categories. See [Streaming search](#streaming-search-genre-and-artist) for `type:"genre"`/`type:"artist"` and `includeStreaming`. |
| `get_tracks_for({ itemKey, limit? })` | Expand an artist/album/genre/playlist candidate into concrete playable tracks. |
| `play_now({ zoneId?, itemKey, shuffle? })` | Immediately play one search candidate; `zoneId` optional (defaults as above). |
| `enqueue_and_play({ zoneId?, itemKeys, shuffle? })` | Build an ad-hoc queue from curated item keys and start it (**replaces** the zone's queue); reports queued/skipped. |
| `now_playing({ zoneId? })` | Snapshot of the zone's current track — state, title, artist, album, seek position. `title`/`artist`/`album` are undefined when nothing is playing. |
| `control_playback({ zoneId?, action })` | Run a transport verb: `pause` / `resume` / `next` / `previous` / `stop`. |
| `set_volume({ zoneId?, level })` | Set the zone's volume to `level` percent (0–100). Rescales to each output's native range; incremental outputs are reported as skipped. |
| `mute({ zoneId?, muted })` | Mute (`muted: true`) or unmute (`muted: false`) every output in the zone. |

### Streaming search (genre and artist)

Genres don't appear in Roon's flat search hierarchy, so `search_music({ type: "genre" })`
is handled specially: the server walks Roon's dedicated **Genres** tree (cached per
session) and returns the nearest-match genre nodes by fuzzy score, with their parent
path in the subtitle — e.g. `"Psychedelic Trance"` yields `Psytrance` / `Trance`. It
never silently broadens to artists/albums. These candidates are **library-scoped**
(genres present in your collection, including TIDAL albums you've added). Expand one
with `get_tracks_for` to get a cross-album mix of that genre.

Artist search is library-scoped too: `search_music({ type: "artist" })` returns artists
present in your collection. When the top-ranked artist has no library content — e.g. a
node with `subtitle: "0 Albums"` because all albums were removed, or an artist not in
your library at all but available on TIDAL — the result's `message` field carries a
hint so the agent can opt in to the streaming path (see below) without having to
discover the dead end at `get_tracks_for` time.

Pass **`includeStreaming: true`** (meaningful for both `type:"genre"` and
`type:"artist"`) to also pull a track mix from streaming services for discovery beyond
your library:

- For `type:"genre"`, the server takes the genre-relevant **albums** the flat search
  surfaces and samples tracks across them. Library genre nodes come first, then
  ready-to-play streaming tracks (each a `track` candidate, source group `Streaming`)
  appended after.
- For `type:"artist"`, the server runs a track search and filters to entries by that
  artist (matching the track's subtitle, which Roon uses for the artist on track rows).
  Library artist candidates come first, then streaming tracks by the same artist
  appended after. This is the path that unblocks "play/queue multiple *Artist* songs"
  for an artist with no library content: the streaming tracks are queue-playable
  directly via `enqueue_and_play`. Results are best-effort — a small fraction may be
  features or compilations; the agent's per-artist cap / dedupe handles that.

Default is `false` (library only).

> Cost: with `includeStreaming` on, each sampled album/track re-navigates the flat
> search, so an opt-in streaming search does a handful of extra browse round-trips.

### Now playing & transport

`now_playing({ zoneId? })` returns a structured snapshot (state, title, artist,
album, seek position) so the agent can confirm what's on and where before
running a transport verb. The server subscribes to Roon's zone-state stream
once per paired Core and waits for the next `Changed` event after `play_now`
/`enqueue_and_play`/`control_playback` — so `nowPlaying` in the response
reflects the new track rather than the one that was playing before the
action. The wait times out fast on a slow Core (2 s) and falls back to the
cached snapshot, so a hung subscription can never delay an MCP call.
`control_playback` takes one verb at a time
(`pause`, `resume`, `next`, `previous`, `stop`) — there is no compound
"pause and skip." For "louder" / "softer" without a number, `set_volume` is
absolute, so the agent should ask for a target percent or apply a default
delta; volume isn't reported in `now_playing`. Volume and mute fan out to
every output in the resolved zone and rescale per output, so a single
`set_volume({ level: 50 })` works correctly across a grouped zone with mixed
dB / numeric devices; incremental outputs (IR blasters and the like) are
reported as `skipped` in the result.

## Assumptions

- **Core language: English.** Category/action label matching (`Artists`, `Play Now`,
  `Top Tracks`, …) assumes an English Core.
- **Sources: local library + TIDAL.** What searches surface reflects this; results
  differ on a local-only Core.
- **Queue: replace.** `enqueue_and_play` starts a fresh queue rather than adding to
  whatever is already playing.
- **Curation is agent-side.** Dedupe / cap-per-artist / ordering / trimming stay in the
  agent; the server has no curation logic.

There is no `save_playlist` tool: Roon exposes no official playlist-write service, so
durable playlists are out of scope. Curated playback is delivered by `enqueue_and_play`
(an ad-hoc, in-the-moment queue).

## Logging

Every Roon API call (`browse`, `load`, `get_zones`, `change_settings`) emits one
structured line to **stderr** (stdout stays reserved for MCP JSON-RPC):

```
[roon-call] {"t":"2026-06-19T18:00:00.000Z","lvl":"info","op":"browse","ms":12,"params":{"hierarchy":"search","item_key":"…"},"result":{"action":"list","count":7}}
```

Failures log `lvl:"error"` with the mapped error code, and retries surface as repeated
lines for the same `op`. Grep stderr for `[roon-call]` to trace a flow.

## Development

```bash
npm install              # pulls node-roon-api packages from RoonLabs' GitHub
npm run build
npm test                 # builds, then runs node:test
npm run dev              # tsc --watch
npm run typecheck
```

Run the built server directly:

```bash
npm start
```

### Integration smoke test

`scripts/integration.mjs` spawns the built server over stdio (like a real MCP client)
and runs list → search → expand against your Core. Audible steps are opt-in so it never
blasts music by accident:

```bash
npm run build
node scripts/integration.mjs                 # list_zones + search only (read-only)
ROON_PLAY=1 node scripts/integration.mjs     # also play_now a shuffled genre
ROON_ENQUEUE=1 node scripts/integration.mjs  # also enqueue a few curated tracks
# overrides: ROON_ZONE="Office"  ROON_QUERY="Tycho"
```

Enable **Roon MCP** under Roon → Settings → Extensions on the first run (the script
retries `list_zones` for ~45s while it waits to pair).

## Releasing

```bash
npm run release -- <patch|minor|major>
```

Requires a clean worktree on `main` and a matching `## [<version>]` entry in
[CHANGELOG.md](CHANGELOG.md). The script runs the tests, bumps the version, tags the
commit, and verifies the package with `npm pack`. It then prints the push and
`npm publish` commands to run.

## License

[MIT](LICENSE)
