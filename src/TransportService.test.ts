import assert from "node:assert/strict";
import { test } from "node:test";

import type { GetZonesBody, RoonApiTransport, RoonApiZone, RoonOutput } from "node-roon-api-transport";

import { RoonClient } from "./RoonClient.js";
import { TransportService } from "./TransportService.js";
import { RoonMcpError, type NowPlayingInfo } from "./types.js";
import { ZoneService } from "./ZoneService.js";
import { ZoneSubscription } from "./ZoneSubscription.js";

function zone(partial: Partial<RoonApiZone> & { zone_id: string }): RoonApiZone {
  return {
    display_name: partial.zone_id,
    state: "stopped",
    outputs: [{ output_id: `o:${partial.zone_id}`, zone_id: partial.zone_id, display_name: partial.zone_id }],
    ...partial,
  };
}

interface RecordedControl {
  zone: string;
  control: string;
}
interface RecordedVolume {
  outputId: string;
  how: string;
  value: number;
}
interface RecordedMute {
  outputId: string;
  how: "mute" | "unmute";
}
interface RecordedSeek {
  zone: string;
  how: "absolute" | "relative";
  seconds: number;
}
interface RecordedSettings {
  zone: string;
  settings: Record<string, unknown>;
}

/** Builds a TransportService backed by a stub RoonClient with the given zones. */
function serviceWith(zones: RoonApiZone[], defaultZone?: string): {
  svc: TransportService;
  controlCalls: RecordedControl[];
  volumeCalls: RecordedVolume[];
  muteCalls: RecordedMute[];
  seekCalls: RecordedSeek[];
  settingsCalls: RecordedSettings[];
} {
  const controlCalls: RecordedControl[] = [];
  const volumeCalls: RecordedVolume[] = [];
  const muteCalls: RecordedMute[] = [];
  const seekCalls: RecordedSeek[] = [];
  const settingsCalls: RecordedSettings[] = [];

  const stub = {
    waitForCore: async () => undefined,
    getTransport: () => ({
      get_zones: (cb: (e: string | false, b: GetZonesBody) => void) => cb(false, { zones }),
      subscribe_zones: () => {},
      control: (
        zoneOrOutput: string,
        control: string,
        cb?: (e: string | false) => void,
      ) => {
        controlCalls.push({ zone: zoneOrOutput, control });
        cb?.(false);
      },
      change_volume: (
        output: string | RoonOutput,
        how: string,
        value: number,
        cb?: (e: string | false) => void,
      ) => {
        const outputId = typeof output === "string" ? output : output.output_id;
        volumeCalls.push({ outputId, how, value });
        cb?.(false);
      },
      mute: (
        output: string | RoonOutput,
        how: "mute" | "unmute",
        cb?: (e: string | false) => void,
      ) => {
        const outputId = typeof output === "string" ? output : output.output_id;
        muteCalls.push({ outputId, how });
        cb?.(false);
      },
      seek: (
        zoneOrOutput: string,
        how: "absolute" | "relative",
        seconds: number,
        cb?: (e: string | false) => void,
      ) => {
        seekCalls.push({ zone: zoneOrOutput, how, seconds });
        cb?.(false);
      },
      change_settings: (
        zoneOrOutput: string,
        settings: Record<string, unknown>,
        cb?: (e: string | false) => void,
      ) => {
        settingsCalls.push({ zone: zoneOrOutput, settings });
        cb?.(false);
      },
    }),
    getActiveSubscription: () => undefined,
  } as unknown as RoonClient;

  const zoneSvc = new ZoneService(stub, undefined, defaultZone);
  const svc = new TransportService(stub, zoneSvc);
  return { svc, controlCalls, volumeCalls, muteCalls, seekCalls, settingsCalls };
}

test("getNowPlaying returns a structured snapshot of a playing zone", async () => {
  const { svc } = serviceWith([
    zone({
      zone_id: "z1",
      display_name: "Office",
      state: "playing",
      now_playing: {
        three_line: { line1: "A Walk", line2: "Tycho", line3: "Dive" },
        seek_position: 42,
        length: 240,
        image_key: "img:1",
      },
    }),
  ]);

  const info = await svc.getNowPlaying();
  assert.deepEqual(info, {
    zoneId: "z1",
    displayName: "Office",
    state: "playing",
    title: "A Walk",
    artist: "Tycho",
    album: "Dive",
    imageKey: "img:1",
    lengthSec: 240,
    seekPositionSec: 42,
  } satisfies NowPlayingInfo);
});

test("getNowPlaying falls back through three/two/one line displays", async () => {
  // Two-line only — `album` should be undefined.
  const two = await serviceWith([
    zone({
      zone_id: "z1",
      state: "playing",
      now_playing: { two_line: { line1: "Strobe", line2: "deadmau5" } },
    }),
  ]).svc.getNowPlaying();
  assert.deepEqual(two, {
    zoneId: "z1",
    displayName: "z1",
    state: "playing",
    title: "Strobe",
    artist: "deadmau5",
    album: undefined,
    imageKey: undefined,
    lengthSec: undefined,
    seekPositionSec: undefined,
  } satisfies NowPlayingInfo);

  // One-line only — both `artist` and `album` should be undefined.
  const one = await serviceWith([
    zone({
      zone_id: "z2",
      state: "playing",
      now_playing: { one_line: { line1: "Track 1" } },
    }),
  ]).svc.getNowPlaying();
  assert.equal(one?.title, "Track 1");
  assert.equal(one?.artist, undefined);
  assert.equal(one?.album, undefined);
});

test("getNowPlaying reports the zone state when nothing is playing", async () => {
  const { svc } = serviceWith([zone({ zone_id: "z1", state: "stopped" })]);
  const info = await svc.getNowPlaying();
  // Zone exists, so the snapshot is returned with `title` undefined to signal
  // "no track" (rather than throwing or returning null).
  assert.equal(info?.state, "stopped");
  assert.equal(info?.title, undefined);
  assert.equal(info?.artist, undefined);
});

test("getNowPlaying rejects an unknown zone id with ZONE_NOT_FOUND", async () => {
  const { svc } = serviceWith([zone({ zone_id: "z1" })]);
  await assert.rejects(
    svc.getNowPlaying("nope"),
    (e) => e instanceof RoonMcpError && e.code === "ZONE_NOT_FOUND",
  );
});

test("control rejects an unknown action with BROWSE_FAILED", async () => {
  const { svc } = serviceWith([zone({ zone_id: "z1", state: "playing" })]);
  await assert.rejects(
    svc.control(undefined, "rewind"),
    (e) => e instanceof RoonMcpError && e.code === "BROWSE_FAILED" && /unknown action/i.test(e.message),
  );
});

test("control('pause') issues transport.control(zoneId, 'pause')", async () => {
  const { svc, controlCalls } = serviceWith([
    zone({ zone_id: "z1", state: "playing", is_pause_allowed: true }),
  ]);
  const out = await svc.control("z1", "pause");
  assert.equal(out.ok, true);
  assert.equal(out.zoneId, "z1");
  assert.equal(out.action, "pause");
  assert.deepEqual(controlCalls, [{ zone: "z1", control: "pause" }]);
});

test("control('resume') maps to Roon's 'play' verb", async () => {
  const { svc, controlCalls } = serviceWith([
    zone({ zone_id: "z1", state: "paused", is_play_allowed: true }),
  ]);
  await svc.control("z1", "resume");
  assert.deepEqual(controlCalls, [{ zone: "z1", control: "play" }]);
});

test("control('next') is refused when is_next_allowed is false", async () => {
  const { svc, controlCalls } = serviceWith([
    zone({ zone_id: "z1", state: "playing", is_next_allowed: false }),
  ]);
  await assert.rejects(
    svc.control("z1", "next"),
    (e) => e instanceof RoonMcpError && e.code === "BROWSE_FAILED",
  );
  assert.deepEqual(controlCalls, []);
});

test("control('stop') bypasses the allowed-flag check", async () => {
  // Roon doesn't expose is_stop_allowed; `stop` should never be refused.
  const { svc, controlCalls } = serviceWith([
    zone({ zone_id: "z1", state: "playing" }),
  ]);
  await svc.control("z1", "stop");
  assert.deepEqual(controlCalls, [{ zone: "z1", control: "stop" }]);
});

test("control resolves an omitted zoneId via ZoneService", async () => {
  const { svc, controlCalls } = serviceWith([
    zone({ zone_id: "z1", state: "playing", is_pause_allowed: true }),
  ]);
  await svc.control(undefined, "pause");
  assert.deepEqual(controlCalls, [{ zone: "z1", control: "pause" }]);
});

test("setVolume rejects out-of-range levels", async () => {
  const { svc } = serviceWith([zone({ zone_id: "z1" })]);
  for (const bad of [-1, 101, Number.NaN]) {
    await assert.rejects(
      svc.setVolume("z1", bad),
      (e) => e instanceof RoonMcpError && e.code === "BROWSE_FAILED",
    );
  }
});

test("setVolume rescales 0..100 to each output's native min/max", async () => {
  // Output with 0..60 numeric range and a step of 5 → 50% maps to 30.
  const { svc, volumeCalls } = serviceWith([
    zone({
      zone_id: "z1",
      outputs: [
        {
          output_id: "o1",
          zone_id: "z1",
          display_name: "Office",
          volume: { min: 0, max: 60, step: 5 },
        },
      ],
    }),
  ]);
  const out = await svc.setVolume("z1", 50);
  assert.equal(out.applied.length, 1);
  assert.deepEqual(volumeCalls, [{ outputId: "o1", how: "absolute", value: 30 }]);
});

test("setVolume fans out across multiple outputs in a grouped zone", async () => {
  const { svc, volumeCalls } = serviceWith([
    zone({
      zone_id: "z1",
      outputs: [
        { output_id: "o1", zone_id: "z1", display_name: "L", volume: { min: 0, max: 100 } },
        { output_id: "o2", zone_id: "z1", display_name: "R", volume: { min: 0, max: 100 } },
      ],
    }),
  ]);
  const out = await svc.setVolume("z1", 25);
  assert.equal(out.applied.length, 2);
  assert.deepEqual(
    volumeCalls.sort((a, b) => a.outputId.localeCompare(b.outputId)),
    [
      { outputId: "o1", how: "absolute", value: 25 },
      { outputId: "o2", how: "absolute", value: 25 },
    ],
  );
});

test("setVolume skips incremental outputs and applies to the rest", async () => {
  const { svc, volumeCalls } = serviceWith([
    zone({
      zone_id: "z1",
      outputs: [
        { output_id: "o1", zone_id: "z1", display_name: "Speaker", volume: { min: 0, max: 100 } },
        // No min/max — incremental IR-blaster style.
        { output_id: "o2", zone_id: "z1", display_name: "IR", volume: { type: "incremental" } },
      ],
    }),
  ]);
  const out = await svc.setVolume("z1", 50);
  assert.deepEqual(out.applied, ["o1"]);
  assert.deepEqual(out.skipped, ["o2"]);
  assert.equal(volumeCalls.length, 1);
});

test("setVolume throws when every output is incremental", async () => {
  const { svc } = serviceWith([
    zone({
      zone_id: "z1",
      outputs: [
        { output_id: "o1", zone_id: "z1", display_name: "IR", volume: { type: "incremental" } },
      ],
    }),
  ]);
  await assert.rejects(
    svc.setVolume("z1", 50),
    (e) =>
      e instanceof RoonMcpError &&
      e.code === "BROWSE_FAILED" &&
      /incremental/i.test(e.message),
  );
});

test("mute fans out to every output with the requested how", async () => {
  const { svc, muteCalls } = serviceWith([
    zone({
      zone_id: "z1",
      outputs: [
        { output_id: "o1", zone_id: "z1", display_name: "L" },
        { output_id: "o2", zone_id: "z1", display_name: "R" },
      ],
    }),
  ]);
  const out = await svc.mute("z1", true);
  assert.equal(out.muted, true);
  assert.deepEqual(
    muteCalls.sort((a, b) => a.outputId.localeCompare(b.outputId)),
    [
      { outputId: "o1", how: "mute" },
      { outputId: "o2", how: "mute" },
    ],
  );

  await svc.mute("z1", false);
  assert.equal(muteCalls.length, 4);
  assert.deepEqual(muteCalls.slice(2), [
    { outputId: "o1", how: "unmute" },
    { outputId: "o2", how: "unmute" },
  ]);
});

test("control('playpause') issues the native playpause verb (issue #17)", async () => {
  const { svc, controlCalls } = serviceWith([
    zone({ zone_id: "z1", state: "playing" }),
  ]);
  const out = await svc.control("z1", "playpause");
  assert.equal(out.ok, true);
  assert.equal(out.action, "playpause");
  // playpause is exempt from the allowed-flag precheck (it's a toggle), so it
  // must pass through without consulting is_play_allowed/is_pause_allowed.
  assert.deepEqual(controlCalls, [{ zone: "z1", control: "playpause" }]);
});

test("seek issues an absolute seek to the target position (issue #17)", async () => {
  const { svc, seekCalls } = serviceWith([
    zone({ zone_id: "z1", state: "playing", is_seek_allowed: true }),
  ]);
  const out = await svc.seek("z1", 90);
  assert.deepEqual(out, { ok: true, zoneId: "z1", mode: "absolute", seconds: 90 });
  assert.deepEqual(seekCalls, [{ zone: "z1", how: "absolute", seconds: 90 }]);
});

test("seek in relative mode moves by a signed delta (issue #17)", async () => {
  const { svc, seekCalls } = serviceWith([
    zone({ zone_id: "z1", state: "playing", is_seek_allowed: true }),
  ]);
  await svc.seek("z1", -10, "relative");
  assert.deepEqual(seekCalls, [{ zone: "z1", how: "relative", seconds: -10 }]);
});

test("seek is refused when is_seek_allowed is false", async () => {
  const { svc, seekCalls } = serviceWith([
    zone({ zone_id: "z1", state: "playing", is_seek_allowed: false }),
  ]);
  await assert.rejects(
    svc.seek("z1", 0),
    (e) => e instanceof RoonMcpError && e.code === "BROWSE_FAILED",
  );
  assert.deepEqual(seekCalls, []);
});

test("seek rejects a negative absolute position", async () => {
  const { svc } = serviceWith([zone({ zone_id: "z1", state: "playing" })]);
  await assert.rejects(
    svc.seek("z1", -5),
    (e) => e instanceof RoonMcpError && e.code === "BROWSE_FAILED",
  );
});

test("setLoop maps each mode to Roon's native loop value (issue #17)", async () => {
  const cases: Array<{ mode: "off" | "all" | "one"; roon: string }> = [
    { mode: "off", roon: "disabled" },
    { mode: "all", roon: "loop" },
    { mode: "one", roon: "loop_one" },
  ];
  for (const { mode, roon } of cases) {
    const { svc, settingsCalls } = serviceWith([zone({ zone_id: "z1" })]);
    const out = await svc.setLoop("z1", mode);
    assert.deepEqual(out, { ok: true, zoneId: "z1", mode });
    assert.deepEqual(settingsCalls, [{ zone: "z1", settings: { loop: roon } }]);
  }
});

/**
 * A subscription-backed transport stub. The `subscribe_zones` callback is
 * captured so the test can drive `Changed` events. The `get_zones` RPC is
 * kept so a cold-start fallback still works.
 */
function serviceWithSubscription(initial: RoonApiZone[]): {
  svc: TransportService;
  controlCalls: RecordedControl[];
  push: (response: string, body: unknown) => void;
} {
  const controlCalls: RecordedControl[] = [];
  let cb: ((response: string, body: unknown) => void) | undefined;
  let getZonesCalls = 0;

  const transport = {
    get_zones: (cb2: (e: string | false, b: GetZonesBody) => void) => {
      getZonesCalls++;
      cb2(false, { zones: initial });
    },
    subscribe_zones: (callback: (response: string, body: unknown) => void) => {
      cb = callback;
    },
    control: (
      zoneOrOutput: string,
      control: string,
      cb3?: (e: string | false) => void,
    ) => {
      controlCalls.push({ zone: zoneOrOutput, control });
      cb3?.(false);
    },
  } as unknown as RoonApiTransport;

  const sub = new ZoneSubscription(transport, "core-1");
  sub.start();
  // Pre-load the cache so reads don't hit the cold-start fallback path.
  cb?.("Subscribed", { zones: initial });

  const stub = {
    waitForCore: async () => undefined,
    getTransport: () => transport,
    getActiveSubscription: () => sub,
  } as unknown as RoonClient;
  const zones = new ZoneService(stub);
  const svc = new TransportService(stub, zones);
  return { svc, controlCalls, push: (r, b) => cb?.(r, b) };
}

test("control waits for the post-action snapshot when the subscription pushes a Changed event", async () => {
  // Reproduces issue #1 for `control_playback`: after `next` the zone's
  // `state` is still the pre-action one until Roon pushes a Changed event.
  const { svc, push } = serviceWithSubscription([
    zone({
      zone_id: "z1",
      state: "playing",
      is_next_allowed: true,
      now_playing: { two_line: { line1: "Old Track" } },
    }),
  ]);

  // Fire the action and the matching Changed event concurrently. The
  // service should observe the new state when the action resolves.
  const out = await Promise.all([
    svc.control("z1", "next"),
    // Simulate Roon pushing the new track on the next event loop turn.
    new Promise<void>((r) => setTimeout(() => {
      push("Changed", {
        zones_changed: [
          zone({
            zone_id: "z1",
            state: "playing",
            is_next_allowed: true,
            now_playing: { two_line: { line1: "New Track" } },
          }),
        ],
      });
      r();
    }, 5)),
  ]).then(([res]) => res);

  assert.equal(out.state, "playing");
});

test("control falls back to the latest snapshot when no Changed event arrives", async () => {
  // No subscription pushes anything; the service should still return
  // promptly with the current snapshot, not hang.
  const { svc } = serviceWithSubscription([
    zone({ zone_id: "z1", state: "paused", is_play_allowed: true }),
  ]);
  const out = await svc.control("z1", "resume");
  assert.equal(out.state, "paused");
});
