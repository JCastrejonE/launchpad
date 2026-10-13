/**
 * Was the code in this release ever stood up on a staging server? (spec 0223.)
 *
 * The check this replaces asked `stagingSha === release.commitSha`, and those
 * two are never equal: promote merges with `merge_method: "merge"`, which always
 * creates a NEW commit, and the release is cut at that merge. So the panel
 * warned *"nunca se levantó en un staging"* on every release ever cut —
 * including ones validated on staging for hours (finding 7.10, run 7).
 *
 * The honest question is containment, not identity: is the commit someone stood
 * up and looked at an ANCESTOR of what is about to ship? That holds for a merge
 * commit, a fast-forward and a rebase alike, so it does not bake today's merge
 * method into the answer.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * @returns `true` when some recorded staging commit is contained in
 *   `commitSha`; `false` when there are staging commits and none is (or when
 *   nothing was ever staged — honestly "never staged"); `undefined` when git
 *   could not answer, which is NOT the same as no.
 */
export async function releaseWasStaged(
  repoRoot: string,
  stagingShas: readonly (string | null | undefined)[],
  commitSha: string,
): Promise<boolean | undefined> {
  const candidates = stagingShas.filter((s): s is string => !!s?.trim());
  // Nothing was ever staged on any branch. That is a real "no", not an
  // unanswered question — the warning it produces is the one true case.
  if (candidates.length === 0) return false;
  if (!repoRoot.trim()) return undefined;

  try {
    // Spec 0223 decision 4: fetch here rather than lean on `commitStillOnMain`
    // having run first. That works today and breaks silently the moment someone
    // reorders two lines.
    await exec("git", ["fetch", "origin", "main"], { cwd: repoRoot });
  } catch {
    return undefined;
  }

  let answered = false;
  for (const staged of candidates) {
    try {
      await exec("git", ["merge-base", "--is-ancestor", staged, commitSha], { cwd: repoRoot });
      return true;
    } catch (err) {
      // Exit 1 is git's honest "no, not an ancestor" — an answer. Anything else
      // (128 = unknown object) means the question was broken for THIS sha; keep
      // trying the others rather than reporting a no we did not establish.
      if ((err as { code?: number }).code === 1) answered = true;
    }
  }
  return answered ? false : undefined;
}
