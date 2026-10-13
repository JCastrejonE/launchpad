/**
 * The spec pipeline — ONE durable Temporal workflow, used both to build the
 * launchpad (target: launchpad) and as the client-facing product feature
 * (target: tenant).
 *
 * draft → [specApproved] → provision env → initializer → (coder → ci)* →
 * PR → [prApproved] → merge → [promote] → deploy prod → teardown
 *
 * Human gates are signals: the workflow parks (for days if needed) at each
 * gate without consuming resources. Agents can never send promote().
 */
import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  patched,
  ApplicationFailure,
  ActivityFailure,
  rootCause,
  CancellationScope,
  isCancellation,
  log,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "./activities.js";
import type { PullRequestRef, RepairContext } from "./activities.js";
import {
  DEFAULT_MAX_ITERATIONS,
  UI_ONLY_MAX_ITERATIONS,
  type PipelineInput,
  type PipelineTarget,
} from "./spec.js";
import { coderLoopDecision } from "./loop.js";
import { backupStampFor } from "./backup-stamp.js";
import {
  ACTIVITY_OPTIONS,
  AGENT_ACTIVITY_OPTIONS,
  PR_APPROVAL_ACTIVITY_OPTIONS,
} from "./activity-options.js";
import { PIPELINE_PHASE_QUERY, isTerminalPhase, projectionStatus, type PipelinePhase } from "./phase.js";
import {
  PIPELINE_PR_QUERY,
  GATE2_POLL_QUERY,
  GATE2_ATTESTATION_QUERY,
  type Gate2PollState,
} from "./pr-query.js";
import type { PromoteAttestation } from "./promote-attestation.js";
import { PIPELINE_TARGET_QUERY } from "./target-query.js";
import { PIPELINE_BRANCH_QUERY } from "./branch-query.js";
import { PIPELINE_STAGING_QUERY, type StagingState } from "./staging-query.js";

// Agent-session activities stream an SDK session and can run long with no
// I/O the framework can see — they get a heartbeatTimeout (spec 0006) so a
// force-killed worker is detected in seconds rather than stalling for the
// full startToCloseTimeout. runRepair (spec 0018) joins this group — it's a
// fixer session, same shape as the other three.
const { draftSpec, runInitializer, runCoder, runRepair } = proxyActivities<
  Pick<typeof activities, "draftSpec" | "runInitializer" | "runCoder" | "runRepair">
>(AGENT_ACTIVITY_OPTIONS);

// Gate-2 approval poll (spec 0015): its own long-timeout profile — see
// activity-options.ts for why it can't share AGENT_ACTIVITY_OPTIONS's
// 30-minute startToCloseTimeout.
const { awaitPrApproval } = proxyActivities<Pick<typeof activities, "awaitPrApproval">>(
  PR_APPROVAL_ACTIVITY_OPTIONS,
);

const {
  provisionEphemeralEnv,
  runCi,
  countRemaining,
  readLastHandoff,
  openPullRequest,
  mergePullRequest,
  deployToProduction,
  teardownEnv,
  deployStaging,
  destroyStaging,
  markSpec,
  ensureCheckout,
  writeTenantDeployManifest,
  resolveProjectId,
  recordAgentRun,
  runBranchStagingOp,
} = proxyActivities<
  Omit<typeof activities, "draftSpec" | "runInitializer" | "runCoder" | "awaitPrApproval">
>(ACTIVITY_OPTIONS);

/**
 * Temporal patch id for spec 0119's staging lifecycle — create at gate 2 and
 * destroy in the teardown block. PERMANENT: a rename strands every marker
 * already recorded in a run's history. One id covers both halves because one
 * spec introduced both; a closed pre-0119 run has neither.
 */
const STAGING_LIFECYCLE_PATCH = "staging-lifecycle-0119";

/**
 * Temporal patch id for spec 0115's gate reshape: **the merge moves from gate 2 to
 * gate 3**, because for the customer flow the merge into `main` IS the production
 * deploy (odoo.sh builds `main` on every push). PERMANENT — a rename strands every
 * marker already recorded.
 */
const PROMOTE_MERGES_PATCH = "promote-merges-0115";

/**
 * Spec 0128 F: the merge is performed with the PROMOTING USER's GitHub credential,
 * so the call site gains an argument.
 *
 * Patched because an in-flight run that already cleared gate 2 must not replay a
 * different call shape — the lesson spec 0119 paid for ("nothing is running" is not
 * "nothing will replay"). Before the patch, promotions merge as the server token,
 * which is exactly the pre-0128 behaviour.
 */
const PROMOTER_CREDENTIAL_PATCH = "promoter-credential-0128";

/**
 * Spec 0129 C: `markSpec` now receives the run's repo root instead of reading
 * `LAUNCHPAD_REPO_ROOT`, so one run touches one repository.
 *
 * Patched for the same reason as the promoter credential: an in-flight run must not
 * replay a different call shape. Before the patch, `markSpec` falls back to the env
 * — which is exactly the pre-0129 behaviour, and correct for the platform project
 * whose checkout IS that env var.
 */
const SPEC_ROOT_PATCH = "spec-root-0129";

/**
 * Spec 0129 B: materialise the project's checkout before anything uses it.
 *
 * Patched like the other two: an in-flight run must not gain an activity call its
 * history does not contain. Before the patch, and for any run with no
 * `input.project`, nothing changes — the platform's checkout already exists.
 */
const ENSURE_CHECKOUT_PATCH = "ensure-checkout-0129";

/**
 * Spec 0170: **gate 3 is gone.** The run now ends when the change is on `main`.
 *
 * Gate 3 asked "promote?" about a commit that, in practice, a human had already
 * merged at gate 2 — every run for weeks advanced by merge, never by review, so
 * the gate's only possible answer was a click. It was not redundant, it was
 * UNANCHORED: it had no object. Spec 0170 gave shipping an object (a release,
 * with a version and a commit) and its own refusable button, so this gate has
 * nothing left to decide.
 *
 * `deployToProduction` goes with it. Deploying is now a decision about a NAMED
 * version, taken in the Versiones panel and gated on `actorFor("promote")` —
 * doing it here as well would be the two "ship?" buttons the owner warned about.
 *
 * Patched for the reason the three markers above were: an in-flight run must not
 * replay a different command sequence, and the frozen replay fixtures must keep
 * replaying. Before the patch, the old gate-3 path runs verbatim.
 */
const RELEASE_GATE_PATCH = "release-gate-0170";

export const specApproved = defineSignal<[{ approvedBy: string }]>("specApproved");
export const specRejected = defineSignal<[{ rejectedBy: string; reason: string }]>("specRejected");
/**
 * Gate 2. Spec 0118 widened the payload with the two SHAs the approval attests to
 * (see promote-attestation.ts): the PR head reviewed, and the `main` tip it was
 * reviewed against.
 *
 * Both are OPTIONAL, and that is a wire-compatibility requirement, not laxity
 * (spec 0036's discipline). Runs already parked at gate 2 when this deploys were
 * started on code that sends only `approvedBy`, and replaying an old history
 * re-delivers the old payload verbatim. A required field would break both.
 * `decidePromoteAttestation` treats a missing attestation as "unknown" and warns
 * rather than blocking, precisely so those runs stay promotable.
 */
export const prApproved =
  defineSignal<[{ approvedBy: string; testedSha?: string; baseSha?: string }]>("prApproved");
export const promote = defineSignal<[{ promotedBy: string }]>("promote");

// The workflow's TRUE position (spec 0007 gate-integrity fix) — see
// phase.ts for why this exists. Plain workflow-local variable, updated at
// every step below, answered by a query so apps/web never has to guess.
export const pipelinePhase = defineQuery<PipelinePhase>(PIPELINE_PHASE_QUERY);

// The current PR ref, once gate 2 opens (spec 0015 item 8) — `undefined`
// before `openPullRequest` runs. apps/web reads this to render a PR link with
// live checks/review state and to know whether it's a real GitHub PR
// (`number > 0`, source of truth = the GitHub review) vs. a local-diff
// fallback (`number === 0`, source of truth = the in-app prApproved button).
export const pipelinePr = defineQuery<PullRequestRef | undefined>(PIPELINE_PR_QUERY);

// Last-known state of the gate-2 approval poll (spec 0016, folding 0018's
// deferral — see pr-query.ts's Gate2PollState doc for the full rationale).
// Recorded by the `.then`/`.catch` handlers around `awaitPrApproval` below;
// `awaitPrApproval` itself and its retry/attempt policy are untouched.
export const gate2Poll = defineQuery<Gate2PollState>(GATE2_POLL_QUERY);

// What gate 2 attested (spec 0118): the reviewed PR head and the main tip it was
// reviewed against, recorded when `prApproved` arrived. `undefined` before gate 2,
// and for a run whose approval predates the widened payload.
//
// A QUERY, not workflow state written to history — queries are not recorded, so
// adding this handler is determinism-free and safe for in-flight runs. A run on
// older code simply has no handler; the reader treats that as `undefined`, which is
// the same answer as "approved without an attestation".
export const gate2Attestation =
  defineQuery<PromoteAttestation | undefined>(GATE2_ATTESTATION_QUERY);

// The run's deploy target (spec 0033 scope A) — `input.target`, unchanged for
// the life of the run. Read-only: no new side effect, no determinism risk.
// apps/web (lib/pipeline.ts) queries this on every RUNNING specPipeline
// execution to map an in-flight deploy to its host (target.vpsId) for the
// /fleet host cards.
export const pipelineTarget = defineQuery<PipelineTarget>(PIPELINE_TARGET_QUERY);

// Spec 0133: the branch a run lands its commits on, or undefined for per-spec
// runs. startPipeline's serialization scan reads this together with
// pipelineTarget: same (repo, branch) on a RUNNING execution ⇒ refuse the new
// run. Queries are unrecorded — no determinism risk; pre-0133 runs have no
// handler and callers treat that as "no branch", correct by construction.
export const pipelineBranch = defineQuery<string | undefined>(PIPELINE_BRANCH_QUERY);

// The run's staging environment (spec 0119) — `{status:"none"}` until gate 2 is
// reached, and for every self/dogfood run. A QUERY, so adding it is
// determinism-free for in-flight runs (queries are not recorded in history); a
// run on an older build simply has no handler, and the reader treats that as
// "no staging", which is the truthful answer for a run that never made one.
export const pipelineStaging = defineQuery<StagingState>(PIPELINE_STAGING_QUERY);

/**
 * Builds the fixer's diagnostic context from a `runCoder` activity failure
 * (spec 0018). `runCoder` throwing means its own `AGENT_ACTIVITY_OPTIONS`
 * retries (3 attempts) are already exhausted — Temporal wraps the final
 * attempt's error as an `ActivityFailure` whose `cause` is an
 * `ApplicationFailure` with `type` set to the original error's constructor
 * name, so a watchdog abort (`SessionStalledError`, session.ts) is
 * distinguishable from any other coder-activity failure without the
 * workflow needing to import agents-package types across the activity
 * boundary. `rootCause` unwraps the Temporal failure chain back to the
 * original thrown message.
 */
function classifyCoderFailure(err: unknown, specId: string): RepairContext {
  const stalled =
    err instanceof ActivityFailure &&
    err.cause instanceof ApplicationFailure &&
    err.cause.type === "SessionStalledError";
  return {
    error: `spec ${specId}: coder activity failed: ${rootCause(err) ?? String(err)}`,
    stalled,
  };
}

/**
 * Throws the workflow-ending failure for a trouble spot that recurred AFTER
 * its one allotted repair round (spec 0018) — both the context that
 * triggered the repair and the fresh failure that followed it are carried in
 * `details` (structured, for tests/tooling) and folded into `message` (for
 * anyone just reading logs).
 */
function repairExhaustedFailure(
  specId: string,
  original: RepairContext,
  again: RepairContext,
): ApplicationFailure {
  return ApplicationFailure.create({
    message:
      `spec ${specId}: trouble spot recurred after its one repair round — ` +
      `original: ${original.error}; after repair: ${again.error}`,
    type: "RepairExhausted",
    nonRetryable: true,
    details: [original, again],
  });
}

/**
 * Throws the workflow-ending failure for a teardownEnv failure that struck
 * AFTER the run had already reached `promoted` (spec 0018, folded from
 * 0020's deferrals — run d1bc4732 surfaced this as a bare, unattributed
 * WorkflowExecutionFailed). Names the true outcome (promotion succeeded)
 * alongside the teardown error so the operator never has to guess which
 * half of the run actually failed.
 */
function teardownFailedFailure(specId: string, teardownError: unknown): ApplicationFailure {
  const teardownMessage = rootCause(teardownError) ?? String(teardownError);
  return ApplicationFailure.create({
    message:
      `spec ${specId}: run promoted successfully, but teardownEnv failed ` +
      `afterward: ${teardownMessage}`,
    type: "TeardownFailed",
    nonRetryable: true,
    details: [{ outcome: "promoted", teardownError: teardownMessage }],
  });
}

export async function specPipeline(input: PipelineInput): Promise<string> {
  let specApproval: { approvedBy: string } | undefined;
  let rejection: { rejectedBy: string; reason: string } | undefined;
  // `via` (spec 0115) is set only by the gate-2 POLL — the in-app `prApproved`
  // signal is never a merge, so its absence there is meaningful, not missing data.
  let prApproval:
    | { approvedBy: string; testedSha?: string; baseSha?: string; via?: "merge" | "review" }
    | undefined;
  // Spec 0129 C: resolved once so the patch is evaluated in one place rather than
  // at each of the ten markSpec call sites.
  const specRoot = patched(SPEC_ROOT_PATCH) ? input.target.repo : undefined;
  // Spec 0129 A: same patch gate — the projection rides along with the root, since a
  // run that passes one has no reason to withhold the other.
  const specProject = patched(SPEC_ROOT_PATCH) ? input.project?.slug : undefined;

  let promotion: { promotedBy: string } | undefined;
  let phase: PipelinePhase = "drafting";
  let pr: PullRequestRef | undefined;
  let gate2PollState: Gate2PollState = { status: "idle", error: null };
  let staging: StagingState = { status: "none" };

  setHandler(specApproved, (a) => void (specApproval = a));
  setHandler(specRejected, (r) => void (rejection = r));
  setHandler(prApproved, (a) => void (prApproval = a));
  setHandler(promote, (p) => void (promotion = p));
  setHandler(pipelinePhase, () => phase);
  setHandler(pipelinePr, () => pr);
  setHandler(gate2Poll, () => gate2PollState);
  // Spec 0118: answer only when the approval carried BOTH SHAs. A half
  // attestation (one SHA) is reported as none — the guard would compare the half
  // it has and pass, which reads as "checked" while half the check never ran.
  setHandler(gate2Attestation, () =>
    prApproval?.testedSha && prApproval.baseSha
      ? {
          approvedBy: prApproval.approvedBy,
          testedSha: prApproval.testedSha,
          baseSha: prApproval.baseSha,
        }
      : undefined,
  );
  setHandler(pipelineTarget, () => input.target);
  setHandler(pipelineBranch, () => input.branch);
  setHandler(pipelineStaging, () => staging);

  // Spec 0129 B: the run's checkout must EXIST before draftSpec writes a spec into
  // it or a worktree is cut from it. Idempotent, so a second run reuses it — and
  // skipped entirely for a run with no project identity (the platform's checkout is
  // the deployed one and is always there).
  //
  // AFTER the setHandler block, deliberately (spec 0133 found this): an await
  // issued before the handlers register leaves the run unqueryable for the whole
  // clone — the web's first pipelinePhase poll during those seconds got "Failed
  // to query Workflow" instead of "drafting". Handler registration emits no
  // commands, so this move leaves every recorded history's command sequence
  // byte-identical (ensureCheckout is still the first command a project run
  // issues) — replay-safe without a marker.
  if (patched(ENSURE_CHECKOUT_PATCH) && input.project) {
    await ensureCheckout(input.project);
  }

  /**
   * Spec 0088 (Phase D) — the SPEC §5 `AgentRun` projection.
   *
   * Resolved lazily on the first phase change rather than up front, so a run
   * that never changes phase never touches the DB. `null` means "no project
   * link" (DB unreachable, or the resolve activity failed open) and simply
   * disables the projection for this run — the build carries on, because this
   * is a view and Temporal remains the truth (SPEC §8).
   */
  let projectId: string | null | undefined;

  /**
   * Assign the phase AND project it. Every `phase = "…"` in this workflow goes
   * through here so the projection cannot silently drift from the real phase —
   * one choke point instead of ~15 remembered call sites.
   *
   * Behind `patched()` for the reason spec 0047 documents at the tenant branch
   * below: adding activity calls changes the command sequence a workflow
   * issues, and an IN-FLIGHT run replaying against this new code would hit a
   * NonDeterminismError (its history has no such commands). An already-running
   * run has no "agent-run-projection-0088" marker, so `patched` returns false
   * on replay and it keeps its original command stream; a NEW run records the
   * marker and gets the projection. The patch id is PERMANENT — renaming it
   * would strand every recorded marker.
   */
  async function setPhase(next: PipelinePhase): Promise<void> {
    phase = next;
    if (!patched("agent-run-projection-0088")) return;
    // Spec 0142: the run's own project wins over the target mapping, which
    // sends every `kind:"self"` run to the platform. Argument widening only —
    // replay-safe by the 0131 C precedent (Temporal compares activity types,
    // never payloads), so no new `patched()` marker.
    if (projectId === undefined)
      projectId = await resolveProjectId(input.target, input.project?.slug);
    if (!projectId) return;
    await recordAgentRun({
      projectId,
      workflowId: workflowInfo().workflowId,
      agent: "pipeline",
      task: input.request,
      status: projectionStatus(next),
      phase: next,
      // Spec 0131 C: which checkout this run works in. `projectId` above cannot
      // answer that — `projectForTarget({kind:"self"})` maps the launchpad's own
      // repo to the `platform` project, so a run that FELL BACK to that repo
      // because its project could not be resolved is projected identically to a
      // deliberate platform run. That is precisely what happened twice on spec
      // 0129 D, and why it took an hour to see: every surface looked normal.
      repoRoot: input.target.repo,
      // Spec 0133: the branch the run lands commits on — the promote roll-up's
      // key. Payload widening only (the 0131 C precedent): replay-safe, since
      // Temporal compares command/activity types, never payloads.
      ...(input.branch ? { branch: input.branch } : {}),
    });
  }

  /**
   * The tenant-vanilla-deploy path (spec 0047): NO LLM draft, NO
   * initializer/coder loop, NO CI, NO gate-2 PR/merge, NO worktree — a
   * deterministic manifest (in place of `draftSpec`'s audit artifact), ONE
   * human gate at promote/deploy, then the deploy. Declared here (nested,
   * not a module-level function) so it closes over `phase`/`promotion`/
   * `rejection` directly — the "already-registered state" the signal
   * handlers above already read and write.
   */
  async function tenantVanillaDeploy(input: PipelineInput): Promise<string> {
    await setPhase("drafting");
    await writeTenantDeployManifest(input);
    await markSpec(input.specId, "staged", specRoot, specProject);
    // Signal hygiene (spec 0007): discard any promote() buffered before this
    // single gate opens, so it always requires a fresh, informed click.
    promotion = undefined;
    await setPhase("awaiting_promotion");
    await condition(() => !!promotion || !!rejection);
    if (rejection) {
      await setPhase("rejected");
      return markSpec(input.specId, "rejected", specRoot, specProject);
    }
    await setPhase("deploying");
    await deployToProduction(input);
    await setPhase("promoted");
    return markSpec(input.specId, "promoted", specRoot, specProject);
  }

  // Spec 0088: project the run the moment it starts, not after `draftSpec`.
  // `phase` is initialised to "drafting" above, but that plain assignment
  // writes no projection row — so without this the run would be invisible in
  // the Agentes tab until the first LLM draft finished (minutes), which
  // defeats the point of a "live agents" view. Same patch gate as every other
  // transition; a no-op for in-flight pre-0088 runs.
  await setPhase("drafting");

  // Version-gated tenant branch (spec 0047 / ADR-021 — the repo's FIRST
  // Temporal `patched()` use). Short-circuited behind the deterministic
  // `target.kind === "tenant"` check so a `self` run NEVER evaluates
  // `patched()` — no marker is ever recorded for self, so its history stays
  // byte-identical (spec 0047 hazard "marker placement / short-circuit"). A
  // CLOSED pre-0047 tenant run (e.g. specs 0034/0045) has no
  // "tenant-vanilla-deploy-0047" marker in its recorded history, so
  // `patched` returns `false` on replay and execution falls through to the
  // UNCHANGED full-pipeline body below — exactly what its history already
  // contains, so the spec-detail page's replay-query never throws a
  // NonDeterminismError. A NEW tenant run has no history yet, so `patched`
  // returns `true` and takes this branch. The patch id string is PERMANENT
  // (renaming it would strand every already-recorded marker).
  if (input.target.kind === "tenant" && patched("tenant-vanilla-deploy-0047")) {
    return await tenantVanillaDeploy(input);
  }

  // 1. Draft spec from the plain-language request (LLM activity).
  await draftSpec(input);

  // 2. GATE 1 — human approves or rejects the spec.
  await setPhase("awaiting_spec_approval");
  await condition(() => !!specApproval || !!rejection);
  if (rejection) {
    await setPhase("rejected");
    return markSpec(input.specId, "rejected", specRoot, specProject);
  }
  await markSpec(input.specId, "approved", specRoot, specProject);

  // 3. Ephemeral env + branch spec/<id> (sanitized prod snapshot for tenants).
  await setPhase("provisioning");
  const env = await provisionEphemeralEnv(input);
  try {
    // 4. Initializer lays foundations; coders iterate in small increments.
    await setPhase("initializing");
    await runInitializer(input, env);

    // A ui_only spec (spec 0031) is capped at UI_ONLY_MAX_ITERATIONS regardless
    // of the caller-supplied maxIterations, so the fast-path stays leaner. The
    // flag comes from provisionEphemeralEnv's activity output (env.uiOnly),
    // never a workflow-side file read — determinism-safe (no TMPRL1100 risk).
    const maxIterations = Math.min(
      input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      env.uiOnly ? UI_ONLY_MAX_ITERATIONS : Infinity,
    );
    let iterations = 0;
    let consecutiveStalls = 0;
    // CI-red streak (spec 0018) — independent of consecutiveStalls, which
    // tracks "no new commit", not CI outcome. A coder that keeps committing
    // while CI stays red still needs a repair round.
    let consecutiveCiRed = 0;
    // A repair round (spec 0018) is available until it's spent by firing
    // once; it becomes available again once the loop next records progress
    // (a coder session that commits something), so a LATER, unrelated
    // trouble spot still gets its own chance rather than inheriting an
    // already-spent one. `repairContext` remembers what the spent repair was
    // for, so a same-spot recurrence can report BOTH failure contexts.
    let repairAvailable = true;
    let repairContext: RepairContext | undefined;
    // Check unchecked (non-human) items without running a coder session first
    // — a spec left with only `(human)` items converges without a wasted
    // session (spec 0006 acceptance criteria).
    await setPhase("coding");
    let { remaining } = await countRemaining(input, env);
    let ci = await runCi(input, env);
    consecutiveCiRed = ci.green ? 0 : 1;

    for (;;) {
      const decision = coderLoopDecision({
        remaining,
        ciGreen: ci.green,
        consecutiveStalls,
        iterations,
        maxIterations,
      });
      if (decision === "proceed_to_gate2") break;
      if (decision === "fail") {
        const lastHandoff = await readLastHandoff(input, env);
        // Non-retryable: a plain Error here would fail the workflow TASK,
        // which Temporal retries forever, wedging the run "Running" instead
        // of ending it (spec 0008 run 1 postmortem). ApplicationFailure with
        // nonRetryable ends the workflow EXECUTION as Failed.
        await setPhase("failed");
        throw ApplicationFailure.create({
          message:
            `spec ${input.specId}: coder loop failed after ${iterations} ` +
            `iteration(s) (consecutiveStalls=${consecutiveStalls}, ` +
            `ci.green=${ci.green}); last handoff: ${lastHandoff || "(none)"}`,
          type: "CoderLoopFailed",
          nonRetryable: true,
        });
      }
      if (rejection) {
        await setPhase("rejected");
        return markSpec(input.specId, "rejected", specRoot, specProject);
      }

      let coderResult;
      try {
        coderResult = await runCoder(input, env);
      } catch (err) {
        // The coder activity failed outright — its own Temporal retries
        // (AGENT_ACTIVITY_OPTIONS, incl. a SessionStalledError-exhausted
        // watchdog abort) are already spent. Repair round: give the fixer
        // ONE shot at this trouble spot, then let the coder loop resume
        // (spec 0018). A second failure while no repair is available means
        // the one allotted repair already fired without progress since —
        // fail the workflow with both contexts.
        const context = classifyCoderFailure(err, input.specId);
        if (!repairAvailable) {
          await setPhase("failed");
          throw repairExhaustedFailure(input.specId, repairContext!, context);
        }
        await runRepair(input, env, context);
        iterations++; // a repair round spends budget just like a coder session.
        repairAvailable = false;
        repairContext = context;
        continue;
      }

      iterations++;
      remaining = coderResult.remaining;
      if (coderResult.progressed) {
        consecutiveStalls = 0;
        // Progress recorded — the repair "spent" state clears so a future,
        // unrelated trouble spot gets its own repair chance.
        repairAvailable = true;
        repairContext = undefined;
      } else {
        consecutiveStalls++;
      }
      ci = await runCi(input, env);
      consecutiveCiRed = ci.green ? 0 : consecutiveCiRed + 1;
      if (consecutiveCiRed >= 2) {
        const context: RepairContext = {
          error:
            `spec ${input.specId}: CI red for ${consecutiveCiRed} consecutive ` +
            `coder iteration(s)`,
          stalled: false,
        };
        if (!repairAvailable) {
          await setPhase("failed");
          throw repairExhaustedFailure(input.specId, repairContext!, context);
        }
        await runRepair(input, env, context);
        iterations++;
        repairAvailable = false;
        repairContext = context;
        // Reset the streak so the next CI run starts a fresh count rather
        // than immediately re-triggering (the repair just spent its shot).
        consecutiveCiRed = 0;
      }
    }

    // 5. GATE 2 — PR review (CI already green). `coderLoopDecision` only
    // returns "proceed_to_gate2" with remaining !== 0 via the stall branch
    // (the `remaining === 0 && ciGreen` branch takes precedence), so that's
    // the signal for whether this arrived via stall vs. clean convergence.
    const stalled = remaining !== 0;
    // Spec 0138: a skipped CI (no Node toolchain) rides the PR body so the
    // reviewer sees the absence of evidence. Payload widening only —
    // replay-safe (the 0131 C precedent).
    pr = await openPullRequest(input, env, {
      stalled,
      ...((ci.note ?? ci.skipped) ? { ciNote: (ci.note ?? ci.skipped)! } : {}),
    });
    // Signal hygiene (spec 0007): discard any prApproved that arrived before
    // this gate opened (e.g. sent while a prior iteration was still coding)
    // so gate 2 always requires a fresh, informed click.
    prApproval = undefined;
    // Spec 0119: stand the change up on its own stack as the run ARRIVES at
    // gate 2 — before the wait, because an environment that appears only after
    // approval cannot inform the approval. Same patch id as the teardown: a
    // closed pre-0119 run has neither call in its history.
    //
    // A create failure does NOT fail the run. The change is still reviewable on
    // the PR, and killing a whole run because the staging box hiccupped is the
    // worse outcome; the reason is recorded in the query so the UI can say why
    // the environment is missing instead of showing an unexplained absence. The
    // stack is torn down on every exit regardless (see the finally below), so a
    // half-created stack is not left behind.
    if (patched(STAGING_LIFECYCLE_PATCH)) {
      try {
        // Spec 0187 E: the branch refresh installs into a database that already
        // exists, and that install takes a backup first — whose directory name
        // must come from workflow time, not from the activity (spec 0105).
        const ref = await deployStaging(
          { ...input, backupTimestamp: backupStampFor(workflowInfo().startTime) },
          env,
        );
        staging = ref ? { status: "ready", ref } : { status: "none" };
      } catch (err) {
        const error = rootCause(err) ?? String(err);
        staging = { status: "failed", error };
        log.warn(`spec ${input.specId}: staging create failed — review continues without it`, {
          error,
        });
      }
    }
    await setPhase("awaiting_pr_approval");
    // Narrowed, non-optional snapshot: `pr` (the outer `let`) reads as
    // possibly-`undefined` inside the closure below (TS can't see that no
    // other branch reassigns it), and openPullRequest above always resolves
    // to a real PullRequestRef, never undefined.
    const openedPr = pr;
    // Gate 2 via GitHub (spec 0015 / ADR-012): in PR mode (a real GitHub PR,
    // pr.number > 0) race the in-app prApproved/specRejected signals against
    // a heartbeating awaitPrApproval poll of the PR's review/checks state —
    // whichever settles first wins, so the Temporal-signal escape hatch and
    // the offline (local-diff) fallback both keep working. Local-diff "PRs"
    // (pr.number === 0) have no remote to poll, so gate 2 stays purely
    // signal-driven for them, same as before this spec.
    await CancellationScope.cancellable(async () => {
      // Spec 0133: a BRANCH run never polls its PR — that PR belongs to the
      // BRANCH (one accumulating PR, merged by the branch-level promote), so a
      // mid-run merge or review of it must not clear THIS spec's gate 2. The
      // in-app prApproved signal ("validated on staging") is the only path.
      if (openedPr.number > 0 && !input.branch) {
        gate2PollState = { status: "polling", error: null };
        void awaitPrApproval(openedPr).then(
          (outcome) => {
            gate2PollState = { status: "settled", error: null };
            if (outcome.outcome === "approved") {
              prApproval = {
                approvedBy: outcome.actor,
                ...(outcome.via ? { via: outcome.via } : {}),
              };
            } else {
              rejection = { rejectedBy: outcome.actor, reason: "PR closed without merge" };
            }
          },
          (err) => {
            // Expected once the signal wins the race and cancels this scope
            // below. Any OTHER failure (e.g. a persistently broken poll)
            // must not crash gate 2 — it just leaves the in-app signal as
            // the sole path, same as before this spec. A cancellation is
            // NOT a poll failure (the signal already satisfied gate 2), so
            // gate2PollState is left as-is (still "polling") rather than
            // flipped to "failed".
            if (!isCancellation(err)) {
              const message = rootCause(err) ?? String(err);
              gate2PollState = { status: "failed", error: message };
              log.warn(`spec ${input.specId}: gate-2 approval poll failed`, {
                error: message,
              });
            }
          },
        );
      }
      await condition(() => !!prApproval || !!rejection);
      // Cancel the losing racer (a no-op if the poll never started or
      // already settled) so it doesn't keep hitting GitHub for the rest of
      // the run.
      CancellationScope.current().cancel();
    });
    if (rejection) {
      await setPhase("rejected");
      return markSpec(input.specId, "rejected", specRoot, specProject);
    }
    // Spec 0133: a BRANCH run ENDS here, at the terminal `staged` phase. Its
    // commits are already on the branch (pushed at gate-2 arrival), the
    // branch's one PR accumulates them, and the production act is the
    // branch-level promote (spec 0136) — a web action merging that PR with the
    // promoting user's own credential. No per-spec merge, no gate 3, no
    // production deploy. The `finally` below still runs: `destroyStaging`
    // no-ops for kind-self runs (the branch's staging server outlives the
    // run — spec 0134), and `teardownEnv` removes the worktree while the
    // branch and its commits remain. Gated on `input.branch`, which no
    // pre-0133 history carries, so no replay can reach this path — the reason
    // this needs no `patched()` marker (spec 0133 decision 1).
    if (input.branch) {
      await setPhase("staged");
      return markSpec(input.specId, "staged", specRoot, specProject);
    }
    // Spec 0115: WHERE the merge happens, decided once, here.
    //
    // The owner's confirmed gate shape: gate 2 records the tested SHA and does NOT merge;
    // gate 3 merges, and for an odoo.sh customer that merge IS the production
    // deploy. So the merge moves to promote — EXCEPT when the approval was itself a
    // merge (ADR-016: a human merging on GitHub is how gate 2 clears for our own
    // dogfood runs). In that case the merge has already happened server-side and
    // this activity's remaining job is to sync the local checkout, which must run
    // NOW because `markSpec` commits there two lines below.
    //
    // `via` is optional for wire compatibility, so a missing value reads as "not a
    // merge" — which is the safe default: the merge then happens at gate 3, where
    // `mergePullRequest` is idempotent and skips an already-merged PR anyway.
    // The cast defeats the SAME TS narrowing artifact the `phase` read in the
    // `finally` below documents: `prApproval` is assigned only from a signal handler
    // and the poll's `.then` closure, so flow analysis stops tracking it and believes
    // it is still `undefined` here. At runtime the `condition` above guarantees it is
    // set (or `rejection` returned two lines up).
    const approvedVia = (prApproval as { via?: "merge" | "review" } | undefined)?.via;
    // Spec 0170: with gate 3 gone there is no "at promote" left to defer to, so
    // the merge happens here — the moment gate 2 says the change is accepted.
    const releaseGate = patched(RELEASE_GATE_PATCH);
    const mergeAtPromote = !releaseGate && patched(PROMOTE_MERGES_PATCH) && approvedVia !== "merge";
    if (!mergeAtPromote) {
      await setPhase("merging");
      await mergePullRequest(openedPr);
    }
    // Same hygiene for gate 3 — discard any promote() buffered before the
    // merge landed.
    promotion = undefined;

    // Spec 0170: the run's job ends with the change on `main`. `promoted` keeps
    // its meaning — "its code is in the trunk" — which is exactly what the
    // status reconciler already infers from a merged branch. What used to follow
    // (a second gate and a production deploy) is now the Versiones panel's
    // release, taken per version and gated on its own.
    if (releaseGate) {
      await setPhase("promoted");
      return markSpec(input.specId, "promoted", specRoot, specProject);
    }

    await markSpec(input.specId, "staged", specRoot, specProject);

    // 6. GATE 3 — explicit human promotion (button in apps/web). Pre-0170 path,
    // kept verbatim so an in-flight run and the frozen fixtures replay unchanged.
    await setPhase("awaiting_promotion");
    await condition(() => !!promotion || !!rejection);
    if (rejection) {
      await setPhase("rejected");
      return markSpec(input.specId, "rejected", specRoot, specProject);
    }
    // Spec 0115: **promote = merge.** For an odoo.sh customer this IS the production
    // deploy — odoo.sh sees the push to `main` and updates the production server — so
    // it runs before `deployToProduction`, which is the deploy for a tenant we host
    // and a no-op for self.
    //
    // A rejection at gate 3 now leaves `main` untouched, which is the point of moving
    // it: under the old order the change was already merged by the time this gate
    // opened, so "reject" could not un-ship it.
    if (mergeAtPromote) {
      await setPhase("merging");
      // Spec 0128 F: merge AS the person who promoted. GitHub then enforces the
      // permission — branch protection, required reviews and CODEOWNERS all apply
      // to them — which is a stronger claim than our own role check can make.
      //
      // The explicit `undefined` skips the activity's injectable `deps` (a test
      // seam the workflow has no business supplying); the TS SDK round-trips an
      // `undefined` argument faithfully, so the activity's default applies.
      //
      // The cast defeats the SAME TS narrowing artifact documented for `prApproval`
      // and `phase` above: `promotion` is assigned only from a signal handler, so
      // flow analysis stops tracking it and believes it is still the `undefined` it
      // was reset to before this gate. At runtime the `condition` that opened gate 3
      // guarantees it is set.
      const promotedBy = patched(PROMOTER_CREDENTIAL_PATCH)
        ? (promotion as { promotedBy: string } | undefined)?.promotedBy
        : undefined;
      await mergePullRequest(openedPr, undefined, promotedBy);
    }
    await setPhase("deploying");
    await deployToProduction(input);
    await setPhase("promoted");
    return markSpec(input.specId, "promoted", specRoot, specProject);
  } finally {
    // A terminal phase set above (failed/rejected/promoted) is the run's true
    // outcome — don't let teardown clobber it back to a non-terminal value.
    // This `finally` still always runs teardownEnv regardless. Captured
    // BEFORE the non-terminal-phase overwrite below, since that overwrite
    // would otherwise erase the one signal (phase === "promoted") that tells
    // us whether a teardown failure below is the promoted_teardown_failed
    // case or an ordinary (unchanged) teardown failure.
    // The cast defeats a TS narrowing artifact introduced by spec 0088, not a
    // logic change: every `phase` write now happens inside `setPhase`, and
    // TypeScript's flow analysis stops tracking a `let` mutated only from a
    // nested closure — so it believes `phase` is still its initializer
    // ("drafting") here and calls this comparison impossible. At runtime the
    // preceding `await setPhase("promoted")` has genuinely run.
    const reachedPromoted = (phase as PipelinePhase) === "promoted";
    if (!isTerminalPhase(phase)) {
      await setPhase("tearing_down");
    }
    // Spec 0119: the staging stack comes down on EVERY exit — promoted,
    // rejected, failed, cancelled — because a create without a matching destroy
    // leaks an Odoo container, a Postgres container and two named volumes per
    // spec onto one 16 GB box. Runs BEFORE teardownEnv so a staging failure can
    // never skip the worktree removal.
    //
    // Not fatal, and specifically not rethrown: turning a teardown failure into
    // the run's outcome is the exact shape spec 0018 had to fix for teardownEnv,
    // and a stack that outlives its run is recoverable — `scripts/staging-sweep.mjs`
    // is the backstop that finds one. The activity's own 3 retries handle the
    // transient SSH case first.
    //
    // Behind `patched()` (the repo's second use, after spec 0047's tenant
    // branch) because this adds an activity command to a path CLOSED runs have
    // already recorded without it. The spec-detail page replay-queries closed
    // runs, so an unpatched addition here raises a NonDeterminismError on
    // histories that predate this spec — caught by test (o)'s frozen pre-0047
    // fixture, not by anything live (this namespace has zero executions). The
    // patch id is PERMANENT: renaming it strands every recorded marker. Shared
    // with the create side below, since one spec introduced both halves.
    if (patched(STAGING_LIFECYCLE_PATCH)) {
      try {
        await destroyStaging(input);
      } catch (err) {
        log.warn(`spec ${input.specId}: staging teardown failed — sweep will find it`, {
          error: rootCause(err) ?? String(err),
        });
      }
    }
    try {
      await teardownEnv(env);
    } catch (err) {
      // Spec 0018: teardown failing after a successful promotion must not
      // surface as a bare WorkflowExecutionFailed (0020 run d1bc4732) — a
      // distinct terminal phase + typed failure names the true outcome.
      // Every other phase's teardown failure is unchanged: it just
      // propagates as before (the dirty-tree guard itself is untouched —
      // 0021 non-goal stands).
      if (reachedPromoted) {
        await setPhase("promoted_teardown_failed");
        throw teardownFailedFailure(input.specId, err);
      }
      throw err;
    }
  }
}

/** Input for {@link branchStagingOp} — deploy/destroy a BRANCH's staging
 * server (spec 0134). */
export interface BranchStagingOpInput {
  op: "deploy" | "destroy";
  projectSlug: string;
  branch: string;
}

/**
 * The tiny explicit-op workflow behind Ramas & builds' staging buttons
 * (spec 0134). A workflow rather than a web-side call because the fleet SSH
 * identity and the Hostinger token are WORKER-only env — the web must not
 * gain them — and because the worker process is where `withRepoLock`
 * serializes against run provisioning. One activity; Temporal's
 * duplicate-workflow-id refusal turns a double click into a no-op (the
 * caller keys the id on project+stack).
 *
 * Started by STRING CONSTANT (`BRANCH_STAGING_WORKFLOW_TYPE`, task-queue.ts)
 * — never the function reference; apps/web's production bundle minifies
 * `branchStagingOp.name` into garbage (docs/VERIFICATION.md #10).
 */
export async function branchStagingOp(
  input: BranchStagingOpInput,
): Promise<{ op: "deploy" | "destroy"; stack: string; host?: string }> {
  // Spec 0187 E: a REDEPLOY installs into the branch database that is already
  // there, and that install backs up first — under a directory named from
  // workflow time so an activity retry reuses it rather than orphaning one.
  return await runBranchStagingOp(
    input.op,
    input.projectSlug,
    input.branch,
    backupStampFor(workflowInfo().startTime),
  );
}

// Spec 0161 F2: the odoo-next `provisionProject` workflow lives in its own
// module for readability, re-exported HERE so it rides the worker's
// `workflowsPath` (worker.ts points at this file) and is registered with no
// worker change — same mechanism `export *` gives specPipeline/branchStagingOp.
export * from "./provisioning-workflow.js";

// Spec 0170: the release-deploy workflow, re-exported here so it rides the
// worker's `workflowsPath` with no worker change — same mechanism 0161 used.
export * from "./release-workflow.js";

// Spec 0228 C: the CI gate, re-exported here so it rides the worker's
// `workflowsPath` with no worker change — same mechanism 0161 and 0170 used.
export * from "./ci-gate-workflow.js";
