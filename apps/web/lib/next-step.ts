/**
 * `deriveNextStep` (spec 0107) — "Siguiente paso": the single next action for
 * one spec, DERIVED on read from state that is already true and stored nowhere
 * (SPEC §8's projection rule — no `next_step` column, the same call spec 0104
 * made about `spec_files`).
 *
 * PURE, exactly like its siblings `derivePrimaryAction` / `deriveRecoverOffer`
 * (lib/run-follow-card.ts): no I/O, no fetch, no React — so it compiles under
 * tsconfig.test.json and is unit-tested for every branch. It consumes state the
 * CALLER already loaded and NEVER queries. In particular the caller runs the
 * Node-only `parseHumanPendingItems` (lib/specs.ts) and `deriveRecoverOffer`
 * where it has the inputs, then passes their RESULTS in here.
 *
 * This module must therefore NEVER import lib/specs.ts (it pulls in `node:fs`):
 * that would drag Node built-ins into the client bundle of any card that
 * value-imports this and break `next build` — the exact trap run-follow-card.ts
 * documents at length. Only pure modules are safe to import here.
 *
 * Rules, FIRST MATCH WINS (Scope §1; rule 0 added by spec 0220):
 *   0. question pending  → "Responder: <resumen>" (an agent is waiting on a person)
 *   1. gate open         → the gate's own action label (GATE_ACTION_LABEL)
 *   2. failed/exception  → the recover offer's copy (RECOVER_OFFER_COPY)
 *   3. `draft`, no run   → "Iniciar corrida" (spec 0104's startSpecRunAction)
 *   4. only (human) left → that item's text — but NOT for a terminal spec
 *   5. promoted/nothing  → "Nada que hacer" (honest terminal, never invented)
 *
 * Invariants the tests must pin (acceptance criteria): a pending question beats
 * even an open gate (rule 0 before rule 1 — spec 0220), a gate-parked run beats
 * a pending (human) item (rule 1 before rule 4 — the gate is the real blocker),
 * and a promoted spec yields "Nada que hacer", not its lingering (human)
 * screenshot item (rule 5's terminal guard must sit before rule 4).
 */
import { GATE_ACTION_LABEL, type GateSignal } from "./gate-actions";
import { RECOVER_OFFER_COPY, type RecoverOffer } from "./run-follow-card";

/** The kind of next step — one per rule above. */
export type NextStepKind = "question" | "gate" | "recover" | "start" | "human" | "none";

/** Already-loaded state for one spec — the caller assembles this; see the
 * module doc for why nothing here is fetched inside `deriveNextStep`. */
export interface NextStepInput {
  /**
   * The spec's `track:` frontmatter (spec 0109): **1** = authored by hand, never
   * enters the pipeline; **2** = runs through the initializer/coder/fixer loop.
   * Absent/unknown is treated as Track 1 — see Rule 3 for why it fails closed.
   */
  track?: 1 | 2;
  /** Spec `status:` frontmatter (draft | approved | in_progress | staged |
   *  promoted | rejected | …). */
  status: string;
  /** Whether any pipeline run/workflow exists for this spec. */
  hasRun: boolean;
  /** Gate actions open right now, with `suppressDuplicateApprove` already
   *  applied (empty unless the run is parked at a gate). */
  gateActions: readonly GateSignal[];
  /** Recover offer for a failed/exception run, else `null` — derived by the
   *  caller via `deriveRecoverOffer` where it has watcher + events. */
  recoverOffer: RecoverOffer;
  /** Unchecked `(human)` item texts (`parseHumanPendingItems`), else `[]`. */
  humanPending: readonly string[];
  /**
   * Spec 0220: the ACTIONABLE pending `AskUserQuestion` for this spec's project
   * — an unresolved row whose run is still live — else `null`/absent. The
   * caller resolves it (`loadPendingQuestion`); only the summary crosses over,
   * and the shape is structural on purpose: `lib/pending-questions.ts` reaches
   * the DB, and this module must stay pure and client-safe.
   */
  pendingQuestion?: { summary: string } | null;
}

/** The derived next step. `actions` carries the gate signals for a `gate` step
 * so the card can render the existing gate buttons; `href` optionally
 * deep-links to the spec detail surface. */
export interface NextStep {
  kind: NextStepKind;
  label: string;
  href?: string;
  actions?: GateSignal[];
}

/** One rendered "Siguiente paso" row (spec 0107 items 2/3): a spec's identity
 * plus its derived next step. Assembled server-side (the route joins the spec
 * list to the run projection) and passed to the card. Lives here — a pure,
 * client-safe module — so the server route and the client card share one shape.
 * `filename`/`title` are what the inline Start action needs (0104's
 * `startSpecRunAction(projectId, filename, specId, title)`). */
export interface NextStepRow {
  specId: string;
  filename: string;
  title: string;
  step: NextStep;
}

/** One row of the Launchpad home's cross-project "what needs a human" card
 * (spec 0107 item 3): a `NextStepRow` tagged with the project it belongs to,
 * since that card lists human-needing steps across ALL projects and needs a
 * project column + a link back into each project's workspace. Types-only, so
 * this module stays pure and client-safe. */
export interface HomeNextStepRow extends NextStepRow {
  projectName: string;
  projectSlug: string;
}

/** Spec statuses that are DONE. A lingering unchecked `(human)` item (e.g. this
 * spec's own screenshot check) must not resurrect a promoted/rejected spec as a
 * task — so the terminal guard sits BEFORE the human rule (acceptance
 * invariant 2). Status-string-keyed, matching `spec-status.ts`'s own
 * "promoted/rejected are terminal" note, so this module stays pure. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["promoted", "rejected"]);

/**
 * Derive the single next action for one spec, first-match-wins (see the module
 * doc's rule table). PURE: a function of the state the caller already loaded.
 */
export function deriveNextStep(input: NextStepInput): NextStep {
  const { status, hasRun, gateActions, recoverOffer, humanPending, track, pendingQuestion } = input;

  // Rule 0 (spec 0220) — an agent is parked on an AskUserQuestion. ABOVE the
  // gate, deliberately: it is the only state with a FUSE (at 15 minutes the
  // question expires, the agent proceeds alone, and nothing distinguishes that
  // from an answered one), and it blocks a turn already in flight — while a
  // gate waits indefinitely and loses nothing by waiting a little longer.
  if (pendingQuestion) {
    return { kind: "question", label: `Responder: ${pendingQuestion.summary}` };
  }

  // Rule 1 — parked at a gate. Beats a pending (human) item: the gate is the
  // real blocker (invariant 1). `actions` carries the full signal list so the
  // card renders the existing gate buttons; the label is the affirmative
  // action only ("Aprobar spec"/"Aprobar PR"/"Promover"), never "Rechazar".
  const affirmative = gateActions.find((a) => a !== "specRejected");
  if (affirmative) {
    return { kind: "gate", label: GATE_ACTION_LABEL[affirmative], actions: [...gateActions] };
  }

  // Rule 2 — a failed/exception run: reuse the Recover strip's exact copy.
  if (recoverOffer !== null) {
    return { kind: "recover", label: RECOVER_OFFER_COPY[recoverOffer] };
  }

  // Rule 3 — a spec that has never run and COULD be run: invite a start
  // (spec 0104's startSpecRunAction).
  //
  // Spec 0109 defect 2: `track` is what makes this safe. A Track-1 spec is
  // authored by hand and never enters the pipeline, so it stays `status: draft`
  // for life — without this check the card invited a pipeline run on finished,
  // merged work (specs 0104 and 0106 were both doing exactly that). An ABSENT
  // track is treated as Track 1, i.e. no invitation: failing closed costs a
  // missing button, failing open re-runs completed work.
  if (status === "draft" && !hasRun && track === 2) {
    return { kind: "start", label: "Iniciar corrida" };
  }

  // Rule 4 — only (human) items remain: surface the first one's text verbatim.
  //
  // Spec 0109 defect 1: this MUST precede the terminal guard below. It used to
  // come after, so a promoted spec with an unfinished `(human)` item reported
  // "Nada que hacer" and the item was invisible — self-demonstrating, since spec
  // 0107 shipped promoted with its own screenshot check still open and the card
  // it built could not show it. A promoted spec with nothing pending still
  // reaches "Nada que hacer" via the terminal guard or the final fallthrough.
  const [firstHuman] = humanPending;
  if (firstHuman !== undefined) {
    return { kind: "human", label: firstHuman };
  }

  // Terminal guard — promoted/rejected with nothing outstanding is done.
  if (TERMINAL_STATUSES.has(status)) {
    return { kind: "none", label: "Nada que hacer" };
  }

  // Rule 5 — nothing pending: an honest terminal state, never an invented task.
  return { kind: "none", label: "Nada que hacer" };
}
