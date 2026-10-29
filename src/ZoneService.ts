import type {
  GetZonesBody,
  RoonApiTransport,
  RoonApiZone,
  RoonZoneState,
} from "node-roon-api-transport";

import { RoonClient } from "./RoonClient.js";
import { silentLogger, type RoonCallLogger } from "./logger.js";
import { findZone, ZoneSubscription } from "./ZoneSubscription.js";
import { RoonMcpError, type RoonZone, type ZoneState } from "./types.js";

export interface ZoneResolutionAmbiguous {
  ambiguous: true;
  candidates: RoonZone[];
}

export interface ResolvedZoneTarget {
  /** Id to pass to Roon browse actions — the caller's id (which may be an
   * output id) when explicit, else the resolved zone's id. */
  targetId: string;
  zone: RoonZone;
}

export function mapState(state: RoonZoneState | undefined): ZoneState {
  switch (state) {
    case "playing":
    case "paused":
    case "loading":
    case "stopped":
      return state;
    default:
      return "unknown";
  }
}

/** Exact display-name matches if any, else substring matches (case-insensitive). */
function matchByName(zones: RoonZone[], name: string): RoonZone[] {
  const needle = name.trim().toLowerCase();
  const exact = zones.filter((z) => z.displayName.toLowerCase() === needle);
  return exact.length
    ? exact
    : zones.filter((z) => z.displayName.toLowerCase().includes(needle));
}

function candidatesOf(zones: RoonZone[]): { zoneId: string; displayName: string }[] {
  return zones.map((z) => ({ zoneId: z.zoneId, displayName: z.displayName }));
}

/** Best-effort "now playing" one-liner for a raw zone. */
export function nowPlayingLine(zone: RoonApiZone | undefined): string | undefined {
  const np = zone?.now_playing;
  return np?.two_line?.line1 ?? np?.one_line?.line1 ?? np?.three_line?.line1;
}

function toRoonZone(zone: RoonApiZone): RoonZone {
  return {
    zoneId: zone.zone_id,
    displayName: zone.display_name,
    state: mapState(zone.state),
    outputIds: (zone.outputs ?? []).map((o) => o.output_id),
    // A zone currently playing is the most natural default target.
    isDefaultCandidate: zone.state === "playing",
  };
}

/** Reads and ranks Roon zones via the Transport service. */
export class ZoneService {
  constructor(
    private readonly roon: RoonClient,
    private readonly logger: RoonCallLogger = silentLogger,
    /** Optional configured default (zone/output id or display-name substring),
     * used when a playback call omits its zoneId. */
    private readonly defaultZone?: string,
  ) {}

  /** List all playable zones exposed by the paired Core. */
  async listZones(): Promise<RoonZone[]> {
    const body = await this.getZonesBody();
    return (body.zones ?? []).map(toRoonZone);
  }

  /**
   * Find a zone by its zone id or by any of its output ids. Roon playback
   * actions accept either, so callers can pass whichever `list_zones` exposed.
   */
  async findZone(idOrOutput: string): Promise<RoonZone | undefined> {
    const raw = await this.findRawZone(idOrOutput);
    return raw ? toRoonZone(raw) : undefined;
  }

  /**
   * Resolve the zone a playback call should target.
   * - Explicit id (zone or output): used as-is. If nothing matches as an id,
   *   fall back to display-name matching — the tool contract promises "an id,
   *   or a name substring like 'Office'". Still nothing → `ZONE_NOT_FOUND`.
   * - Omitted: fall back to the configured default (matched as an id first,
   *   then as a display name), else the single/Office/playing heuristics.
   * Returns `ZONE_AMBIGUOUS` when no single zone can be chosen.
   */
  async resolveTarget(explicitId?: string): Promise<ResolvedZoneTarget> {
    if (explicitId) {
      const zone = await this.findZone(explicitId);
      if (zone) {
        // Preserve the caller's id (it may be an output id) as the action target.
        return { targetId: explicitId, zone };
      }
      // Strict name matching only — no single-zone shortcut, so a garbage id
      // never silently redirects to an unrelated zone.
      const matches = matchByName(await this.listZones(), explicitId);
      if (matches.length === 1) return { targetId: matches[0]!.zoneId, zone: matches[0]! };
      if (matches.length > 1) {
        throw new RoonMcpError(
          "ZONE_AMBIGUOUS",
          `"${explicitId}" matches multiple zones; pass an explicit zoneId.`,
          { candidates: candidatesOf(matches) },
        );
      }
      throw new RoonMcpError(
        "ZONE_NOT_FOUND",
        `No zone or output matches "${explicitId}". Call list_zones for current ids and names.`,
      );
    }

    // A configured default may be a zone/output id…
    if (this.defaultZone) {
      const byId = await this.findZone(this.defaultZone);
      if (byId) return { targetId: byId.zoneId, zone: byId };
    }

    // …or a display name; otherwise apply the resolution heuristics.
    const resolved = await this.resolveZone(this.defaultZone);
    if ("ambiguous" in resolved) {
      throw new RoonMcpError(
        "ZONE_AMBIGUOUS",
        this.defaultZone
          ? `Default zone "${this.defaultZone}" matches multiple zones; pass an explicit zoneId.`
          : "Multiple zones available; set ROON_DEFAULT_ZONE or pass an explicit zoneId.",
        { candidates: candidatesOf(resolved.candidates) },
      );
    }
    return { targetId: resolved.zoneId, zone: resolved };
  }

  /** Best-effort "now playing" one-liner for a zone or output id. */
  async nowPlayingFor(idOrOutput: string): Promise<string | undefined> {
    return nowPlayingLine(await this.findRawZone(idOrOutput));
  }

  /** The raw Roon zone for a zone or output id, from the current snapshot. */
  async findRawZone(idOrOutput: string): Promise<RoonApiZone | undefined> {
    return findZone(await this.getZonesBody(), idOrOutput);
  }

  /**
   * The current zone snapshot: the subscription cache when warm, else a
   * logged one-shot `get_zones`.
   */
  async getZonesBody(): Promise<GetZonesBody> {
    await this.roon.waitForCore();
    const transport = this.roon.getTransport();
    const sub: ZoneSubscription | undefined = this.roon.getActiveSubscription();
    if (sub) {
      // Prefer the cache kept current by Roon's `subscribe_zones` events;
      // fall back to a one-shot `get_zones` only on cold start (cache empty).
      return sub.getSnapshot(() => this.fallbackGetZones(transport));
    }
    return this.fallbackGetZones(transport);
  }

  private fallbackGetZones(transport: RoonApiTransport): Promise<GetZonesBody> {
    return this.logger.call(
      "get_zones",
      {},
      () =>
        new Promise<GetZonesBody>((resolve, reject) => {
          transport.get_zones((error, result) => {
            if (error) {
              reject(new RoonMcpError("BROWSE_FAILED", `get_zones failed: ${error}`));
              return;
            }
            resolve(result);
          });
        }),
      (body) => ({ zones: body.zones?.length ?? 0 }),
    );
  }

  /**
   * Resolve a single zone, applying the plan's resolution rules:
   * 1. Exact, then fuzzy, name match when a preferred name is given.
   * 2. Prefer a zone named "Office".
   * 3. Prefer a currently playing zone.
   * Returns ambiguity when several plausible zones remain.
   */
  async resolveZone(
    preferredName?: string,
  ): Promise<RoonZone | ZoneResolutionAmbiguous> {
    const zones = await this.listZones();

    if (zones.length === 0) {
      throw new RoonMcpError("ZONE_NOT_FOUND", "No zones are available on the Core.");
    }
    if (zones.length === 1) return zones[0]!;

    if (preferredName) {
      const matches = matchByName(zones, preferredName);
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) return { ambiguous: true, candidates: matches };
      throw new RoonMcpError(
        "ZONE_NOT_FOUND",
        `No zone matches "${preferredName}".`,
        { available: zones.map((z) => z.displayName) },
      );
    }

    const office = zones.filter((z) => z.displayName.toLowerCase().includes("office"));
    if (office.length === 1) return office[0]!;

    const playing = zones.filter((z) => z.state === "playing");
    if (playing.length === 1) return playing[0]!;

    return { ambiguous: true, candidates: zones };
  }
}
