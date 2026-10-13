import { test } from "node:test";
import assert from "node:assert/strict";
import { CI_GATE_WORKFLOW, ciGateWorkflowId } from "./ci-gate-workflow.js";
import { CI_GATE_WORKFLOW_TYPE } from "./task-queue.js";

// Spec 0228 C.

test("the workflow type is a STRING, and the two declarations agree", () => {
  // VERIFICATION #10: a minifier renamed specPipeline to "P" and Temporal retried
  // a type no worker served for nine hours. A string literal survives that; a
  // function reference does not. Two places name this type, so they are compared
  // rather than trusted to stay in step.
  assert.equal(typeof CI_GATE_WORKFLOW, "string");
  assert.equal(CI_GATE_WORKFLOW, "ciGate");
  assert.equal(CI_GATE_WORKFLOW_TYPE, CI_GATE_WORKFLOW);
});

test("the id is per-commit, so two pushes of one sha are one gate", () => {
  assert.equal(ciGateWorkflowId("abc123"), "ci-gate-abc123");
  assert.notEqual(ciGateWorkflowId("abc123"), ciGateWorkflowId("def456"));
});
