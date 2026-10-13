/**
 * Spec 0118. These cases are the reason the decision is pure: "two users interleave
 * their promotes" cannot be staged live on demand, so if it is not a unit test it is
 * not tested at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decidePromoteAttestation,
  isProductionBusyPhase,
  PRODUCTION_BUSY_PHASES,
  type PromoteAttestation,
} from "./promote-attestation.js";
import { PIPELINE_PHASES } from "./phase.js";

const ATTESTED: PromoteAttestation = {
  approvedBy: "owner@example.com",
  testedSha: "aaaaaaa1111111111111111111111111111111111",
  baseSha: "bbbbbbb2222222222222222222222222222222222",
};

const OTHER = "ccccccc3333333333333333333333333333333333";

test("everything matches, production idle -> allowed, no noise", () => {
  const d = decidePromoteAttestation({
    attestation: ATTESTED,
    prHead: ATTESTED.testedSha,
    mainHead: ATTESTED.baseSha,
    busyRuns: [],
  });
  assert.deepEqual(d, { blocked: false });
});

// --- clause 2: the PR moved under the approval -----------------------------

test("PR head moved after approval -> blocked, naming both SHAs", () => {
  const d = decidePromoteAttestation({
    attestation: ATTESTED,
    prHead: OTHER,
    mainHead: ATTESTED.baseSha,
  });
  assert.equal(d.blocked, true);
  assert.equal(d.tone, "danger");
  assert.match(d.message ?? "", /aaaaaaa/);
  assert.match(d.message ?? "", /ccccccc/);
  assert.match(d.message ?? "", /Re-approve/);
});

// --- clause 3: main moved under the approval -------------------------------

test("main moved after approval -> blocked even though the PR is untouched", () => {
  // The case that only exists with concurrent users, and the one that looks
  // completely safe: PR head unchanged, CI still green, button enabled.
  const d = decidePromoteAttestation({
    attestation: ATTESTED,
    prHead: ATTESTED.testedSha,
    mainHead: OTHER,
  });
  assert.equal(d.blocked, true);
  assert.match(d.message ?? "", /another change was promoted first/);
  assert.match(d.message ?? "", /Re-test/);
});

test("the two stale reasons are distinguishable — they have different fixes", () => {
  const prMoved = decidePromoteAttestation({
    attestation: ATTESTED,
    prHead: OTHER,
    mainHead: ATTESTED.baseSha,
  });
  const baseMoved = decidePromoteAttestation({
    attestation: ATTESTED,
    prHead: ATTESTED.testedSha,
    mainHead: OTHER,
  });
  assert.notEqual(prMoved.message, baseMoved.message);
  assert.match(prMoved.message ?? "", /Re-approve/);
  assert.match(baseMoved.message ?? "", /Re-test/);
});

// --- clause 4: production busy ---------------------------------------------

test("another run mid-deploy on this repo -> blocked, even with a perfect attestation", () => {
  const d = decidePromoteAttestation({
    attestation: ATTESTED,
    prHead: ATTESTED.testedSha,
    mainHead: ATTESTED.baseSha,
    busyRuns: ["0042"],
  });
  assert.equal(d.blocked, true);
  assert.match(d.message ?? "", /spec 0042/);
  assert.match(d.message ?? "", /is mid-deploy/);
});

test("busy production outranks a stale attestation — the more fundamental refusal wins", () => {
  const d = decidePromoteAttestation({
    attestation: ATTESTED,
    prHead: OTHER,
    mainHead: OTHER,
    busyRuns: ["0042", "0043"],
  });
  assert.match(d.message ?? "", /are mid-deploy/);
  assert.match(d.message ?? "", /spec 0042, spec 0043/);
});

// --- posture: block on known-bad, warn on unknown --------------------------

test("no attestation (a run approved before this shipped) -> warns, does NOT block", () => {
  // Blocking here would have made this guard's rollout an outage: every run
  // already parked at gate 3 has no attestation and cannot grow one.
  const d = decidePromoteAttestation({ prHead: OTHER, mainHead: OTHER });
  assert.equal(d.blocked, false);
  assert.equal(d.tone, "warn");
  assert.match(d.message ?? "", /never recorded/);
});

test("attestation present but the current SHAs unreadable -> warns that it could NOT check", () => {
  const d = decidePromoteAttestation({ attestation: ATTESTED });
  assert.equal(d.blocked, false);
  assert.equal(d.tone, "warn");
  assert.match(d.message ?? "", /could not be re-checked/);
});

test("an unreadable input never reads as a pass", () => {
  // The failure mode being guarded: `prHead === undefined` short-circuiting the
  // !== comparison and falling through to a silent, message-less allow.
  for (const partial of [
    { attestation: ATTESTED, prHead: ATTESTED.testedSha },
    { attestation: ATTESTED, mainHead: ATTESTED.baseSha },
  ]) {
    const d = decidePromoteAttestation(partial);
    assert.equal(d.blocked, false);
    assert.ok(d.message, "a half-checked promote must still say so");
  }
});

// --- phase classification ---------------------------------------------------

test("production-busy phases are exactly merging/deploying/tearing_down", () => {
  assert.deepEqual([...PRODUCTION_BUSY_PHASES], ["merging", "deploying", "tearing_down"]);
});

test("no gate or terminal phase counts as busy — waiting blocks nobody", () => {
  const busy = PIPELINE_PHASES.filter(isProductionBusyPhase);
  assert.deepEqual(busy, [...PRODUCTION_BUSY_PHASES]);
  for (const p of ["awaiting_promotion", "awaiting_pr_approval", "promoted", "failed"] as const) {
    assert.equal(isProductionBusyPhase(p), false, p);
  }
});

test("an unknown phase (a run too old to answer) is not busy", () => {
  // Counting unknown as busy would let one legacy run block every promote.
  assert.equal(isProductionBusyPhase(undefined), false);
});

// ---------------------------------------------------------------------------
// Spec 0115 — clause 4's credentialed half: odoo.sh mid-build on production.
//
// The blocking case is the easy one. The two ALLOW cases are what stop this
// clause from making promote impossible everywhere.
// ---------------------------------------------------------------------------

const GOOD_ATTESTATION = { approvedBy: "owner", testedSha: "a".repeat(40), baseSha: "b".repeat(40) };

test("clause 4: an in-flight odoo.sh production build BLOCKS the promote", () => {
  const decision = decidePromoteAttestation({
    attestation: GOOD_ATTESTATION,
    prHead: GOOD_ATTESTATION.testedSha,
    mainHead: GOOD_ATTESTATION.baseSha,
    productionBuild: { status: "building", description: "Build 42", url: null },
  });
  assert.equal(decision.blocked, true);
  assert.equal(decision.tone, "danger");
  // The reason names the undocumented behaviour it is avoiding, so the operator
  // knows why waiting is the answer rather than retrying.
  assert.match(decision.message ?? "", /still building production/);
  assert.match(decision.message ?? "", /Build 42/);
  assert.match(decision.message ?? "", /undocumented/);
});

test("clause 4: ABSENT does not block — most repos never report this context", () => {
  // Our own dogfood repo has no odoo.sh at all. Blocking on absence would make
  // promote impossible everywhere except one customer.
  const decision = decidePromoteAttestation({
    attestation: GOOD_ATTESTATION,
    prHead: GOOD_ATTESTATION.testedSha,
    mainHead: GOOD_ATTESTATION.baseSha,
    productionBuild: { status: "absent" },
  });
  assert.equal(decision.blocked, false);
});

test("clause 4: a FAILED production build does not block", () => {
  // Per spec 0115: promoting over a failed build is safe precisely because
  // odoo.sh falls back to the last good build rather than leaving production down.
  const decision = decidePromoteAttestation({
    attestation: GOOD_ATTESTATION,
    prHead: GOOD_ATTESTATION.testedSha,
    mainHead: GOOD_ATTESTATION.baseSha,
    productionBuild: { status: "failed", description: null, url: null, githubState: "failure" },
  });
  assert.equal(decision.blocked, false);
});

test("clause 4: a successful build does not block, and not looking at all does not either", () => {
  for (const productionBuild of [
    { status: "success" as const, description: null, url: null },
    undefined,
  ]) {
    const decision = decidePromoteAttestation({
      attestation: GOOD_ATTESTATION,
      prHead: GOOD_ATTESTATION.testedSha,
      mainHead: GOOD_ATTESTATION.baseSha,
      ...(productionBuild ? { productionBuild } : {}),
    });
    assert.equal(decision.blocked, false, JSON.stringify(productionBuild));
  }
});

test("clause 4 is checked BEFORE the stale-attestation clauses — production busy wins", () => {
  // Ordering matters for the message the operator reads: if production is mid-build
  // AND the PR moved, "wait for the build" is not the most useful thing to say...
  // but a busy production is the more fundamental refusal, and it is the one that
  // cannot be fixed by re-approving. Asserted so the order is deliberate, not
  // incidental.
  const decision = decidePromoteAttestation({
    attestation: GOOD_ATTESTATION,
    prHead: "c".repeat(40), // stale — clause 2 would also block
    mainHead: GOOD_ATTESTATION.baseSha,
    productionBuild: { status: "building", description: null, url: null },
  });
  assert.equal(decision.blocked, true);
  assert.match(decision.message ?? "", /still building production/);
});

test("our own busy run still outranks odoo.sh's build — the existing clause comes first", () => {
  const decision = decidePromoteAttestation({
    attestation: GOOD_ATTESTATION,
    prHead: GOOD_ATTESTATION.testedSha,
    mainHead: GOOD_ATTESTATION.baseSha,
    busyRuns: ["0099"],
    productionBuild: { status: "building", description: null, url: null },
  });
  assert.equal(decision.blocked, true);
  assert.match(decision.message ?? "", /Production is busy/);
});
