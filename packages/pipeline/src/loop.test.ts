import { test } from "node:test";
import assert from "node:assert/strict";
import { coderLoopDecision, type CoderLoopState } from "./loop.js";

/** Baseline: mid-run, work remaining, CI green, no stalls. */
const base: CoderLoopState = {
  remaining: 3,
  ciGreen: true,
  consecutiveStalls: 0,
  iterations: 1,
  maxIterations: 12,
};

// These pin the four acceptance-criteria branches (converge / stall→gate2 /
// stall+red→fail / max-iterations→fail) plus the default continue case.

test("continue while work remains and CI is green", () => {
  assert.equal(coderLoopDecision(base), "continue");
});

test("converge: no work left + CI green → proceed to gate 2", () => {
  assert.equal(coderLoopDecision({ ...base, remaining: 0 }), "proceed_to_gate2");
});

test("stalled twice + CI green → proceed to gate 2 (human decides)", () => {
  assert.equal(
    coderLoopDecision({ ...base, consecutiveStalls: 2 }),
    "proceed_to_gate2",
  );
});

test("stalled twice + CI red → fail", () => {
  assert.equal(
    coderLoopDecision({ ...base, consecutiveStalls: 2, ciGreen: false }),
    "fail",
  );
});

// SPEC-ALIGNMENT §9.4: budget exhaustion routes on CI colour — a green branch
// goes to gate 2 with its partial work (a human decides) instead of tearing
// down; only a red branch fails.
test("budget exhausted + CI green → proceed to gate 2 (human decides on partial work)", () => {
  assert.equal(
    coderLoopDecision({ ...base, iterations: 12, maxIterations: 12 }),
    "proceed_to_gate2",
  );
});

test("budget exhausted + CI red → fail", () => {
  assert.equal(
    coderLoopDecision({ ...base, iterations: 12, maxIterations: 12, ciGreen: false }),
    "fail",
  );
});
