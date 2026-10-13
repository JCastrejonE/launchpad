import test from "node:test";
import assert from "node:assert/strict";
import { isValidBranchName } from "./branch-name.js";

// The shape is a strict subset of git's ref rules: every accept here must be
// creatable as a real ref, and every reserved/edge case is a refusal — the
// validate-never-sanitise rule (0126) applied to branches.

test("accepts the shapes users will actually type", () => {
  for (const name of [
    "feature/checkout",
    "tester/pos-fixes",
    "fix-1042",
    "release-2026.08",
    "a",
    "deep/nested/branch-name",
    "v2_experiments",
  ]) {
    assert.equal(isValidBranchName(name), true, name);
  }
});

test("refuses everything outside the shape", () => {
  const cases: Array<[string, string]> = [
    ["", "empty"],
    ["Feature/Checkout", "uppercase — DNS labels cannot carry case (0134)"],
    ["-lead", "leading hyphen"],
    [".hidden", "leading dot"],
    ["feat/.hidden", "segment starting with a dot"],
    ["a..b", "git path traversal"],
    ["a//b", "empty segment"],
    ["trailing/", "trailing slash"],
    ["trailing.", "trailing dot"],
    ["branch.lock", "git refuses .lock"],
    ["con espacios", "space"],
    ["a".repeat(82), "over 80 chars"],
    ["árbol", "non-ascii"],
    ["ref~1", "git revision syntax"],
  ];
  for (const [name, why] of cases) {
    assert.equal(isValidBranchName(name), false, `${why}: ${JSON.stringify(name)}`);
  }
});

test("reserves the promote target and the platform's spec/ prefix", () => {
  for (const name of ["main", "master", "head", "spec", "spec/0133-anything"]) {
    assert.equal(isValidBranchName(name), false, name);
  }
  // HEAD is uppercase so the SHAPE already refuses it, but the reservation is
  // stated for the day the shape loosens — this asserts intent, not mechanism.
  assert.equal(isValidBranchName("HEAD"), false);
});
