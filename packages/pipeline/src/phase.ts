/**
 * The workflow's TRUE position, exposed to apps/web via a Temporal query
 * (spec 0007). This is the fix for the gate-integrity defect: apps/web used
 * to guess the current gate from spec frontmatter (`approved` + RUNNING ⇒
 * "gate 2"), which was wrong while the workflow was mid-coder-loop and let a
 * premature Approve-PR click sail through gate 2. Instead the workflow keeps
 * a plain workflow-local variable updated at every step and answers the
 * `pipelinePhase` query with it, so the UI renders gate buttons ONLY when the
 * workflow is genuinely parked at that gate.
 *
 * Pure module (no @temporalio import) so both the workflow and the web layer
 * can share the type and the awaiting-phase set, and so it loads under
 * `node --test`.
 */

/** Every position the workflow can report, in rough lifecycle order. The
 * `awaiting_*` phases are the three human gates (spec/PR/promotion) — the only
 * phases in which a gate button should render. The final four (`promoted`,
 * `promoted_teardown_failed`, `rejected`, `failed`) are TERMINAL (spec 0009,
 * `promoted_teardown_failed` added by spec 0018): the workflow sets one as
 * its last step before returning/throwing so a closed run reports its true
 * outcome instead of `tearing_down` forever. `promoted_teardown_failed` is
 * the run that DID promote successfully but then hit a teardownEnv failure
 * (0020 run d1bc4732 surfaced this as a bare, unattributed
 * WorkflowExecutionFailed) — distinct from plain `failed` so the operator
 * sees the true outcome (promotion succeeded) alongside the cleanup
 * problem. */
export type PipelinePhase =
  | "drafting"
  | "awaiting_spec_approval"
  | "provisioning"
  | "initializing"
  | "coding"
  | "awaiting_pr_approval"
  | "merging"
  | "staged"
  | "awaiting_promotion"
  | "deploying"
  | "tearing_down"
  | "promoted"
  | "promoted_teardown_failed"
  | "rejected"
  | "failed";

/** All phases, in lifecycle order — the single source of truth the query
 * handler, the web view derivation, and the tests all read from. */
export const PIPELINE_PHASES: readonly PipelinePhase[] = [
  "drafting",
  "awaiting_spec_approval",
  "provisioning",
  "initializing",
  "coding",
  "awaiting_pr_approval",
  "merging",
  "staged",
  "awaiting_promotion",
  "deploying",
  "tearing_down",
  "promoted",
  "promoted_teardown_failed",
  "rejected",
  "failed",
] as const;

/** The TERMINAL phases (spec 0009; `promoted_teardown_failed` added by
 * spec 0018; `staged` added by spec 0133) — the outcome a closed run reports.
 * `promoted`/`rejected`/`staged` map to the UI's "completed" state, `failed`
 * to "failed", and `promoted_teardown_failed` to its own label
 * (apps/web/lib/pipeline.ts). The workflow sets one of these as its final
 * step so the `pipelinePhase` query never answers `tearing_down` on a
 * finished run. `staged` is a BRANCH run's ending: its commits are on the
 * branch and the production act is the branch-level promote (spec 0136) —
 * a non-terminal `staged` would let the `finally` stamp `tearing_down`
 * forever, the 0009 bug wearing a new hat. */
export const TERMINAL_PHASES: readonly PipelinePhase[] = [
  "staged",
  "promoted",
  "promoted_teardown_failed",
  "rejected",
  "failed",
] as const;

export function isTerminalPhase(phase: PipelinePhase): boolean {
  return (TERMINAL_PHASES as readonly string[]).includes(phase);
}

/** The three human-gate phases. A gate button renders in the UI only when the
 * reported phase is one of these — never during `coding`, `merging`, etc. */
export const AWAITING_PHASES: readonly PipelinePhase[] = [
  "awaiting_spec_approval",
  "awaiting_pr_approval",
  "awaiting_promotion",
] as const;

export function isAwaitingPhase(phase: PipelinePhase): boolean {
  return (AWAITING_PHASES as readonly string[]).includes(phase);
}

/** Name of the Temporal query apps/web calls to read the true phase. Shared so
 * the `defineQuery` in workflow.ts and the `client.workflow...query()` call in
 * apps/web/lib/pipeline.ts never drift apart. */
export const PIPELINE_PHASE_QUERY = "pipelinePhase";

/**
 * The SPEC §5 `AgentRun.status` vocabulary — deliberately a different, smaller
 * alphabet from {@link PipelinePhase}. The phase is the pipeline's own state
 * machine; this is what the workspace's Agentes tab colours a badge with.
 */
export type AgentRunStatus = "running" | "queued" | "completed" | "failed" | "waiting-approval";

/**
 * Map a pipeline phase to the projection status (spec 0088, Phase D).
 *
 * Composed from the existing predicates rather than a 14-entry table, so a
 * phase added to {@link PIPELINE_PHASES} later is classified automatically
 * instead of silently falling through a stale map:
 *   - a human gate            → `waiting-approval`
 *   - `failed`                → `failed`
 *   - any other terminal      → `completed` (promoted / rejected /
 *                               promoted_teardown_failed: the run is over)
 *   - everything else         → `running`
 */
export function projectionStatus(phase: PipelinePhase): AgentRunStatus {
  if (isAwaitingPhase(phase)) return "waiting-approval";
  if (phase === "failed") return "failed";
  if (isTerminalPhase(phase)) return "completed";
  return "running";
}
