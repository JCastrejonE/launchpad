/**
 * Pure coder-loop convergence logic (spec 0006). No I/O, fully unit-tested in
 * loop.test.ts — the workflow (workflow.ts) only wires this decision to the
 * activity calls. Keeping it here (not inside workflow.ts) means the branches
 * can be tested without pulling in @temporalio/workflow.
 */

/** What the coder loop should do next after a coder session + CI run. */
export type CoderLoopDecision = "continue" | "proceed_to_gate2" | "fail";

export interface CoderLoopState {
  /** Non-human unchecked plan items left (store.countUnchecked — excludes
   * `(human)` items). */
  remaining: number;
  /** Whether the latest CI run was green. */
  ciGreen: boolean;
  /** Consecutive coder sessions that produced NO new commit on the branch. */
  consecutiveStalls: number;
  /** Coder sessions already run this workflow. */
  iterations: number;
  /** Budget cap from PipelineInput (default 12). */
  maxIterations: number;
}

/**
 * Decide the coder loop's next move:
 *  - `proceed_to_gate2` when the work is done (remaining 0, CI green); OR the
 *    loop has stalled twice consecutively with CI green; OR the iteration
 *    budget is exhausted with CI green — in the latter two a human decides at
 *    gate 2, with the remaining/un-doable items and last handoff in the PR body.
 *  - `fail` when stalled with CI red, or the budget is exhausted with CI red.
 *  - `continue` otherwise.
 *
 */
export function coderLoopDecision(state: CoderLoopState): CoderLoopDecision {
  const { remaining, ciGreen, consecutiveStalls, iterations, maxIterations } =
    state;

  if (remaining === 0 && ciGreen) {
    return "proceed_to_gate2";
  }

  if (consecutiveStalls >= 2) {
    return ciGreen ? "proceed_to_gate2" : "fail";
  }

  if (iterations >= maxIterations) {
    // Budget exhausted: if CI is green, hand the partial (but working) branch
    // to a human at gate 2 — the same disposition as the stall branch above —
    // instead of tearing down a green branch. The remaining items surface in
    // the PR body via the workflow's `stalled = remaining !== 0`. Reserve
    // `fail` for budget-exhausted-with-red-CI (SPEC-ALIGNMENT §9.4).
    return ciGreen ? "proceed_to_gate2" : "fail";
  }

  return "continue";
}
