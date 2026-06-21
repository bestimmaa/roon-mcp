import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeLocator,
  encodeGenreLocator,
  encodeLocator,
  hierarchyForLocator,
  isGenreLocator,
  withTrackIndex,
} from "./locator.js";

test("a search locator round-trips through encode/decode", () => {
  const token = encodeLocator({ q: "Tycho", g: 1, i: 2 });
  const loc = decodeLocator(token);
  assert.ok(loc && !isGenreLocator(loc));
  assert.deepEqual(loc, { q: "Tycho", g: 1, i: 2 });
  assert.equal(hierarchyForLocator(loc), "search");
});

test("a genre locator round-trips and reports the genres hierarchy", () => {
  const token = encodeGenreLocator(["Electronic", "Trance", "Psytrance"]);
  const loc = decodeLocator(token);
  assert.ok(loc && isGenreLocator(loc));
  assert.deepEqual(loc.ge, ["Electronic", "Trance", "Psytrance"]);
  assert.equal(loc.a, undefined);
  assert.equal(loc.t, undefined);
  assert.equal(hierarchyForLocator(loc), "genres");
});

test("a genre track locator carries the (album, track) coordinates", () => {
  const token = encodeGenreLocator(["Electronic", "Trance", "Psytrance"], { a: 2, t: 5 });
  const loc = decodeLocator(token);
  assert.ok(loc && isGenreLocator(loc));
  assert.equal(loc.a, 2);
  assert.equal(loc.t, 5);
});

test("withTrackIndex extends a search locator with a track index", () => {
  const search = decodeLocator(encodeLocator({ q: "x", g: 0, i: 0 }))!;
  assert.ok(!isGenreLocator(search));
  const searchT = withTrackIndex(search, 3);
  assert.equal(searchT.t, 3);
});

test("a non-locator token decodes to null", () => {
  assert.equal(decodeLocator("341:0"), null);
  assert.equal(decodeLocator("rl1:not-base64-json"), null);
});
