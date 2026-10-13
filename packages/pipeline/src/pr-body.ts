/**
 * Pure builder for the pull-request body (spec 0006; reshaped by spec 0042
 * item C). Kept separate from the openPullRequest activity so it can be
 * unit-tested without any git/fs I/O.
 *
 * The body leads with `Spec <id>: <title>` and the spec's verbatim `##
 * Intent` goal paragraph (deterministic md-parse, no LLM/paraphrase), then
 * surfaces what a human needs at gate 2:
 *  - When the loop arrived here via stall detection (not clean convergence),
 *    a prominent "coder loop stalled" note plus the last handoff entry, so the
 *    reviewer knows the diff may be incomplete.
 *  - A `## Key changes` bullet list of completed `## Progress` items.
 * There is deliberately NO "Waiting on you" section here (the owner's directive) —
 * `(human)` pending items still surface on the Forge web spec-detail page
 * (`apps/web/lib/specs.ts`'s own `humanPendingItems`), just not in the PR
 * description.
 */

export interface PrBodyInput {
  specId: string;
  /** Frontmatter `title:` value; "" falls the lead line back to bare `Spec <id>`. */
  title: string;
  /** Verbatim first paragraph of `## Intent` (store.intentGoal); "" omits the goal line. */
  goal: string;
  /** Completed `## Progress` item texts (store.completedProgressItems), rendered as bullets. */
  keyChanges: string[];
  /** True when the loop reached gate 2 via stall detection, not convergence. */
  stalled: boolean;
  /** The spec's most recent Handoff log entry (store.lastHandoffEntry). */
  lastHandoff: string;
  /** Spec 0138: the recorded reason CI did not run (no Node toolchain) — the
   * absence of evidence, kept visible where the reviewer reads. */
  ciNote?: string;
}

/** Render the PR body markdown. */
export function buildPullRequestBody(input: PrBodyInput): string {
  const lead = input.title ? `Spec ${input.specId}: ${input.title}` : `Spec ${input.specId}`;
  const sections: string[] = [lead];

  if (input.goal) {
    sections.push(input.goal);
  }

  if (input.stalled) {
    sections.push(
      "> ⚠️ **Coder loop stalled** — the loop parked here after two " +
        "consecutive sessions produced no new commit (CI was green). The " +
        "diff may be incomplete; please review before approving.\n\n" +
        `Last handoff entry:\n\n${input.lastHandoff || "(none)"}`,
    );
  }

  if (input.ciNote) {
    sections.push(`> ℹ️ ${input.ciNote}`);
  }

  if (input.keyChanges.length > 0) {
    const items = input.keyChanges.map((item) => `- ${item}`).join("\n");
    sections.push(`## Key changes\n\n${items}`);
  }

  return sections.join("\n\n");
}
