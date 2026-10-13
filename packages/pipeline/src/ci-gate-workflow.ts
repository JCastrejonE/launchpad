/**
 * The CI gate workflow (spec 0228 C).
 *
 * Thin on purpose, like release-workflow.ts: one activity, because everything it
 * needs — SSH to the sandbox box, the GitHub token — is worker-only, and a
 * workflow may hold no side effects of its own.
 */
import { proxyActivities } from "@temporalio/workflow";
import type { CiGateInput, CiGateResult } from "./ci-gate-activity.js";

/**
 * The workflow TYPE the caller passes to `client.workflow.start`, and the name
 * the worker registers this export under. A STRING CONSTANT, never a function
 * reference: a production minifier renamed `specPipeline` to "P" and Temporal
 * retried a type no worker served for nine hours (VERIFICATION #10).
 */
export const CI_GATE_WORKFLOW = "ciGate";

/** One run per commit. The caller uses this as the workflow id, so two pushes of
 *  the same SHA are one gate rather than two. */
export function ciGateWorkflowId(sha: string): string {
  return `ci-gate-${sha}`;
}

const { runCiGate } = proxyActivities<{
  runCiGate(input: CiGateInput): Promise<CiGateResult>;
}>({
  // The gate installs dependencies and builds apps/web on a 4-core box. Generous,
  // and far short of infinite: a gate that never times out is a pending status
  // that never resolves, and promote treats pending as "in flight".
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 1 },
});

export async function ciGate(input: CiGateInput): Promise<CiGateResult> {
  return await runCiGate(input);
}
