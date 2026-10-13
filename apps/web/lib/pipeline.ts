/**
 * Thin server-side wrapper around @temporalio/client for driving the spec
 * pipeline from apps/web (spec 0005) — start a run, signal a gate, and read
 * back enough state to render buttons/progress. Reuses the signal
 * definitions and TASK_QUEUE exported by @launchpad/pipeline; no
 * string/signal duplication between apps/web and the worker.
 *
 * Split in two halves on purpose:
 *  - derivePipelineState(): pure, no I/O, fully unit-tested (the
 *    workflow-status × spec-status matrix from the spec's acceptance
 *    criteria).
 *  - startPipeline/signalGate/describePipeline: real Temporal I/O, thin
 *    mirrors of packages/pipeline/src/cli.ts. Not unit-tested here (same as
 *    cli.ts) — needs a live Temporal server; exercised end-to-end instead.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { Client, Connection, isGrpcServiceError, WorkflowNotFoundError } from "@temporalio/client";
import type { WorkflowExecutionStatusName } from "@temporalio/client";
import {
  specPipeline,
  specApproved,
  prApproved,
  promote as promoteSignal,
  specRejected,
  pipelinePhase,
  pipelinePr,
  gate2Poll,
  gate2Attestation,
  pipelineTarget,
  pipelineBranch,
  pipelineStaging,
  decidePromoteAttestation,
  isProductionBusyPhase,
  isValidBranchName,
  type PromoteAttestation,
  TASK_QUEUE,
  SPEC_PIPELINE_WORKFLOW_TYPE,
  type PipelinePhase,
  type PipelineInput,
  type PullRequestRef,
  type Gate2PollState,
  type PipelineTarget,
  type StagingState,
  // Spec 0115 clause 4: odoo.sh's production build state, read by the promote guard.
  type OdooShBuild,
  isTerminalPhase,
  activities,
} from "@launchpad/pipeline";
import { GithubClient, type PrState } from "@launchpad/github";
import { branchByName, projectBySlug } from "@launchpad/db";
import { PLATFORM_PROJECT_SLUG } from "./spec-project";
import { validatePrModeEnv } from "./env";
import { getDb } from "./db";
import { projectSlugForSpec } from "./spec-project";
import { locateSpec } from "./spec-locate";
import { resolveRunRepoRoot, type ProjectRepoFacts } from "./run-repo";
import { GATE_ACTION_LABEL, mergeIsTheGate, suppressDuplicateApprove, type GateSignal } from "./gate-actions";
import { getThread } from "./chat-store";
import { buildTenantPipelineInput, type TenantStartArgs } from "./tenant-start";
import { branchStartRefusal } from "./branch-start";
import { selectPromoteCiArtifact, type PromoteCiConclusion } from "./promote-ci-artifact";

// Re-exported for existing callers (app/specs/[filename]/page.tsx,
// lib/chat-cards.ts, lib/chat-tools.ts) — split into lib/gate-actions.ts
// (spec 0016 item 6b, `suppressDuplicateApprove` added spec 0052 item E) so
// a "use client" file can import these without pulling this module's
// `@temporalio/client` import into the browser bundle. See that file's doc
// comment for why.
export { GATE_ACTION_LABEL, mergeIsTheGate, suppressDuplicateApprove };
export type { GateSignal };

// ---------------------------------------------------------------------------
// Pure state derivation — no network, no fs. See lib/pipeline.test.ts for the
// full workflow-status × spec-status matrix this covers.
// ---------------------------------------------------------------------------

/** Coarse pipeline state for the spec detail page and inbox column. */
export type PipelineStateKind =
  | "not_started"
  | "running"
  | "waiting_at_gate"
  | "completed"
  | "failed"
  | "promoted_teardown_failed"
  | "unknown_legacy_run";

/** Which of the three human gates the workflow is currently parked at. Only
 * meaningful when state === "waiting_at_gate". */
export type PipelineGate = "spec" | "pr" | "promote";

/** Result of describePipeline(): whether a workflow exists for this spec and,
 * if so, its Temporal execution status. */
export interface PipelineDescription {
  /** Spec 0179: the branch a BRANCH run lands on (spec 0133), read from
   * `pipelineBranch`. Absent for a per-spec run and for any run started before
   * the handler existed — and its absence is what made gate 2 unapprovable on
   * the spec page. */
  branch?: string;
  exists: boolean;
  status?: WorkflowExecutionStatusName;
  /** The workflow's TRUE position, read from the `pipelinePhase` query (spec
   * 0007). Absent for workflows started on older code that predates the query
   * handler — callers fall back to the frontmatter heuristic in that case. */
  phase?: PipelinePhase;
  /** The current PR ref, read from the `pipelinePr` query (spec 0015 item 8).
   * Absent before gate 2 opens, for local-diff-only historical runs on older
   * code, or on any query failure. */
  pr?: PullRequestRef;
  /** Last-known gate-2 approval-poll health, read from the `gate2Poll` query
   * (spec 0016). Absent for runs started before the query handler existed
   * (bootstrap note in pr-query.ts) or on any query failure — callers treat
   * that the same as healthy (see deriveGate2PollBadge). */
  gate2Poll?: Gate2PollState;
  /** Pending-activity type names off `describe().raw.pendingActivities` (spec
   * 0052 item D) — the same read `supervise.mjs` does per poll — for the
   * run-follow console's current-activity indicator. Additive + optional:
   * absent on any error or when there are none, and dropped on the named cut
   * (see spec 0052 Plan). */
  currentActivities?: string[];
  /** The run's target (self/code repo vs. tenant deploy host), read from the
   * `pipelineTarget` query (spec 0033) — the same query `/`'s "Deploying"
   * pills already use via `listRunningPipelineTargets`. Absent for a
   * pre-0033 legacy run or on any query failure; spec 0059 threads this
   * through so the run-follow card can render exactly one Hangar link
   * (tenant host card vs. app root) without guessing. */
  target?: PipelineTarget;
  /** The run's staging environment, read from the `pipelineStaging` query (spec
   * 0119). Absent for a run started before the handler existed or on any query
   * failure — which a caller must render as "nothing to show", never as a
   * fabricated environment. `{status:"none"}` is the same outcome expressed by a
   * run that legitimately has no staging (a dogfood target, or a run that has
   * not reached gate 2 yet). */
  staging?: StagingState;
}

/** Checked/total plan items, shown in place of gate buttons while the
 * workflow is in the `coding` phase (spec 0007). */
export interface PlanProgress {
  checked: number;
  total: number;
}

export interface PipelineViewState {
  /** Spec 0179: the run's branch, carried through verbatim from
   * `PipelineDescription.branch`. The gate-2 suppression rule needs it — spec
   * 0142 wrote that rule and neither call site could supply the argument. */
  branch?: string;
  state: PipelineStateKind;
  /** Set only when state === "waiting_at_gate". */
  gate?: PipelineGate;
  /** Signals valid to send right now — empty unless waiting at a gate. */
  availableActions: GateSignal[];
  /** Whether a Start button should render: true when no workflow exists yet,
   * OR (spec 0008 item 7) the latest run ended Failed/Terminated — Temporal
   * allows workflow id reuse once the prior run is closed, so a fresh
   * startPipeline() call is safe and is how a stuck/failed run recovers. */
  canStart: boolean;
  /** Set only while the workflow is in the `coding` phase (spec 0007): the
   * page shows plan progress here instead of any gate button. */
  planProgress?: PlanProgress;
  /** The workflow's current PR ref (spec 0015 item 8), carried through
   * verbatim from `PipelineDescription.pr` by `getPipelineViewState` — the
   * pure derive functions below never set this themselves. Absent before
   * gate 2 opens or when the query wasn't answered. */
  pr?: PullRequestRef;
  /** The workflow's last-known gate-2 poll health (spec 0016), carried
   * through verbatim from `PipelineDescription.gate2Poll` by
   * `getPipelineViewState` — same passthrough discipline as `pr` above. */
  gate2Poll?: Gate2PollState;
  /** The workflow's current pending-activity type names (spec 0052 item D),
   * carried through verbatim from `PipelineDescription.currentActivities` by
   * `getPipelineViewState` — same passthrough discipline as `pr`/`gate2Poll`
   * above. Feeds the run-follow console's current-activity indicator. */
  currentActivities?: string[];
  /** The workflow's TRUE phase (spec 0052 item D), carried through verbatim
   * from `PipelineDescription.phase` — same passthrough discipline as
   * `pr`/`gate2Poll`/`currentActivities` above. `state`/`gate` above are the
   * COARSE view (not_started/running/waiting_at_gate/...); `phase` is the
   * fine-grained `PipelinePhase` the run-follow stepper needs to place every
   * lifecycle step (provisioning/initializing/merging/deploying/tearing_down
   * all collapse to `state: "running"` with no other way to tell them apart).
   * Absent when the query wasn't answered (pre-0007 legacy run or any query
   * failure) — same as `PipelineDescription.phase`. */
  phase?: PipelinePhase;
  /** The run's target (spec 0059), carried through verbatim from
   * `PipelineDescription.target` by `getPipelineViewState` — same
   * passthrough discipline as `pr`/`gate2Poll`/`currentActivities`/`phase`
   * above. Feeds the run-follow card's Hangar deep-link (tenant host card
   * vs. app root). Absent for a pre-0033 legacy run or any query failure. */
  target?: PipelineTarget;
  /** The run's staging environment (spec 0119), carried through verbatim from
   * `PipelineDescription.staging` — same passthrough discipline as the fields
   * above. Feeds the workspace's staging panel via the pure
   * `deriveStagingView`. Absent for a pre-0119 run or any query failure, which
   * renders as no panel rather than an invented environment. */
  staging?: StagingState;
}

const NO_ACTIONS: PipelineViewState = {
  state: "running",
  availableActions: [],
  canStart: false,
};

/** Human-readable label for each PipelineStateKind — shared by the spec
 * detail page and the inbox's pipeline-state column so the two never drift
 * out of sync. */
export const PIPELINE_STATE_LABEL: Record<PipelineStateKind, string> = {
  not_started: "Sin empezar",
  running: "En curso",
  waiting_at_gate: "Esperando en compuerta",
  completed: "Completado",
  failed: "Fallido",
  // spec 0018: promotion itself succeeded — this is NOT a plain "Failed",
  // it's a cleanup problem on an otherwise-successful run (0020 run
  // d1bc4732 is the bare-WorkflowExecutionFailed case this label replaces).
  promoted_teardown_failed: "Promovido (falló el desmontaje)",
  unknown_legacy_run: "Desconocido (corrida antigua)",
};

/** Human-readable label for each PipelineGate — same sharing rationale as
 * PIPELINE_STATE_LABEL. */
export const PIPELINE_GATE_LABEL: Record<PipelineGate, string> = {
  spec: "aprobación de spec (compuerta 1)",
  pr: "aprobación de PR (compuerta 2)",
  promote: "promoción (compuerta 3)",
};

/** Pure formatter: renders a PipelineViewState (or null, meaning
 * getPipelineViewStateSafe couldn't reach Temporal for this row) as one
 * label string. Kept separate from the labels above and unit-tested so the
 * inbox's "must not crash, render a clear unknown state" requirement has a
 * pure function backing it rather than only being exercised in JSX. */
export function formatPipelineLabel(view: PipelineViewState | null): string {
  if (!view) return "Desconocido";
  const label = PIPELINE_STATE_LABEL[view.state];
  return view.gate ? `${label} — ${PIPELINE_GATE_LABEL[view.gate]}` : label;
}

/**
 * Combines the spec's frontmatter status with the workflow's Temporal
 * execution status to decide what to show/enable in the UI.
 *
 * Why spec status matters: a parked-at-gate workflow and an actively-working
 * workflow both report Temporal status RUNNING (Temporal has no concept of
 * "waiting on a signal" vs. "running an activity" at the execution-status
 * level — see packages/pipeline/src/workflow.ts's condition() gates). The
 * spec's frontmatter status is what actually tells us which gate (if any)
 * we're parked at: draft → gate 1, approved/in_progress → gate 2, staged →
 * gate 3. promoted/rejected are terminal spec states with no further gate.
 *
 * Never throws: an unrecognized specStatus falls through to the safe
 * default (no actions offered) rather than guessing a gate.
 */
export function derivePipelineState(
  specStatus: string,
  pipeline: PipelineDescription,
): PipelineViewState {
  if (!pipeline.exists) {
    return { state: "not_started", availableActions: [], canStart: true };
  }

  if (pipeline.status === "COMPLETED") {
    return { state: "completed", availableActions: [], canStart: false };
  }

  if (pipeline.status !== "RUNNING") {
    // FAILED | TERMINATED | CANCELLED | TIMED_OUT | CONTINUED_AS_NEW |
    // UNSPECIFIED | PAUSED | UNKNOWN — anything that isn't actively running
    // and isn't a clean completion reads as failed to the UI. Only
    // FAILED/TERMINATED offer a restart (spec 0008 item 7, acceptance
    // criterion: "Start new run" on a Failed/Terminated latest run) — the
    // other terminal-ish statuses are rare/ambiguous enough that guessing
    // it's safe to reuse the workflow id isn't worth it here.
    const canRestart = pipeline.status === "FAILED" || pipeline.status === "TERMINATED";
    return { state: "failed", availableActions: [], canStart: canRestart };
  }

  switch (specStatus) {
    case "draft":
      return {
        state: "waiting_at_gate",
        gate: "spec",
        availableActions: ["specApproved", "specRejected"],
        canStart: false,
      };
    case "approved":
    case "in_progress":
      return {
        state: "waiting_at_gate",
        gate: "pr",
        availableActions: ["prApproved", "specRejected"],
        canStart: false,
      };
    case "staged":
      return {
        state: "waiting_at_gate",
        gate: "promote",
        availableActions: ["promote", "specRejected"],
        canStart: false,
      };
    case "promoted":
    case "rejected":
    default:
      // Terminal spec state (or an unrecognized one) while the workflow is
      // still finishing up (e.g. teardown) — nothing left to gate.
      return NO_ACTIONS;
  }
}

/**
 * Derive the view state from the workflow's TRUE phase (spec 0007) — the fix
 * for the gate-integrity defect. Gate buttons render ONLY in the three
 * `awaiting_*` phases; `coding` reports plan progress instead of any button;
 * all other running phases (drafting/provisioning/initializing/merging/
 * deploying/tearing_down) show "running" with no actions.
 *
 * When `phase` is undefined, the reason matters (spec 0008 item 7 demotes
 * the old behaviour here):
 *  - The workflow isn't actually RUNNING (`isRunning` false — not started,
 *    completed, or failed/terminated): `fallback` already reflects that real
 *    status without guessing which gate we're at, so it's safe to use as-is.
 *  - The workflow IS RUNNING but the query is unavailable (pre-0007 legacy
 *    run, or any other query failure): `fallback`'s frontmatter-status guess
 *    is exactly the bug that showed an "Approve PR" button at gate 1 in run
 *    2 (see spec 0007's postmortem, restated in this spec's Scope) — a wrong
 *    guess lets a click deliver the wrong signal. Render an honest
 *    "unknown (legacy run)" state with no gate buttons instead of guessing.
 *
 * Terminal phases (spec 0009) are mapped directly, whether or not the
 * workflow is still RUNNING by Temporal's own status: `promoted`/`rejected`
 * → "completed" (nothing left to gate, no restart), `failed` → "failed"
 * (restart offered, same as a FAILED/TERMINATED Temporal status in
 * `derivePipelineState`), `promoted_teardown_failed` (spec 0018) → its own
 * state (nothing left to gate, no restart — promotion already succeeded,
 * only cleanup needs an operator's attention). This replaces the old
 * behaviour where a defined but unrecognized phase fell through to the
 * `default` case ("running", no actions) even on a closed run — the
 * `fallback` guess is never consulted
 * for a terminal phase, closed run or not.
 */
export function derivePhaseViewState(
  phase: PipelinePhase | undefined,
  isRunning: boolean,
  fallback: PipelineViewState,
  planProgress?: PlanProgress,
): PipelineViewState {
  if (phase === undefined) {
    if (isRunning) {
      return { state: "unknown_legacy_run", availableActions: [], canStart: false };
    }
    return fallback;
  }

  // A CLOSED workflow's real status always dominates a non-terminal phase.
  // Queries replay history, so runs completed before spec 0009's
  // terminal-phase code report their last recorded phase (typically
  // `tearing_down`) forever — without this guard the switch's default
  // branch showed those runs as "Running" in the inbox, and a closed run
  // reporting a gate phase would even render clickable gate buttons for a
  // workflow that can no longer receive signals (found live 2026-07-03).
  if (!isRunning && !isTerminalPhase(phase)) {
    return fallback;
  }

  switch (phase) {
    case "awaiting_spec_approval":
      return {
        state: "waiting_at_gate",
        gate: "spec",
        availableActions: ["specApproved", "specRejected"],
        canStart: false,
      };
    case "awaiting_pr_approval":
      return {
        state: "waiting_at_gate",
        gate: "pr",
        availableActions: ["prApproved", "specRejected"],
        canStart: false,
      };
    case "awaiting_promotion":
      return {
        state: "waiting_at_gate",
        gate: "promote",
        availableActions: ["promote", "specRejected"],
        canStart: false,
      };
    case "coding":
      return {
        state: "running",
        availableActions: [],
        canStart: false,
        planProgress,
      };
    case "promoted":
    case "rejected":
      return { state: "completed", availableActions: [], canStart: false };
    case "promoted_teardown_failed":
      // The run's actual goal (promotion) succeeded — only cleanup failed.
      // No restart offered: re-running the whole pipeline for a spec that
      // already promoted would be wrong (unlike plain `failed`, where a
      // fresh attempt is the right next step).
      return { state: "promoted_teardown_failed", availableActions: [], canStart: false };
    case "failed":
      return { state: "failed", availableActions: [], canStart: true };
    default:
      // drafting/provisioning/initializing/merging/deploying/tearing_down —
      // actively running, no gate to show.
      return { state: "running", availableActions: [], canStart: false };
  }
}

// ---------------------------------------------------------------------------
// Temporal I/O — real implementations, mirroring packages/pipeline/src/cli.ts.
// ---------------------------------------------------------------------------

/**
 * The workflow id for a spec (spec 0142 C).
 *
 * Every project numbers its specs from 0001, so the original `spec-<id>` made
 * two projects' spec 0001 the SAME Temporal workflow — one project's run would
 * appear on the other's page, and starting one while the other ran would be
 * refused as a duplicate. A project's runs are namespaced by slug; the platform
 * keeps the bare form, because thousands of its ids are already in Temporal's
 * history and renaming them would orphan every one.
 */
export function workflowIdFor(specId: string, projectSlug?: string): string {
  return projectSlug && projectSlug !== PLATFORM_PROJECT_SLUG
    ? `spec-${projectSlug}-${specId}`
    : `spec-${specId}`;
}

/**
 * The workflow id an EXISTING run actually has (spec 0142 C).
 *
 * The formula changed, so recomputing it would miss every run started before
 * this — including any in flight right now. `agent_runs.workflow_id` records
 * what was really used, so resolution reads that first and only falls back to
 * the formula for a run with no row yet (a start that has not reached its first
 * phase transition). Fail-soft: a DB problem must not make a gate button
 * unusable, so the formula is the fallback there too.
 */
export async function resolveWorkflowId(specId: string, projectSlug?: string): Promise<string> {
  try {
    const { projectBySlug, recordedWorkflowIdForSpec } = await import("@launchpad/db");
    const db = getDb();
    const projectId = projectSlug ? (await projectBySlug(db, projectSlug))?.id : undefined;
    const recorded = await recordedWorkflowIdForSpec(db, specId, projectId);
    if (recorded) return recorded;
  } catch (err) {
    console.warn(`[workflowId] could not resolve a recorded id for spec ${specId}:`, err);
  }
  return workflowIdFor(specId, projectSlug);
}

let clientPromise: Promise<Client> | null = null;

/** Lazily connects once per server process; resets on failure so a later
 * call retries instead of caching a broken connection forever.
 *
 * Exported since spec 0092 — `lib/agent-runs-reconcile.ts` needs the same
 * single per-process connection rather than opening a second one. */
export function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = Connection.connect({
      address: process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233",
    })
      .then((connection) => new Client({ connection }))
      .catch((err: unknown) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

/**
 * Resolve the checkout a run for `specId` should operate on (spec 0126 D).
 *
 * The spec's `tenant:` frontmatter names its project (`projectSlugForSpec`, the
 * same rule the workspace already uses to list a project's specs), so a run
 * inherits its repo from the project that owns the spec — no new parameter and
 * no new source of truth. `LAUNCHPAD_REPO_ROOT` stays the fallback, because for
 * the platform/dogfood project it genuinely IS the right checkout.
 *
 * The decision itself is `resolveRunRepoRoot` (pure, tested); this only supplies
 * the spec's tenant, the project row and the filesystem check.
 */
export interface RunTarget {
  /** Checkout the run works in — may not exist yet; the run's first activity makes it. */
  repo: string;
  /** Project identity, so the workflow can MATERIALISE that checkout (spec 0129 B).
   * Absent for a spec whose project has no control-plane row.
   *
   * Spec 0150: the workflow payload's own type, not a second copy of it. The copy
   * is how `repoRoot` came to be resolved here and dropped on the way in — the
   * shapes drifted and nothing said so. */
  project?: PipelineInput["project"];
  /** The thread that DRAFTED this spec, when the resolution found one (spec
   * 0186). It comes from the same `locateSpec(specId, projectSlug)` call that
   * resolved the project, which is the whole point: the branch and the project
   * used to be resolved by two different lookups — one scoped, one not — and a
   * new project's spec `0001` inherited sushi's branch. One lookup cannot
   * disagree with itself. */
  chatId?: string;
}

/**
 * Resolve BOTH halves a run needs: where it works, and who it belongs to.
 *
 * Returning only the path (which is what this did first) meant `startPipeline` had
 * nothing to pass as `input.project`, so `ensureCheckout` was skipped and the run
 * would try to work in a directory nothing had created. The two facts come from one
 * lookup, so they are returned together rather than resolved twice and risking
 * disagreement.
 */
export async function resolveRunTargetForSpec(
  specId: string,
  /** Spec 0142: the project the caller already knows. Without it, "0001"
   * resolves against this repo's own specs and a customer's run is aimed at
   * the platform. */
  projectSlug?: string,
): Promise<RunTarget> {
  const fallback = process.env["LAUNCHPAD_REPO_ROOT"];

  let project: ProjectRepoFacts | null = null;
  let chatId: string | null = null;
  try {
    // Spec 0135 D: one way to FIND a spec — the platform's specs are files in
    // this repo; every other project's live as spec_files rows. Before this,
    // a chat-drafted project spec was invisible to run start unless a human
    // hand-placed a file in OUR tree (the 0130 bootstrap hack).
    // Spec 0142: scoped by the caller's project when it knows one — an
    // unscoped "0001" matches this repo's own spec 0001 and aims a customer's
    // run at the platform.
    const located = await locateSpec(specId, projectSlug);
    const slug = located?.projectSlug ?? projectSlug ?? projectSlugForSpec(undefined);
    project = (await projectBySlug(getDb(), slug)) ?? null;
    // Spec 0186: the drafting chat rides along with the project it was resolved
    // WITH, instead of being looked up again by spec id alone.
    chatId = located?.chatId ?? null;
  } catch (err) {
    // A DB or specs-directory failure must not block the platform's own runs: fall
    // through with no project, which resolves to the fallback checkout.
    //
    // But it must not be SILENT. A swallowed error here sends a run at the
    // launchpad's own repo while looking like a deliberate platform run — which is
    // exactly what happened on the first live A/B attempt, and cost an hour to
    // locate because nothing recorded why `project` was null.
    console.error(
      `[startPipeline] spec ${specId}: project lookup FAILED, falling back to LAUNCHPAD_REPO_ROOT —`,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
    project = null;
  }

  const resolved = resolveRunRepoRoot(project, fallback);
  if (!resolved.ok) throw new Error(resolved.problem);

  // Spec 0129 B: a checkout that does NOT exist yet is normal now — the run's first
  // activity clones it. Only refuse a path that exists and is not a git checkout,
  // which is a genuinely broken state no clone would repair.
  if (existsSync(resolved.root) && !existsSync(join(resolved.root, ".git"))) {
    throw new Error(
      `${resolved.root} existe pero no es un repositorio git. Bórralo o corrige repo_root del proyecto.`,
    );
  }
  // One line per run start, so "which repo did this run use, and why" is answerable
  // from the journal instead of from Temporal history and four guesses.
  console.log(
    `[startPipeline] spec ${specId}: repo=${resolved.root} project=${project?.slug ?? "none"} ` +
      `fromFallback=${resolved.fromFallback}`,
  );
  return {
    repo: resolved.root,
    ...(chatId ? { chatId } : {}),
    ...(project
      ? {
          project: {
            slug: project.slug,
            repoOwner: project.repoOwner,
            repoName: project.repoName,
            kind: (project as { kind?: string | null }).kind ?? null,
            // Spec 0150: the root THIS function already resolved. `ensureCheckout`
            // re-derived it from owner/name alone and refused the platform, whose
            // checkout is the deployed repo and has no clone URL. Passing the
            // resolved root means the run's first activity confirms the checkout it
            // was aimed at instead of guessing at a second one.
            repoRoot: resolved.root,
          },
        }
      : {}),
  };
}

/**
 * The branch a DRAFTING CHAT is bound to, or undefined (spec 0135).
 *
 * Spec 0186: the chat id is now the caller's, resolved by the same scoped
 * `locateSpec` that resolved the project. It used to be found here from the spec
 * id alone (`specFileBySpecId(db, specId)`, no project) — and since every
 * project numbers its specs from 0001, `autopartes`'s spec 0001 resolved to
 * sushi's row and its run was refused for a branch it had never named.
 */
async function branchOfChat(chatId: string): Promise<string | undefined> {
  try {
    const thread = await getThread(chatId);
    return thread.ok ? (thread.data?.branch ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/** Starts a new spec pipeline run. specId must match an existing spec file's
 * frontmatter id (see @launchpad/pipeline's store.ts) once the workflow's
 * draftSpec activity runs. The checkout comes from the spec's PROJECT
 * (spec 0126 D), falling back to LAUNCHPAD_REPO_ROOT.
 *
 * `opts.branch` (spec 0133) makes this a BRANCH run: commits land on that
 * branch, the branch's one PR accumulates them, and the run ends `staged`.
 * Absent an explicit branch, a spec drafted in a branch-bound chat derives
 * its branch from that chat (spec 0135). The refusal ladder lives HERE and
 * only here — routes and actions forward (the four-disagreeing-starters
 * lesson, spec 0131). */
export async function startPipeline(
  specId: string,
  request: string,
  requestedBy: string,
  opts: { branch?: string; projectSlug?: string } = {},
): Promise<void> {
  // Spec 0142: the caller's project scopes the spec lookup; spec ids are only
  // unique WITHIN a project.
  const runTarget = await resolveRunTargetForSpec(specId, opts.projectSlug);
  // Spec 0135: a spec drafted in a branch-bound chat runs on THAT branch no
  // matter which button starts it — the spec row carries its drafting chat,
  // the chat carries its branch. An explicit opts.branch (0133's plumbing)
  // still wins, as the deliberate override.
  const derived =
    !opts.branch && runTarget.project && runTarget.chatId
      ? await branchOfChat(runTarget.chatId)
      : undefined;
  const branch = opts.branch ?? derived;
  // Spec 0186 C: which of the three cases this run took. Without it, "no branch"
  // and "the chat's branch" look identical in the log, and a project run that
  // silently became a per-spec run is invisible (VERIFICATION #9).
  console.log(
    `[startPipeline] spec ${specId}: branch=${branch ?? "none"} ` +
      `source=${opts.branch ? "explicit" : derived ? "chat" : "none"}`,
  );
  if (branch) {
    const project = runTarget.project
      ? await projectBySlug(getDb(), runTarget.project.slug)
      : null;
    const row = project ? await branchByName(getDb(), project.id, branch) : null;
    const refusal = branchStartRefusal({
      branch,
      validName: isValidBranchName(branch),
      project: runTarget.project
        ? { slug: runTarget.project.slug, kind: runTarget.project.kind ?? null }
        : null,
      row: row ? { mergedAt: row.mergedAt } : null,
      inFlightSpecId: await findRunningBranchRun(runTarget.repo, branch),
      derived: !opts.branch,
    });
    if (refusal) throw new Error(refusal);
  }
  const client = await getClient();
  // The TYPE NAME as a string, never the function: this bundle is minified in
  // production, where `specPipeline.name` is `"P"`. See
  // SPEC_PIPELINE_WORKFLOW_TYPE — this is the exact line that took production's
  // worker into a retry loop for hours.
  await client.workflow.start<typeof specPipeline>(SPEC_PIPELINE_WORKFLOW_TYPE, {
    taskQueue: TASK_QUEUE,
    // Spec 0142 C: namespaced by the project, so two projects' spec 0001 are
    // two workflows rather than a collision.
    workflowId: workflowIdFor(specId, runTarget.project?.slug),
    args: [
      {
        specId,
        target: { kind: "self", repo: runTarget.repo },
        request,
        requestedBy,
        // Spec 0129 B: without this the workflow skips ensureCheckout and the run
        // works in a directory nothing created.
        ...(runTarget.project ? { project: runTarget.project } : {}),
        // Spec 0133: the branch this run lands its commits on.
        ...(branch ? { branch } : {}),
      },
    ],
  });
}

/** Starts a new TENANT pipeline run (spec 0027) — the UI-driven equivalent of
 * `cli start-tenant`. Same task queue and `spec-<id>` workflow id as
 * `startPipeline`; the only difference is the target
 * (`{ kind: "tenant", ... }`), built by the shared, unit-tested
 * `buildTenantPipelineInput` so the CLI and UI paths never drift.
 *
 * `repo` stays LAUNCHPAD_REPO_ROOT and deliberately does NOT go through
 * `resolveRunTargetForSpec` (spec 0126 D / 0129 B). The distinction is real: a tenant
 * deploy run executes OUR `infra/tenant/` templates and reads a tenant-deploy
 * spec that lives in THIS repo's `specs/`, so the launchpad checkout is the
 * correct target. A code pipeline run works on the project's own code, which is
 * why only `startPipeline` resolves per project. Routing this path through the
 * project would refuse a deploy for any tenant whose project has a linked repo
 * but no local clone — a run that works today and has no need of that clone.
 * Real Temporal I/O — not unit-tested here (same rationale as `startPipeline`);
 * exercised end-to-end. The server action (app/fleet/actions.ts) is the only
 * caller and is responsible for the server-side sandbox re-check FIRST. */
export async function startTenantPipeline(
  specId: string,
  request: string,
  requestedBy: string,
  args: TenantStartArgs,
): Promise<void> {
  const repo = process.env["LAUNCHPAD_REPO_ROOT"];
  if (!repo) throw new Error("LAUNCHPAD_REPO_ROOT not set");
  const input = buildTenantPipelineInput(specId, request, requestedBy, repo, args);
  const client = await getClient();
  // Same minification hazard as `startPipeline` — and this call site has carried it
  // since the app was first deployed with a production build (spec 0125), so a
  // tenant deploy started from the Hangar form has never reached a worker there.
  await client.workflow.start<typeof specPipeline>(SPEC_PIPELINE_WORKFLOW_TYPE, {
    taskQueue: TASK_QUEUE,
    workflowId: workflowIdFor(specId),
    args: [input],
  });
}

/** The slice of `Client` that `signalGate` actually needs — narrow on
 * purpose so tests can pass a fake without implementing the whole
 * `@temporalio/client` surface (the seam spec 0008 item 6 asks for). */
export type SignalClient = Pick<Client, "workflow">;

/** Sends one of the four gate signals to a running pipeline. `reason` is
 * only used for specRejected (the workflow's own signal payload requires
 * one); callers that don't collect a reason from the user can rely on the
 * default.
 *
 * Diagnosis (spec 0008 item 6): a bare `handle.signal(...)` with no run id
 * resolves to whichever execution is "current" for this workflow id. When
 * that execution isn't actually RUNNING (its latest run already went
 * Failed/Terminated/Completed — e.g. the id got reused after a prior failed
 * run, or the click landed on a stale page render), the server rejects the
 * signal with a low-level, easy-to-miss gRPC error, and upstream that read
 * like "the click never signaled the workflow". `describe()` first so we can
 * throw one clear, named error the UI's error banner can show verbatim
 * instead of a raw NOT_FOUND/invalid-argument message. `clientOverride` is
 * the test seam — omit it in real callers to use the lazily-connected
 * singleton. */
export async function signalGate(
  specId: string,
  gate: GateSignal,
  actor: string,
  reason = "Rejected via web UI",
  clientOverride?: SignalClient,
  /** Spec 0142 C: the project whose spec this is. Ids are namespaced by slug,
   * so a caller that knows the project resolves unambiguously; without it the
   * recorded-id lookup still finds a unique run, and only a genuinely ambiguous
   * spec number falls back to the legacy `spec-<id>`. */
  projectSlug?: string,
): Promise<void> {
  const client = clientOverride ?? (await getClient());
  const handle = client.workflow.getHandle(await resolveWorkflowId(specId, projectSlug));
  const description = await handle.describe();
  if (description.status.name !== "RUNNING") {
    throw new Error(
      `spec ${specId}: workflow is not running (status: ${description.status.name}) — ` +
        `cannot deliver "${gate}". The latest run may have already finished; ` +
        `check the spec page for a "Start new run" option.`,
    );
  }
  switch (gate) {
    case "specApproved":
      await handle.signal(specApproved, { approvedBy: actor });
      return;
    case "prApproved": {
      // Spec 0118: approving a change RECORDS what was approved — the PR head
      // reviewed and the main tip it was reviewed against. Resolved here, at the
      // moment of the human's judgment, because that is the only moment the answer
      // is true; asking later is asking a different question. Both SHAs or neither
      // (see resolveGate2Attestation) — a half attestation reads as checked.
      let approvedPr: PullRequestRef | undefined;
      try {
        approvedPr = await handle.query(pipelinePr);
      } catch {
        // Pre-0015 run with no handler — no PR ref, so no attestation. The guard
        // warns rather than blocks, which is the right answer for a legacy run.
      }
      const attestation = resolveGate2Attestation(
        approvedPr,
        approvedPr?.repoRoot ?? approvedPr?.workdir ?? process.env["LAUNCHPAD_REPO_ROOT"],
      );
      await handle.signal(prApproved, { approvedBy: actor, ...(attestation ?? {}) });
      return;
    }
    case "promote":
      await handle.signal(promoteSignal, { promotedBy: actor });
      return;
    case "specRejected":
      await handle.signal(specRejected, { rejectedBy: actor, reason });
      return;
  }
}

/** Describes a spec's pipeline workflow. Never throws for "doesn't exist" —
 * that's the expected shape for a spec that hasn't been started yet.
 * `clientOverride` is the test seam (same rationale/type as `signalGate`'s) —
 * omit it in real callers to use the lazily-connected singleton. */
export async function describePipeline(
  specId: string,
  clientOverride?: SignalClient,
  /** Spec 0142 C: the project whose spec this is. Ids are namespaced by slug,
   * so a caller that knows the project resolves unambiguously; without it the
   * recorded-id lookup still finds a unique run, and only a genuinely ambiguous
   * spec number falls back to the legacy `spec-<id>`. */
  projectSlug?: string,
): Promise<PipelineDescription> {
  const client = clientOverride ?? (await getClient());
  try {
    const handle = client.workflow.getHandle(await resolveWorkflowId(specId, projectSlug));
    const description = await handle.describe();
    // Best-effort: workflows started before spec 0007's query handler existed
    // (or any other query failure, e.g. a not-yet-RUNNING execution) simply
    // report no phase — callers fall back to the frontmatter heuristic.
    const phase = await handle.query(pipelinePhase).catch(() => undefined);
    const pr = await handle.query(pipelinePr).catch(() => undefined);
    const gate2PollState = await handle.query(gate2Poll).catch(() => undefined);
    // Same read supervise.mjs's readState() does per poll: pending-activity
    // type names off the raw describe() response (spec 0052 item D). Absent
    // (undefined, never []) when there are none or the field is missing, so
    // callers can tell "no activities reported" from "none pending" the same
    // way pr/gate2Poll are only set when present.
    const currentActivities = (description.raw?.pendingActivities ?? [])
      .map((p) => p.activityType?.name)
      .filter((name): name is string => typeof name === "string");
    // Spec 0059: same degrade-to-absent rule as the three queries above —
    // a pre-0033 legacy run with no `pipelineTarget` handler, or any other
    // query failure, simply yields no target (and therefore no Hangar
    // deep-link) rather than an error.
    const target = await handle.query(pipelineTarget).catch(() => undefined);
    // Spec 0119, same rule again: a run started before this handler existed
    // yields no staging rather than an error, and the panel renders nothing.
    const staging = await handle.query(pipelineStaging).catch(() => undefined);
    // Spec 0179, same rule again. Without this the spec page could not tell a
    // BRANCH run from a per-spec one, so `suppressDuplicateApprove` hid gate 2's
    // approve on every branch run that had a PR — leaving a page that offers
    // only Reject at the gate it names. Spec 0142 already taught the rule about
    // branch runs; this is the argument it needed and never got.
    const branch = (await handle.query(pipelineBranch).catch(() => undefined)) || undefined;
    return {
      exists: true,
      status: description.status.name,
      phase,
      pr,
      gate2Poll: gate2PollState,
      ...(branch ? { branch } : {}),
      ...(currentActivities.length ? { currentActivities } : {}),
      ...(target ? { target } : {}),
      ...(staging ? { staging } : {}),
    };
  } catch (err) {
    // @temporalio/client's WorkflowHandle.describe() catches the raw gRPC
    // NOT_FOUND (code 5) itself and re-throws it as a WorkflowNotFoundError
    // (see workflow-client.js's _errorMappingInterceptor) — by the time it
    // reaches us the original ServiceError is already gone, so checking
    // isGrpcServiceError(err).code === 5 here never matches and every
    // no-workflow-yet spec 500s instead of rendering "not started" (found by
    // hitting a genuinely un-started spec end-to-end — see spec 0005's
    // Handoff log). Match WorkflowNotFoundError directly; keep the raw
    // gRPC check too in case some other call path surfaces the
    // untransformed error.
    if (err instanceof WorkflowNotFoundError || (isGrpcServiceError(err) && err.code === 5)) {
      return { exists: false };
    }
    throw err;
  }
}

/** Convenience: describe + derive in one call, for pages that just want the
 * view state and don't care about the raw Temporal description. `planProgress`
 * is optional (callers like the inbox list, which don't have a spec's raw
 * markdown handy, simply omit it) and is only surfaced when the workflow is
 * actually in the `coding` phase — see derivePhaseViewState. */
export async function getPipelineViewState(
  specId: string,
  specStatus: string,
  planProgress?: PlanProgress,
  clientOverride?: SignalClient,
  /** Spec 0149: the project whose spec this is. Workflow ids are namespaced by
   * slug (0142 C), so the ONE spec page — which serves every project — must say
   * which project's `0003` it is asking about. */
  projectSlug?: string,
): Promise<PipelineViewState> {
  const pipeline = await describePipeline(specId, clientOverride, projectSlug);
  const fallback = derivePipelineState(specStatus, pipeline);
  const view = derivePhaseViewState(pipeline.phase, pipeline.status === "RUNNING", fallback, planProgress);
  return {
    ...view,
    ...(pipeline.pr ? { pr: pipeline.pr } : {}),
    ...(pipeline.gate2Poll ? { gate2Poll: pipeline.gate2Poll } : {}),
    ...(pipeline.currentActivities ? { currentActivities: pipeline.currentActivities } : {}),
    ...(pipeline.phase ? { phase: pipeline.phase } : {}),
    ...(pipeline.target ? { target: pipeline.target } : {}),
    ...(pipeline.staging ? { staging: pipeline.staging } : {}),
    // Spec 0179: passthrough, same discipline as every field above.
    ...(pipeline.branch ? { branch: pipeline.branch } : {}),
  };
}

/** Same as getPipelineViewState, but never throws — for the spec inbox,
 * which renders one row per spec and must not take the whole page down if
 * Temporal is unreachable for a single row (or any other describePipeline
 * failure that isn't the expected "no workflow yet" case). Returns null on
 * failure; pair with formatPipelineLabel(null) → "Unknown" to render a clear
 * per-row error state instead of crashing.
 *
 * `planProgress` mirrors getPipelineViewState's own signature (spec 0042 item
 * D) — the spec-detail page's MAIN render path used to call the unsafe
 * variant specifically because this one dropped `planProgress` on the floor;
 * now both take it, so a Temporal outage degrades that page instead of
 * 500ing it. `null` here means specifically "live state source is down" —
 * the expected "no workflow yet" case already returns a non-null "not
 * started" view via describePipeline's NOT_FOUND handling. `clientOverride`
 * is the test seam, forwarded unchanged. */
export async function getPipelineViewStateSafe(
  specId: string,
  specStatus: string,
  planProgress?: PlanProgress,
  clientOverride?: SignalClient,
  /** Spec 0149: see `getPipelineViewState`. */
  projectSlug?: string,
): Promise<PipelineViewState | null> {
  try {
    return await getPipelineViewState(specId, specStatus, planProgress, clientOverride, projectSlug);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Spec 0033 Scope A — locate RUNNING deploys to their target host.
//
// /fleet needs, per host, the spec id(s) currently deploying into it.
// `listRunningPipelineTargets` lists RUNNING `specPipeline` executions via
// Temporal visibility and queries each for `pipelineTarget`, returning the
// spec id + target host id per run. NEVER throws — a visibility/query outage
// yields an empty list so the page still renders (spec 0033 Scope A). The
// by-host indexing + card wiring live in lib/fleet.ts.
// ---------------------------------------------------------------------------

/** A RUNNING deploy located to its host: spec id + the VPS id its target names
 * (absent for a `launchpad` run, which targets no host). */
export interface RunningPipelineTarget {
  specId: string;
  vpsId?: number;
}

/** Pure: the host id a target names, or `undefined` for a `launchpad` target
 * (no host). Keeps the `PipelineTarget` discriminant in one place. */
export function targetVpsId(target: PipelineTarget): number | undefined {
  return target.kind === "tenant" ? target.vpsId : undefined;
}

/**
 * Lists RUNNING `specPipeline` deploys with their target host id (spec 0033
 * Scope A). NEVER throws — returns `[]` on any visibility/query failure
 * (Temporal unreachable, or the visibility list itself erroring), and a
 * single run's query failure (e.g. a run started on a pre-0033 snapshot with
 * no `pipelineTarget` handler yet) only drops that one run rather than
 * blanking the whole list.
 */
/**
 * The spec id inside a workflow id — its LAST segment (spec 0156).
 *
 * `spec-0147` (platform) and `spec-ab-test-sandbox-0003` (every other project,
 * spec 0142 C) both END in the spec id, so the last segment is right for both.
 * `workflowId.replace(/^spec-/, "")` is not: on a namespaced id it yields
 * `<slug>-<id>`, which is not a spec id anywhere.
 *
 * This exists as ONE function because the mistake has now been made four times
 * in four files. `listRunningPipelineTargets` documented the rule in a comment
 * in spec 0142 and three other call sites kept the broken form — a comment is
 * not a control.
 */
export function specIdFromWorkflowId(workflowId: string): string {
  return workflowId.split("-").pop() || workflowId;
}

/**
 * The spec id inside a workflow id, for THIS project — or null (spec 0153).
 *
 * Pure, and the exact inverse of `workflowIdFor`: the platform's runs are
 * `spec-<id>`, every other project's are `spec-<slug>-<id>` (spec 0142 C). The
 * scoping is the point — without it, the platform's `spec-0003` would read as
 * a customer's `0003` and hide a button on the wrong project.
 *
 * Legacy caveat, stated rather than papered over: a project run started BEFORE
 * 0142 is `spec-<id>` with no slug, so it reads as the platform's. Those runs
 * are all closed; a closed run is not in the RUNNING list this feeds.
 */
export function specIdForProjectWorkflowId(
  workflowId: string,
  projectSlug: string,
): string | null {
  const prefix =
    projectSlug === PLATFORM_PROJECT_SLUG ? "spec-" : `spec-${projectSlug}-`;
  if (!workflowId.startsWith(prefix)) return null;
  const rest = workflowId.slice(prefix.length);
  return /^\d+$/.test(rest) ? rest : null;
}

/**
 * Spec ids with a RUNNING pipeline workflow in this project (spec 0153).
 *
 * ONE visibility query for the whole list — deliberately not
 * `listRunningPipelineTargets`, which additionally queries every execution for
 * its target host and would turn a spec list into N round trips.
 *
 * NEVER throws, and fails OPEN (empty set): Temporal being unreachable must not
 * hide a Start button that would have worked. The refusal behind the button is
 * the real guard (spec 0152 made it legible); this only stops the user walking
 * into it.
 */
export async function listRunningSpecIds(projectSlug: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const client = await getClient();
    const executions = client.workflow.list({
      query: `WorkflowType="${SPEC_PIPELINE_WORKFLOW_TYPE}" AND ExecutionStatus="Running"`,
    });
    for await (const execution of executions) {
      const specId = specIdForProjectWorkflowId(execution.workflowId, projectSlug);
      if (specId) ids.add(specId);
    }
  } catch {
    return new Set();
  }
  return ids;
}

export async function listRunningPipelineTargets(): Promise<RunningPipelineTarget[]> {
  const targets: RunningPipelineTarget[] = [];
  try {
    const client = await getClient();
    const executions = client.workflow.list({
      query: `WorkflowType="specPipeline" AND ExecutionStatus="Running"`,
    });
    for await (const execution of executions) {
      try {
        const handle = client.workflow.getHandle(execution.workflowId, execution.runId);
        const target = await handle.query(pipelineTarget);
        // Spec 0142 C / 0156: the LAST segment — see `specIdFromWorkflowId`.
        const specId = specIdFromWorkflowId(execution.workflowId);
        targets.push({ specId, vpsId: targetVpsId(target) });
      } catch {
        // Per-run query failure — skip this one run, never let it blank the
        // rest of the list.
      }
    }
  } catch {
    // Visibility list itself unreachable (Temporal down, bad query, etc.) —
    // degrade to empty so /fleet still renders (spec 0033 Scope A).
    return [];
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Live PR check/review state (spec 0015 item 8) — apps/web's own GithubClient
// call, separate from the pipeline worker's. Never throws: a spec page must
// render even when GITHUB_TOKEN is unset or GitHub is briefly unreachable —
// callers get a typed "why unavailable" reason instead of a crash.
// ---------------------------------------------------------------------------

export type PrLiveStateResult =
  | { available: true; state: PrState }
  | { available: false; reason: "no_token" | "unparseable_repo" | "fetch_failed" };

/** Test seam for getPrLiveState — same injectable-`createGithubClient`
 * discipline as the pipeline's own OpenPullRequestDeps/AwaitPrApprovalDeps/
 * MergePullRequestDeps, so a fake client can stand in without a real
 * GithubClient/fetch/network. Defaults to a real `GithubClient`. */
export interface GetPrLiveStateDeps {
  createGithubClient: (config: {
    token: string;
    owner: string;
    repo: string;
  }) => Pick<GithubClient, "getPrState">;
}

const defaultGetPrLiveStateDeps: GetPrLiveStateDeps = {
  createGithubClient: (config) => new GithubClient(config),
};

/**
 * Fetches live check/review state for a real GitHub PR via `GithubClient`
 * (spec 0015 item 8). Callers must only call this for a real GitHub PR ref
 * (`pr.number > 0`) — local-diff refs have no remote to query.
 *
 * GITHUB_TOKEN is validated here (via `validatePrModeEnv`), NOT folded into
 * `validateWebEnv`'s page-wide gate: most specs may still be running
 * local-diff, so the token is only ever required once a spec's gate 2 is
 * actually a GitHub PR.
 */
export async function getPrLiveState(
  pr: PullRequestRef,
  env: Record<string, string | undefined> = process.env,
  deps: GetPrLiveStateDeps = defaultGetPrLiveStateDeps,
): Promise<PrLiveStateResult> {
  const envCheck = validatePrModeEnv(env);
  if (!envCheck.ok) return { available: false, reason: "no_token" };
  const ownerRepo = activities.parseOwnerRepo(pr.repo);
  if (!ownerRepo) return { available: false, reason: "unparseable_repo" };
  try {
    // Non-null assertion is safe: validatePrModeEnv(env).ok above guarantees
    // GITHUB_TOKEN is present and non-blank.
    const client = deps.createGithubClient({
      token: env["GITHUB_TOKEN"]!,
      owner: ownerRepo.owner,
      repo: ownerRepo.repo,
    });
    const state = await client.getPrState(pr.number);
    return { available: true, state };
  } catch {
    return { available: false, reason: "fetch_failed" };
  }
}

// ---------------------------------------------------------------------------
// Promote / gate-3 CI guard (spec 0043, source swapped to local CI by spec
// 0058 / ADR-024, made TOKEN-LESS by spec 0063) — does the current
// `origin/main` tip have a recorded local-CI verdict for this spec? Separate
// from getPrLiveState above (which reads the PR branch head's checks for
// gate 2): by gate 3 the PR is merged, and the thing actually being promoted
// is `main`, not the (often-deleted) PR branch. Same never-throws,
// typed-reason discipline as getPrLiveState so a spec page or server action
// can render/guard without risking a crash.
//
// GitHub Actions is retired as the CI source (0 workflow runs are ever
// created for this account now — see spec 0058's Intent). Spec 0063 removes
// the GitHub round-trip entirely: a polish relaunch's fresh process never
// runs gate 2, so there is no cached branch-head SHA to resolve a merge
// commit from, and neither the watcher nor the web server carries a
// GITHUB_TOKEN either way. Instead of locating the artifact by merge SHA,
// this lists every `.preflight/promote-ci-*.json` candidate and selects by
// the artifact's own `specId` + `evaluatedSha` (./promote-ci-artifact.ts's
// `selectPromoteCiArtifact` is the shared contract with the writer in
// scripts/supervise.mjs) — trusting only an artifact whose CI run actually
// evaluated the CURRENT `origin/main` tip. There is no local "pending": the
// artifact's absence (or staleness) is the pending/not-yet-reported state,
// surfaced as the allow-with-note `no_local_ci` reason below — never a hard
// block.
// ---------------------------------------------------------------------------

export type PromoteCiResult =
  | { available: true; conclusion: PromoteCiConclusion }
  | {
      available: false;
      reason:
        | "no_token"
        | "local_diff"
        | "unparseable_repo"
        | "no_merge_commit"
        | "fetch_failed"
        | "no_local_ci";
    };

/** Test seam for getPromoteCiState (spec 0063: token-less, no GitHub client
 * involved). `listPromoteCiArtifacts` returns the raw contents of every
 * `.preflight/promote-ci-*.json` candidate (tolerant: `[]` on any read
 * error); `resolveOriginMainSha` runs the local, no-fetch
 * `git rev-parse origin/main` (tolerant: `null` on any error) — same
 * discipline as supervisor-run.ts's `defaultReadEventsFile`, so tests never
 * touch the real filesystem or spawn a process. */
export interface GetPromoteCiStateDeps {
  listPromoteCiArtifacts: (repoRoot: string) => string[];
  resolveOriginMainSha: (repoRoot: string) => string | null;
}

function defaultListPromoteCiArtifacts(repoRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(`${repoRoot}/.preflight`);
  } catch {
    return [];
  }
  const raws: string[] = [];
  for (const name of names) {
    if (!name.startsWith("promote-ci-") || !name.endsWith(".json")) continue;
    try {
      raws.push(readFileSync(`${repoRoot}/.preflight/${name}`, "utf8"));
    } catch {
      // Skip a file that vanished between the listing and the read.
    }
  }
  return raws;
}

function defaultResolveOriginMainSha(repoRoot: string): string | null {
  try {
    return execSync("git rev-parse origin/main", {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Resolve any ref to a SHA in `repoRoot` (spec 0118) — the generalization of
 * `defaultResolveOriginMainSha`, used for a spec branch's tip as well as `main`.
 *
 * Refs are validated against a conservative shape before reaching the shell,
 * because unlike the hard-coded `origin/main` above, this one takes a caller's
 * string. Only characters git refs legitimately use are allowed; a `;` or a space
 * can never reach the command line.
 *
 * `null` on anything unresolvable — an unknown ref is a normal answer here (the
 * branch may be gone after a merge), not an error worth throwing at a gate.
 */
const SAFE_REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

export function resolveRefSha(repoRoot: string, ref: string): string | null {
  if (!SAFE_REF_RE.test(ref)) return null;
  try {
    const sha = execSync(`git rev-parse --verify --quiet ${ref}^{commit}`, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * The two SHAs gate 2 attests to (spec 0118): the PR head being approved, and the
 * `main` tip it was tested against.
 *
 * Read from the LOCAL checkout via `origin/<branch>` rather than the GitHub API —
 * the same token-less choice spec 0063 made for the CI signal. `git fetch` runs on
 * every pipeline step, so `origin/*` tracks the remote, and this works today with no
 * credentials for either repo.
 *
 * Returns `undefined` when either SHA is unresolvable rather than a partial record:
 * a half attestation is worse than none, because the guard would compare the half it
 * has and pass — which reads as "checked".
 */
export function resolveGate2Attestation(
  pr: PullRequestRef | undefined,
  repoRoot: string | undefined,
  resolve: (repoRoot: string, ref: string) => string | null = resolveRefSha,
): { testedSha: string; baseSha: string } | undefined {
  if (!pr || !repoRoot) return undefined;
  const testedSha = resolve(repoRoot, `origin/${pr.branch}`);
  const baseSha = resolve(repoRoot, "origin/main");
  if (!testedSha || !baseSha) return undefined;
  return { testedSha, baseSha };
}

const defaultGetPromoteCiStateDeps: GetPromoteCiStateDeps = {
  listPromoteCiArtifacts: defaultListPromoteCiArtifacts,
  resolveOriginMainSha: defaultResolveOriginMainSha,
};

/**
 * Fetches the gate-3 promote guard's local-CI signal (spec 0058, made
 * token-less by spec 0063): is there a local-CI artifact for this spec whose
 * `evaluatedSha` matches the CURRENT `origin/main` tip? NEVER throws: every
 * reason a real answer isn't available (local-diff ref, no repo root
 * configured, no matching/current artifact, or any read/git error) surfaces
 * as a typed `available: false` reason instead of an exception, so callers
 * (the page's SSR render and the promote server action) can both
 * render/guard without risk of crashing.
 *
 * `local_diff` is checked first (pr.number === 0) — a local-diff ref has
 * nothing on `main` to promote via a merge commit at all. `no_token`,
 * `unparseable_repo`, and `no_merge_commit` are no longer produced from here
 * (nothing here calls GitHub) but stay in `PromoteCiResult`'s reason union —
 * `decidePromoteGate` and its tests still consume them directly.
 */
export async function getPromoteCiState(
  pr: PullRequestRef,
  specId: string,
  env: Record<string, string | undefined> = process.env,
  deps: GetPromoteCiStateDeps = defaultGetPromoteCiStateDeps,
): Promise<PromoteCiResult> {
  if (pr.number === 0) return { available: false, reason: "local_diff" };
  const repoRoot = env["LAUNCHPAD_REPO_ROOT"];
  if (!repoRoot) return { available: false, reason: "no_local_ci" };
  try {
    const currentSha = deps.resolveOriginMainSha(repoRoot);
    if (!currentSha) return { available: false, reason: "no_local_ci" };
    const raws = deps.listPromoteCiArtifacts(repoRoot);
    const artifact = selectPromoteCiArtifact(raws, specId, currentSha);
    if (!artifact) return { available: false, reason: "no_local_ci" };
    return { available: true, conclusion: artifact.conclusion };
  } catch {
    return { available: false, reason: "fetch_failed" };
  }
}

/** What the promote control should render/allow, given a `PromoteCiResult`.
 * PURE — no I/O — so it's trivially unit-testable and shared verbatim between
 * the page's render (item C) and the server action's defense-in-depth guard
 * (item D), which is what keeps client and server from ever diverging on the
 * same decision.
 *
 * `available: false` (any reason) is deliberately ALLOW-WITH-NOTE, never a
 * block: there's no red signal to honor (no token, no remote, local-diff, PR
 * not yet merged, or a transient fetch failure), and hard-blocking here would
 * brick local-diff/dogfood promotion for a condition that isn't "CI failed" —
 * the human still decides, now with an honest caveat instead of a silent gap. */
export function decidePromoteGate(
  result: PromoteCiResult,
): { enabled: boolean; tone: "ok" | "danger" | "info" | "warn"; message: string } {
  if (!result.available) {
    if (result.reason === "no_local_ci") {
      return {
        enabled: true,
        tone: "warn",
        message:
          "El CI local no ha reportado para este commit de fusión (el watcher post-merge aún no ha corrido) — promueves bajo tu criterio.",
      };
    }
    return {
      enabled: true,
      tone: "warn",
      message: `Estado de CI no disponible (${result.reason}) — promueves bajo tu criterio.`,
    };
  }
  switch (result.conclusion) {
    case "success":
      return { enabled: true, tone: "ok", message: "CI local verde — listo para promover." };
    case "failure":
      return {
        enabled: false,
        tone: "danger",
        message: "CI local rojo — no se puede promover. Arregla en main y vuelve a correr el watcher.",
      };
  }
}

/**
 * Server-side promote-signal guard (spec 0043 item D) — defense-in-depth
 * behind item C's UI disable, since the promote button is still a plain
 * `<form>` POST a client could resubmit after the page went stale. Resolves
 * whether a gate signal about to be sent must be BLOCKED.
 *
 * Only ever consults local CI for `signal === "promote"` — every other
 * signal returns `{ blocked: false }` immediately, without calling
 * getPipelineViewStateSafe/getPromoteCiState at all, so this can never add
 * latency or a failure mode to specApproved/prApproved/specRejected.
 *
 * Reuses the SAME getPromoteCiState + decidePromoteGate as the page's render
 * (item C), so the server can never diverge from what the client showed:
 * `enabled: false` (a genuinely red local-CI artifact) blocks; `enabled:
 * true` (green artifact, or any allow-with-note unavailable reason including
 * no artifact yet, or no PR ref to check at all) allows — purely subtractive,
 * this can only turn an allowed promote into a blocked one, never the
 * reverse, and it never sends a signal itself.
 *
 * `clientOverride`/`env`/`promoteCiDeps` mirror getPipelineViewStateSafe's
 * and getPromoteCiState's own test seams, so the guard is unit-testable
 * without a live Temporal server or real network.
 */
export async function resolvePromoteSignalGuard(
  specId: string,
  signal: GateSignal,
  clientOverride?: SignalClient,
  env: Record<string, string | undefined> = process.env,
  promoteCiDeps?: GetPromoteCiStateDeps,
  concurrencyDeps: PromoteConcurrencyDeps = defaultPromoteConcurrencyDeps,
): Promise<{ blocked: boolean; message?: string }> {
  if (signal !== "promote") return { blocked: false };
  // specStatus is irrelevant here: getPipelineViewState only uses it for the
  // no-live-phase fallback derivation, while view.pr is assigned
  // unconditionally from the workflow's pipelinePr query — the only piece of
  // `view` this guard reads.
  const view = await getPipelineViewStateSafe(specId, "", undefined, clientOverride);
  const ci = view?.pr ? await getPromoteCiState(view.pr, specId, env, promoteCiDeps) : null;
  const decision = ci ? decidePromoteGate(ci) : null;
  if (decision && !decision.enabled) {
    return { blocked: true, message: decision.message };
  }
  // Spec 0118 (concurrency B): the CI check above asks "is this change good?".
  // These clauses ask "is it still the change you approved, and is production
  // free to receive it?" — orthogonal questions, so both run, CI first because
  // a red build is the more fundamental refusal.
  const concurrency = await resolvePromoteConcurrency(specId, view, env, concurrencyDeps);
  if (concurrency.blocked) {
    return { blocked: true, message: concurrency.message ?? "Promote blocked." };
  }
  return { blocked: false };
}

/** Injectable IO seam for the spec-0118 clauses — the three live reads (workflow
 * query, git, Temporal visibility) that the pure `decidePromoteAttestation` cannot
 * do, so its interesting cases (two users, interleaved) are unit-testable without
 * staging a race. */
export interface PromoteConcurrencyDeps {
  getGate2Attestation: (specId: string) => Promise<PromoteAttestation | undefined>;
  resolveRefSha: (repoRoot: string, ref: string) => string | null;
  listProductionBusySpecIds: (repo: string) => Promise<string[]>;
  /** Spec 0115 clause 4: odoo.sh's build state for a commit. Injectable like the
   * others so the in-flight refusal is unit-testable without a GitHub token. */
  readOdooShBuild: (repo: string, sha: string) => Promise<OdooShBuild>;
}

export const defaultPromoteConcurrencyDeps: PromoteConcurrencyDeps = {
  getGate2Attestation: getGate2AttestationSafe,
  resolveRefSha,
  listProductionBusySpecIds,
  readOdooShBuild: (repo, sha) => activities.readOdooShBuild(repo, sha),
};

/**
 * Resolve the three spec-0118 inputs and apply the pure decision.
 *
 * Every read degrades to `undefined`/`[]` rather than throwing: this runs on the
 * click path of a button, and a Temporal hiccup must not turn a promote into a
 * stack trace. `decidePromoteAttestation` is explicit that unknown inputs warn
 * rather than block, so degradation never silently hardens OR weakens the gate —
 * it produces the "could not check" message.
 */
async function resolvePromoteConcurrency(
  specId: string,
  view: PipelineViewState | null,
  env: Record<string, string | undefined>,
  deps: PromoteConcurrencyDeps,
): Promise<{ blocked: boolean; message?: string }> {
  const repoRoot = view?.pr?.repoRoot ?? view?.pr?.workdir ?? env["LAUNCHPAD_REPO_ROOT"];
  const attestation = await deps.getGate2Attestation(specId);
  const busyRuns = repoRoot ? await deps.listProductionBusySpecIds(repoRoot) : [];
  const mainHeadSha = repoRoot ? deps.resolveRefSha(repoRoot, "origin/main") : null;
  // `view.pr.repo` is `owner/repo` in GitHub mode and a workdir path for a
  // local-diff run; readOdooShBuild answers "absent" for the latter rather than
  // throwing, so no branch is needed here.
  const productionBuild =
    view?.pr?.repo && mainHeadSha
      ? await deps.readOdooShBuild(view.pr.repo, mainHeadSha).catch(() => undefined)
      : undefined;
  const decision = decidePromoteAttestation({
    attestation,
    ...(view?.pr && repoRoot
      ? { prHead: deps.resolveRefSha(repoRoot, `origin/${view.pr.branch}`) ?? undefined }
      : {}),
    ...(repoRoot ? { mainHead: deps.resolveRefSha(repoRoot, "origin/main") ?? undefined } : {}),
    busyRuns: busyRuns.filter((s) => s !== specId),
    // Spec 0115 clause 4: read odoo.sh's state for the commit production is
    // SERVING (main's HEAD), not the PR head — the question is whether production
    // is free, not whether this change is good. Degrades to "absent" on any
    // failure, which does not block; see the field's doc for why that is right.
    ...(productionBuild ? { productionBuild } : {}),
  });
  return decision.blocked
    ? { blocked: true, ...(decision.message ? { message: decision.message } : {}) }
    : { blocked: false };
}

/** Read a run's gate-2 attestation. `undefined` on every failure — no handler (a
 * run started before spec 0118), not running, or Temporal unreachable — which the
 * pure decision treats as "unknown", not "fine". */
export async function getGate2AttestationSafe(
  specId: string,
  clientOverride?: SignalClient,
  /** Spec 0142 C: the project whose spec this is. Ids are namespaced by slug,
   * so a caller that knows the project resolves unambiguously; without it the
   * recorded-id lookup still finds a unique run, and only a genuinely ambiguous
   * spec number falls back to the legacy `spec-<id>`. */
  projectSlug?: string,
): Promise<PromoteAttestation | undefined> {
  try {
    const client = clientOverride ?? (await getClient());
    const handle = client.workflow.getHandle(await resolveWorkflowId(specId, projectSlug));
    return (await handle.query(gate2Attestation)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Spec ids of RUNNING pipelines on `repo` that are currently in a production-busy
 * phase (spec 0118 clause 4's credential-free half).
 *
 * Same shape and same degradation as `listRunningPipelineTargets`: `[]` on a
 * visibility failure, and one run's failed query drops only that run. Filtered by
 * repo, because two projects deploying at once is not a collision — only two runs on
 * the same `main` is.
 */
/**
 * Spec id of a RUNNING run on `(repo, branch)`, or null — the FRIENDLY half of
 * spec 0133's per-branch serialization. Git's one-checkout-per-branch
 * invariant is the atomic half behind it, so a visibility failure here
 * degrades to a later, uglier-but-correct refusal instead of a double run.
 */
export async function findRunningBranchRun(repo: string, branch: string): Promise<string | null> {
  try {
    const client = await getClient();
    const executions = client.workflow.list({
      query: `WorkflowType="specPipeline" AND ExecutionStatus="Running"`,
    });
    for await (const execution of executions) {
      try {
        const handle = client.workflow.getHandle(execution.workflowId, execution.runId);
        const [target, runBranch] = await Promise.all([
          handle.query(pipelineTarget),
          handle.query(pipelineBranch),
        ]);
        if (runBranch === branch && target.repo === repo) {
          return specIdFromWorkflowId(execution.workflowId);
        }
      } catch {
        // A pre-0133 run has no pipelineBranch handler — it carries no branch,
        // so it cannot collide with one. Skip rather than blank the scan.
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function listProductionBusySpecIds(repo: string): Promise<string[]> {
  const busy: string[] = [];
  try {
    const client = await getClient();
    const executions = client.workflow.list({
      query: `WorkflowType="specPipeline" AND ExecutionStatus="Running"`,
    });
    for await (const execution of executions) {
      try {
        const handle = client.workflow.getHandle(execution.workflowId, execution.runId);
        const [phase, target] = await Promise.all([
          handle.query(pipelinePhase),
          handle.query(pipelineTarget),
        ]);
        if (target.repo !== repo) continue;
        if (isProductionBusyPhase(phase)) busy.push(specIdFromWorkflowId(execution.workflowId));
      } catch {
        // A pre-0033 run has no pipelineTarget handler; skip it rather than
        // blanking the list. It also cannot be matched to a repo, so counting it
        // as busy would block every promote everywhere.
      }
    }
  } catch {
    return [];
  }
  return busy;
}
