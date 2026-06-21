import assert from "node:assert/strict";
import { test } from "node:test";

import type { GetZonesBody, RoonApiZone, RoonOutput } from "node-roon-api-transport";

import { RoonClient } from "./RoonClient.js";
import { TransportService } from "./TransportService.js";
import { RoonMcpError, type NowPlayingInfo } from "./types.js";
import { ZoneService } from "./ZoneService.js";

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

/** Builds a TransportService backed by a stub RoonClient with the given zones. */
function serviceWith(zones: RoonApiZone[], defaultZone?: string): {
  svc: TransportService;
  controlCalls: RecordedControl[];
  volumeCalls: RecordedVolume[];
  muteCalls: RecordedMute[];
} {
  const controlCalls: RecordedControl[] = [];
  const volumeCalls: RecordedVolume[] = [];
  const muteCalls: RecordedMute[] = [];

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
    }),
  } as unknown as RoonClient;

  const zoneSvc = new ZoneService(stub, undefined, defaultZone);
  const svc = new TransportService(stub, zoneSvc);
  return { svc, controlCalls, volumeCalls, muteCalls };
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
