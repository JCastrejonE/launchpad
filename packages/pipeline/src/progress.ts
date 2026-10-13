/**
 * Stall-detection "diff seam" (spec 0008). Spec 0007's runs 1-2 stalled
 * forever because ANY new commit — including a coder session that only
 * appended a handoff note — reset the stall counter, so two genuinely no-op
 * sessions never tripped the "stalled twice ⇒ gate 2" branch.
 *
 * The fix redefines what "the session made progress" means, and pulls the
 * decision out of the activity (runCoder) into this pure, unit-testable
 * function — the same split as loop.ts's coderLoopDecision. runCoder gathers
 * the raw diff facts (via git.changedFiles + a checked-box count delta) and
 * asks this function; nothing here does I/O.
 *
 * Progress rule (spec 0008): a session progressed iff its commits either
 *   - changed at least one checkbox in the spec's Plan/Progress (checkboxDelta
 *     is non-zero — a box went from `- [ ]` to `- [x]` or vice-versa), OR
 *   - touched any file other than this spec's own markdown file.
 * A handoff-only commit (touches just the spec file, flips no checkbox) is
 * therefore `progressed: false` — two in a row exit the loop to gate 2 with
 * the blocker surfaced in the PR body.
 *
 * SPEC 0113 adds a third disjunct: a **justified plan revision** counts as
 * progress. Measured cause: across 8 coder sessions the plan was revised zero
 * times, and this function is part of why — a session that rewrote the checklist
 * without ticking a box touched only the spec file and so read as a stall. We had
 * built an incentive against the one thing the loop most needs, and spec 0107's
 * coder consequently diverged *silently* (it reordered `deriveNextStep` and pinned
 * the wrong behaviour as an "invariant") instead of revising the plan out loud.
 *
 * The tradeoff, stated rather than hidden: a revision resets the stall counter, so
 * an agent that revised forever would no longer be caught by the stall branch. It
 * would still be caught by `coderLoopDecision`'s `iterations >= maxIterations`
 * budget cap, which routes to gate 2 with the remaining items in the PR body. So
 * this trades stall-detection SPEED for the ability to revise at all; it does not
 * remove the bound.
 */

/** Raw facts about what a coder session's commits changed — everything
 * `sessionProgressed` needs, and nothing it has to compute. `runCoder` fills
 * this in from git (changed files) and the store (checked-box counts). */
export interface SessionDiff {
  /** Repo-relative paths changed across the session's commits
   * (`git diff --name-only <before>..<after>`). Empty ⇒ no commit at all. */
  changedFiles: string[];
  /** Net change in the number of checked `- [x]` boxes in the spec across the
   * session (countChecked(after) - countChecked(before)); non-zero means at
   * least one Plan/Progress item was checked or unchecked. */
  checkboxDelta: number;
  /** Repo-relative path of THIS spec's markdown file, so a handoff-only commit
   * (which touches only this path) can be told apart from real code changes.
   * Must be repo-relative to match `changedFiles` entries. */
  specFile: string;
  /**
   * True when the session committed a justified plan revision (spec 0113) —
   * `runCoder` sets this from the commit subject marker `revise plan`, which
   * `agents/coder.md` instructs a coder to use when it finds an item already
   * built, superseded, or wrong in light of the code.
   *
   * Deliberately a commit-message signal, not a diff heuristic: a revision that
   * swaps one wrong item for one right item is count-neutral, so no structural
   * diff test can see it, and that is the single most valuable revision there is.
   */
  planRevised?: boolean;
}

/**
 * Whether a coder session made real progress (see module doc). Pure.
 * progressed iff checkboxDelta !== 0 OR changedFiles contains any path other
 * than specFile.
 */
export function sessionProgressed(diff: SessionDiff): boolean {
  if (diff.checkboxDelta !== 0) return true;
  // Spec 0113: correcting the plan IS forward motion. See the module doc for the
  // stall-speed tradeoff this accepts.
  if (diff.planRevised === true) return true;
  return diff.changedFiles.some((f) => f !== diff.specFile);
}

/**
 * Commit-subject marker for a justified plan revision (spec 0113), e.g.
 * `docs(spec-0113): revise plan — item 2 was already built by spec 0104`.
 * Exported so `runCoder` and the tests agree on one spelling.
 */
export const PLAN_REVISION_MARKER = "revise plan";

/** True when any of the session's commit subjects marks a plan revision. */
export function commitsMarkPlanRevision(subjects: readonly string[]): boolean {
  return subjects.some((s) => s.toLowerCase().includes(PLAN_REVISION_MARKER));
}
