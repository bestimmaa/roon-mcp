import assert from "node:assert/strict";
import { test } from "node:test";

import { createStderrLogger, silentLogger } from "./logger.js";

function captureLogger() {
  const lines: string[] = [];
  return { logger: createStderrLogger((l) => lines.push(l)), lines };
}

/** Parse the JSON payload out of a `[roon-call] {json}\n` line. */
function parse(line: string): Record<string, unknown> {
  const json = line.replace(/^\[roon-call] /, "").trimEnd();
  return JSON.parse(json) as Record<string, unknown>;
}

test("logs one info line with op, params, summary and timing on success", async () => {
  const { logger, lines } = captureLogger();

  const result = await logger.call(
    "browse",
    { hierarchy: "search", item_key: "k1" },
    async () => ({ action: "list" }),
    (r) => ({ action: r.action }),
  );

  assert.deepEqual(result, { action: "list" });
  assert.equal(lines.length, 1);
  const rec = parse(lines[0]!);
  assert.equal(rec.lvl, "info");
  assert.equal(rec.op, "browse");
  assert.deepEqual(rec.params, { hierarchy: "search", item_key: "k1" });
  assert.deepEqual(rec.result, { action: "list" });
  assert.equal(typeof rec.ms, "number");
  assert.equal(typeof rec.t, "string");
});

test("logs an error line and rethrows the original error", async () => {
  const { logger, lines } = captureLogger();
  const boom = Object.assign(new Error("kaboom"), { code: "BROWSE_FAILED" });

  await assert.rejects(
    logger.call("load", { offset: 0 }, async () => {
      throw boom;
    }),
    (e) => e === boom, // same instance, so downstream code can read err.code
  );

  assert.equal(lines.length, 1);
  const rec = parse(lines[0]!);
  assert.equal(rec.lvl, "error");
  assert.equal(rec.op, "load");
  assert.deepEqual(rec.error, { code: "BROWSE_FAILED", message: "kaboom" });
});

test("omits the result field when no summarizer is given", async () => {
  const { logger, lines } = captureLogger();
  await logger.call("get_zones", {}, async () => ({ zones: [] }));
  const rec = parse(lines[0]!);
  assert.ok(!("result" in rec));
});

test("silentLogger runs the call but emits nothing", async () => {
  let ran = false;
  const out = await silentLogger.call("browse", {}, async () => {
    ran = true;
    return 7;
  });
  assert.equal(ran, true);
  assert.equal(out, 7);
});
