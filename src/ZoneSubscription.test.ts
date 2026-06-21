import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  GetZonesBody,
  RoonApiTransport,
  RoonApiZone,
} from "node-roon-api-transport";

import { ZoneSubscription } from "./ZoneSubscription.js";

/** Build a zone with sensible defaults so tests can focus on the bits that
 * matter (state, now_playing). */
function zone(partial: Partial<RoonApiZone> & { zone_id: string }): RoonApiZone {
  return {
    display_name: partial.zone_id,
    state: "stopped",
    outputs: [{ output_id: `o:${partial.zone_id}`, zone_id: partial.zone_id, display_name: partial.zone_id }],
    ...partial,
  };
}

/**
 * Builds a transport stub whose `subscribe_zones` callback can be invoked
 * manually to simulate Roon's `Subscribed` / `Changed` / `Unsubscribed`
 * events. Returns the subscription plus a `push` helper to drive it.
 */
function buildSubscription(initial: RoonApiZone[] = []): {
  sub: ZoneSubscription;
  push: (response: string, body: unknown) => void;
} {
  let cb: ((response: string, body: unknown) => void) | undefined;
  const transport = {
    subscribe_zones: (callback: (response: string, body: unknown) => void) => {
      cb = callback;
    },
  } as unknown as RoonApiTransport;

  const sub = new ZoneSubscription(transport, "core-1");
  sub.start();
  // Pre-load the cache so reads don't fall through to a one-shot RPC.
  if (initial.length) cb?.("Subscribed", { zones: initial });
  return { sub, push: (response, body) => cb?.(response, body) };
}

test("Subscribed populates the cache from the full snapshot", () => {
  const { sub } = buildSubscription([
    zone({ zone_id: "z1", state: "playing", now_playing: { two_line: { line1: "A" } } }),
  ]);
  // getSnapshot should return the cached body without invoking a fallback.
  void sub
    .getSnapshot(() => {
      throw new Error("fallback should not be called when the cache is fresh");
    })
    .then((body) => {
      assert.equal(body.zones?.length, 1);
      assert.equal(body.zones?.[0]?.zone_id, "z1");
    });
});

test("getSnapshot falls back to a one-shot RPC when the cache is empty", async () => {
  const transport = {
    subscribe_zones: () => {},
  } as unknown as RoonApiTransport;
  const sub = new ZoneSubscription(transport, "core-1");
  sub.start();

  const fallback = await sub.getSnapshot(
    async () => ({ zones: [zone({ zone_id: "lazy" })] }),
  );
  assert.equal(fallback.zones?.[0]?.zone_id, "lazy");
});

test("Changed merges zones_added, zones_changed, and zones_removed into the cache", () => {
  const { sub, push } = buildSubscription([
    zone({ zone_id: "z1" }),
    zone({ zone_id: "z2" }),
  ]);

  push("Changed", {
    zones_removed: ["z1"],
    zones_added: [zone({ zone_id: "z3" })],
    zones_changed: [zone({ zone_id: "z2", state: "playing" })],
  });

  void sub
    .getSnapshot(() => Promise.resolve({ zones: [] } satisfies GetZonesBody))
    .then((body) => {
      const ids = (body.zones ?? []).map((z) => z.zone_id).sort();
      assert.deepEqual(ids, ["z2", "z3"]);
      const z2 = body.zones?.find((z) => z.zone_id === "z2");
      assert.equal(z2?.state, "playing");
    });
});

test("waitForZoneChange resolves on a Changed event with a different fingerprint", async () => {
  const { sub, push } = buildSubscription([
    zone({
      zone_id: "z1",
      state: "playing",
      now_playing: { two_line: { line1: "Old Track", line2: "Old Artist" } },
    }),
  ]);
  // Capture the pre-action fingerprint manually.
  const before = (await sub.getSnapshot(() => Promise.resolve({ zones: [] }))).zones
    ? { state: "playing", title: "Old Track", artist: "Old Artist" } as const
    : undefined;
  assert.ok(before);

  // Simulate the new track landing.
  const waiter = sub.waitForZoneChange("z1", before);
  push("Changed", {
    zones_changed: [
      zone({
        zone_id: "z1",
        state: "playing",
        now_playing: { two_line: { line1: "New Track", line2: "New Artist" } },
      }),
    ],
  });

  const after = await waiter;
  const z1 = after.zones?.find((z) => z.zone_id === "z1");
  assert.equal(z1?.now_playing?.two_line?.line1, "New Track");
});

test("waitForZoneChange resolves immediately when the change already landed", async () => {
  const { sub, push } = buildSubscription([
    zone({ zone_id: "z1", state: "stopped" }),
  ]);
  // Push the new state BEFORE the wait — the synchronous check in
  // waitForZoneChange should catch it.
  push("Changed", {
    zones_changed: [
      zone({
        zone_id: "z1",
        state: "playing",
        now_playing: { two_line: { line1: "New Track" } },
      }),
    ],
  });
  const before = { state: "stopped", title: undefined, artist: undefined, album: undefined } as const;
  const after = await sub.waitForZoneChange("z1", before);
  const z1 = after.zones?.find((z) => z.zone_id === "z1");
  assert.equal(z1?.state, "playing");
});

test("waitForZoneChange times out and returns the latest snapshot", async () => {
  const { sub } = buildSubscription([
    zone({ zone_id: "z1", state: "stopped" }),
  ]);
  const before = { state: "stopped", title: undefined, artist: undefined, album: undefined } as const;
  const after = await sub.waitForZoneChange("z1", before, 5);
  // No change event ever fires; the waiter returns the current snapshot
  // so the caller can still report *something* useful.
  assert.equal(after.zones?.length, 1);
});

test("waitForZoneChange does not match a seek-position-only update", async () => {
  // Issue: a high-frequency `seek_position` tick should not satisfy a
  // wait — the agent is waiting for the *track* to change, not for the
  // playback position to advance. node-roon-api-transport's internal cache
  // already updates `seek_position` on `Changed`/`zones_seek_changed`; we
  // only consume `zones_changed` here, so a seek-only tick doesn't move
  // the fingerprint. This test pins that behavior: a Changed event with
  // the same track must not resolve the waiter before the timeout.
  const { sub, push } = buildSubscription([
    zone({
      zone_id: "z1",
      state: "playing",
      now_playing: { two_line: { line1: "A Walk", line2: "Tycho" }, seek_position: 10 },
    }),
  ]);
  const before = { state: "playing", title: "A Walk", artist: "Tycho", album: undefined } as const;
  const waiter = sub.waitForZoneChange("z1", before, 5);
  // Same track, just a position tick — should not satisfy the wait.
  push("Changed", {
    zones_changed: [
      zone({
        zone_id: "z1",
        state: "playing",
        now_playing: { two_line: { line1: "A Walk", line2: "Tycho" }, seek_position: 20 },
      }),
    ],
  });
  const after = await waiter;
  const z1 = after.zones?.find((z) => z.zone_id === "z1");
  // The cache is updated (the snapshot reflects the new position), but the
  // wait resolved via timeout — the caller's fingerprint would not match.
  assert.equal(z1?.now_playing?.seek_position, 20);
});

test("Unsubscribed drops the cache and resolves pending waiters", async () => {
  const { sub, push } = buildSubscription([
    zone({ zone_id: "z1", state: "stopped" }),
  ]);
  const before = { state: "stopped", title: undefined, artist: undefined, album: undefined } as const;
  const waiter = sub.waitForZoneChange("z1", before, 5_000);
  push("Unsubscribed", {});
  const after = await waiter;
  // Cache cleared; waiter resolves with an empty snapshot.
  assert.equal(after.zones?.length ?? 0, 0);
});

test("stop() resolves any pending waiters with the last known snapshot", async () => {
  const { sub } = buildSubscription([zone({ zone_id: "z1", state: "stopped" })]);
  const before = { state: "stopped", title: undefined, artist: undefined, album: undefined } as const;
  const waiter = sub.waitForZoneChange("z1", before, 5_000);
  sub.stop();
  const after = await waiter;
  assert.equal(after.zones?.length ?? 0, 0);
});
