import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

import { installShutdown } from "./lifecycle.js";

function harness(stop: () => Promise<void> = async () => {}) {
  const stdin = new EventEmitter();
  const signals = new EventEmitter();
  const stopFn = mock.fn(stop);
  const exit = mock.fn((_code: number) => {});
  installShutdown({ stdin, signals, stop: stopFn, exit, graceMs: 1_000 });
  const exitCodes = () => exit.mock.calls.map((c) => c.arguments[0]);
  return { stdin, signals, stopFn, exitCodes };
}

const flush = () => new Promise((r) => setImmediate(r));

for (const [source, event] of [
  ["stdin", "end"],
  ["stdin", "close"],
  ["stdin", "error"],
  ["signals", "SIGINT"],
  ["signals", "SIGTERM"],
] as const) {
  test(`${source} '${event}' stops the server and exits 0`, async () => {
    const h = harness();
    h[source].emit(event, new Error("pipe broke"));
    await flush();
    assert.equal(h.stopFn.mock.callCount(), 1);
    assert.deepEqual(h.exitCodes(), [0]);
  });
}

test("repeated triggers stop and exit only once", async () => {
  const h = harness();
  h.stdin.emit("end");
  h.stdin.emit("close");
  h.signals.emit("SIGTERM");
  await flush();
  assert.equal(h.stopFn.mock.callCount(), 1);
  assert.deepEqual(h.exitCodes(), [0]);
});

test("a rejecting stop() exits 1", async () => {
  const h = harness(async () => {
    throw new Error("boom");
  });
  h.stdin.emit("end");
  await flush();
  assert.deepEqual(h.exitCodes(), [1]);
});

test("a hanging stop() exits 1 after the grace period", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(() => new Promise<void>(() => {}));
  h.stdin.emit("end");
  t.mock.timers.tick(999);
  assert.deepEqual(h.exitCodes(), []);
  t.mock.timers.tick(1);
  assert.deepEqual(h.exitCodes(), [1]);
});

test("the built server exits when its client closes stdin", async () => {
  // Point the server at a closed local port with a throwaway config, so it
  // neither touches a real Core nor the user's pairing lock.
  const configDir = mkdtempSync(join(tmpdir(), "roon-mcp-lifecycle-"));
  try {
    const entry = join(dirname(fileURLToPath(import.meta.url)), "index.js");
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, ROON_MCP_CONFIG: configDir, ROON_HOST: "127.0.0.1", ROON_PORT: "1" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exited = once(child, "exit");
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 5_000);
    const [code] = await exited;
    clearTimeout(timeout);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /shutting down: MCP client closed stdin/);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
