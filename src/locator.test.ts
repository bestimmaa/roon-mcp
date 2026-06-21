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
  assert.equal(hierarchyForLocator(loc), "genres");
});

test("withTrackIndex preserves the locator shape", () => {
  const search = decodeLocator(encodeLocator({ q: "x", g: 0, i: 0 }))!;
  const searchT = withTrackIndex(search, 3);
  assert.ok(!isGenreLocator(searchT) && searchT.t === 3);

  const genre = decodeLocator(encodeGenreLocator(["Jazz"]))!;
  const genreT = withTrackIndex(genre, 5);
  assert.ok(isGenreLocator(genreT) && genreT.t === 5);
  assert.deepEqual((genreT as { ge: string[] }).ge, ["Jazz"]);
});

test("a non-locator token decodes to null", () => {
  assert.equal(decodeLocator("341:0"), null);
  assert.equal(decodeLocator("rl1:not-base64-json"), null);
});
