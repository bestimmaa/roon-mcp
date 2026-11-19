import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { installShutdown } from "./lifecycle.js";

function harness(stop: () => Promise<void> = async () => {}, graceMs = 1_000) {
  const stdin = new EventEmitter();
  const signals = new EventEmitter();
  const exits: number[] = [];
  let stops = 0;
  let exited!: () => void;
  const exitedPromise = new Promise<void>((resolve) => (exited = resolve));
  installShutdown({
    stdin,
    signals,
    stop: () => {
      stops += 1;
      return stop();
    },
    exit: (code) => {
      exits.push(code);
      exited();
    },
    graceMs,
  });
  return { stdin, signals, exits, stops: () => stops, exited: exitedPromise };
}

for (const event of ["end", "close"]) {
  test(`stdin '${event}' stops the server and exits 0`, async () => {
    const h = harness();
    h.stdin.emit(event);
    await h.exited;
    assert.equal(h.stops(), 1);
    assert.deepEqual(h.exits, [0]);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`${signal} stops the server and exits 0`, async () => {
    const h = harness();
    h.signals.emit(signal);
    await h.exited;
    assert.equal(h.stops(), 1);
    assert.deepEqual(h.exits, [0]);
  });
}

test("repeated triggers stop and exit only once", async () => {
  const h = harness();
  h.stdin.emit("end");
  h.stdin.emit("close");
  h.signals.emit("SIGTERM");
  await h.exited;
  await new Promise((r) => setImmediate(r));
  assert.equal(h.stops(), 1);
  assert.deepEqual(h.exits, [0]);
});

test("a rejecting stop() still exits", async () => {
  const h = harness(async () => {
    throw new Error("boom");
  });
  h.stdin.emit("end");
  await h.exited;
  assert.deepEqual(h.exits, [0]);
});

test("a hanging stop() exits after the grace period", async () => {
  const h = harness(() => new Promise<void>(() => {}), 20);
  const started = Date.now();
  h.stdin.emit("end");
  await h.exited;
  assert.deepEqual(h.exits, [0]);
  assert.ok(Date.now() - started >= 15);
});
