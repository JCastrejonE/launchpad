/**
 * Identifier invariance (spec 0211, acceptance criterion 3).
 *
 * Spec 0211 translates the UI to Spanish. Its ONE hard constraint is that only
 * the LABEL a human reads changes — never the VALUE a machine reads. Those
 * values are not decoration: a phase name is a Temporal query answer, a spec
 * status is the on-disk frontmatter of 208 spec files, and a gate signal name
 * is the literal signal identifier `signalGate()` sends to a running workflow.
 * CLAUDE.md rule #10 is what this exists to prevent — a name that crossed a
 * process boundary and no longer matched cost nine hours of production retries.
 *
 * So this test is not about Spanish at all. It pins the three identifier sets
 * to a LITERAL English list written out by hand, so any translation of a key
 * (as opposed to a value) turns this red before it can reach a workflow, a
 * frontmatter parser or a gate button.
 *
 * The lists below are deliberately duplicated rather than derived from the
 * types: a test that reads its expectation from the thing under test cannot
 * fail (CLAUDE.md verification rule #2). Adding a genuinely new phase/status
 * is expected to edit this file — that edit is the point, it is where the
 * "is this a rename or an addition?" question gets asked.
 *
 * PURE — no Temporal client, no fs. Runs under `node --test` like its
 * neighbours.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PIPELINE_PHASES } from "@launchpad/pipeline";
import { KNOWN_STATUSES } from "./spec-status";
import { GATE_ACTION_LABEL } from "./gate-actions";
import { PIPELINE_GATE_LABEL } from "./pipeline";

test("PipelinePhase values are byte-identical to the known English set", () => {
  assert.deepEqual(
    [...PIPELINE_PHASES],
    [
      "drafting",
      "awaiting_spec_approval",
      "provisioning",
      "initializing",
      "coding",
      "awaiting_pr_approval",
      "merging",
      "staged",
      "awaiting_promotion",
      "deploying",
      "tearing_down",
      "promoted",
      "promoted_teardown_failed",
      "rejected",
      "failed",
    ],
  );
});

test("spec status values are byte-identical to the known English set", () => {
  // These are frontmatter on disk in every spec file, and what the reconciler
  // and the status badge switch on.
  assert.deepEqual(
    [...KNOWN_STATUSES],
    ["draft", "approved", "in_progress", "staged", "promoted", "rejected", "completed"],
  );
});

test("gate signal names are byte-identical to the workflow's own signal identifiers", () => {
  // The KEYS of the label map are the wire values `signalGate()` sends; the
  // VALUES are button text and are free to be Spanish.
  assert.deepEqual(Object.keys(GATE_ACTION_LABEL).sort(), [
    "promote",
    "prApproved",
    "specApproved",
    "specRejected",
  ].sort());
});

test("PipelineGate values are byte-identical to the known English set", () => {
  assert.deepEqual(Object.keys(PIPELINE_GATE_LABEL).sort(), ["pr", "promote", "spec"]);
});
