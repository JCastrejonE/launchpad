import { test } from "node:test";
import assert from "node:assert/strict";
import { isSelfTarget } from "./spec.js";

// Spec 0036 — isSelfTarget() is the WIRE-COMPAT contract: it must accept both
// the current "self" literal and the legacy "launchpad" literal that may
// still be persisted in a Temporal workflow input/history from a run started
// before this rename, indefinitely.
test("isSelfTarget: true for the current self literal", () => {
  assert.equal(isSelfTarget({ kind: "self" }), true);
});

test("isSelfTarget: true for the legacy launchpad literal", () => {
  assert.equal(isSelfTarget({ kind: "launchpad" }), true);
});

test("isSelfTarget: false for the tenant literal", () => {
  assert.equal(isSelfTarget({ kind: "tenant" }), false);
});
