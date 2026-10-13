/**
 * Name of the Temporal query apps/web calls to read a running workflow's
 * BRANCH (spec 0133) — the `PipelineInput.branch` the run was started with,
 * or undefined for per-spec runs. Mirrors target-query.ts so the
 * `defineQuery` in workflow.ts and the `handle.query(...)` in apps/web never
 * drift apart.
 *
 * startPipeline's per-branch serialization (spec 0133 decision 4) lists
 * RUNNING `specPipeline` executions and asks each this query plus
 * `pipelineTarget`: same (repo, branch) ⇒ the new run is refused naming the
 * in-flight spec. Read-only, no determinism risk — the value is already in
 * workflow state.
 *
 * Bootstrap note (cf. pipelineTarget): a run on an older snapshot has no
 * handler; callers treat the query as unavailable — which reads as "no
 * branch", correct for every pre-0133 run by construction.
 */
export const PIPELINE_BRANCH_QUERY = "pipelineBranch";
