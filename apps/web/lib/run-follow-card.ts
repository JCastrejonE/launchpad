/**
 * Pure card-model derivation for `RunFollowCard.tsx` (spec 0052 / ADR-022 §6,
 * item E) — the same "framework-free lib backs a thin JSX shell" discipline
 * as `lib/chat-cards.ts`, but with one extra constraint: this module is
 * imported DIRECTLY (as a value, not just a type) by the "use client"
 * `RunFollowCard.tsx`, because the card polls the follow route and re-derives
 * its own view model in the browser on every tick — there is no
 * "use server" boundary computing props ahead of time the way
 * `resolveSupervisorGateCard`/`deriveSpecDraftCard` do for the other
 * supervisor-console cards.
 *
 * That means this module must NEVER import `lib/pipeline.ts` (or anything
 * that does, like `lib/supervisor-run.ts`) as a VALUE — only as `import
 * type`, which TypeScript fully erases. A value import would drag
 * `@temporalio/client` into the browser bundle and break `next build`
 * (`lib/gate-actions.ts`'s doc comment is the precedent for this exact
 * failure mode; `suppressDuplicateApprove` moved there in this same item for
 * the same reason, so it's safe to reuse here as a value import).
 *
 * No I/O, no fetch, no React — compiles under `tsconfig.test.json` and runs
 * under `node --test`.
 */
import type { PipelinePhase, PullRequestRef, WatcherEvent } from "@launchpad/pipeline";
// VALUE import from the DEDICATED subpath `@launchpad/pipeline/watcher-playbook`
// (not the barrel): the playbook module is `@temporalio/client`- and
// `node:fs`-free by construction, but the package INDEX re-exports
// `activities.js` (→ `node:fs`), so a barrel value-import would drag Node
// built-ins into this client bundle and break `next build`. The subpath
// resolves straight to `dist/watcher-playbook.js`, keeping the bundle clean
// (same client-bundle discipline this module's doc comment describes;
// verified by `next build` in increment C).
import { describeWatcherExitCode, type WatcherExceptionGuidance } from "@launchpad/pipeline/watcher-playbook";
import { suppressDuplicateApprove, type GateSignal } from "./gate-actions";
import { PLATFORM_PROJECT_SLUG } from "./spec-project";
import type { PipelineGate, PlanProgress } from "./pipeline";
import type { RunStep } from "./supervisor-run";

/** Human-readable label for every lifecycle phase — the run-follow stepper's
 * own label map (deliberately separate from the spec page's coarser 4-step
 * `STEP_LABELS`: this stepper renders every `PIPELINE_PHASES` entry, not a
 * collapsed 4-step summary). */
export const PIPELINE_PHASE_LABEL: Record<PipelinePhase, string> = {
  drafting: "Redactando",
  awaiting_spec_approval: "Compuerta 1 · aprobación de spec",
  provisioning: "Aprovisionando",
  initializing: "Inicializando",
  coding: "Programando",
  awaiting_pr_approval: "Compuerta 2 · aprobación de PR",
  merging: "Fusionando",
  // Spec 0133: a BRANCH run's terminal ending — validated on staging, commits
  // on the branch; production is the branch-level promote (spec 0136).
  staged: "Staged en rama",
  awaiting_promotion: "Compuerta 3 · promoción",
  deploying: "Desplegando",
  tearing_down: "Desmontando",
  promoted: "Promovido",
  promoted_teardown_failed: "Promovido (falló el desmontaje)",
  rejected: "Rechazado",
  failed: "Fallido",
};

/**
 * Phases that mean "the change is merged" and, for the PLATFORM project only, do
 * NOT mean it is running (spec 0212).
 *
 * `deployToProduction` returns on its first line for a self target
 * (`isSelfTarget(input.target)`), and spec 0170 removed the call from the path
 * anyway — so a platform run ends AT the merge. Every other project is fine:
 * an odoo.sh customer's push to `main` genuinely is their deploy. launchpad is
 * the one project with no CD, so it is the one that needs the word corrected.
 *
 * Both phases are here on purpose. They mean the same thing to a reader, and a
 * rule that fixes one word and leaves its twin is a rule someone trips over.
 *
 * The label says only what the RUN did — "Fusionado a main". It deliberately does
 * NOT say "sin desplegar": the phase records where the run ended, and knows
 * nothing about whether a human deployed afterwards, so that claim would be true
 * for an hour and a lie thereafter. What is permanently true is the sentence in
 * PLATFORM_DEPLOY_HINT, which describes the PIPELINE rather than the world.
 */
const PLATFORM_MERGED_LABEL: Partial<Record<PipelinePhase, string>> = {
  promoted: "Fusionado a main",
  promoted_teardown_failed: "Fusionado a main (falló el desmontaje)",
};

/**
 * What still has to happen for a merged platform change to actually run.
 *
 * Deliberately temporary: spec 0213 gives the platform the staging + deploy path
 * every other project has, and replaces this sentence with a button. It lives in
 * one exported constant so that replacement is one edit, not a grep.
 */
export const PLATFORM_DEPLOY_HINT =
  "El pipeline no despliega el control plane: ese paso es aparte (scripts/deploy-control-plane.sh).";

/**
 * The label a human should read for a run's phase.
 *
 * `phase` arrives as a plain `string` — it is an `agent_runs` column, see
 * `AgentRunView.phase` — so an unrecognised value falls back to ITSELF and never
 * to `undefined`. Rendering `undefined` would replace a confusing word with a
 * blank, which is strictly worse: the reader cannot even tell something is off.
 */
export function phaseLabel(phase: string, projectSlug?: string): string {
  if (projectSlug === PLATFORM_PROJECT_SLUG) {
    const merged = PLATFORM_MERGED_LABEL[phase as PipelinePhase];
    if (merged) return merged;
  }
  return PIPELINE_PHASE_LABEL[phase as PipelinePhase] ?? phase;
}

/** Short label for the three human gates — a local copy of
 * `PIPELINE_GATE_LABEL` (lib/pipeline.ts) rather than importing it, for the
 * same bundle-safety reason as the module doc comment above. */
const GATE_SHORT_LABEL: Record<PipelineGate, string> = {
  spec: "aprobación de spec (compuerta 1)",
  pr: "aprobación de PR (compuerta 2)",
  promote: "promoción (compuerta 3)",
};

// ---------------------------------------------------------------------------
// Watcher chip
// ---------------------------------------------------------------------------

export type WatcherChipState = "idle" | "following" | "exited";

export interface WatcherChipModel {
  state: WatcherChipState;
  label: string;
  pid?: number;
}

/**
 * Derive the watcher chip (not running / following · pid / exited). `exited`
 * is distinguished from `idle` by whether the events tail ever saw a `start`
 * record — an idle spec that has never been followed shows "Sin seguir";
 * one whose watcher started and later exited (a benign gate-park, an
 * exception, or a clean done) shows "Terminó" instead, so the Follow button's
 * relabeling ("Follow" vs "Re-attach") has something to key off.
 */
export function deriveWatcherChip(
  watcher: { running: boolean; pid?: number },
  events: readonly WatcherEvent[],
): WatcherChipModel {
  if (watcher.running) {
    return {
      state: "following",
      label: watcher.pid !== undefined ? `Siguiendo · pid ${watcher.pid}` : "Siguiendo",
      pid: watcher.pid,
    };
  }
  const everStarted = events.some((e) => e.type === "start");
  return everStarted ? { state: "exited", label: "Terminó" } : { state: "idle", label: "Sin seguir" };
}

// ---------------------------------------------------------------------------
// Outcome cards (exception / polish-pause / close-out / done)
// ---------------------------------------------------------------------------

export interface OutcomeCardModel {
  kind: "exception" | "polish" | "closeout" | "done";
  message: string;
  ts: string;
  /** Only present on `exception` cards. */
  code?: number;
  /** Only present on `done` cards — true for the benign poll-cap gate-park
   * exit, false for a normal end-to-end completion. */
  benign?: boolean;
}

/**
 * Maps the events tail to the watcher's judgment-moment cards, in the same
 * order they were emitted (the tail is already bounded to
 * `EVENTS_TAIL_LIMIT`). `start`/`cue`/`review` are NOT outcome cards — `cue`
 * feeds the gate cue card, `review` feeds {@link deriveLatestReviewNote},
 * `start` only feeds the watcher chip above. Verbatim message/code — no
 * guided fixes (phase 4).
 */
export function deriveOutcomeCards(events: readonly WatcherEvent[]): OutcomeCardModel[] {
  const cards: OutcomeCardModel[] = [];
  for (const e of events) {
    switch (e.type) {
      case "exception":
        cards.push({ kind: "exception", message: e.msg, ts: e.ts, code: e.code });
        break;
      case "polish":
        cards.push({ kind: "polish", message: e.msg, ts: e.ts });
        break;
      case "closeout":
        cards.push({ kind: "closeout", message: e.msg, ts: e.ts });
        break;
      case "done":
        cards.push({ kind: "done", message: e.msg, ts: e.ts, benign: e.benign });
        break;
      default:
        break;
    }
  }
  return cards;
}

/**
 * The most recent gate-2 mechanical-review summary lines, or `null` if the
 * watcher hasn't emitted one yet. Only meaningful at gate 2 — the caller
 * decides whether to render it (`view.gate === "pr"`).
 */
export function deriveLatestReviewNote(events: readonly WatcherEvent[]): string[] | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === "review") return e.lines;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Current-activity line (spec 0052 Plan's NAMED CUT if the loop strains)
// ---------------------------------------------------------------------------

/**
 * The current-activity line: running activity names when present, else the
 * gate the run is parked at, else `null` (nothing to show — e.g. a
 * not-yet-started run, or a terminal phase). `currentActivities` is the named
 * cut candidate (see spec 0052 Plan) — this function degrades to the parked
 * gate or `null` if that field is ever dropped, never throws.
 */
export function deriveCurrentActivityLine(
  currentActivities: readonly string[] | undefined,
  gate: PipelineGate | undefined,
): string | null {
  if (currentActivities && currentActivities.length > 0) return currentActivities.join(", ");
  if (gate) return `Detenido en la ${GATE_SHORT_LABEL[gate]}`;
  return null;
}

// ---------------------------------------------------------------------------
// Gate cue model
// ---------------------------------------------------------------------------

export interface GateCueModel {
  gate: PipelineGate;
  /** Actions to render via the EXISTING `GateActionButtons` — already run
   * through `suppressDuplicateApprove` for a real GitHub PR at gate 2. */
  actions: GateSignal[];
  pr?: PullRequestRef;
  /** The watcher's latest gate-2 mechanical-review note, when present. */
  reviewLines: string[] | null;
}

/**
 * Derive the gate cue card's props from the run-follow view state — `null`
 * when the run isn't currently parked at a gate (no card to show). Reuses
 * the EXISTING `suppressDuplicateApprove` (moved to gate-actions.ts this
 * item) so gate 2 never shows a redundant in-app Approve button next to the
 * real GitHub-merge approval path.
 */
export function deriveGateCueModel(view: {
  gate?: PipelineGate;
  availableActions: GateSignal[];
  pr?: PullRequestRef;
  /** Spec 0179: a BRANCH run's gate 2 is the in-app approval, so the
   * suppression must not hide it. The rule has taken this argument since spec
   * 0142; no caller could supply it until the view carried it. */
  branch?: string;
}, events: readonly WatcherEvent[]): GateCueModel | null {
  if (!view.gate) return null;
  return {
    gate: view.gate,
    actions: suppressDuplicateApprove([...view.availableActions], view.pr, view.branch),
    pr: view.pr,
    reviewLines: view.gate === "pr" ? deriveLatestReviewNote(events) : null,
  };
}

// ---------------------------------------------------------------------------
// Plan progress
// ---------------------------------------------------------------------------

/** Whether the plan-progress line should render — only during `coding`, and
 * only once at least one plan item exists (mirrors the spec page's own
 * `planProgress.total > 0` gate). */
export function shouldShowPlanProgress(
  phase: PipelinePhase | undefined,
  planProgress: PlanProgress | undefined,
): planProgress is PlanProgress {
  return phase === "coding" && !!planProgress && planProgress.total > 0;
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

/** One rendered stepper node — phase + status + label, so the component
 * never has to re-derive the label itself. */
export interface StepperNode extends RunStep {
  label: string;
}

export function deriveStepperNodes(steps: readonly RunStep[]): StepperNode[] {
  return steps.map((s) => ({ ...s, label: PIPELINE_PHASE_LABEL[s.phase] }));
}

// ---------------------------------------------------------------------------
// Primary footer action (spec 0056 phase 4c) — pure.
// ---------------------------------------------------------------------------

/** The footer's single primary action, derived from live run state:
 *  - `start`    — the run can be started (a watched start; the new 4c path);
 *  - `follow`   — a started run with no watcher yet attached;
 *  - `reattach` — a run whose watcher started and later exited;
 *  - `null`     — nothing to offer (e.g. already following, or unknown state). */
export type PrimaryAction = "start" | "follow" | "reattach" | null;

/**
 * Derive the footer's primary action from the run's view state + watcher
 * liveness. `start` iff `view?.canStart === true` AND no watcher is running
 * (`derivePipelineState`'s `canStart`: no workflow exists, or the latest run
 * ended FAILED/TERMINATED — the SAME rule the spec page's Start button uses)
 * — this takes priority over any prior exited watcher, since `canStart` means
 * there is nothing live left to re-attach to. `view` null (Temporal
 * unreachable) NEVER yields `start` — no start affordance on unknown state.
 *
 * The follow / re-attach derivation is the EXISTING behavior, unchanged: this
 * just reuses {@link deriveWatcherChip} (running ⇒ `null`, no action needed;
 * ever-exited ⇒ `reattach`; else ⇒ `follow`) over the SAME `events` tail the
 * chip itself already derives from — `events` defaults to `[]` so existing
 * call sites that only care about `start` vs. not don't need updating.
 *
 * PURE — no fetch, no spawn: deriving this (even with `canStart` true) sends
 * nothing; only the human's Start-button click POSTs `{mode:"start"}`.
 */
export function derivePrimaryAction(
  view: { canStart?: boolean } | null,
  watcher: { running: boolean; pid?: number },
  events: readonly WatcherEvent[] = [],
): PrimaryAction {
  if (view?.canStart === true && !watcher.running) return "start";
  const chip = deriveWatcherChip(watcher, events);
  if (chip.state === "following") return null;
  if (chip.state === "exited") return "reattach";
  return "follow";
}

// ---------------------------------------------------------------------------
// Exception guidance + diagnosis prompt (spec 0054 phase 4a) — pure.
// ---------------------------------------------------------------------------

/**
 * The playbook guidance for an exception outcome card — a thin wrapper over
 * the pure `describeWatcherExitCode` (VALUE-imported from the dedicated
 * `@launchpad/pipeline/watcher-playbook` subpath — see the import comment
 * above) so the card feeds its title/meaning/ordered-steps from the exit code
 * the events tail carried. TOTAL: an unknown code degrades to the playbook
 * fallback, never throws — `describeWatcherExitCode` itself is total, this is
 * just the `OutcomeCardModel -> WatcherExceptionGuidance` plumbing.
 */
export function deriveExceptionGuidance(card: OutcomeCardModel): WatcherExceptionGuidance {
  return describeWatcherExitCode(card.code ?? -1);
}

/**
 * Compose the Diagnose-in-console handoff prompt — a PURE, deterministic NL
 * template (same input class as the human typing) sent into the EXISTING
 * `POST /api/supervisor` bridge as a visible user turn. Includes: what
 * happened (spec id, exit code + playbook title, verbatim watcher message,
 * last known phase), where to look (the run's `.preflight/supervise-<id>.out`,
 * `.events.ndjson`, `.review` paths; `docs/SUPERVISOR.md`'s exit-code table;
 * `cli status`), and the standing boundary sentence (diagnose with read-only
 * inspection; propose ordered fix steps for the HUMAN to execute; never
 * approve/merge/promote, never run the CLI gate verbs, never edit files).
 */
export function buildDiagnosisPrompt(input: {
  specId: string;
  code: number;
  msg: string;
  phase?: string;
}): string {
  const { specId, code, msg, phase } = input;
  const guidance = describeWatcherExitCode(code);
  const phaseLine = phase ? `Última fase conocida: ${phase}.` : "Última fase conocida: desconocida.";
  return [
    `El watcher del spec ${specId} terminó con la excepción de código ${code} (${guidance.title}).`,
    `Mensaje textual del watcher: "${msg}"`,
    phaseLine,
    `Dónde mirar: `
      + `.preflight/supervise-${specId}.out, .preflight/supervise-${specId}.events.ndjson, `
      + `.preflight/supervise-${specId}.review (si existe), la tabla de códigos de salida de docs/SUPERVISOR.md, `
      + `y \`node packages/pipeline/dist/cli.js status ${specId}\`.`,
    `Diagnostica sólo con inspección de lectura, y luego propón pasos de arreglo ordenados para que los `
      + `ejecute yo (el humano). Nunca apruebes, fusiones ni promuevas; nunca ejecutes los verbos de `
      + `compuerta del CLI (approve-spec / approve-pr / promote); nunca edites archivos.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Remediation offers (spec 0057 phase 4b) — PURE, no fetch, no spawn.
//
// Increment C: surfacing rules per the spec's Intent + "How it works" §6.
// Deriving an offer — even both true — sends NOTHING; only the human's
// Recover / Resume (polished) button click POSTs (the no-auto-spawn proof,
// mirroring 0052/0056). Both are `null`/`false` whenever a watcher is running
// OR a recovery is in progress (`recovering`).
// ---------------------------------------------------------------------------

/** The three reasons the Recover card surfaces, checked in this order (§6):
 *  - `exception-recoverable` — the latest exception since the last `start` has
 *    playbook `recoverHint: true` (the outage class, exit 13/14/17/18);
 *  - `watcher-died-silently` — a `start` with NO terminal judgment record
 *    (`exception`/`polish`/`done`) after it while the run is still open (a
 *    non-terminal phase): the watcher died without saying goodbye;
 *  - `temporal-unreachable` — `view` is `null` (the GET route's degraded mode):
 *    the durable layer itself needs ADR-023 step 1. This is the spec's NAMED
 *    CUT (Plan) — cut FIRST if the loop strains.
 * `null` when none apply (incl. always when a watcher runs or recovery is in
 * progress). */
export type RecoverOffer =
  | "exception-recoverable"
  | "watcher-died-silently"
  | "temporal-unreachable"
  | null;

/** Reason copy for the Recover strip — one line per {@link RecoverOffer}
 * reason (spec 0057 / ADR-023), presentation-only. Moved here out of
 * `RunFollowCard.tsx` (spec 0107) so both the card and `deriveNextStep`
 * (lib/next-step.ts) surface the SAME sentence for a failed/exception run
 * instead of restating it. */
export const RECOVER_OFFER_COPY: Record<NonNullable<RecoverOffer>, string> = {
  "exception-recoverable":
    "Esta excepción es de una clase de caída recuperable. Recover restaura la infraestructura de forma idempotente, resincroniza main y vuelve a enganchar el watcher.",
  "watcher-died-silently":
    "El proceso watcher parece haber muerto sin salir limpiamente. Recover restaura la infraestructura, resincroniza main y vuelve a enganchar el watcher.",
  "temporal-unreachable":
    "Ahora mismo no se alcanza el estado durable del pipeline. Recover restaura primero la infraestructura, luego resincroniza main y vuelve a enganchar el watcher.",
};

/** Local terminal-phase set for the "run still open" test (§6) — a local copy,
 * matching this module's `GATE_SHORT_LABEL` client-bundle discipline (never
 * value-import the pipeline barrel here). INCREMENT C uses this in
 * {@link deriveRecoverOffer}'s silent-death branch. */
const TERMINAL_PHASES: ReadonlySet<PipelinePhase> = new Set<PipelinePhase>([
  "promoted",
  "promoted_teardown_failed",
  "rejected",
  "failed",
]);

/** The events strictly after the most recent `start` record (or `[]` when the
 * run has never started) — the shared "since the last start" window both
 * derivations below key off, so a stale record from a PRIOR start (e.g. an
 * old `polish` from a prior attempt) never counts. */
function eventsSinceLastStart(events: readonly WatcherEvent[]): {
  everStarted: boolean;
  sinceStart: readonly WatcherEvent[];
} {
  const lastStartIdx = events.reduce((acc, e, i) => (e.type === "start" ? i : acc), -1);
  return {
    everStarted: lastStartIdx >= 0,
    sinceStart: lastStartIdx >= 0 ? events.slice(lastStartIdx + 1) : [],
  };
}

/**
 * INCREMENT C (§6). Derive which — if any — Recover offer the follow card
 * shows, per the ordered surfacing rules above. PURE. Returns `null` whenever
 * `watcher.running` or `recovering` is true (no stacked remediations). `view`
 * `null` is the `temporal-unreachable` case (the NAMED CUT).
 */
export function deriveRecoverOffer(
  view: { gate?: PipelineGate; phase?: PipelinePhase } | null,
  watcher: { running: boolean },
  events: readonly WatcherEvent[],
  recovering: boolean,
): RecoverOffer {
  if (watcher.running || recovering) return null;

  const { everStarted, sinceStart } = eventsSinceLastStart(events);

  // (a) exception-recoverable — the LATEST exception since the last `start`
  // has playbook `recoverHint: true` (the outage-class codes).
  const latestException = [...sinceStart].reverse().find((e) => e.type === "exception");
  if (latestException && latestException.type === "exception") {
    if (describeWatcherExitCode(latestException.code).recoverHint) return "exception-recoverable";
  }

  // (b) watcher-died-silently — a `start` with NO terminal judgment record
  // (exception/polish/done) after it, while the run is still open. A
  // non-recoverable exception (just excluded above) still counts as a
  // terminal record, so this never double-fires alongside a benign/(a)-losing
  // exception.
  const hasTerminalRecord = sinceStart.some(
    (e) => e.type === "exception" || e.type === "polish" || e.type === "done",
  );
  const runStillOpen = view !== null && !(view.phase !== undefined && TERMINAL_PHASES.has(view.phase));
  if (everStarted && !hasTerminalRecord && runStillOpen) return "watcher-died-silently";

  // (c) temporal-unreachable — the NAMED CUT (Plan).
  if (view === null) return "temporal-unreachable";

  return null;
}

/**
 * INCREMENT C (§6). True iff the Resume (polished) offer should surface: a
 * `polish` record after the last `start`, `view.gate === "promote"` (still
 * parked at gate 3), no watcher running, and not recovering. PURE.
 */
export function deriveResumePolishedOffer(
  view: { gate?: PipelineGate } | null,
  watcher: { running: boolean },
  events: readonly WatcherEvent[],
  recovering: boolean,
): boolean {
  if (watcher.running || recovering) return false;
  if (!view || view.gate !== "promote") return false;
  const { sinceStart } = eventsSinceLastStart(events);
  return sinceStart.some((e) => e.type === "polish");
}
