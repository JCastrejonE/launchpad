import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PIPELINE_PHASES,
  AWAITING_PHASES,
  TERMINAL_PHASES,
  isAwaitingPhase,
  isTerminalPhase,
  PIPELINE_PHASE_QUERY,
} from "./phase.js";

test("PIPELINE_PHASES lists every documented phase in lifecycle order", () => {
  assert.deepEqual(PIPELINE_PHASES, [
    "drafting",
    "awaiting_spec_approval",
    "provisioning",
    "initializing",
    "coding",
    "awaiting_pr_approval",
    "merging",
    // Spec 0133: a BRANCH run's terminal ending — its commits are on the
    // branch; the production act is the branch-level promote (spec 0136).
    "staged",
    "awaiting_promotion",
    "deploying",
    "tearing_down",
    "promoted",
    "promoted_teardown_failed",
    "rejected",
    "failed",
  ]);
});

test("TERMINAL_PHASES are exactly staged/promoted/promoted_teardown_failed/rejected/failed and a subset of PIPELINE_PHASES", () => {
  assert.deepEqual(TERMINAL_PHASES, [
    "staged",
    "promoted",
    "promoted_teardown_failed",
    "rejected",
    "failed",
  ]);
  for (const p of TERMINAL_PHASES) {
    assert.ok(PIPELINE_PHASES.includes(p), `${p} missing from PIPELINE_PHASES`);
  }
});

test("isTerminalPhase is true only for the terminal phases", () => {
  assert.equal(isTerminalPhase("promoted"), true);
  assert.equal(isTerminalPhase("promoted_teardown_failed"), true);
  assert.equal(isTerminalPhase("rejected"), true);
  assert.equal(isTerminalPhase("failed"), true);
  assert.equal(isTerminalPhase("tearing_down"), false);
  assert.equal(isTerminalPhase("coding"), false);
});

test("AWAITING_PHASES are exactly the three human gates and are a subset of PIPELINE_PHASES", () => {
  assert.deepEqual(AWAITING_PHASES, [
    "awaiting_spec_approval",
    "awaiting_pr_approval",
    "awaiting_promotion",
  ]);
  for (const p of AWAITING_PHASES) {
    assert.ok(PIPELINE_PHASES.includes(p), `${p} missing from PIPELINE_PHASES`);
  }
});

test("isAwaitingPhase is true only for the gate phases", () => {
  assert.equal(isAwaitingPhase("awaiting_pr_approval"), true);
  assert.equal(isAwaitingPhase("coding"), false);
  assert.equal(isAwaitingPhase("merging"), false);
});

test("PIPELINE_PHASE_QUERY is the shared query name", () => {
  assert.equal(PIPELINE_PHASE_QUERY, "pipelinePhase");
});
