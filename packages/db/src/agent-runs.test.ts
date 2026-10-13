import assert from "node:assert/strict";
import { test } from "node:test";
import { agentRunValues } from "./agent-runs.js";

const base = {
  projectId: "11111111-1111-4111-8111-111111111111",
  workflowId: "wf-spdd-0042",
  agent: "coder",
  status: "running",
};

test("agentRunValues defaults every optional column (never leaves them undefined)", () => {
  const v = agentRunValues(base);
  assert.equal(v.task, "");
  assert.equal(v.phase, "");
  assert.equal(v.step, 0);
  assert.equal(v.totalSteps, 0);
  assert.equal(v.repoRoot, "");
  assert.equal(v.workflowId, "wf-spdd-0042");
  assert.equal(v.projectId, base.projectId);
});

test("agentRunValues passes through the advancing state", () => {
  const v = agentRunValues({ ...base, task: "implement item 3", phase: "coder", step: 3, totalSteps: 7 });
  assert.equal(v.task, "implement item 3");
  assert.equal(v.phase, "coder");
  assert.equal(v.step, 3);
  assert.equal(v.totalSteps, 7);
});

test("agentRunValues carries the run's checkout (spec 0131 C)", () => {
  // The field exists to tell a deliberate platform run apart from a run that FELL
  // BACK to the platform checkout: both carry the `platform` project id, so the
  // repo is the only distinguishing fact.
  const v = agentRunValues({ ...base, repoRoot: "/srv/launchpad/checkouts/prueba" });
  assert.equal(v.repoRoot, "/srv/launchpad/checkouts/prueba");
});

test("agentRunValues trims the identity fields", () => {
  const v = agentRunValues({ ...base, workflowId: "  wf-1 ", agent: " coder ", status: " running " });
  assert.equal(v.workflowId, "wf-1");
  assert.equal(v.agent, "coder");
  assert.equal(v.status, "running");
});

test("agentRunValues rejects a call site that would write an unusable row", () => {
  // workflowId is the upsert's conflict target — a blank one would make every
  // run collide on the same row, which is worse than failing loudly.
  assert.throws(() => agentRunValues({ ...base, workflowId: "   " }), /workflowId/);
  assert.throws(() => agentRunValues({ ...base, projectId: "" }), /projectId/);
  assert.throws(() => agentRunValues({ ...base, agent: "" }), /agent/);
  assert.throws(() => agentRunValues({ ...base, status: " " }), /status/);
});

test("step 0 is preserved, not defaulted away", () => {
  // `?? 0` (not `|| 0`) matters: a run legitimately sits at step 0 before its
  // first phase completes, and `|| 0` would mask a real 0 the same as absent.
  assert.equal(agentRunValues({ ...base, step: 0, totalSteps: 5 }).step, 0);
  assert.equal(agentRunValues({ ...base, step: 5, totalSteps: 5 }).totalSteps, 5);
});
