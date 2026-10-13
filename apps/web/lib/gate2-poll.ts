/**
 * Shared, pure derivation for the gate-2 poll-health badge (spec 0016).
 *
 * When the workflow's `awaitPrApproval` poll has genuinely broken
 * (`Gate2PollState.status === "failed"`), a GitHub merge will NOT be
 * auto-detected — gate 2 has silently degraded to signal-only. Both the chat
 * PR link card AND the spec page's existing gate-2 PR block render a loud
 * badge from THIS one function, so the two surfaces never drift.
 *
 * Framework-free (no React) so it compiles under tsconfig.test.json and is
 * unit-testable with plain `node --test` — the JSX shells import the derived
 * result and render it. Never throws.
 */
import type { Gate2PollState } from "@launchpad/pipeline";

/** Rendered badge content. `null` from the derivation means "render nothing"
 * (the healthy/idle/unknown case). */
export interface Gate2PollBadge {
  /** The loud, operator-facing line. */
  message: string;
}

/** The exact copy the failed badge must show, per spec 0016 Scope. Exported
 * so the badge test and both JSX shells reference one string, not three
 * hand-copied ones. */
export const GATE2_POLL_FAILED_MESSAGE =
  "gate-2 poll failed: a GitHub merge will NOT be auto-detected; use the in-app/Temporal signal";

/**
 * Returns a badge ONLY when the gate-2 poll has failed, else `null`.
 *
 * `undefined` (query unavailable — a pre-0016 run with no handler, or a query
 * error) is treated the same as healthy: no badge. A missing signal must not
 * masquerade as a failure.
 */
export function deriveGate2PollBadge(poll: Gate2PollState | undefined): Gate2PollBadge | null {
  if (poll?.status !== "failed") return null;
  return { message: GATE2_POLL_FAILED_MESSAGE };
}
