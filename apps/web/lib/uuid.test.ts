import assert from "node:assert/strict";
import test from "node:test";

import { isUuid } from "./uuid.js";

test("isUuid accepts a well-formed UUID in either case", () => {
  assert.equal(isUuid("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isUuid("A0B1C2D3-E4F5-4678-89AB-CDEF01234567"), true);
});

test("isUuid rejects anything that could reach the project_id FK malformed", () => {
  for (const bad of [
    "",
    "platform", // a slug, the most likely real mistake
    "11111111-1111-4111-8111",
    "11111111-1111-4111-8111-11111111111", // 11 in last group
    "11111111-1111-4111-8111-1111111111111", // 13
    "gggggggg-1111-4111-8111-111111111111",
    " 11111111-1111-4111-8111-111111111111",
    "11111111-1111-4111-8111-111111111111 ",
  ]) {
    assert.equal(isUuid(bad), false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});
