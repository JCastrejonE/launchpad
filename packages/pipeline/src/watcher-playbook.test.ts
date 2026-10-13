/**
 * Tests for spec 0054 increment A — the pure exception playbook
 * (`watcher-playbook.ts`). Per spec 0054 Scope §A:
 *  - every documented code (2, 10–18, 20, 30, 31, 32, 40, 41, 50) returns
 *    non-empty title/meaning/steps and the right `recoverHint`
 *    (true for 13/14/17/18, false otherwise);
 *  - an unknown code → the generic fallback (never throws / never undefined);
 *  - the never-signal property: NO entry's steps (nor the fallback's) contain
 *    a CLI gate-verb invocation (`approve-spec`/`approve-pr`/`promote`) as an
 *    instruction to run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeWatcherExitCode, type WatcherExceptionGuidance } from "./watcher-playbook.js";

// Type-level sanity: the guidance shape is what the card + prompt consume.
const _shape: WatcherExceptionGuidance = {
  code: 0,
  title: "",
  meaning: "",
  steps: [],
  recoverHint: false,
};
void _shape;

const DOCUMENTED_CODES = [2, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 30, 31, 32, 40, 41, 50];
const RECOVER_HINT_CODES = new Set([13, 14, 17, 18]);
const GATE_VERB_RE = /\b(approve-spec|approve-pr|promote)\b/;

test("describeWatcherExitCode is exported as a function", () => {
  assert.equal(typeof describeWatcherExitCode, "function");
});

test("every documented code returns non-empty title/meaning/steps and the right recoverHint", () => {
  for (const code of DOCUMENTED_CODES) {
    const g = describeWatcherExitCode(code);
    assert.equal(g.code, code, `code echoed back for ${code}`);
    assert.ok(g.title.trim().length > 0, `title for ${code}`);
    assert.ok(g.meaning.trim().length > 0, `meaning for ${code}`);
    assert.ok(Array.isArray(g.steps) && g.steps.length > 0, `steps for ${code}`);
    for (const step of g.steps) {
      assert.ok(step.trim().length > 0, `non-empty step text for ${code}`);
    }
    assert.equal(
      g.recoverHint,
      RECOVER_HINT_CODES.has(code),
      `recoverHint for ${code} should be ${RECOVER_HINT_CODES.has(code)}`,
    );
  }
});

test("an unknown code degrades to the generic fallback, never throws or is undefined", () => {
  for (const code of [999, -1, 0, 1, 6, 19, 42, 100]) {
    const g = describeWatcherExitCode(code);
    assert.equal(g.code, code);
    assert.ok(g.title.trim().length > 0);
    assert.ok(g.meaning.trim().length > 0);
    assert.ok(g.steps.length > 0);
    assert.equal(g.recoverHint, false);
  }
});

test("never-signal property: no entry's steps instruct running a CLI gate verb", () => {
  const allCodesToCheck = [...DOCUMENTED_CODES, 999];
  for (const code of allCodesToCheck) {
    const g = describeWatcherExitCode(code);
    for (const step of g.steps) {
      assert.doesNotMatch(
        step,
        GATE_VERB_RE,
        `code ${code} step "${step}" must not instruct a CLI gate verb`,
      );
    }
  }
});

test("describeWatcherExitCode is a pure function: same input -> equal output", () => {
  const a = describeWatcherExitCode(14);
  const b = describeWatcherExitCode(14);
  assert.deepEqual(a, b);
});
