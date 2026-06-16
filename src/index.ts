#!/usr/bin/env node
import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { RoonClient } from "./RoonClient.js";
import { RoonMcpServer } from "./RoonMcpServer.js";
import { SearchService } from "./SearchService.js";
import { ZoneService } from "./ZoneService.js";

// node-roon-api logs discovery chatter via console.log. On a stdio MCP server
// stdout is reserved for JSON-RPC, so route all console output to stderr.
for (const method of ["log", "info", "debug", "warn"] as const) {
  console[method] = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(" ")}\n`);
  };
}

async function main(): Promise<void> {
  const roon = new RoonClient();
  const zones = new ZoneService(roon);
  const browse = new BrowseSessionManager(roon);
  const search = new SearchService(browse);
  const server = new RoonMcpServer(roon, zones, search);

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
