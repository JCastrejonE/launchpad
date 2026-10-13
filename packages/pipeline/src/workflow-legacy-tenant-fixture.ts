/**
 * FROZEN test fixture — spec 0047 item B, determinism hazard "closed pre-0047
 * tenant runs are replay-queried" (see workflow.ts's
 * `patched("tenant-vanilla-deploy-0047")` branch and
 * specs/0047-tenant-vanilla-deploy-flow.md).
 *
 * Before spec 0047, a `target: tenant` run traversed the EXACT SAME body as
 * `target: self` — there was no branch at all (see workflow.test.ts's test
 * (o), pre-0047: draft → gate 1 → provision → init → coder loop → gate 2 (PR)
 * → merge → gate 3 (promote) → deploy → promoted, teardown in `finally`).
 * This file exists ONLY so workflow.test.ts's replay test (B-iv) can RECORD a
 * REAL Temporal history shaped like a closed pre-0047 tenant run — i.e. one
 * with NO "tenant-vanilla-deploy-0047" patch-marker event in it — and then
 * replay that history against the CURRENT workflow.ts (which DOES call
 * `patched()` at the top of `specPipeline`). A clean replay (no
 * NonDeterminismError / DeterminismViolationError) is the proof that
 * `patched()` returns `false` for such a history and execution falls back to
 * the old full-pipeline body, protecting closed runs like specs 0034/0045
 * from breaking when the spec-detail page queries them.
 *
 * It exports its workflow function as `specPipeline` (same name the real
 * workflow.ts exports) so the recorded history's WorkflowType matches
 * production reality — pre-0047, EVERY run (self or tenant) was WorkflowType
 * "specPipeline"; there was no separate tenant workflow type. That is also
 * why the replay step in the test points `workflowsPath` at the real
 * workflow.js: replay looks up the history's WorkflowType ("specPipeline") in
 * the given bundle, so it finds and runs the CURRENT specPipeline, not this
 * fixture.
 *
 * Trimmed to the single scenario the replay test drives (mocks that converge
 * immediately: `countRemaining` reports nothing left, `runCi` is green, the
 * PR is a local-diff ref) — the full pre-0047 body's coder-loop/repair/
 * teardown-failure machinery is unreachable in that scenario and is not
 * reproduced here; see workflow.ts for the general shape this snapshots. NOT
 * imported by any production code. Never "fix" this file to track future
 * `specPipeline` changes — its entire point is staying frozen at the pre-0047
 * shape so the replay test keeps proving what a REAL old history looks like.
 */
import { proxyActivities, setHandler, condition } from "@temporalio/workflow";
import type * as activities from "./activities.js";
import type { PullRequestRef } from "./activities.js";
import type { PipelineInput } from "./spec.js";
import { ACTIVITY_OPTIONS, AGENT_ACTIVITY_OPTIONS } from "./activity-options.js";
import { isTerminalPhase, type PipelinePhase } from "./phase.js";
import {
  specApproved,
  specRejected,
  prApproved,
  promote,
  pipelinePhase,
  pipelinePr,
  gate2Poll,
  pipelineTarget,
} from "./workflow.js";

const { draftSpec, runInitializer } = proxyActivities<
  Pick<typeof activities, "draftSpec" | "runInitializer">
>(AGENT_ACTIVITY_OPTIONS);

const { provisionEphemeralEnv, runCi, countRemaining, openPullRequest, mergePullRequest, deployToProduction, teardownEnv, markSpec } =
  proxyActivities<
    Pick<
      typeof activities,
      | "provisionEphemeralEnv"
      | "runCi"
      | "countRemaining"
      | "openPullRequest"
      | "mergePullRequest"
      | "deployToProduction"
      | "teardownEnv"
      | "markSpec"
    >
  >(ACTIVITY_OPTIONS);

export async function specPipeline(input: PipelineInput): Promise<string> {
  let specApproval: { approvedBy: string } | undefined;
  let rejection: { rejectedBy: string; reason: string } | undefined;
  let prApproval: { approvedBy: string } | undefined;
  let promotion: { promotedBy: string } | undefined;
  let phase: PipelinePhase = "drafting";
  let pr: PullRequestRef | undefined;

  setHandler(specApproved, (a) => void (specApproval = a));
  setHandler(specRejected, (r) => void (rejection = r));
  setHandler(prApproved, (a) => void (prApproval = a));
  setHandler(promote, (p) => void (promotion = p));
  setHandler(pipelinePhase, () => phase);
  setHandler(pipelinePr, () => pr);
  setHandler(gate2Poll, () => ({ status: "idle" as const, error: null }));
  setHandler(pipelineTarget, () => input.target);

  // 1. Draft spec from the plain-language request (LLM activity).
  await draftSpec(input);

  // 2. GATE 1 — human approves or rejects the spec.
  phase = "awaiting_spec_approval";
  await condition(() => !!specApproval || !!rejection);
  if (rejection) {
    phase = "rejected";
    return markSpec(input.specId, "rejected");
  }
  await markSpec(input.specId, "approved");

  // 3. Ephemeral env + branch spec/<id>.
  phase = "provisioning";
  const env = await provisionEphemeralEnv(input);
  try {
    // 4. Initializer, then the (here: zero-iteration) coder loop — this
    // fixture only models the always-converges-immediately scenario the
    // replay test's mocks drive; it deliberately does not reproduce the full
    // coder-loop/repair machinery (unreachable for that scenario).
    phase = "initializing";
    await runInitializer(input, env);
    phase = "coding";
    const { remaining } = await countRemaining(input, env);
    const ci = await runCi(input, env);
    if (remaining !== 0 || !ci.green) {
      throw new Error(
        "workflow-legacy-tenant-fixture: only models the immediate-convergence " +
          "scenario (remaining === 0 && ci.green) — not a general pre-0047 " +
          "replica of the coder loop",
      );
    }

    // 5. GATE 2 — PR review.
    pr = await openPullRequest(input, env, { stalled: false });
    prApproval = undefined;
    phase = "awaiting_pr_approval";
    const openedPr = pr;
    await condition(() => !!prApproval || !!rejection);
    if (rejection) {
      phase = "rejected";
      return markSpec(input.specId, "rejected");
    }
    phase = "merging";
    await mergePullRequest(openedPr);
    promotion = undefined;
    await markSpec(input.specId, "staged");

    // 6. GATE 3 — explicit human promotion.
    phase = "awaiting_promotion";
    await condition(() => !!promotion || !!rejection);
    if (rejection) {
      phase = "rejected";
      return markSpec(input.specId, "rejected");
    }
    phase = "deploying";
    await deployToProduction(input);
    phase = "promoted";
    return markSpec(input.specId, "promoted");
  } finally {
    if (!isTerminalPhase(phase)) {
      phase = "tearing_down";
    }
    await teardownEnv(env);
  }
}
