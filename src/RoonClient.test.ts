import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RoonCore } from "node-roon-api";

import { RoonClient } from "./RoonClient.js";
import { RoonMcpError } from "./types.js";

/** A RoonClient whose pairing state points at a throwaway temp file. */
function newClient(): RoonClient {
  const dir = mkdtempSync(join(tmpdir(), "roon-mcp-test-"));
  return new RoonClient({
    configPath: join(dir, "config.json"),
    log: () => {},
  });
}

const fakeCore = {
  core_id: "c1",
  display_name: "Office Core",
  services: { RoonApiTransport: { subscribe_zones: () => {} } },
} as unknown as RoonCore;

type Lifecycle = { onCorePaired(c: RoonCore): void; onCoreUnpaired(c: RoonCore): void };

test("waitForCore rejects with NO_CORE_PAIRED when the Core unpairs (issue #16)", async () => {
  // Previously a pending waiter hung until its full timeout fired after an
  // unpair; it must reject promptly instead.
  const client = newClient();
  const pending = client.waitForCore(60_000);
  (client as unknown as Lifecycle).onCoreUnpaired(fakeCore);
  await assert.rejects(
    pending,
    (e) => e instanceof RoonMcpError && e.code === "NO_CORE_PAIRED" && /unpaired/i.test(e.message),
  );
});

test("waitForCore still resolves when the Core pairs", async () => {
  const client = newClient();
  const pending = client.waitForCore(60_000);
  (client as unknown as Lifecycle).onCorePaired(fakeCore);
  const core = await pending;
  assert.equal(core, fakeCore);
});

test("waitForCore returns the already-paired Core immediately", async () => {
  const client = newClient();
  (client as unknown as Lifecycle).onCorePaired(fakeCore);
  // After pairing, a later waiter resolves synchronously (no timer armed).
  const core = await client.waitForCore(60_000);
  assert.equal(core, fakeCore);
});

test("stop() rejects a pending waiter instead of leaving it to time out", async () => {
  const client = newClient();
  const pending = client.waitForCore(60_000);
  client.stop();
  await assert.rejects(
    pending,
    (e) => e instanceof RoonMcpError && e.code === "NO_CORE_PAIRED",
  );
});

test("start() surfaces CORE_PAIRING_HELD instead of contending when another live process holds the lock (issue #40)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roon-mcp-test-"));
  const lockPath = join(dir, "instance.lock");
  // pid 1 (init/launchd) is always alive, standing in for a live "other instance".
  writeFileSync(lockPath, JSON.stringify({ pid: 1, startedAt: "2026-01-01T00:00:00.000Z" }));

  const client = new RoonClient({ configPath: join(dir, "config.json"), lockPath, log: () => {} });
  client.start();

  await assert.rejects(
    client.waitForCore(60_000),
    (e) =>
      e instanceof RoonMcpError &&
      e.code === "CORE_PAIRING_HELD" &&
      /pid 1/.test(e.message) &&
      !/enable the extension/i.test(e.message),
  );
  assert.throws(
    () => client.getTransport(),
    (e) => e instanceof RoonMcpError && e.code === "CORE_PAIRING_HELD",
  );
  assert.throws(
    () => client.getBrowse(),
    (e) => e instanceof RoonMcpError && e.code === "CORE_PAIRING_HELD",
  );
});

test("a blocked instance takes over the lock once the holder exits (issue #48)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roon-mcp-test-"));
  const lockPath = join(dir, "instance.lock");
  // pid 1 stands in for a live holder at startup.
  writeFileSync(lockPath, JSON.stringify({ pid: 1, startedAt: "2026-01-01T00:00:00.000Z" }));

  const client = new RoonClient({ configPath: join(dir, "config.json"), lockPath, log: () => {} });
  // Recovery runs the discovery half of start(); stub it so the test stays
  // off the network, and count that takeover triggers it exactly once.
  let discoveryStarts = 0;
  (client as unknown as { beginDiscovery(): void }).beginDiscovery = () => {
    discoveryStarts++;
  };
  client.start();
  await assert.rejects(
    client.waitForCore(60_000),
    (e) => e instanceof RoonMcpError && e.code === "CORE_PAIRING_HELD",
  );

  // The holder dies without releasing (kill -9): its lock file lingers with a
  // dead pid. The next call must re-probe, take the lock over, start
  // discovery, and wait for pairing instead of reporting the dead pid forever.
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 2_147_483_647, startedAt: "2026-01-01T00:00:00.000Z" }),
  );
  const pending = client.waitForCore(60_000);
  (client as unknown as Lifecycle).onCorePaired(fakeCore);
  assert.equal(await pending, fakeCore);
  assert.equal(discoveryStarts, 1);
  // The lock file now names this process, and accessors no longer report the
  // dead holder.
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid);
  assert.ok(client.getTransport());
});

test("a blocked instance stays blocked while the holder is alive, refreshing the owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roon-mcp-test-"));
  const lockPath = join(dir, "instance.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: 1, startedAt: "2026-01-01T00:00:00.000Z" }));

  const client = new RoonClient({ configPath: join(dir, "config.json"), lockPath, log: () => {} });
  (client as unknown as { beginDiscovery(): void }).beginDiscovery = () => {
    throw new Error("discovery must not start while the lock is held elsewhere");
  };
  client.start();

  // Repeated calls keep re-probing without taking over a live holder's lock…
  await assert.rejects(
    client.waitForCore(60_000),
    (e) => e instanceof RoonMcpError && e.code === "CORE_PAIRING_HELD" && /pid 1/.test(e.message),
  );
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, 1);

  // …and the error names the current holder, not the one seen at startup.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: "2026-02-02T00:00:00.000Z" }));
  await assert.rejects(
    client.waitForCore(60_000),
    (e) =>
      e instanceof RoonMcpError &&
      e.code === "CORE_PAIRING_HELD" &&
      new RegExp(`pid ${process.pid}`).test(e.message),
  );
});
