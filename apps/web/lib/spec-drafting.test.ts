import { test } from "node:test";
import assert from "node:assert/strict";
import { decideUnresolvedSpecView } from "./spec-drafting.js";
import type { PipelineViewState, PipelineStateKind } from "./pipeline.js";

const view = (state: PipelineStateKind): PipelineViewState => ({
  state,
  availableActions: [],
  canStart: state === "not_started",
});

test("null view (no reachable workflow) → not_found", () => {
  assert.equal(decideUnresolvedSpecView(null), "not_found");
});

test("not_started → not_found (no workflow yet, nothing to draft)", () => {
  assert.equal(decideUnresolvedSpecView(view("not_started")), "not_found");
});

test("running → drafting (live workflow, async draftSpec window)", () => {
  assert.equal(decideUnresolvedSpecView(view("running")), "drafting");
});

test("waiting_at_gate → drafting (parked at gate 1 before the commit lands)", () => {
  assert.equal(decideUnresolvedSpecView(view("waiting_at_gate")), "drafting");
});

for (const terminal of [
  "completed",
  "failed",
  "promoted_teardown_failed",
  "unknown_legacy_run",
] as const) {
  test(`${terminal} → not_found (closed run that left no file is a genuine miss)`, () => {
    assert.equal(decideUnresolvedSpecView(view(terminal)), "not_found");
  });
}
