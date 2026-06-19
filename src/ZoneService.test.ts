import assert from "node:assert/strict";
import { test } from "node:test";

import type { GetZonesBody, RoonApiZone } from "node-roon-api-transport";

import { RoonClient } from "./RoonClient.js";
import { ZoneService } from "./ZoneService.js";
import { RoonMcpError, type RoonZone } from "./types.js";

function zone(partial: Partial<RoonApiZone> & { zone_id: string }): RoonApiZone {
  return {
    display_name: partial.zone_id,
    state: "stopped",
    outputs: [{ output_id: `o:${partial.zone_id}`, zone_id: partial.zone_id, display_name: partial.zone_id }],
    ...partial,
  };
}

/** Builds a ZoneService backed by a stub RoonClient returning the given zones. */
function serviceWith(zones: RoonApiZone[], defaultZone?: string): ZoneService {
  const stub = {
    waitForCore: async () => undefined,
    getTransport: () => ({
      get_zones: (cb: (e: string | false, b: GetZonesBody) => void) => cb(false, { zones }),
      subscribe_zones: () => {},
    }),
  } as unknown as RoonClient;
  return new ZoneService(stub, undefined, defaultZone);
}

test("listZones maps Roon zones to the public shape", async () => {
  const svc = serviceWith([zone({ zone_id: "z1", display_name: "Office", state: "playing" })]);
  const [z] = await svc.listZones();
  assert.deepEqual(z, {
    zoneId: "z1",
    displayName: "Office",
    state: "playing",
    outputIds: ["o:z1"],
    isDefaultCandidate: true,
  } satisfies RoonZone);
});

test("resolveZone returns the only zone without a preferred name", async () => {
  const svc = serviceWith([zone({ zone_id: "z1", display_name: "Kitchen" })]);
  const res = await svc.resolveZone();
  assert.equal((res as RoonZone).zoneId, "z1");
});

test("resolveZone prefers an exact name match over a substring", async () => {
  const svc = serviceWith([
    zone({ zone_id: "z1", display_name: "Office" }),
    zone({ zone_id: "z2", display_name: "Office Speakers" }),
  ]);
  const res = await svc.resolveZone("Office");
  assert.equal((res as RoonZone).zoneId, "z1");
});

test("resolveZone returns ambiguity when a fuzzy name matches several zones", async () => {
  const svc = serviceWith([
    zone({ zone_id: "z1", display_name: "Living Room" }),
    zone({ zone_id: "z2", display_name: "Living Room Sub" }),
  ]);
  const res = await svc.resolveZone("living");
  assert.equal("ambiguous" in res && res.ambiguous, true);
});

test("resolveZone falls back to an Office zone with no preferred name", async () => {
  const svc = serviceWith([
    zone({ zone_id: "z1", display_name: "Kitchen" }),
    zone({ zone_id: "z2", display_name: "Home Office" }),
  ]);
  const res = await svc.resolveZone();
  assert.equal((res as RoonZone).zoneId, "z2");
});

test("resolveZone prefers the currently playing zone when no name match", async () => {
  const svc = serviceWith([
    zone({ zone_id: "z1", display_name: "Kitchen", state: "stopped" }),
    zone({ zone_id: "z2", display_name: "Bedroom", state: "playing" }),
  ]);
  const res = await svc.resolveZone();
  assert.equal((res as RoonZone).zoneId, "z2");
});

test("resolveZone throws ZONE_NOT_FOUND when there are no zones", async () => {
  const svc = serviceWith([]);
  await assert.rejects(svc.resolveZone(), (e) => e instanceof RoonMcpError && e.code === "ZONE_NOT_FOUND");
});

test("resolveTarget passes an explicit id through unchanged (output id preserved)", async () => {
  const svc = serviceWith([
    zone({ zone_id: "z1", display_name: "Office" }),
    zone({ zone_id: "z2", display_name: "Kitchen" }),
  ]);
  const out = await svc.resolveTarget("o:z2");
  assert.equal(out.targetId, "o:z2"); // caller's output id, not the zone id
  assert.equal(out.zone.zoneId, "z2");
});

test("resolveTarget rejects an unknown explicit id with ZONE_NOT_FOUND", async () => {
  const svc = serviceWith([zone({ zone_id: "z1", display_name: "Office" })]);
  await assert.rejects(
    svc.resolveTarget("nope"),
    (e) => e instanceof RoonMcpError && e.code === "ZONE_NOT_FOUND",
  );
});

test("resolveTarget uses the configured default zone (by name) when none is passed", async () => {
  const svc = serviceWith(
    [zone({ zone_id: "z1", display_name: "Kitchen" }), zone({ zone_id: "z2", display_name: "Office" })],
    "Office",
  );
  const out = await svc.resolveTarget();
  assert.equal(out.targetId, "z2");
});

test("resolveTarget honours a default given as a zone id", async () => {
  const svc = serviceWith(
    [zone({ zone_id: "z1", display_name: "Kitchen" }), zone({ zone_id: "z2", display_name: "Office" })],
    "z1",
  );
  const out = await svc.resolveTarget();
  assert.equal(out.targetId, "z1");
});

test("resolveTarget falls back to the single zone when no default is set", async () => {
  const svc = serviceWith([zone({ zone_id: "z1", display_name: "Kitchen" })]);
  const out = await svc.resolveTarget();
  assert.equal(out.targetId, "z1");
});

test("resolveTarget throws ZONE_AMBIGUOUS when no default and several zones", async () => {
  const svc = serviceWith([
    zone({ zone_id: "z1", display_name: "Kitchen", state: "stopped" }),
    zone({ zone_id: "z2", display_name: "Bedroom", state: "stopped" }),
  ]);
  await assert.rejects(
    svc.resolveTarget(),
    (e) => e instanceof RoonMcpError && e.code === "ZONE_AMBIGUOUS",
  );
});
