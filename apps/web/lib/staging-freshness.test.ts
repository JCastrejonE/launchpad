import test from "node:test";
import assert from "node:assert/strict";
import { stagingFreshnessNotice } from "./staging-freshness";

// Spec 0187 A. The run this exists for: gate 2 offered Approve PR on a branch
// whose staging server was deployed before the first commit, and said nothing.

test("staging on the head under review says nothing", () => {
  assert.equal(
    stagingFreshnessNotice({ stagingSha: "c426022", branchHead: "c426022", stagingStatus: "ready" }),
    null,
  );
});

test("staging behind the head names both commits", () => {
  const notice = stagingFreshnessNotice({
    stagingSha: "f7b2f2077b067cb200810cab1686b1d3865e66cd",
    branchHead: "c426022709921725ea35c40cd817e3514e4bc1d8",
    stagingStatus: "ready",
  });
  assert.match(notice ?? "", /f7b2f20/);
  assert.match(notice ?? "", /c426022/);
  assert.match(notice ?? "", /NO es este cambio/);
});

test("no stack at all is said plainly, not implied", () => {
  const notice = stagingFreshnessNotice({ stagingStatus: "none", branchHead: "c426022" });
  assert.match(notice ?? "", /no tiene servidor de staging/);
});

test("a FAILED staging is not silence", () => {
  const notice = stagingFreshnessNotice({
    stagingSha: "c426022",
    branchHead: "c426022",
    stagingStatus: "failed",
  });
  assert.match(notice ?? "", /falló/);
});

// The discipline this module is written under: absence of an answer must never
// render as an accusation. An unreadable head is not evidence of staleness.
test("an unknown head produces NO notice when staging looks ready", () => {
  assert.equal(stagingFreshnessNotice({ stagingSha: "c426022", stagingStatus: "ready" }), null);
});

// --- spec 0195 B: the reason travels to the decision ------------------------

test("a failed staging tells the reviewer WHY, not just that it failed", () => {
  const notice = stagingFreshnessNotice({
    stagingStatus: "failed",
    stagingSha: "ab3ea32",
    branchHead: "26e560b",
    stagingNote: "ENOENT: no such file or directory, stat '/app/specs'",
  });
  assert.match(notice ?? "", /Redesplégalo/);
  assert.match(notice ?? "", /Motivo: ENOENT/, "the cause belongs where the decision is made");
});

// Every failure recorded before migration 0016 has no note. The sentence must
// still read as a sentence.
test("no note recorded is a notice without a reason, not a dangling 'Motivo:'", () => {
  const notice = stagingFreshnessNotice({ stagingStatus: "failed", stagingSha: "ab3ea32" });
  assert.doesNotMatch(notice ?? "", /Motivo/);
});
