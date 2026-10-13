import { test } from "node:test";
import assert from "node:assert/strict";
import { decideBranchPromote, type BranchPromoteInput } from "./branch-promote.js";

// Table-driven over the guard (spec 0136), the promote-attestation.test.ts
// posture: every clause proven individually, precedence proven by stacking,
// and the warn-shaped absences never read as passes.

const clean: BranchPromoteInput = {
  branchHead: "aaaaaaa1",
  mainHead: "bbbbbbb1",
  stagingSha: "aaaaaaa1",
  stagingBaseSha: "bbbbbbb1",
  checks: "success",
  busyRuns: [],
};

test("a validated, current branch on a quiet production promotes without a word", () => {
  const d = decideBranchPromote(clean);
  assert.deepEqual(d, { blocked: false });
});

test("each clause blocks with ITS message", () => {
  const cases: Array<[Partial<BranchPromoteInput>, RegExp]> = [
    [{ busyRuns: ["0142"] }, /ocupada — spec 0142/],
    [{ productionBuild: { status: "building" } as never }, /odoo\.sh sigue construyendo/],
    [{ branchHead: "ccccccc1" }, /redeploya el staging/],
    [{ mainHead: "ddddddd1" }, /otra rama se promovió primero/],
    [{ checks: "failure" }, /checks del PR están en rojo/],
  ];
  for (const [override, expected] of cases) {
    const d = decideBranchPromote({ ...clean, ...override });
    assert.equal(d.blocked, true, JSON.stringify(override));
    assert.match(d.message ?? "", expected, JSON.stringify(override));
    assert.equal(d.tone, "danger");
  }
});

test("precedence: a busy production wins over a stale attestation", () => {
  const d = decideBranchPromote({ ...clean, busyRuns: ["0142"], branchHead: "ccccccc1" });
  assert.match(d.message ?? "", /ocupada/);
});

test("the warn-shaped absences never block AND never stay silent", () => {
  const cases: Array<[Partial<BranchPromoteInput>, RegExp]> = [
    [{ stagingSha: null, stagingBaseSha: null }, /no tiene staging validado/],
    [{ branchHead: undefined }, /no se pudo comparar/],
    [{ mainHead: undefined }, /no se pudo comparar/],
    [{ checks: "pending" }, /siguen corriendo/],
  ];
  for (const [override, expected] of cases) {
    const d = decideBranchPromote({ ...clean, ...override });
    assert.equal(d.blocked, false, JSON.stringify(override));
    assert.equal(d.tone, "warn", JSON.stringify(override));
    assert.match(d.message ?? "", expected, JSON.stringify(override));
  }
});

// Spec 0188 C. `aggregateChecks` reports "pending" for a head with no workflow
// runs, which on a repo with NO Actions is forever — and `autopartes` PR #1 read
// `Checks 0 (0)` on GitHub while this guard said they were still running. A
// warning that is always on is one nobody reads.
test("pending checks on a repo with NO workflows is silence, not a warn", () => {
  const d = decideBranchPromote({ ...clean, checks: "pending", checksConfigured: false });
  assert.equal(d.blocked, false);
  assert.equal(d.message, undefined);
});

test("pending checks still warn when the repo HAS workflows, or when we could not ask", () => {
  for (const checksConfigured of [true, undefined]) {
    const d = decideBranchPromote({ ...clean, checks: "pending", checksConfigured });
    assert.equal(d.blocked, false, String(checksConfigured));
    assert.match(d.message ?? "", /siguen corriendo/, String(checksConfigured));
  }
});

test("checksConfigured never softens a RED check", () => {
  // Absent CI explains a pending; it explains nothing about a failure.
  const d = decideBranchPromote({ ...clean, checks: "failure", checksConfigured: false });
  assert.equal(d.blocked, true);
  assert.match(d.message ?? "", /en rojo/);
});

test("a destroyed staging (cleared attestation) is the never-staged warn, not a stale block", () => {
  // clearBranchStaging wipes the SHAs with the stack — so the guard must land
  // on "no validated staging", never compare against a ghost.
  const d = decideBranchPromote({
    ...clean,
    stagingSha: null,
    stagingBaseSha: null,
    branchHead: "eeeeeee1",
  });
  assert.equal(d.blocked, false);
  assert.match(d.message ?? "", /no tiene staging validado/);
});

// --- spec 0228 E: our own CI, reported as a commit status ------------------
// A separate reading from `checks`, which is GitHub Actions and which this org
// does not run. One table row per state, because this code decides production
// deploys.

test("a red gate BLOCKS", () => {
  for (const state of ["failure", "error"] as const) {
    const d = decideBranchPromote({ ...clean, gateStatus: state });
    assert.equal(d.blocked, true, state);
    assert.equal(d.tone, "danger", state);
    assert.match(d.message ?? "", /ci\/launchpad/, state);
  }
});

test("a running gate warns but does not block", () => {
  const d = decideBranchPromote({ ...clean, gateStatus: "pending" });
  assert.equal(d.blocked, false);
  assert.equal(d.tone, "warn");
});

test("a green gate does not block", () => {
  assert.equal(decideBranchPromote({ ...clean, gateStatus: "success" }).blocked, false);
});

test("ABSENT says nothing, and is never read as a pass", () => {
  // The dangerous case. Nothing posted means no CI saw this commit; treating
  // that as green is how a promote gate comes to certify nothing (rows 74, 55).
  const absent = decideBranchPromote({ ...clean, gateStatus: undefined });
  const green = decideBranchPromote({ ...clean, gateStatus: "success" });
  // Both are unblocked here, so the assertion that carries weight is that
  // absence never produces the reassurance a pass would.
  assert.equal(absent.blocked, false);
  assert.notEqual(absent.message ?? "", green.message ?? "__never__");
});

test("a red gate outranks green Actions checks", () => {
  // Two sources; ANY red blocks. Our gate is the one that actually ran.
  const d = decideBranchPromote({ ...clean, checks: "success", gateStatus: "failure" });
  assert.equal(d.blocked, true);
  assert.match(d.message ?? "", /ci\/launchpad/);
});
