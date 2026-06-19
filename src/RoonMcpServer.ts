import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { PlaybackService } from "./PlaybackService.js";
import { RoonClient } from "./RoonClient.js";
import { SearchService } from "./SearchService.js";
import { ZoneService } from "./ZoneService.js";
import { RoonMcpError } from "./types.js";

const MUSIC_ITEM_TYPES = [
  "artist",
  "album",
  "track",
  "genre",
  "playlist",
  "radio",
  "unknown",
] as const;

/**
 * Owns MCP startup and tool registration, and maps tool calls to services.
 * Milestone 1 ships only `list_zones`.
 */
export class RoonMcpServer {
  private readonly server: McpServer;

  constructor(
    private readonly roon: RoonClient,
    private readonly zones: ZoneService,
    private readonly search: SearchService,
    private readonly playback: PlaybackService,
  ) {
    this.server = new McpServer({
      name: "roon-mcp",
      version: "0.1.0",
    });
    this.registerTools();
  }

  registerTools(): void {
    this.server.registerTool(
      "list_zones",
      {
        title: "List Roon zones",
        description:
          "List the playable zones/outputs exposed by the paired Roon Core. " +
          "Returns each zone's id, display name, playback state, and output ids.",
        inputSchema: {},
      },
      async () => {
        try {
          const zones = await this.zones.listZones();
          const message =
            zones.length === 0 ? "No zones available on the paired Core." : undefined;
          return structured({ zones, ...(message ? { message } : {}) });
        } catch (err) {
          return toToolError(err);
        }
      },
    );

    this.server.registerTool(
      "search_music",
      {
        title: "Search Roon music",
        description:
          "Resolve a text query into ranked Roon browse candidates. Optionally " +
          "filter by item type (artist, album, track, genre, playlist, radio); " +
          "if a typed search is empty the server broadens to all categories. " +
          "Returns opaque, session-scoped item keys for use by playback tools.",
        inputSchema: {
          query: z.string().min(1).describe("Free-text search, e.g. 'Dark Ambient' or 'Tycho'."),
          type: z
            .enum(MUSIC_ITEM_TYPES)
            .optional()
            .describe("Restrict results to this item type."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Max candidates to return (default 10)."),
        },
      },
      async (args) => {
        try {
          const result = await this.search.searchMusic(args);
          return structured(result);
        } catch (err) {
          return toToolError(err);
        }
      },
    );

    this.server.registerTool(
      "play_now",
      {
        title: "Play an item now in a Roon zone",
        description:
          "Immediately play a single search candidate in the given zone. Pass a " +
          "zoneId (a zone id or output id from list_zones) and an itemKey from a " +
          "recent search_music result. Item keys are session-scoped, so use a " +
          "fresh one. Optionally shuffle. Returns a PlaybackResult.",
        inputSchema: {
          zoneId: z
            .string()
            .min(1)
            .describe("Target zone id or output id (from list_zones)."),
          itemKey: z
            .string()
            .min(1)
            .describe("Opaque item key from a recent search_music result."),
          shuffle: z
            .boolean()
            .optional()
            .describe("Shuffle the selection when starting playback."),
        },
      },
      async (args) => {
        try {
          const result = await this.playback.playNow(args);
          return structured(result);
        } catch (err) {
          return toToolError(err);
        }
      },
    );
  }

  async start(): Promise<void> {
    this.roon.start();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  async stop(): Promise<void> {
    this.roon.stop();
    await this.server.close();
  }
}

function structured(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function toToolError(err: unknown) {
  const code = err instanceof RoonMcpError ? err.code : "BROWSE_FAILED";
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true as const,
    content: [
      { type: "text" as const, text: JSON.stringify({ error: { code, message } }, null, 2) },
    ],
  };
}
