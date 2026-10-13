import assert from "node:assert/strict";
import test from "node:test";

import {
  humanizeSince,
  isTerminalProjectionStatus,
  reconciledStatus,
  toAgentRunView,
  toAgentRunViews,
} from "./agent-run-view.js";

type Row = Parameters<typeof toAgentRunView>[0];

const NOW = new Date("2026-07-27T12:00:00.000Z");

function row(over: Partial<Row> = {}): Row {
  return {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    projectId: "bbbbbbbb-1111-4111-8111-111111111111",
    workflowId: "wf-spdd-0042",
    agent: "pipeline",
    task: "add a loyalty widget",
    status: "running",
    phase: "coding",
    step: 3,
    totalSteps: 7,
    startedAt: new Date("2026-07-27T11:52:00.000Z"),
    ...over,
  } as Row;
}

test("maps the projection row onto the tab's shape", () => {
  const v = toAgentRunView(row(), NOW);
  assert.equal(v.workflow, "wf-spdd-0042"); // workflowId → workflow
  assert.equal(v.agent, "pipeline");
  assert.equal(v.task, "add a loyalty widget");
  assert.equal(v.status, "running");
  assert.equal(v.phase, "coding");
  assert.equal(v.step, 3);
  assert.equal(v.totalSteps, 7);
});

test("humanizeSince covers seconds → days without a date library", () => {
  const at = (ms: number) => new Date(NOW.getTime() - ms);
  assert.equal(humanizeSince(at(5_000), NOW), "hace segundos");
  assert.equal(humanizeSince(at(8 * 60_000), NOW), "hace 8 min");
  assert.equal(humanizeSince(at(3 * 3_600_000), NOW), "hace 3 h");
  assert.equal(humanizeSince(at(2 * 86_400_000), NOW), "hace 2 d");
});

test("a clock skewed into the future reads as just-started, never negative", () => {
  // Worker and web can disagree by a second; "hace -1 min" would look broken.
  assert.equal(humanizeSince(new Date(NOW.getTime() + 30_000), NOW), "hace segundos");
});

test("toAgentRunViews preserves order (the query already sorts newest-first)", () => {
  const rows = [row({ id: "r1", workflowId: "wf-1" }), row({ id: "r2", workflowId: "wf-2" })];
  assert.deepEqual(
    toAgentRunViews(rows, NOW).map((r) => r.workflow),
    ["wf-1", "wf-2"],
  );
});

// ── spec 0092: terminal reconciliation ──────────────────────────────────────

test("reconciledStatus: a closed execution overrides a row still claiming to run", () => {
  // The case that motivated this: `terminate` runs no workflow code, so the
  // projection is never updated and the Launchpad's live-agent count inflates.
  assert.equal(reconciledStatus("running", "TERMINATED"), "failed");
  assert.equal(reconciledStatus("running", "CANCELED"), "failed");
  assert.equal(reconciledStatus("running", "FAILED"), "failed");
  assert.equal(reconciledStatus("running", "TIMED_OUT"), "failed");
  assert.equal(reconciledStatus("running", "COMPLETED"), "completed");
  assert.equal(reconciledStatus("waiting-approval", "TERMINATED"), "failed");
});

test("reconciledStatus: a live execution leaves the projection alone", () => {
  assert.equal(reconciledStatus("running", "RUNNING"), "running");
  assert.equal(reconciledStatus("waiting-approval", "RUNNING"), "waiting-approval");
  assert.equal(reconciledStatus("running", "CONTINUED_AS_NEW"), "running");
});

test("reconciledStatus: an unavailable Temporal never guesses", () => {
  // describe() failed / workflow not found — degrade, don't invent an outcome.
  assert.equal(reconciledStatus("running", undefined), "running");
  assert.equal(reconciledStatus("running", "WHO_KNOWS"), "running");
});

test("reconciledStatus: an already-terminal row is authoritative", () => {
  // The workflow wrote it with more detail than a closed-execution status has,
  // so a later describe() must not flip `completed` to `failed`.
  assert.equal(reconciledStatus("completed", "TERMINATED"), "completed");
  assert.equal(reconciledStatus("failed", "COMPLETED"), "failed");
  assert.equal(isTerminalProjectionStatus("completed"), true);
  assert.equal(isTerminalProjectionStatus("running"), false);
});
