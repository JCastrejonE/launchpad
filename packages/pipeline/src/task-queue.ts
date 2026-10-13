/**
 * Task queue name shared by the worker and every client that talks to it
 * (the CLI, apps/web's lib/pipeline.ts). Lives in its own module — separate
 * from worker.ts — so clients can import it without pulling in
 * @temporalio/worker's native bindings.
 */
export const TASK_QUEUE = "spec-pipeline";

/**
 * The Temporal namespace this process belongs to (spec 0213 A).
 *
 * Lives here, beside the queue name and away from `@temporalio/worker`'s native
 * bindings, so it is importable and unit-testable from either side.
 *
 * WHY A NAMESPACE AND NOT A SECOND QUEUE NAME. The control plane is getting a
 * staging stack, which means a second worker on the same Temporal cluster. Both
 * halves must agree on where they are, and they can disagree in two ways:
 *
 *   - namespaces differ  -> nobody polls the queue the client wrote to, the run
 *     visibly sits there, and PRODUCTION IS UNTOUCHED. Fails closed.
 *   - queue names differ -> the client writes to `spec-pipeline`, which the
 *     PRODUCTION worker is polling, and Temporal hands it the task. Staging's
 *     run executes against production's checkout. Fails open.
 *
 * Only the first failure is survivable, so the boundary is the namespace. Kept
 * byte-identical to `apps/web`'s reader (`lib/env.ts`) on purpose: if the two
 * halves resolved it differently, that is precisely the disagreement above.
 */
export function temporalNamespace(env: Record<string, string | undefined> = process.env): string {
  return env["TEMPORAL_NAMESPACE"]?.trim() || "default";
}

/**
 * The workflow TYPE name, as a string — never `specPipeline` the function.
 *
 * Temporal identifies a workflow by the NAME of the function handed to
 * `client.workflow.start`. `apps/web`'s production bundle is MINIFIED, so
 * `specPipeline.name` there is `"P"`, and every run started from the deployed web
 * app registered as workflow type `P` — which no worker exports:
 *
 *   TypeError: Failed to initialize workflow of type 'P': no such function is
 *   exported by the workflow bundle
 *
 * It failed on a ~10 s retry loop for hours on production (2026-08-05). The defect
 * was LATENT for as long as only `cli start` (plain, unminified Node) started runs
 * from the UI's Start button; spec 0131 A routed that button through `apps/web` and
 * made it live. `startTenantPipeline` had it all along — the Hangar deploy form has
 * never worked against a production build.
 *
 * Passing the function is the natural thing to write and it type-checks, which is
 * why this constant exists next to the queue name instead of a comment asking
 * people to remember. Use it with the generic so the args stay type-checked:
 * `client.workflow.start<typeof specPipeline>(SPEC_PIPELINE_WORKFLOW_TYPE, …)`.
 */
export const SPEC_PIPELINE_WORKFLOW_TYPE = "specPipeline";

/** Spec 0134's explicit branch-staging op workflow — same rule, same reason:
 * the TYPE name as a string, never `branchStagingOp` the function. */
export const BRANCH_STAGING_WORKFLOW_TYPE = "branchStagingOp";

/** Spec 0228 C: the CI gate. A STRING, for the reason above — the minifier does
 *  not rename a string literal. Its id is `ciGateWorkflowId(sha)`, so two pushes
 *  of the same commit are one gate. */
export const CI_GATE_WORKFLOW_TYPE = "ciGate";
