/**
 * Tests for spec 0052 item E — RunFollowCard's pure card-model derivation
 * (lib/run-follow-card.ts). No React, no DOM: this repo's test harness is
 * plain `node --test` over compiled lib-only TS, so every card-model claim
 * has to be provable as a pure function of its inputs (mirrors
 * lib/chat-cards.test.ts's approach for the chat surface's generative cards).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WatcherEvent } from "@launchpad/pipeline";
import {
  buildDiagnosisPrompt,
  deriveCurrentActivityLine,
  deriveExceptionGuidance,
  deriveGateCueModel,
  deriveLatestReviewNote,
  deriveOutcomeCards,
  derivePrimaryAction,
  phaseLabel,
  deriveRecoverOffer,
  deriveResumePolishedOffer,
  deriveStepperNodes,
  deriveWatcherChip,
  PIPELINE_PHASE_LABEL,
  shouldShowPlanProgress,
} from "./run-follow-card.js";
import type { OutcomeCardModel } from "./run-follow-card.js";
import type { RunStep } from "./supervisor-run.js";

const ev = (partial: WatcherEvent): WatcherEvent => partial;

// ---------------------------------------------------------------------------
// deriveWatcherChip
// ---------------------------------------------------------------------------

test("deriveWatcherChip: never started, not running → idle", () => {
  assert.deepEqual(deriveWatcherChip({ running: false }, []), { state: "idle", label: "Sin seguir" });
});

test("deriveWatcherChip: running with a pid → following, labeled with the pid", () => {
  assert.deepEqual(deriveWatcherChip({ running: true, pid: 4242 }, []), {
    state: "following",
    label: "Siguiendo · pid 4242",
    pid: 4242,
  });
});

test("deriveWatcherChip: started once, now not running → exited (not idle)", () => {
  const events: WatcherEvent[] = [ev({ ts: "t0", type: "start", pid: 1, flags: ["--no-start"] })];
  assert.deepEqual(deriveWatcherChip({ running: false }, events), { state: "exited", label: "Terminó" });
});

// ---------------------------------------------------------------------------
// deriveOutcomeCards
// ---------------------------------------------------------------------------

test("deriveOutcomeCards: maps exception/polish/closeout/done, skips start/cue/review", () => {
  const events: WatcherEvent[] = [
    ev({ ts: "t0", type: "start", pid: 1, flags: [] }),
    ev({ ts: "t1", type: "cue", gate: 1, msg: "gate 1" }),
    ev({ ts: "t2", type: "review", lines: ["ok"] }),
    ev({ ts: "t3", type: "exception", code: 2, msg: "boom" }),
    ev({ ts: "t4", type: "polish", msg: "polishing" }),
    ev({ ts: "t5", type: "closeout", msg: "closing out" }),
    ev({ ts: "t6", type: "done", benign: true, msg: "gate-parked" }),
  ];
  assert.deepEqual(deriveOutcomeCards(events), [
    { kind: "exception", message: "boom", ts: "t3", code: 2 },
    { kind: "polish", message: "polishing", ts: "t4" },
    { kind: "closeout", message: "closing out", ts: "t5" },
    { kind: "done", message: "gate-parked", ts: "t6", benign: true },
  ]);
});

test("deriveOutcomeCards: empty tail → empty list", () => {
  assert.deepEqual(deriveOutcomeCards([]), []);
});

// ---------------------------------------------------------------------------
// deriveLatestReviewNote
// ---------------------------------------------------------------------------

test("deriveLatestReviewNote: no review event → null", () => {
  assert.equal(deriveLatestReviewNote([ev({ ts: "t0", type: "start", pid: 1, flags: [] })]), null);
});

test("deriveLatestReviewNote: returns the LAST review event's lines", () => {
  const events: WatcherEvent[] = [
    ev({ ts: "t0", type: "review", lines: ["first"] }),
    ev({ ts: "t1", type: "cue", gate: 2, msg: "gate 2" }),
    ev({ ts: "t2", type: "review", lines: ["second", "line"] }),
  ];
  assert.deepEqual(deriveLatestReviewNote(events), ["second", "line"]);
});

// ---------------------------------------------------------------------------
// deriveCurrentActivityLine
// ---------------------------------------------------------------------------

test("deriveCurrentActivityLine: activities present → joined", () => {
  assert.equal(deriveCurrentActivityLine(["runCoder", "runChecks"], undefined), "runCoder, runChecks");
});

test("deriveCurrentActivityLine: no activities, parked at a gate → gate label", () => {
  assert.equal(deriveCurrentActivityLine(undefined, "pr"), "Detenido en la aprobación de PR (compuerta 2)");
});

test("deriveCurrentActivityLine: no activities, no gate → null (named-cut degrade)", () => {
  assert.equal(deriveCurrentActivityLine(undefined, undefined), null);
});

test("deriveCurrentActivityLine: empty activities array treated as absent", () => {
  assert.equal(deriveCurrentActivityLine([], "promote"), "Detenido en la promoción (compuerta 3)");
});

// ---------------------------------------------------------------------------
// deriveGateCueModel
// ---------------------------------------------------------------------------

const PR_REF = {
  repo: "example-org/launchpad",
  branch: "spec/0052",
  workdir: "/tmp/repo",
  number: 52,
  url: "https://github.com/example-org/launchpad/pull/52",
};

test("deriveGateCueModel: no gate → null", () => {
  assert.equal(deriveGateCueModel({ availableActions: [] }, []), null);
});

test("deriveGateCueModel: gate 1 → actions passed through unfiltered, no review note", () => {
  const model = deriveGateCueModel(
    { gate: "spec", availableActions: ["specApproved", "specRejected"] },
    [ev({ ts: "t0", type: "review", lines: ["irrelevant at gate 1"] })],
  );
  assert.deepEqual(model, {
    gate: "spec",
    actions: ["specApproved", "specRejected"],
    pr: undefined,
    reviewLines: null,
  });
});

test("deriveGateCueModel: gate 2 with a real PR → prApproved suppressed, review note attached", () => {
  const model = deriveGateCueModel(
    { gate: "pr", availableActions: ["prApproved", "specRejected"], pr: PR_REF },
    [ev({ ts: "t0", type: "review", lines: ["mechanical review: clean", "CI: green"] })],
  );
  assert.deepEqual(model, {
    gate: "pr",
    actions: ["specRejected"],
    pr: PR_REF,
    reviewLines: ["mechanical review: clean", "CI: green"],
  });
});

test("deriveGateCueModel: gate 2, local-diff pr (number 0) → prApproved kept", () => {
  const model = deriveGateCueModel(
    { gate: "pr", availableActions: ["prApproved", "specRejected"], pr: { ...PR_REF, number: 0 } },
    [],
  );
  assert.deepEqual(model?.actions, ["prApproved", "specRejected"]);
});

// ---------------------------------------------------------------------------
// shouldShowPlanProgress
// ---------------------------------------------------------------------------

test("shouldShowPlanProgress: coding phase with items → true", () => {
  assert.equal(shouldShowPlanProgress("coding", { checked: 2, total: 5 }), true);
});

test("shouldShowPlanProgress: coding phase, zero total → false", () => {
  assert.equal(shouldShowPlanProgress("coding", { checked: 0, total: 0 }), false);
});

test("shouldShowPlanProgress: not coding → false even with items", () => {
  assert.equal(shouldShowPlanProgress("merging", { checked: 2, total: 5 }), false);
});

test("shouldShowPlanProgress: coding phase, no planProgress at all → false", () => {
  assert.equal(shouldShowPlanProgress("coding", undefined), false);
});

// ---------------------------------------------------------------------------
// deriveStepperNodes / PIPELINE_PHASE_LABEL
// ---------------------------------------------------------------------------

test("PIPELINE_PHASE_LABEL: every phase has a non-empty label", () => {
  for (const label of Object.values(PIPELINE_PHASE_LABEL)) {
    assert.ok(label.length > 0);
  }
});

test("deriveStepperNodes: attaches the phase label to each step, preserving order/status", () => {
  const steps: RunStep[] = [
    { phase: "drafting", status: "done" },
    { phase: "awaiting_spec_approval", status: "current" },
    { phase: "coding", status: "upcoming" },
  ];
  assert.deepEqual(deriveStepperNodes(steps), [
    { phase: "drafting", status: "done", label: "Redactando" },
    { phase: "awaiting_spec_approval", status: "current", label: "Compuerta 1 · aprobación de spec" },
    { phase: "coding", status: "upcoming", label: "Programando" },
  ]);
});

test("deriveStepperNodes: empty steps → empty list", () => {
  assert.deepEqual(deriveStepperNodes([]), []);
});

// ---------------------------------------------------------------------------
// deriveExceptionGuidance + buildDiagnosisPrompt (spec 0054 increment B)
// ---------------------------------------------------------------------------

const GATE_VERB_RE = /\b(approve-spec|approve-pr|promote)\b/;

test("deriveExceptionGuidance derives the playbook entry for a known exit code", () => {
  const card: OutcomeCardModel = {
    kind: "exception",
    message: "web /api/health check failed",
    ts: "2026-07-15T00:00:00Z",
    code: 18,
  };
  const guidance = deriveExceptionGuidance(card);
  assert.equal(guidance.code, 18);
  assert.ok(guidance.title.trim().length > 0);
  assert.ok(guidance.meaning.trim().length > 0);
  assert.ok(guidance.steps.length > 0);
  assert.equal(guidance.recoverHint, true);
});

test("deriveExceptionGuidance degrades to the fallback for an unknown code, never throws", () => {
  const card: OutcomeCardModel = {
    kind: "exception",
    message: "something odd",
    ts: "2026-07-15T00:00:00Z",
    code: 999,
  };
  const guidance = deriveExceptionGuidance(card);
  assert.equal(guidance.code, 999);
  assert.ok(guidance.title.trim().length > 0);
  assert.ok(guidance.steps.length > 0);
});

test("buildDiagnosisPrompt contains the spec id, exit code, verbatim message, and the boundary sentence", () => {
  const prompt = buildDiagnosisPrompt({
    specId: "0054",
    code: 18,
    msg: "GET /api/health returned 503",
    phase: "coding",
  });
  assert.match(prompt, /0054/);
  assert.match(prompt, /\b18\b/);
  assert.match(prompt, /GET \/api\/health returned 503/);
  assert.match(prompt, /coding/);
  assert.match(prompt, /inspección de lectura/);
  assert.match(prompt, /pasos de arreglo ordenados/);
  assert.match(prompt, /humano/i);
  assert.match(prompt, /nunca apruebes, fusiones ni promuevas/i);
  assert.match(prompt, /nunca edites archivos/i);
});

test("buildDiagnosisPrompt never instructs running a CLI gate verb", () => {
  const prompt = buildDiagnosisPrompt({ specId: "0054", code: 40, msg: "diverged" });
  // The boundary sentence names the gate verbs to explain what NOT to do —
  // assert none of them appear as a bare invocation the way a step would
  // ("node scripts/... approve-spec") vs. the prohibition wording itself.
  assert.match(prompt, GATE_VERB_RE, "the boundary sentence must still name the gate verbs to forbid");
  assert.doesNotMatch(prompt, /ejecut\w*\s+`?(approve-spec|approve-pr|promote)/i);
});

test("buildDiagnosisPrompt is deterministic — same input yields an identical string", () => {
  const input = { specId: "0007", code: 14, msg: "worker died", phase: "provisioning" };
  assert.equal(buildDiagnosisPrompt(input), buildDiagnosisPrompt({ ...input }));
});

test("buildDiagnosisPrompt handles a missing phase without throwing", () => {
  const prompt = buildDiagnosisPrompt({ specId: "0007", code: 50, msg: "shell step failed" });
  assert.match(prompt, /Última fase conocida: desconocida\./);
});

// ---------------------------------------------------------------------------
// Exception guidance card model + no-side-effect proof (spec 0054 increment C)
// ---------------------------------------------------------------------------

test("deriveOutcomeCards + deriveExceptionGuidance together yield a full guidance card model for an exception event", () => {
  const events: WatcherEvent[] = [
    ev({ ts: "2026-07-15T00:00:00Z", type: "exception", code: 18, msg: "web /api/health check failed" }),
  ];
  const cards = deriveOutcomeCards(events);
  assert.equal(cards.length, 1);
  const [card] = cards;
  assert.ok(card);
  assert.equal(card.kind, "exception");
  const guidance = deriveExceptionGuidance(card);
  assert.ok(guidance.title.trim().length > 0);
  assert.ok(guidance.meaning.trim().length > 0);
  assert.ok(guidance.steps.length > 0);
});

// ---------------------------------------------------------------------------
// derivePrimaryAction (spec 0056 increment C)
// ---------------------------------------------------------------------------

test("derivePrimaryAction: no workflow (canStart true), watcher not running → start", () => {
  assert.equal(derivePrimaryAction({ canStart: true }, { running: false }), "start");
});

test("derivePrimaryAction: FAILED run (canStart true), watcher not running → start", () => {
  // Same rule the spec page's Start button uses: a closed-unsuccessful run
  // can be restarted, even if a PRIOR watcher for it once ran and exited —
  // canStart wins over any stale exited-watcher history.
  const events: WatcherEvent[] = [ev({ ts: "t0", type: "start", pid: 1, flags: ["--no-start"] })];
  assert.equal(derivePrimaryAction({ canStart: true }, { running: false }, events), "start");
});

test("derivePrimaryAction: RUNNING workflow (canStart false), no watcher ever attached → follow", () => {
  assert.equal(derivePrimaryAction({ canStart: false }, { running: false }), "follow");
});

test("derivePrimaryAction: COMPLETED workflow (canStart false), no watcher ever attached → follow", () => {
  assert.equal(derivePrimaryAction({ canStart: false }, { running: false }), "follow");
});

test("derivePrimaryAction: watcher currently running → null (already following, nothing to offer)", () => {
  assert.equal(derivePrimaryAction({ canStart: true }, { running: true, pid: 99 }), null);
  assert.equal(derivePrimaryAction({ canStart: false }, { running: true, pid: 99 }), null);
});

test("derivePrimaryAction: watcher started once and exited, canStart false → reattach", () => {
  const events: WatcherEvent[] = [ev({ ts: "t0", type: "start", pid: 1, flags: ["--no-start"] })];
  assert.equal(derivePrimaryAction({ canStart: false }, { running: false }, events), "reattach");
});

test("derivePrimaryAction: view null (Temporal unreachable) never yields start", () => {
  assert.equal(derivePrimaryAction(null, { running: false }), "follow");
  const events: WatcherEvent[] = [ev({ ts: "t0", type: "start", pid: 1, flags: ["--no-start"] })];
  assert.equal(derivePrimaryAction(null, { running: false }, events), "reattach");
  assert.equal(derivePrimaryAction(null, { running: true, pid: 1 }), null);
});

test("no-auto-start: deriving a model with canStart true sends nothing (mirrors the no-auto-spawn proof)", () => {
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch?: unknown }).fetch = () => {
    throw new Error("derivePrimaryAction must never call fetch");
  };
  try {
    assert.equal(derivePrimaryAction({ canStart: true }, { running: false }), "start");
  } finally {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// deriveRecoverOffer / deriveResumePolishedOffer (spec 0057 increment C)
// ---------------------------------------------------------------------------

const START = (ts: string): WatcherEvent => ev({ ts, type: "start", pid: 1, flags: ["--no-start", "--events"] });
const EXC = (ts: string, code: number): WatcherEvent => ev({ ts, type: "exception", code, msg: `exit ${code}` });
const POLISH = (ts: string): WatcherEvent => ev({ ts, type: "polish", msg: "polish pause" });
const DONE = (ts: string, benign = false): WatcherEvent => ev({ ts, type: "done", benign, msg: "done" });

test("deriveRecoverOffer: watcher running → null even with a recoverable exception", () => {
  const events = [START("t0"), EXC("t1", 18)];
  assert.equal(deriveRecoverOffer({ phase: "coding" }, { running: true }, events, false), null);
});

test("deriveRecoverOffer: recovering already in progress → null (no stacked remediations)", () => {
  const events = [START("t0"), EXC("t1", 18)];
  assert.equal(deriveRecoverOffer({ phase: "coding" }, { running: false }, events, true), null);
});

test("deriveRecoverOffer: (a) latest exception since last start has recoverHint true → exception-recoverable", () => {
  for (const code of [13, 14, 17, 18]) {
    const events = [START("t0"), EXC("t1", code)];
    assert.equal(
      deriveRecoverOffer({ phase: "coding" }, { running: false }, events, false),
      "exception-recoverable",
      `code ${code} should be recoverable`,
    );
  }
});

test("deriveRecoverOffer: latest exception has recoverHint false → not exception-recoverable, and (since it IS a terminal record) not silent-death either", () => {
  const events = [START("t0"), EXC("t1", 2)]; // code 2 = usage error, recoverHint false
  assert.equal(deriveRecoverOffer({ phase: "coding" }, { running: false }, events, false), null);
});

test("deriveRecoverOffer: (b) start with no terminal record after it, run still open → watcher-died-silently", () => {
  const events = [START("t0")];
  assert.equal(
    deriveRecoverOffer({ phase: "coding" }, { running: false }, events, false),
    "watcher-died-silently",
  );
});

test("deriveRecoverOffer: start followed by a benign done exit → no offer (a clean gate-park, not a silent death)", () => {
  const events = [START("t0"), DONE("t1", true)];
  assert.equal(deriveRecoverOffer({ phase: "coding" }, { running: false }, events, false), null);
});

test("deriveRecoverOffer: start followed by a polish exit → no offer here (handled by deriveResumePolishedOffer instead)", () => {
  const events = [START("t0"), POLISH("t1")];
  assert.equal(deriveRecoverOffer({ gate: "promote", phase: "awaiting_promotion" }, { running: false }, events, false), null);
});

test("deriveRecoverOffer: start with no terminal record, but the run's phase is terminal → no offer (run already closed)", () => {
  const events = [START("t0")];
  for (const phase of ["promoted", "promoted_teardown_failed", "rejected", "failed"] as const) {
    assert.equal(
      deriveRecoverOffer({ phase }, { running: false }, events, false),
      null,
      `terminal phase ${phase} should suppress the silent-death offer`,
    );
  }
});

test("deriveRecoverOffer: never started at all, view present → no offer", () => {
  assert.equal(deriveRecoverOffer({ phase: "drafting" }, { running: false }, [], false), null);
});

test("deriveRecoverOffer: (c) view null (Temporal unreachable) → temporal-unreachable (the named cut)", () => {
  assert.equal(deriveRecoverOffer(null, { running: false }, [], false), "temporal-unreachable");
});

test("deriveRecoverOffer: view null wins even with a started-but-not-yet-judged run (case (c) still applies)", () => {
  const events = [START("t0")];
  assert.equal(deriveRecoverOffer(null, { running: false }, events, false), "temporal-unreachable");
});

test("deriveRecoverOffer: order — exception-recoverable takes priority over a stale started-but-open reading", () => {
  const events = [START("t0"), EXC("t1", 14)];
  assert.equal(
    deriveRecoverOffer({ phase: "coding" }, { running: false }, events, false),
    "exception-recoverable",
  );
});

test("deriveRecoverOffer: a prior start's leftover exception is ignored once a fresh start has re-run", () => {
  const events = [START("t0"), EXC("t1", 18), START("t2")];
  // Fresh start, nothing since it yet → silent-death territory, not the old exception.
  assert.equal(
    deriveRecoverOffer({ phase: "coding" }, { running: false }, events, false),
    "watcher-died-silently",
  );
});

test("no-auto-spawn (Recover): deriving the offer — even a recoverable one — sends nothing", () => {
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch?: unknown }).fetch = () => {
    throw new Error("deriveRecoverOffer must never call fetch");
  };
  try {
    const events = [START("t0"), EXC("t1", 14)];
    assert.equal(
      deriveRecoverOffer({ phase: "coding" }, { running: false }, events, false),
      "exception-recoverable",
    );
  } finally {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  }
});

test("deriveResumePolishedOffer: watcher running → false", () => {
  const events = [START("t0"), POLISH("t1")];
  assert.equal(deriveResumePolishedOffer({ gate: "promote" }, { running: true }, events, false), false);
});

test("deriveResumePolishedOffer: recovering → false", () => {
  const events = [START("t0"), POLISH("t1")];
  assert.equal(deriveResumePolishedOffer({ gate: "promote" }, { running: false }, events, true), false);
});

test("deriveResumePolishedOffer: polish after last start, gate promote, no watcher, not recovering → true", () => {
  const events = [START("t0"), POLISH("t1")];
  assert.equal(deriveResumePolishedOffer({ gate: "promote" }, { running: false }, events, false), true);
});

test("deriveResumePolishedOffer: view null → false", () => {
  const events = [START("t0"), POLISH("t1")];
  assert.equal(deriveResumePolishedOffer(null, { running: false }, events, false), false);
});

test("deriveResumePolishedOffer: gate is not promote (already advanced) → false", () => {
  const events = [START("t0"), POLISH("t1")];
  assert.equal(deriveResumePolishedOffer({ gate: "spec" }, { running: false }, events, false), false);
  assert.equal(deriveResumePolishedOffer({}, { running: false }, events, false), false);
});

test("deriveResumePolishedOffer: a polish record from BEFORE the last start is ignored (stale prior attempt)", () => {
  const events = [POLISH("t0"), START("t1")];
  assert.equal(deriveResumePolishedOffer({ gate: "promote" }, { running: false }, events, false), false);
});

test("deriveResumePolishedOffer: never started, no polish → false", () => {
  assert.equal(deriveResumePolishedOffer({ gate: "promote" }, { running: false }, [], false), false);
});

test("no-auto-spawn (Resume polished): deriving a true offer sends nothing", () => {
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch?: unknown }).fetch = () => {
    throw new Error("deriveResumePolishedOffer must never call fetch");
  };
  try {
    const events = [START("t0"), POLISH("t1")];
    assert.equal(deriveResumePolishedOffer({ gate: "promote" }, { running: false }, events, false), true);
  } finally {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  }
});

test("exception guidance-card derivation never calls fetch/send — deriving the card and its playbook is pure (mirrors the no-auto-spawn proof)", () => {
  // The ENTIRE work RunFollowCard does to render an exception card's playbook
  // is deriveOutcomeCards + deriveExceptionGuidance — no fetch/POST fires
  // until the human clicks Diagnose in console (that click calls the
  // component's onDiagnose prop, exercised by hand in the live acceptance
  // pass; there is no DOM renderer in this test harness). Stub fetch to throw
  // so any accidental network call from derivation alone fails loudly.
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch?: unknown }).fetch = () => {
    throw new Error("exception-card derivation must never call fetch");
  };
  try {
    const events: WatcherEvent[] = [ev({ ts: "t1", type: "exception", code: 40, msg: "diverged" })];
    const [card] = deriveOutcomeCards(events);
    assert.ok(card);
    const guidance = deriveExceptionGuidance(card);
    assert.ok(guidance.steps.length > 0);
  } finally {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Spec 0212 — "promoted" means "merged" for the platform, and only there.
// ---------------------------------------------------------------------------

test("phaseLabel: a platform run that reached promoted says merged, not shipped", () => {
  // The whole point of the spec: `deployToProduction` returns immediately for a
  // self target, so this run's code is on main and is NOT running.
  assert.equal(phaseLabel("promoted", "platform"), "Fusionado a main");
  assert.equal(
    phaseLabel("promoted_teardown_failed", "platform"),
    "Fusionado a main (falló el desmontaje)",
  );
  // NOT "sin desplegar": the phase knows where the run ended, not whether a
  // human deployed afterwards. A label that is true for an hour is a liability.
  assert.ok(!phaseLabel("promoted", "platform").includes("sin desplegar"));
});

test("phaseLabel: every other project keeps 'Promovido' — their merge IS their deploy", () => {
  // An odoo.sh customer's push to main rebuilds their production. Correcting the
  // word for them would make the UI wrong in the other direction.
  assert.equal(phaseLabel("promoted", "refaccionaria-norte"), "Promovido");
  assert.equal(phaseLabel("promoted", undefined), "Promovido");
});

test("phaseLabel: a platform run that is NOT merged is labelled normally", () => {
  // The override is two phases wide, not "anything on the platform".
  assert.equal(phaseLabel("coding", "platform"), "Programando");
  assert.equal(phaseLabel("awaiting_pr_approval", "platform"), "Compuerta 2 · aprobación de PR");
});

test("phaseLabel: an unknown phase falls back to itself, never to undefined", () => {
  // `phase` is a plain string off an agent_runs column, so a legacy or future
  // value must still render SOMETHING — a blank where a word belongs is worse
  // than an ugly word, because the reader cannot tell anything is missing.
  assert.equal(phaseLabel("some_phase_from_2024", "platform"), "some_phase_from_2024");
  assert.equal(phaseLabel("", "platform"), "");
});
