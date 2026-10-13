/**
 * Commit-trailer enforcement (spec 0009). Every agent commit (initializer +
 * coder) must carry a `Co-Authored-By: Claude <model-id>` trailer for model
 * attribution — 0008's run landed it on only 3/6 commits, so we stop relying
 * on prompt hope and enforce it two ways:
 *
 *   1. commitTrailerInstruction(model) is appended to the role prompt by the
 *      session runner so the agent writes the trailer itself (the happy path).
 *   2. ensureCoAuthorTrailer(message, model) is the pure check/repair the
 *      runInitializer/runCoder activities use to message-only-amend the last
 *      commit when an agent forgot (the safety net). Message-only — commit
 *      CONTENT is never touched.
 *
 * Pure module (no git, no IO) so the check/repair logic is unit-tested in
 * commit-trailer.test.ts without needing a real repository. The git side
 * (reading the last commit message, `commit --amend -m`) lives in git.ts and
 * is wired together in activities.ts.
 */

/** The Co-Authored-By author name — the trailer reads
 * `Co-Authored-By: Claude <model-id>`. */
export const CO_AUTHOR_NAME = "Claude";

/** Matches any existing `Co-Authored-By: Claude <model-id>` trailer line,
 * regardless of model id. */
const CO_AUTHOR_TRAILER_RE = /^Co-Authored-By:\s*Claude\s+\S+/m;

/** The trailer line for a given model id, e.g.
 * `Co-Authored-By: Claude claude-sonnet-5`. */
export function coAuthorTrailer(model: string): string {
  return `Co-Authored-By: ${CO_AUTHOR_NAME} ${model}`;
}

/** True if `message` already carries a `Co-Authored-By: Claude <...>` trailer
 * (any model id) — the guard that keeps repair idempotent and avoids a second
 * trailer on a commit the agent already attributed. */
export function hasCoAuthorTrailer(message: string): boolean {
  return CO_AUTHOR_TRAILER_RE.test(message);
}

/**
 * Pure check/repair used by the verify-post-session step: returns the message
 * unchanged (`changed: false`) when it already carries the trailer, otherwise
 * the message with the trailer appended as a proper git trailer block
 * (`changed: true`). Never mutates commit content — the caller feeds the
 * returned message to a message-only `git commit --amend`.
 */
export function ensureCoAuthorTrailer(
  message: string,
  model: string,
): { changed: boolean; message: string } {
  if (hasCoAuthorTrailer(message)) {
    return { changed: false, message };
  }
  const trimmed = message.replace(/\s+$/, "");
  return {
    changed: true,
    message: `${trimmed}\n\n${coAuthorTrailer(model)}`,
  };
}

/**
 * Prompt suffix telling an agent to end every commit message with the
 * model-attribution trailer. Appended to the role prompt by the session runner
 * so the trailer is written at commit time (the safety-net amend then only
 * fires when the agent slips).
 */
export function commitTrailerInstruction(model: string): string {
  return (
    `Every commit you create in this session MUST end its commit message ` +
    `with the following trailer, on its own line after a blank line:\n\n` +
    `${coAuthorTrailer(model)}`
  );
}

// ---------------------------------------------------------------------------
// Trailer-coverage policy (spec 0010 item 3)
//
// Agent session commits must carry the trailer 100% of the time. Three commit
// classes are explicitly OUTSIDE that requirement so a coverage audit doesn't
// flag them: markSpec's own `chore(spec-NNNN): status -> *` status bumps,
// merge commits, and the human operator's own commits. The exemption predicate
// is pure so it's unit-tested (commit-trailer.test.ts).
// ---------------------------------------------------------------------------

/** Author email of the human operator whose own commits are exempt from
 * agent trailer-coverage checks (spec 0010 item 3). */
export const HUMAN_AUTHOR_EMAIL = "owner@example.com";

/** A commit as seen by the trailer-coverage checker. */
export interface CommitMeta {
  /** Full commit message (subject + body). */
  message: string;
  /** Author email. */
  authorEmail: string;
  /** Parent count — a merge commit has more than one (git `%P`). Optional so
   * callers that don't compute it default to non-merge. */
  parents?: number;
}

/** Matches a markSpec status-bump commit subject, e.g.
 * `chore(spec-0010): status -> promoted`. */
const MARK_SPEC_STATUS_RE = /^chore\(spec-\d+\):\s*status\s*->\s*\S+/m;

/**
 * True when `commit` is outside agent trailer-coverage (spec 0010 item 3):
 * a markSpec `chore(spec-NNNN): status -> *` status bump, a merge commit, or a
 * human commit (author {@link HUMAN_AUTHOR_EMAIL}). Agent session commits are
 * never exempt.
 */
export function isTrailerExempt(commit: CommitMeta): boolean {
  if ((commit.parents ?? 1) > 1) {
    return true;
  }
  if (commit.authorEmail === HUMAN_AUTHOR_EMAIL) {
    return true;
  }
  if (MARK_SPEC_STATUS_RE.test(commit.message)) {
    return true;
  }
  return false;
}

/**
 * Non-exempt commits that are missing the `Co-Authored-By` trailer
 * (spec 0010 item 3) — an empty array ⇒ 100% agent-commit coverage. Feeds the
 * coverage audit.
 */
export function trailerCoverageViolations(commits: CommitMeta[]): CommitMeta[] {
  return commits.filter((commit) => !isTrailerExempt(commit) && !hasCoAuthorTrailer(commit.message));
}
