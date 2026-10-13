/**
 * Tests for `deriveNextStep` (spec 0107 item 1). Pure function of already-loaded
 * state — no React, no DOM — proved under plain `node --test` over compiled
 * lib-only TS, the same harness `lib/run-follow-card.test.ts` uses.
 *
 * SCAFFOLD: the branch structure below mirrors the five first-match-wins rules
 * in `next-step.ts`. Each `todo` becomes a real assertion when the coder
 * implements the function in item 1. The two invariants called out in the
 * spec's acceptance criteria have their own cases so they can never silently
 * regress: a gate-parked run beats a pending (human) item, and a promoted spec
 * yields "Nada que hacer" rather than its lingering (human) screenshot item.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveNextStep, type NextStepInput } from "./next-step.js";
import { RECOVER_OFFER_COPY } from "./run-follow-card.js";

/** A neutral, "nothing pending" baseline; each test overrides the fields it
 * exercises so the intent of every case reads at a glance. */
const BASE: NextStepInput = {
  status: "in_progress",
  hasRun: true,
  gateActions: [],
  recoverOffer: null,
  humanPending: [],
};

test("rule 1 — a run parked at a gate surfaces that gate's own action", () => {
  const step = deriveNextStep({ ...BASE, gateActions: ["specApproved", "specRejected"] });
  assert.equal(step.kind, "gate");
  assert.equal(step.label, "Aprobar spec");
  // the full signal list rides along so the card can render the gate buttons
  assert.deepEqual(step.actions, ["specApproved", "specRejected"]);
});

test("rule 2 — a failed/exception run surfaces the recover offer's copy", () => {
  const step = deriveNextStep({ ...BASE, recoverOffer: "watcher-died-silently" });
  assert.equal(step.kind, "recover");
  // reuses the SAME copy the Recover strip renders, never restated
  assert.equal(step.label, RECOVER_OFFER_COPY["watcher-died-silently"]);
});

test("rule 3 — a TRACK-2 draft spec with no run surfaces \"Iniciar corrida\"", () => {
  // Spec 0109 added `track`: only a pipeline-bound spec gets the invitation.
  const step = deriveNextStep({ ...BASE, status: "draft", hasRun: false, track: 2 });
  assert.deepEqual(step, { kind: "start", label: "Iniciar corrida" });
});

test("rule 4 — only (human) items remain surfaces that item's text", () => {
  const step = deriveNextStep({ ...BASE, humanPending: ["live-check the deploy on staging"] });
  assert.deepEqual(step, { kind: "human", label: "live-check the deploy on staging" });
});

test("rule 5 — promoted / nothing pending yields \"Nada que hacer\"", () => {
  const step = deriveNextStep({ ...BASE, status: "promoted" });
  assert.deepEqual(step, { kind: "none", label: "Nada que hacer" });
});

test("invariant — a gate-parked run beats a pending (human) item", () => {
  const step = deriveNextStep({
    ...BASE,
    gateActions: ["prApproved", "specRejected"],
    humanPending: ["someone still owes a screenshot"],
  });
  assert.equal(step.kind, "gate");
  assert.equal(step.label, "Aprobar PR");
});

// SPEC 0109 REVERSED THIS. The test that used to live here asserted the opposite
// as an "invariant" — that a promoted spec hides its lingering `(human)` item —
// and its example was, precisely, spec 0107's own unfinished screenshot check.
// So the case was seen and deliberately hidden. The intuition is defensible (a
// shipped spec's leftovers are usually historical), but it was wrong for the case
// that mattered: 0107 shipped promoted with that check genuinely outstanding, and
// the card 0107 built could not display its own remaining task. A promoted spec
// with NOTHING pending still reads "Nada que hacer" — see the test below.
test("a promoted spec SURFACES a still-pending (human) item (spec 0109 defect 1)", () => {
  const step = deriveNextStep({
    ...BASE,
    status: "promoted",
    humanPending: ["screenshots of the Resumen and home cards inspected"],
  });
  assert.deepEqual(step, {
    kind: "human",
    label: "screenshots of the Resumen and home cards inspected",
  });
});

// --- Spec 0109: the two defects the screenshot check caught -----------------

test("0109 defect 1: a PROMOTED spec's pending (human) item is surfaced, not hidden", () => {
  // Regression case is spec 0107's real shape: promoted, with its own screenshot
  // check still unchecked. Before the fix the terminal guard ran first and this
  // returned "Nada que hacer" — so the card could not show its own outstanding task.
  const step = deriveNextStep({
    ...BASE,
    status: "promoted",
    hasRun: true,
    humanPending: ["screenshots of the Resumen and home cards inspected"],
    track: 2,
  });
  assert.equal(step.kind, "human");
  assert.equal(step.label, "screenshots of the Resumen and home cards inspected");
});

test("0109 defect 1: a promoted spec with NOTHING pending is still 'Nada que hacer'", () => {
  const step = deriveNextStep({ ...BASE, status: "promoted", hasRun: true, track: 2 });
  assert.equal(step.kind, "none");
  assert.equal(step.label, "Nada que hacer");
});

test("0109 defect 2: a Track-1 spec is never offered a run, however draft it looks", () => {
  // Hand-authored specs stay `draft` for life because no pipeline run advances
  // them. Offering Start would invite a run on already-merged work.
  const step = deriveNextStep({ ...BASE, status: "draft", hasRun: false, track: 1 });
  assert.notEqual(step.kind, "start");
  assert.equal(step.kind, "none");
});

test("0109 defect 2: a Track-2 draft with no run IS offered a run", () => {
  const step = deriveNextStep({ ...BASE, status: "draft", hasRun: false, track: 2 });
  assert.equal(step.kind, "start");
  assert.equal(step.label, "Iniciar corrida");
});

test("0109 defect 2: an ABSENT track fails closed (treated as Track 1, no invitation)", () => {
  // Failing closed costs a missing button; failing open re-runs finished work.
  const step = deriveNextStep({ ...BASE, status: "draft", hasRun: false });
  assert.notEqual(step.kind, "start");
});

// --- Spec 0220: a pending AskUserQuestion outranks every other rule ---------

test("0220 rule 0 — a pending question is the next step, ABOVE an open gate", () => {
  // The ordering the spec makes explicit: the question has a 15-minute fuse and
  // blocks a turn in flight; the gate waits indefinitely.
  const step = deriveNextStep({
    ...BASE,
    gateActions: ["specApproved", "specRejected"],
    humanPending: ["someone still owes a screenshot"],
    pendingQuestion: { summary: "¿Incluyo el carrito en el alcance?" },
  });
  assert.equal(step.kind, "question");
  assert.equal(step.label, "Responder: ¿Incluyo el carrito en el alcance?");
});

test("0220 — a resolved question yields no question step", () => {
  // `loadPendingQuestion` answers null once the row is resolved (or its run is
  // gone), and every other rule must then behave exactly as before.
  const gated = deriveNextStep({ ...BASE, pendingQuestion: null, gateActions: ["specApproved"] });
  assert.equal(gated.kind, "gate");
  const idle = deriveNextStep({ ...BASE, pendingQuestion: null });
  assert.deepEqual(idle, { kind: "none", label: "Nada que hacer" });
});

test("0109: a gate still beats everything, including a pending (human) item", () => {
  const step = deriveNextStep({
    ...BASE,
    status: "draft",
    hasRun: true,
    gateActions: ["specApproved"] as never,
    humanPending: ["some manual check"],
    track: 2,
  });
  assert.equal(step.kind, "gate");
});
