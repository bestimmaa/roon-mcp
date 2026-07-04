# Changelog

All notable changes to this project will be documented in this file.

The version history source of truth is git tags in the format `vMAJOR.MINOR.PATCH`.

## [0.3.0] - 2026-07-04

### Added

- `now_playing` now reports `volumePercent` and `isMuted` (issue #10), so
  relative volume requests like "make it louder" have something to compute
  from.
- `control_playback` gains a `playpause` verb, and two new tools land:
  `seek` (absolute position or relative delta) and `set_loop`
  (off/all/one) (issue #17).
- `play_now` accepts `addToQueue: true` to append to the zone's existing
  queue instead of replacing it.

### Fixed

- The MCP server handshake reported a hard-coded `0.1.0` instead of the
  real package version (issue #6).
- Unexpected errors were mislabeled `BROWSE_FAILED`; they now use a
  dedicated `INTERNAL_ERROR` code so an agent doesn't retry a genuine bug
  as if it were a browse hiccup (issue #13).
- `console.error` now routes through the same stderr redirect as the other
  console methods, for uniform log formatting (issue #15).
- `now_playing` threw an unshaped `undefined` instead of `ZONE_NOT_FOUND`
  when a zone vanished mid-request (issue #9).
- `enqueue_and_play` no longer warns about shuffle being off when
  `change_settings` is simply unavailable — a common, harmless case on
  older transports (issue #11).
- A pending `waitForCore` call now rejects immediately with
  `NO_CORE_PAIRED` when the Core unpairs or the client stops, instead of
  hanging until its timeout (issue #16).
- Library search candidates no longer carry a stray result count (e.g.
  `"Artists (12)"`) in `sourceGroup` (issue #12).
- `control_playback(resume)` is now a no-op on an already-playing zone
  instead of failing with "Action resume is not available" (issue #7).
- `set_volume`/`mute` targeting a single output in a grouped zone no
  longer fans out to every output in the group (issue #14).
- The genre search index now expires after 60 minutes so genres
  added/removed/renamed in Roon eventually surface without a restart
  (issue #18).

### Changed

- README: clarified that streaming search/transport support isn't
  Tidal-specific, and simplified the streaming search and transport
  sections for non-technical readers.

## [0.2.3] - 2026-06-22

### Fixed

- Extension ID updated to `com.bestimmaa.roon-mcp` and website URL corrected
  to the `bestimmaa` GitHub org. Display version now reads dynamically from
  `package.json` instead of being hard-coded.

## [0.2.2] - 2026-06-22

### Fixed

- Pairing state now persists to a stable per-user path
  (`~/.config/roon-mcp/config.json`, override via `ROON_MCP_CONFIG`) instead of
  a `config.json` relative to the launch directory (issue #4). An MCP server is
  started from unpredictable working directories, so the old behavior lost the
  pairing token on every restart — Roon then registered a fresh "Discovered"
  extension, and multiple enabled duplicates caused intermittent
  `NO_CORE_PAIRED` failures on transport calls. The extension now stays
  authorized across restarts. Existing duplicate "Roon MCP" entries should be
  removed once in Roon → Settings → Extensions.

## [0.2.1]

### Fixed

- `nowPlaying` returned by `play_now` / `enqueue_and_play` no longer reports
  the track that was playing *before* the action (issue #1). The server now
  subscribes to Roon's zone-state stream at startup and waits for the next
  `Changed` event after a playback action before reading the snapshot, so
  the response reflects the new track. Falls back to the cached snapshot
  after a 2 s timeout so a slow Core never delays an MCP call.

### Changed

- README: added a natural-language example prompt to illustrate conversational
  Roon control via an AI agent.

## [0.2.0] - 2026-06-21

### Added

- `now_playing`, `control_playback`, `set_volume`, and `mute` tools to expose
  Roon's transport controls and current-track state. Previously the server
  could only start playback, not steer it.
- `search_music({ type: "artist", includeStreaming: true })` now appends a
  streaming track mix by the requested artist (via a track search filtered
  to that artist's subtitle), so requests like "queue multiple *Artist*
  songs" work even when the artist is missing from the local library or
  has zero library albums. The streaming path mirrors the existing
  genre `includeStreaming` flow: library candidates first, then
  ready-to-play streaming tracks appended with `sourceGroup: "Streaming"`.
- `search_music({ type: "artist" })` now reports an artist with no library
  content (e.g. `subtitle: "0 Albums"`) via the result's `message` field,
  so the agent can opt in to the streaming fallback up front instead of
  discovering the dead end at `get_tracks_for` time.

## [0.1.0] - 2026-06-21

### Added

- Initial version.
