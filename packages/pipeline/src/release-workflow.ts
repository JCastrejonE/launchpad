/**
 * The release-deploy workflow (spec 0170).
 *
 * Thin on purpose: one activity, because everything it needs — fleet SSH, the
 * Hostinger token, tenant DB passwords — is worker-only, and a workflow may hold
 * no side effects of its own.
 */
import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import type { DeployReleaseInput, DeployReleaseResult } from "./release-deploy.js";
import { backupStampFor } from "./backup-stamp.js";

/**
 * The workflow TYPE apps/web passes to `client.workflow.start`, and the name the
 * worker registers this export under. A string constant, never a function
 * reference: a production minifier renames the reference and Temporal looks up a
 * type no worker serves (VERIFICATION #10 — nine hours of production retries).
 */
export const DEPLOY_RELEASE_WORKFLOW = "deployReleaseWorkflow";

const { deployReleaseActivity } = proxyActivities<{
  deployReleaseActivity(input: DeployReleaseInput): Promise<DeployReleaseResult>;
}>({
  // A production deploy installs Odoo modules and can run migrations; it is slow
  // and must not be cut off mid-migration.
  startToCloseTimeout: "45 minutes",
  retry: { maximumAttempts: 1 },
});

export async function deployReleaseWorkflow(
  input: DeployReleaseInput,
): Promise<DeployReleaseResult> {
  return await deployReleaseActivity({
    ...input,
    backupTimestamp: backupStampFor(workflowInfo().startTime),
  });
}
