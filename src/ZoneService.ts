import type {
  GetZonesBody,
  RoonApiZone,
  RoonZoneState,
} from "node-roon-api-transport";

import { RoonClient } from "./RoonClient.js";
import { RoonMcpError, type RoonZone, type ZoneState } from "./types.js";

export interface ZoneResolutionAmbiguous {
  ambiguous: true;
  candidates: RoonZone[];
}

function mapState(state: RoonZoneState | undefined): ZoneState {
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
  constructor(private readonly roon: RoonClient) {}

  /** List all playable zones exposed by the paired Core. */
  async listZones(): Promise<RoonZone[]> {
    await this.roon.waitForCore();
    const transport = this.roon.getTransport();

    const body = await new Promise<GetZonesBody>((resolve, reject) => {
      transport.get_zones((error, result) => {
        if (error) {
          reject(new RoonMcpError("BROWSE_FAILED", `get_zones failed: ${error}`));
          return;
        }
        resolve(result);
      });
    });

    return (body.zones ?? []).map(toRoonZone);
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
      const needle = preferredName.trim().toLowerCase();
      const exact = zones.filter((z) => z.displayName.toLowerCase() === needle);
      if (exact.length === 1) return exact[0]!;

      const fuzzy = zones.filter((z) =>
        z.displayName.toLowerCase().includes(needle),
      );
      if (fuzzy.length === 1) return fuzzy[0]!;
      if (fuzzy.length > 1) return { ambiguous: true, candidates: fuzzy };
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
