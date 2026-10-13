/**
 * Name of the Temporal query apps/web calls to read a running workflow's
 * deploy target (spec 0033) — the `PipelineInput.target` the run was started
 * with (`{ kind, tenantId?, vpsId?, odooVersion?, repo }`). Mirrors
 * phase.ts's `PIPELINE_PHASE_QUERY` and pr-query.ts's `PIPELINE_PR_QUERY`
 * split so the `defineQuery` in workflow.ts and the `handle.query(...)` call
 * in apps/web (lib/pipeline.ts / lib/fleet.ts) never drift apart.
 *
 * /fleet (spec 0033 scope A) lists RUNNING `specPipeline` executions via
 * Temporal visibility and queries each for `pipelineTarget`, then indexes by
 * `target.vpsId` so a host card can link to the spec currently deploying into
 * it. The query is READ-ONLY — it returns a value already in workflow state
 * (`input.target`), adds no side effect, and carries no determinism/versioning
 * risk (spec 0033 Scope A).
 *
 * Bootstrap note (cf. pipelinePr/gate2Poll): this is workflow code, so it only
 * answers on runs started from the NEXT preflight restart — a run on an older
 * snapshot has no handler and callers must treat the query as unavailable
 * (yield no host mapping for that run), never crash.
 *
 * Its own tiny module (rather than folded into phase.ts/pr-query.ts) since
 * it's about the run's target, not its phase or PR surface. The result type is
 * `PipelineTarget`, already defined in spec.ts.
 */
export const PIPELINE_TARGET_QUERY = "pipelineTarget";
