import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { PlaybackService } from "./PlaybackService.js";
import { RoonClient } from "./RoonClient.js";
import { SearchService } from "./SearchService.js";
import { TrackExpansionService } from "./TrackExpansionService.js";
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
    private readonly tracks: TrackExpansionService,
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
          "for non-genre types, an empty typed search broadens to all categories. " +
          "type:\"genre\" is special: genres don't appear in Roon's flat search, so " +
          "the server walks the dedicated Genres tree and returns the nearest-match " +
          "genre nodes (with their parent path in the subtitle) without broadening — " +
          "e.g. \"Psychedelic Trance\" yields \"Psytrance\"/\"Trance\". Set " +
          "includeStreaming:true (only meaningful for type:\"genre\") to also pull a " +
          "track mix from streaming services (e.g. TIDAL): the server takes the " +
          "genre-relevant albums and samples tracks across them, so library genre " +
          "nodes are listed first and ready-to-play streaming tracks appended after. " +
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
          includeStreaming: z
            .boolean()
            .optional()
            .describe(
              "Also pull a track mix from streaming services. " +
                "Only applies when type is \"genre\": library genre nodes come first, " +
                "then tracks sampled across genre-relevant streaming albums. Default false.",
            ),
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
      "get_tracks_for",
      {
        title: "Expand a Roon item into tracks",
        description:
          "Expand an artist, album, genre, or playlist candidate into concrete " +
          "playable tracks. Pass an itemKey from a recent search_music result. " +
          "Returns track candidates with session-scoped item keys (use them " +
          "promptly with enqueue_and_play). Non-expandable items return empty " +
          "tracks with a skipped reason rather than an error.",
        inputSchema: {
          itemKey: z
            .string()
            .min(1)
            .describe("Opaque item key from a recent search_music result."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Max tracks to return (default 10)."),
        },
      },
      async (args) => {
        try {
          const result = await this.tracks.getTracksFor(args);
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
          "Immediately play a single search candidate in the target zone. Pass an " +
          "itemKey from a recent search_music result (item keys are session-scoped, " +
          "so use a fresh one). zoneId is optional: omit it to use the configured " +
          "default zone (ROON_DEFAULT_ZONE) or the single/Office/playing fallback; " +
          "an ambiguous result returns ZONE_AMBIGUOUS so you can ask. Optionally " +
          "shuffle. Returns a PlaybackResult.",
        inputSchema: {
          zoneId: z
            .string()
            .min(1)
            .optional()
            .describe("Target zone id or output id (from list_zones). Omit to use the default zone."),
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

    this.server.registerTool(
      "enqueue_and_play",
      {
        title: "Build and start a curated Roon queue",
        description:
          "Build an ad-hoc queue from an ordered list of curated item keys and " +
          "start playback in the target zone. This replaces the zone's current " +
          "queue: the first playable item starts immediately (Play Now), the rest " +
          "are appended in order. Pass itemKeys from recent get_tracks_for/" +
          "search_music results (use them promptly — they are session-scoped). " +
          "zoneId is optional (omit to use the default zone; see play_now). " +
          "Optionally shuffle. Returns a PlaybackResult with queued/skipped counts " +
          "so you can backfill skipped items.",
        inputSchema: {
          zoneId: z
            .string()
            .min(1)
            .optional()
            .describe("Target zone id or output id (from list_zones). Omit to use the default zone."),
          itemKeys: z
            .array(z.string().min(1))
            .min(1)
            .describe("Ordered item keys to queue (from get_tracks_for/search_music)."),
          shuffle: z
            .boolean()
            .optional()
            .describe("Shuffle the queue; omit to leave the zone's setting unchanged."),
        },
      },
      async (args) => {
        try {
          const result = await this.playback.enqueueAndPlay(args);
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
