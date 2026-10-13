/**
 * The odoo-next PROVISIONING workflow (spec 0161 F2) — ONE durable Temporal
 * workflow over the F1 phase model: `repo → dns → odoo → front → verify`.
 *
 * Deterministic, like every workflow: it only orchestrates. Every side effect
 * is an activity in provisioning-activities.ts. Modelled on the minimal
 * `branchStagingOp` (workflow.ts) plus `specPipeline`'s query pattern — a
 * workflow-local `phase` variable answered by a query so apps/web never guesses.
 *
 * It is registered by the SAME worker as specPipeline: this module is
 * re-exported from workflow.ts, which is the worker's `workflowsPath`, so the
 * `provisionProject` export is picked up with no worker change. apps/web starts
 * it by the STRING CONSTANT `PROVISION_PROJECT_WORKFLOW` (provisioning-phase.ts),
 * never `provisionProject` the function reference — a production minifier renames
 * the reference and Temporal looks up a type no worker serves (VERIFICATION #10,
 * the nine-hour incident).
 */
import { proxyActivities, defineQuery, setHandler, ApplicationFailure, rootCause } from "@temporalio/workflow";
import type * as activities from "./activities.js";
import { ACTIVITY_OPTIONS } from "./activity-options.js";
import {
  PROVISIONING_PHASE_QUERY,
  PROVISIONING_FAILED_PHASE_QUERY,
  type ProvisioningPhase,
  type ProvisionProjectInput,
} from "./provisioning-phase.js";

const { provisionRepo, provisionDns, provisionOdoo, provisionFront, verifyProvision } = proxyActivities<
  Pick<
    typeof activities,
    "provisionRepo" | "provisionDns" | "provisionOdoo" | "provisionFront" | "verifyProvision"
  >
>(ACTIVITY_OPTIONS);

/** The run's live work phase (spec 0161 F3) — the SAME define-at-module-scope /
 * setHandler-in-body pattern specPipeline uses for `pipelinePhase`. */
export const provisioningPhase = defineQuery<ProvisioningPhase>(PROVISIONING_PHASE_QUERY);

/** WHICH work phase a failed run died on, or `undefined` while running/completed
 * (spec 0161 F3). Read alongside {@link provisioningPhase} so the progress view
 * marks that phase failed instead of showing a spinner. */
export const provisioningFailedPhase = defineQuery<ProvisioningPhase | undefined>(
  PROVISIONING_FAILED_PHASE_QUERY,
);

export async function provisionProject(input: ProvisionProjectInput): Promise<string> {
  let phase: ProvisioningPhase = "repo";
  let failedAt: ProvisioningPhase | undefined;
  // Registered BEFORE the first await (the ordering specPipeline documents at
  // line 319), so the web's first phase poll gets "repo", not a query error.
  setHandler(provisioningPhase, () => phase);
  setHandler(provisioningFailedPhase, () => failedAt);

  try {
    phase = "repo";
    await provisionRepo(input);
    phase = "dns";
    await provisionDns(input);
    phase = "odoo";
    await provisionOdoo(input);
    phase = "front";
    await provisionFront(input);
    phase = "verify";
    await verifyProvision(input);
    phase = "completed";
    return input.slug;
  } catch (err) {
    // Record WHICH phase died before flipping `phase` to the terminal, so a
    // closed failed run reports both — the progress view marks that phase
    // failed rather than leaving a spinner (spec 0161 F3). Non-retryable, so
    // the execution ends Failed rather than Temporal retrying the task forever
    // (the specPipeline CoderLoopFailed lesson, spec 0008).
    failedAt = phase;
    phase = "failed";
    throw ApplicationFailure.create({
      message: `provisioning ${input.slug}: ${failedAt} phase failed: ${rootCause(err) ?? String(err)}`,
      type: "ProvisioningFailed",
      nonRetryable: true,
    });
  }
}
