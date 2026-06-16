import assert from "node:assert/strict";
import { test } from "node:test";

import { BrowseSessionManager } from "./BrowseSessionManager.js";
import { RoonClient } from "./RoonClient.js";
import { RoonMcpError } from "./types.js";

function managerWithBrowse(browse: unknown): BrowseSessionManager {
  const stub = {
    waitForCore: async () => undefined,
    getBrowse: () => browse,
  } as unknown as RoonClient;
  return new BrowseSessionManager(stub);
}

test("runExclusive serializes operations, never interleaving them", async () => {
  const mgr = managerWithBrowse({});
  const events: string[] = [];
  let releaseA!: () => void;
  const aGate = new Promise<void>((r) => (releaseA = r));

  const a = mgr.runExclusive(async () => {
    events.push("a:start");
    await aGate;
    events.push("a:end");
  });
  const b = mgr.runExclusive(async () => {
    events.push("b:start");
    events.push("b:end");
  });

  // B must not start until A finishes, even though A is still awaiting.
  await Promise.resolve();
  assert.deepEqual(events, ["a:start"]);
  releaseA();
  await Promise.all([a, b]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end"]);
});

test("runExclusive keeps the chain alive after an operation throws", async () => {
  const mgr = managerWithBrowse({});
  await assert.rejects(mgr.runExclusive(async () => {
    throw new Error("boom");
  }));
  const ok = await mgr.runExclusive(async () => 42);
  assert.equal(ok, 42);
});

test("browse maps InvalidItemKey to a RoonMcpError code", async () => {
  const mgr = managerWithBrowse({
    browse: (_opts: unknown, cb: (e: string | false, b: unknown) => void) =>
      cb("InvalidItemKey", undefined),
  });
  await assert.rejects(
    mgr.browse({ hierarchy: "search", item_key: "x" }),
    (e) => e instanceof RoonMcpError && e.code === "INVALID_ITEM_KEY",
  );
});

test("browse maps other errors to BROWSE_FAILED", async () => {
  const mgr = managerWithBrowse({
    browse: (_opts: unknown, cb: (e: string | false, b: unknown) => void) =>
      cb("NetworkError", undefined),
  });
  await assert.rejects(
    mgr.browse({ hierarchy: "search" }),
    (e) => e instanceof RoonMcpError && e.code === "BROWSE_FAILED",
  );
});
