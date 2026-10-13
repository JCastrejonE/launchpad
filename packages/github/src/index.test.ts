import { test } from "node:test";
import assert from "node:assert/strict";
import { specBranchRef } from "./index.js";

test("specBranchRef builds the spec/<id> branch name", () => {
  assert.equal(specBranchRef("0003"), "spec/0003");
});

test("specBranchRef throws on an empty specId", () => {
  assert.throws(() => specBranchRef(""), /specId must not be empty/);
  assert.throws(() => specBranchRef("   "), /specId must not be empty/);
});
