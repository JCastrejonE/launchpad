import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionProgressed, type SessionDiff, commitsMarkPlanRevision } from "./progress.js";

// Scaffold for spec 0008 item 2 (the "diff seam"). Skipped until
// sessionProgressed is implemented — these pin the acceptance criterion
// "a coder session that only commits a handoff note yields progressed:false"
// plus the two ways a session DOES count as progress.
const SPEC = "specs/0008-pipeline-hardening-round2.md";
const diff = (over: Partial<SessionDiff> = {}): SessionDiff => ({
  changedFiles: [],
  checkboxDelta: 0,
  specFile: SPEC,
  ...over,
});

test("no commit at all → not progressed", () => {
  assert.equal(sessionProgressed(diff()), false);
});

test("handoff-only commit (spec file, no checkbox change) → not progressed", () => {
  assert.equal(sessionProgressed(diff({ changedFiles: [SPEC] })), false);
});

test("checkbox flipped in the spec → progressed", () => {
  assert.equal(
    sessionProgressed(diff({ changedFiles: [SPEC], checkboxDelta: 1 })),
    true,
  );
});

test("any non-spec file touched → progressed", () => {
  assert.equal(
    sessionProgressed(diff({ changedFiles: [SPEC, "packages/pipeline/src/loop.ts"] })),
    true,
  );
});

// --- Spec 0113: a justified plan revision is progress -----------------------

test("a plan-revision commit counts as progress even though it touches only the spec", () => {
  // The measured problem: 0 revisions in 8 coder sessions. A session that rewrote
  // the checklist without ticking a box looked identical to a stall, so the loop
  // punished the one thing it most needs.
  assert.equal(
    sessionProgressed({
      changedFiles: ["specs/0113-x.md"],
      checkboxDelta: 0,
      specFile: "specs/0113-x.md",
      planRevised: true,
    }),
    true,
  );
});

test("a handoff-only session is STILL a stall — the revision escape is narrow", () => {
  assert.equal(
    sessionProgressed({
      changedFiles: ["specs/0113-x.md"],
      checkboxDelta: 0,
      specFile: "specs/0113-x.md",
      planRevised: false,
    }),
    false,
  );
  // and absent (the pre-0113 shape) behaves the same
  assert.equal(
    sessionProgressed({
      changedFiles: ["specs/0113-x.md"],
      checkboxDelta: 0,
      specFile: "specs/0113-x.md",
    }),
    false,
  );
});

test("commitsMarkPlanRevision keys on the documented subject marker", () => {
  assert.equal(commitsMarkPlanRevision(["docs(spec-0113): revise plan — item 2 already built"]), true);
  assert.equal(commitsMarkPlanRevision(["docs(spec-0113): Revise Plan — case-insensitive"]), true);
  assert.equal(commitsMarkPlanRevision(["feat(spec-0113): implement item 2"]), false);
  assert.equal(commitsMarkPlanRevision([]), false);
  // Only the marker counts — a coder cannot claim a revision by mentioning plans.
  assert.equal(commitsMarkPlanRevision(["docs(spec-0113): update the plan section"]), false);
});
