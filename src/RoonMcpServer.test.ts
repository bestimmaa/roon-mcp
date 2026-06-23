import assert from "node:assert/strict";
import { test } from "node:test";

import pkg from "../package.json" with { type: "json" };

import { RoonMcpServer } from "./RoonMcpServer.js";
import { PlaybackService } from "./PlaybackService.js";
import { RoonClient } from "./RoonClient.js";
import { SearchService } from "./SearchService.js";
import { TrackExpansionService } from "./TrackExpansionService.js";
import { TransportService } from "./TransportService.js";
import { ZoneService } from "./ZoneService.js";

/**
 * Constructing the server only registers tool schemas (handlers are not
 * invoked), so empty stubs suffice. Guards against the version drifting back
 * to a hardcoded literal (issue #6).
 */
function buildServer(): RoonMcpServer {
  return new RoonMcpServer(
    {} as unknown as RoonClient,
    {} as unknown as ZoneService,
    {} as unknown as SearchService,
    {} as unknown as TrackExpansionService,
    {} as unknown as PlaybackService,
    {} as unknown as TransportService,
  );
}

test("the MCP server reports the package version, not a hardcoded literal", () => {
  const server = buildServer();
  assert.equal(server.version, pkg.version);
  assert.notEqual(server.version, "0.1.0");
});