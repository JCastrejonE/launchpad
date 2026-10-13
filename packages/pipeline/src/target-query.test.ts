import { test } from "node:test";
import assert from "node:assert/strict";
import { PIPELINE_TARGET_QUERY } from "./target-query.js";

// Spec 0033 Scope A — foundation scaffold. The wire-level behaviour (the
// `pipelineTarget` query returning `input.target` for a tenant run and a
// launchpad run, no TMPRL1100/determinism regression) is exercised in
// workflow.test.ts under the TEMPORAL_TEST harness; this file just pins the
// shared query-name constant so the workflow handler and the apps/web caller
// can never drift.
test("PIPELINE_TARGET_QUERY is the stable query name", () => {
  assert.equal(PIPELINE_TARGET_QUERY, "pipelineTarget");
});
