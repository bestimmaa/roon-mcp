#!/usr/bin/env node
import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { GenreService } from "./GenreService.js";
import { PlaybackService } from "./PlaybackService.js";
import { RoonClient } from "./RoonClient.js";
import { RoonMcpServer } from "./RoonMcpServer.js";
import { SearchService } from "./SearchService.js";
import { TrackExpansionService } from "./TrackExpansionService.js";
import { ZoneService } from "./ZoneService.js";
import { createStderrLogger } from "./logger.js";

// node-roon-api logs discovery chatter via console.log. On a stdio MCP server
// stdout is reserved for JSON-RPC, so route all console output to stderr.
for (const method of ["log", "info", "debug", "warn"] as const) {
  console[method] = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(" ")}\n`);
  };
}

async function main(): Promise<void> {
  // One structured logger shared across services; emits [roon-call] lines to
  // stderr so stdout stays reserved for the MCP JSON-RPC stream.
  const logger = createStderrLogger();
  const roon = new RoonClient();
  // Optional configured default zone (a zone/output id or display-name) used
  // when a playback call omits its zoneId.
  const defaultZone = process.env.ROON_DEFAULT_ZONE?.trim() || undefined;
  const zones = new ZoneService(roon, logger, defaultZone);
  const browse = new BrowseSessionManager(roon, logger);
  const genres = new GenreService(browse);
  const search = new SearchService(browse, genres);
  const tracks = new TrackExpansionService(browse);
  const playback = new PlaybackService(browse, zones, roon, tracks, logger);
  const server = new RoonMcpServer(roon, zones, search, tracks, playback);

  const shutdown = () => {
    void server.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.start();
}

main().catch((err) => {
  process.stderr.write(`[roon-mcp] fatal: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
