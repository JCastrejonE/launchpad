import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordHarnessCase,
  harnessExecutedCount,
  resetHarnessCount,
  harnessSkipProofError,
} from "./harness-exec.js";

test("recordHarnessCase increments the executed count", () => {
  resetHarnessCount();
  recordHarnessCase();
  recordHarnessCase();
  assert.equal(harnessExecutedCount(), 2);
});

test("harnessSkipProofError flags a TEMPORAL_TEST run with 0 (or absent) executed cases", () => {
  assert.ok(harnessSkipProofError({ temporalTest: true, executed: 0 }));
  assert.ok(harnessSkipProofError({ temporalTest: true, executed: null }));
});

test("harnessSkipProofError is silent when cases executed, or TEMPORAL_TEST is unset", () => {
  assert.equal(harnessSkipProofError({ temporalTest: true, executed: 3 }), null);
  assert.equal(harnessSkipProofError({ temporalTest: false, executed: 0 }), null);
  assert.equal(harnessSkipProofError({ temporalTest: false, executed: null }), null);
});
