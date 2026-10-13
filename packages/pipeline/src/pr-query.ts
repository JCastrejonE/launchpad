/**
 * Name of the Temporal query apps/web calls to read the workflow's current
 * `PullRequestRef` (spec 0015 item 8) — mirrors phase.ts's
 * `PIPELINE_PHASE_QUERY` split so the `defineQuery` in workflow.ts and the
 * `handle.query(...)` call in apps/web/lib/pipeline.ts never drift apart.
 * Its own tiny module (rather than folded into phase.ts) since it's about
 * the PR ref, not the workflow's phase.
 */
export const PIPELINE_PR_QUERY = "pipelinePr";

/**
 * Last-known state of the gate-2 approval poll (spec 0016, folding 0018's
 * deferral). Today a failed `awaitPrApproval` poll is swallowed by design —
 * `workflow.ts` logs "gate-2 approval poll failed" via `log.warn` and gate 2
 * silently degrades to signal-only. This query exposes that failure so both
 * the chat PR link card and the spec page's gate-2 block can render a loud
 * "a GitHub merge will NOT be auto-detected" badge instead of the operator
 * finding out only from worker.log.
 *
 *  - "idle":    gate 2 not open yet (or a local-diff PR with no poll).
 *  - "polling": `awaitPrApproval` is running.
 *  - "settled": the poll resolved (approved/rejected) — it did its job.
 *  - "failed":  the poll rejected with a NON-cancellation error, i.e. it
 *               genuinely broke (`error` carries the message). A cancellation
 *               (the signal won the race and cancelled the losing poll) is
 *               NOT a failure and never sets this.
 *
 * Recorded by the existing `.then`/`.catch` handlers around `awaitPrApproval`
 * in `workflow.ts`; `awaitPrApproval` itself and its retry/attempt policy are
 * untouched (surfacing only — spec 0016 Non-goals).
 */
export interface Gate2PollState {
  status: "idle" | "polling" | "failed" | "settled";
  /** The failure message when `status === "failed"`, else `null`. */
  error: string | null;
}

/**
 * Name of the Temporal query apps/web (and `scripts/gate-watch.mjs`) call to
 * read the workflow's `Gate2PollState` — same `defineQuery`/`handle.query`
 * drift-guard rationale as `PIPELINE_PR_QUERY` above. Lives here alongside it
 * since both are about gate 2's PR surface.
 *
 * Bootstrap note (cf. 0017/0018/0019): this is workflow code, so it only
 * answers on runs started from the NEXT preflight restart — a run on an older
 * snapshot has no handler and callers must treat the query as unavailable
 * (fall back to "idle"/undefined), exactly as `pipelinePr` does for pre-0015
 * runs.
 */
export const GATE2_POLL_QUERY = "gate2Poll";

/** Query name for what gate 2 attested (spec 0118) — same bootstrap caveat as
 * `GATE2_POLL_QUERY` above: runs on an older snapshot have no handler, and callers
 * treat that as `undefined`. */
export const GATE2_ATTESTATION_QUERY = "gate2Attestation";
