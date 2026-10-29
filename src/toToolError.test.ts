import assert from "node:assert/strict";
import { test } from "node:test";

import { toToolError } from "./RoonMcpServer.js";
import { RoonMcpError } from "./types.js";

/** Decode the JSON error body carried in the text content of a tool result. */
function errorBody(result: ReturnType<typeof toToolError>): { code: string; message: string } {
  assert.equal(result.isError, true);
  const text = result.content[0]!.text;
  return JSON.parse(text).error;
}

test("toToolError labels unexpected errors INTERNAL_ERROR, not BROWSE_FAILED (issue #13)", () => {
  // A plain Error thrown from a bug or an unhandled transport path is an
  // internal failure, not a browse failure — the label must reflect that.
  const out = errorBody(toToolError(new Error("boom")));
  assert.equal(out.code, "INTERNAL_ERROR");
  assert.equal(out.message, "boom");
});

test("toToolError labels non-Error values INTERNAL_ERROR", () => {
  const out = errorBody(toToolError("something odd"));
  assert.equal(out.code, "INTERNAL_ERROR");
  assert.equal(out.message, "something odd");
});

test("toToolError preserves a RoonMcpError's own code", () => {
  const err = new RoonMcpError("ZONE_NOT_FOUND", "Zone gone.");
  const out = errorBody(toToolError(err));
  assert.equal(out.code, "ZONE_NOT_FOUND");
  assert.equal(out.message, "Zone gone.");
});