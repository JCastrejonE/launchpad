/**
 * Spec 0124. The cases that matter are the ones the page got wrong: a spec with no
 * run must not offer to start one just because Temporal says `canStart` — Temporal
 * says that precisely BECAUSE no run exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeStepForView,
  deriveSpecProgress,
  isTerminalSpecStatus,
  TRACK1_STEPS,
  TRACK2_STEPS,
} from "./spec-progress";
import type { PipelineViewState } from "./pipeline";

/** A view for a spec that never ran — which is what Temporal reports for every
 * Track-1 spec, and the shape that produced the bogus Start button. */
const NEVER_RAN: PipelineViewState = { state: "not_started", availableActions: [], canStart: true };

test("a Track-1 spec never offers Start, even though the view says canStart", () => {
  // THE bug. canStart is true because no run exists; for hand-authored work that is
  // not an invitation to start one.
  const p = deriveSpecProgress({ track: 1, status: "draft", view: NEVER_RAN, viewActiveStep: 1 });
  assert.equal(p.showStart, false);
  assert.equal(p.showComplete, true, "Track 1's forward action is the manual Complete");
});

test("a Track-1 spec shows only Draft and Promoted", () => {
  const p = deriveSpecProgress({ track: 1, status: "draft", view: NEVER_RAN, viewActiveStep: 1 });
  assert.deepEqual(p.steps, TRACK1_STEPS);
  assert.equal(p.steps.length, 2);
});

test("Track-1 Promoted completes ONLY on a real merge (status promoted), not on completed", () => {
  // The owner's rule: for Track 1 that step means the chat actually merged it.
  const merged = deriveSpecProgress({ track: 1, status: "promoted", view: null, viewActiveStep: 1 });
  assert.equal(merged.activeStep, TRACK1_STEPS.length + 1, "all steps complete");

  const byHand = deriveSpecProgress({ track: 1, status: "completed", view: null, viewActiveStep: 1 });
  assert.equal(byHand.activeStep, 2, "Draft done, Promoted not — it was finished by hand");
  assert.equal(byHand.showComplete, false, "already terminal, nothing left to complete");
  assert.equal(byHand.phaseLabel, "Listo");
});

test("a terminal Track-2 spec marks every gate complete and hides Start", () => {
  // Including when the run has aged out of Temporal and the view says canStart.
  for (const status of ["promoted", "completed"]) {
    const p = deriveSpecProgress({ track: 2, status, view: NEVER_RAN, viewActiveStep: 1 });
    assert.equal(p.activeStep, TRACK2_STEPS.length + 1, status);
    assert.equal(p.showStart, false, status);
    assert.equal(p.showComplete, false, `${status}: Complete is a Track-1 affordance only`);
    assert.equal(p.phaseLabel, "Listo", status);
  }
});

test("a LIVE Track-2 spec keeps today's behaviour exactly", () => {
  // The positive control: this change must not alter a run in flight.
  const running: PipelineViewState = { state: "running", availableActions: [], canStart: false };
  const p = deriveSpecProgress({ track: 2, status: "in_progress", view: running, viewActiveStep: 2 });
  assert.deepEqual(p.steps, TRACK2_STEPS);
  assert.equal(p.activeStep, 2, "the view's own step is used unchanged");
  assert.equal(p.showStart, false);
  assert.equal(p.showComplete, false);
  assert.equal(p.phaseLabel, undefined, "the page keeps its own wording while live");
});

test("a failed Track-2 run can still be restarted", () => {
  const failed: PipelineViewState = { state: "failed", availableActions: [], canStart: true };
  const p = deriveSpecProgress({ track: 2, status: "in_progress", view: failed, viewActiveStep: 1 });
  assert.equal(p.showStart, true);
});

test("a missing track is treated as Track 1 — fail closed", () => {
  // An unlabelled spec is hand-authored until proven otherwise, matching
  // deriveNextStep. Guessing Track 2 would put a Start button on it.
  const p = deriveSpecProgress({ status: "draft", view: NEVER_RAN, viewActiveStep: 1 });
  assert.deepEqual(p.steps, TRACK1_STEPS);
  assert.equal(p.showStart, false);
});

test("rejected is terminal, and says so rather than reporting Done", () => {
  assert.equal(isTerminalSpecStatus("rejected"), true);
  const p = deriveSpecProgress({ track: 2, status: "rejected", view: NEVER_RAN, viewActiveStep: 1 });
  assert.equal(p.showStart, false);
  assert.equal(p.phaseLabel, "Rechazado");
});

test("isTerminalSpecStatus tolerates whitespace and rejects live statuses", () => {
  for (const s of [" promoted ", "completed", "rejected"]) assert.equal(isTerminalSpecStatus(s), true, s);
  for (const s of ["draft", "approved", "in_progress", "staged", ""]) {
    assert.equal(isTerminalSpecStatus(s), false, s);
  }
});

/**
 * Spec 0149: `activeStepForView` moved out of `/forge/specs/[filename]/page.tsx`
 * when that page became a redirect. It had no test there — this is the first one,
 * and it covers the null case the page never had to handle (Temporal unreachable).
 */
test("activeStepForView maps each view state to its gate step", () => {
  assert.equal(activeStepForView(null), 1);
  assert.equal(activeStepForView({ ...NEVER_RAN, state: "not_started" }), 1);
  assert.equal(activeStepForView({ ...NEVER_RAN, state: "running" }), 2);
  assert.equal(activeStepForView({ ...NEVER_RAN, state: "waiting_at_gate", gate: "spec" }), 1);
  assert.equal(activeStepForView({ ...NEVER_RAN, state: "waiting_at_gate", gate: "pr" }), 3);
  assert.equal(activeStepForView({ ...NEVER_RAN, state: "waiting_at_gate", gate: "promote" }), 4);
  assert.equal(activeStepForView({ ...NEVER_RAN, state: "completed" }), 5);
  assert.equal(activeStepForView({ ...NEVER_RAN, state: "promoted_teardown_failed" }), 5);
  assert.equal(activeStepForView({ ...NEVER_RAN, state: "failed" }), 1);
});
