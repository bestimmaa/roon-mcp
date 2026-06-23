import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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