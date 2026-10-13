import { test } from "node:test";
import assert from "node:assert/strict";
import { GATE_ACTION_LABEL, mergeIsTheGate, suppressDuplicateApprove, type GateSignal } from "./gate-actions";
import type { PullRequestRef } from "@launchpad/pipeline";

const ALL_GATE_SIGNALS = ["specApproved", "prApproved", "promote", "specRejected"] as const;

test("GATE_ACTION_LABEL has a distinct, non-empty label for every gate signal", () => {
  const labels = ALL_GATE_SIGNALS.map((signal) => GATE_ACTION_LABEL[signal]);
  for (const label of labels) {
    assert.ok(label.length > 0);
  }
  assert.equal(new Set(labels).size, labels.length);
});

// suppressDuplicateApprove (spec 0015 item 8; moved here spec 0052 item E so
// run-follow-card.ts can reuse it without pulling @temporalio/client into the
// browser bundle — see this file's doc comment). Full behavior coverage
// stays in lib/pipeline.test.ts too (re-exported there unchanged, still
// green); these are a light smoke check at the symbol's actual new home.
const PR_ACTIONS: Array<"prApproved" | "specRejected"> = ["prApproved", "specRejected"];

function ghPr(overrides: Partial<PullRequestRef> = {}): PullRequestRef {
  return {
    repo: "example-org/launchpad",
    branch: "spec/0015",
    workdir: "/tmp/repo",
    number: 42,
    url: "https://github.com/example-org/launchpad/pull/42",
    ...overrides,
  };
}

test("suppressDuplicateApprove: no pr ref → unchanged", () => {
  assert.deepEqual(suppressDuplicateApprove([...PR_ACTIONS], undefined), PR_ACTIONS);
});

test("suppressDuplicateApprove: real GitHub PR → prApproved removed", () => {
  assert.deepEqual(suppressDuplicateApprove([...PR_ACTIONS], ghPr()), ["specRejected"]);
});

// Spec 0142: the first branch run reached gate 2 with a green staging
// environment, a Reject button and NOTHING else — the suppression hid the
// only approval path a branch run has, and no PR poll was running to deliver
// one instead. The run could never advance.
test("a BRANCH run keeps Approve PR even when a real PR exists", () => {
  const actions: GateSignal[] = ["prApproved", "specRejected"];
  const pr = { number: 1, url: "https://github.com/o/r/pull/1" } as PullRequestRef;

  // Per-spec model: GitHub's review IS gate 2, so the button stays suppressed.
  assert.deepEqual(suppressDuplicateApprove(actions, pr), ["specRejected"]);

  // Branch model: the in-app signal is the ONLY approval path.
  assert.deepEqual(suppressDuplicateApprove(actions, pr, "owner/hola-addon"), [
    "prApproved",
    "specRejected",
  ]);
});

// --- Spec 0225 D: the merge button appears exactly where the approve vanished

test("spec 0225: mergeIsTheGate is TRUE exactly when suppressDuplicateApprove hides the approve", () => {
  const cases: Array<[ReturnType<typeof ghPr> | undefined, string | undefined]> = [
    [ghPr(), undefined],                 // real PR, per-spec run → merge is the gate
    [ghPr(), "owner/menu-sushi"],           // branch run → not the gate
    [ghPr({ number: 0 }), undefined],    // local-diff ref → not the gate
    [undefined, undefined],              // no PR at all → not the gate
  ];
  for (const [pr, branch] of cases) {
    const hidden = !suppressDuplicateApprove([...PR_ACTIONS], pr, branch).includes("prApproved");
    assert.equal(
      mergeIsTheGate(pr, branch),
      hidden,
      `disagreement for pr=${JSON.stringify(pr?.number)} branch=${branch}`,
    );
  }
});

test("spec 0225: a branch run is never merged from gate 2 — that is promote", () => {
  assert.equal(mergeIsTheGate(ghPr(), "owner/landing-tarjetas"), false);
});
