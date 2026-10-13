/**
 * The workflow TYPE name is a string, and it must equal the exported function's
 * real name (spec 0131 follow-up, live incident 2026-08-05).
 *
 * What this test can catch: someone renaming `specPipeline` (or the constant)
 * without the other, which would make the worker's registration and the client's
 * start disagree.
 *
 * What it CANNOT catch, and must not be mistaken for: the minification failure
 * itself. `specPipeline.name` is `"specPipeline"` here and in every unit test,
 * because nothing minifies this file — that is precisely why the bug survived a
 * green suite and only appeared in `apps/web`'s production bundle, where the name
 * became `"P"`. The check that CAN fail for that is live: start a run from the
 * deployed app and read the recorded `WorkflowType` back from Temporal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { specPipeline, branchStagingOp } from "./workflow.js";
import {
  SPEC_PIPELINE_WORKFLOW_TYPE,
  BRANCH_STAGING_WORKFLOW_TYPE,
  TASK_QUEUE,
} from "./task-queue.js";

test("SPEC_PIPELINE_WORKFLOW_TYPE matches the workflow function's own name", () => {
  assert.equal(SPEC_PIPELINE_WORKFLOW_TYPE, specPipeline.name);
  assert.equal(SPEC_PIPELINE_WORKFLOW_TYPE, "specPipeline");
});

test("BRANCH_STAGING_WORKFLOW_TYPE matches its workflow function's own name (spec 0134)", () => {
  assert.equal(BRANCH_STAGING_WORKFLOW_TYPE, branchStagingOp.name);
  assert.equal(BRANCH_STAGING_WORKFLOW_TYPE, "branchStagingOp");
});

test("the type name is a plain string, not a function reference", () => {
  // The whole point: a string survives a bundler, a function reference does not.
  assert.equal(typeof SPEC_PIPELINE_WORKFLOW_TYPE, "string");
  assert.equal(typeof TASK_QUEUE, "string");
});
