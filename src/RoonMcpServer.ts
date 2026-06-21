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
          "Use this when the user asks which rooms, speakers, or outputs Roon can " +
          "play to, or before starting playback when the target zone is unclear " +
          "(e.g. \"what zones are on?\", \"play in the kitchen\", \"which speaker is " +
          "in the office?\"). Lists every zone/output the paired Core exposes with " +
          "its id, display name, current playback state, and output ids. Call this " +
          "first if no zone is obvious and ROON_DEFAULT_ZONE is not set.",
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
          "Use this when the user names music to find — an artist, album, track, " +
          "playlist, radio station, or genre (e.g. \"find Tycho\", \"look up the " +
          "album In Rainbows\", \"play some Psytrance\", \"anything by Ryuichi " +
          "Sakamoto?\"). Resolves a free-text query into ranked Roon browse " +
          "candidates. Optionally restrict to one item type (artist, album, track, " +
          "genre, playlist, radio); for non-genre types, an empty typed search " +
          "broadens to all categories. type:\"genre\" is special — genres don't " +
          "appear in Roon's flat search, so the server walks the dedicated Genres " +
          "tree and returns the nearest-match genre nodes (with parent path in the " +
          "subtitle) without broadening; e.g. \"Psychedelic Trance\" yields " +
          "\"Psytrance\"/\"Trance\". Set includeStreaming:true (only meaningful for " +
          "type:\"genre\") to also pull a track mix from streaming services " +
          "(e.g. TIDAL): the server takes the genre-relevant albums and samples " +
          "tracks across them, so library genre nodes come first and ready-to-play " +
          "streaming tracks are appended after. Returns opaque, session-scoped item " +
          "keys for use by the playback tools — pair with get_tracks_for to expand, " +
          "then play_now or enqueue_and_play.",
        inputSchema: {
          query: z
            .string()
            .min(1)
            .describe(
              "What to search for — an artist, album, track, playlist, radio, or " +
                "genre name (e.g. 'Tycho', 'In Rainbows', 'Dark Ambient').",
            ),
          type: z
            .enum(MUSIC_ITEM_TYPES)
            .optional()
            .describe(
              "Restrict the search to one item type. Omit to broaden across all " +
                "non-genre categories. Use 'genre' for music-genre lookups.",
            ),
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
              "Only for type 'genre': also pull a track mix from streaming services " +
                "(e.g. TIDAL). Library genre nodes come first, then sampled streaming " +
                "tracks. Default false (library only).",
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
          "Use this after search_music when the user wants a concrete list of " +
          "songs — to preview tracks, build a queue, or pick one to start with " +
          "(e.g. \"what tracks are on this album?\", \"give me 5 tracks of " +
          "Dark Ambient\", \"what's on this playlist?\"). Expands an artist, " +
          "album, genre, or playlist candidate into concrete playable tracks. " +
          "Pass an itemKey from a recent search_music result. Returns track " +
          "candidates with session-scoped item keys (use them promptly with " +
          "enqueue_and_play). Non-expandable items return empty tracks with a " +
          "skipped reason rather than an error.",
        inputSchema: {
          itemKey: z
            .string()
            .min(1)
            .describe(
              "Item key to expand — from a recent search_music candidate (artist, " +
                "album, genre, or playlist).",
            ),
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
          "Use this when the user wants one specific thing playing right now — " +
          "an album, artist, playlist, genre mix, or single track (e.g. \"play " +
          "Tycho\", \"put on In Rainbows\", \"start some Psytrance in the office\", " +
          "\"play that track\"). Immediately plays a single search candidate in " +
          "the target zone and replaces whatever was queued. Pass an itemKey from " +
          "a recent search_music (or get_tracks_for) result — item keys are " +
          "session-scoped, so use a fresh one. zoneId is optional: omit it to use " +
          "ROON_DEFAULT_ZONE, or fall back to the only zone / an \"Office\" zone / " +
          "the currently-playing zone; if it still can't decide it returns " +
          "ZONE_AMBIGUOUS so the agent can ask the user or call list_zones. " +
          "Optionally shuffle. Returns a PlaybackResult.",
        inputSchema: {
          zoneId: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Target zone id or output id from list_zones (e.g. an id, or a name " +
                "substring like 'Office'). Omit to use ROON_DEFAULT_ZONE or fall " +
                "back automatically.",
            ),
          itemKey: z
            .string()
            .min(1)
            .describe(
              "What to play — item key from a recent search_music or get_tracks_for " +
                "result (album, artist, playlist, genre, track, etc.).",
            ),
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
          "Use this when the user wants a custom lineup — a mix of artists, a " +
          "shuffled selection across albums, a hand-picked set of tracks, or any " +
          "time \"queue\", \"setlist\", \"mix of\", or \"play these in order\" comes " +
          "up (e.g. \"queue up five Tycho tracks then some Boards of Canada\", " +
          "\"shuffle 10 ambient tracks\", \"build a set: artist A, then B, then C\"). " +
          "Builds an ad-hoc queue from an ordered list of curated item keys and " +
          "starts playback in the target zone. This replaces the zone's current " +
          "queue: the first playable item starts immediately (Play Now), the rest " +
          "are appended in order. Pass itemKeys from recent get_tracks_for / " +
          "search_music results (use them promptly — they are session-scoped). " +
          "zoneId is optional (omit to use the default zone; see play_now). " +
          "Optionally shuffle. Returns a PlaybackResult with queued/skipped counts " +
          "so you can backfill skipped items.",
        inputSchema: {
          zoneId: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Target zone id or output id from list_zones. Omit to use the default " +
                "zone (see play_now).",
            ),
          itemKeys: z
            .array(z.string().min(1))
            .min(1)
            .describe(
              "Ordered item keys to queue, from recent get_tracks_for or " +
                "search_music results (tracks, albums, artists, etc.).",
            ),
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
