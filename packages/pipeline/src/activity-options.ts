/**
 * Temporal activity proxy options, extracted from workflow.ts so a plain unit
 * test can assert them (spec 0006 requires the agent-session activities to
 * declare a heartbeatTimeout — see activity-options.test.ts). Kept free of any
 * @temporalio/workflow import so it loads under `node --test`.
 *
 * Three profiles:
 *  - ACTIVITY_OPTIONS: the default for short, non-agent activities (git, CI,
 *    marking spec status).
 *  - AGENT_ACTIVITY_OPTIONS: for long-running agent-session activities
 *    (draftSpec, runInitializer, runCoder) — adds a heartbeatTimeout so a
 *    force-killed worker is detected in seconds and the activity is retried on
 *    restart, instead of stalling for the full startToCloseTimeout.
 *  - PR_APPROVAL_ACTIVITY_OPTIONS: for `awaitPrApproval` (spec 0015) — a
 *    heartbeating poll that can legitimately run for days (human-review
 *    timescale, same as the in-app gate signals), so it gets its own long
 *    startToCloseTimeout instead of the 30-minute default.
 */

/** Non-agent activities: short, no heartbeat needed. */
export const ACTIVITY_OPTIONS = {
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 3 },
} as const;

/** How often agent-session activities heartbeat while the SDK streams. A
 * force-killed worker is detected within ~2× this. */
export const AGENT_HEARTBEAT_TIMEOUT = "60 seconds";

/** Agent-session activities: long-running, must heartbeat. */
export const AGENT_ACTIVITY_OPTIONS = {
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: AGENT_HEARTBEAT_TIMEOUT,
  retry: { maximumAttempts: 3 },
} as const;

/** How often `awaitPrApproval`'s poll loop heartbeats — must comfortably
 * exceed the poll interval so a live poll isn't flagged as stalled between
 * iterations. */
export const PR_APPROVAL_HEARTBEAT_TIMEOUT = "5 minutes";

/** Error `type` that `awaitPrApproval` stamps on a genuinely-fatal failure
 * (missing token/owner, or a non-retryable `GithubApiError` such as 401/403) so
 * Temporal does NOT retry it. Everything else the poll throws is transient and
 * retried by {@link PR_APPROVAL_ACTIVITY_OPTIONS}'s policy. */
export const PR_APPROVAL_NONRETRYABLE_ERROR_TYPE = "PrApprovalFatalError";

/**
 * Gate-2 PR-approval poll (spec 0015): can run for as long as a human takes
 * to review on GitHub — the same "days if needed" timescale as the in-app
 * gate signals (see workflow.ts's module doc) — so it gets a long
 * startToCloseTimeout bounded at 30 days rather than the 30-minute default.
 *
 * Retry is UNBOUNDED with backoff (SPEC-ALIGNMENT §9.2), NOT `maximumAttempts:
 * 1`: an activity does not survive a worker restart, so with a single attempt a
 * routine redeploy/reboot during the multi-day wait fired the 5-minute
 * heartbeat timeout, failed the sole attempt, and permanently stopped
 * auto-detecting a GitHub merge — leaving the in-app signal as the only path
 * (the gate silently degraded on the common case). Retrying re-issues the
 * stateless poll on restart. `nonRetryableErrorTypes` keeps the original intent
 * for the case it was actually reaching for — a genuinely broken token no
 * longer loops forever, it fails fast — via the error type
 * `awaitPrApproval` stamps on fatal failures.
 */
export const PR_APPROVAL_ACTIVITY_OPTIONS = {
  startToCloseTimeout: "30 days",
  heartbeatTimeout: PR_APPROVAL_HEARTBEAT_TIMEOUT,
  retry: {
    initialInterval: "10 seconds",
    maximumInterval: "5 minutes",
    backoffCoefficient: 2,
    // Mutable on purpose: RetryPolicy wants string[], and a readonly tuple
    // (from the outer as const) is not assignable to it.
    nonRetryableErrorTypes: [PR_APPROVAL_NONRETRYABLE_ERROR_TYPE] as string[],
  },
  // `as const` like AGENT_ACTIVITY_OPTIONS above: Temporal's `Duration` is a
  // TEMPLATE-LITERAL string type (`${number} seconds` …), so these must stay
  // literals. Without it the object widens to `string` and stops compiling the
  // moment dependency hoisting resolves the stricter `ms` typings — which is
  // exactly how spec 0144 D's unrelated dependency add broke this file.
} as const;
