# Changelog

All notable changes to this project will be documented in this file.

The version history source of truth is git tags in the format `vMAJOR.MINOR.PATCH`.

## [Unreleased]

### Fixed

- `nowPlaying` returned by `play_now` / `enqueue_and_play` no longer reports
  the track that was playing *before* the action (issue #1). The server now
  subscribes to Roon's zone-state stream at startup and waits for the next
  `Changed` event after a playback action before reading the snapshot, so
  the response reflects the new track. Falls back to the cached snapshot
  after a 2 s timeout so a slow Core never delays an MCP call.

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
