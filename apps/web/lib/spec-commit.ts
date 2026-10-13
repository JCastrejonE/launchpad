/**
 * Commit a spec file the UI just wrote (spec 0160).
 *
 * ## The bug this exists to close
 *
 * The platform's specs are **git-tracked files in this repo** (spec 0141 moved
 * only a *project's* specs outside their checkout). So `setSpecArchivedAction`
 * and `completeProjectSpecAction` edited a tracked file in the shared primary
 * checkout and left it uncommitted — for two days, in the case that surfaced
 * this. The cost landed on an unrelated pipeline run: `mergePullRequest`'s
 * `assertCleanTree` refused, naming two spec files nobody connected to an
 * Archivar button pressed on Tuesday.
 *
 * Two rules make it safe to run from a web request:
 *
 *  - **Only the one file.** `git commit <pathspec>` commits that path and
 *    nothing else, whatever else is in the index or the tree. A run's in-flight
 *    work is never swept in.
 *  - **Best-effort.** The frontmatter edit already succeeded and is what the user
 *    asked for; failing their action because git was busy would be worse than a
 *    dirty file. Failures are logged, loudly enough to find.
 *
 * Not a substitute for a repo lock: the worker's `withRepoLock` is in-process and
 * a different process cannot take it. A single-path commit is the narrowest
 * write available, which is why it is the one used.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface SpecCommitResult {
  ok: boolean;
  /** Present when the commit did not happen; safe to log, never shown as an error. */
  problem?: string;
}

/**
 * Commit `file` inside `repoRoot` with `message`. A no-op that reports success
 * when the file has no changes staged or unstaged — the common case when a
 * status is rewritten to the value it already had.
 */
export async function commitSpecFile(
  repoRoot: string,
  file: string,
  message: string,
): Promise<SpecCommitResult> {
  const rel = path.relative(repoRoot, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, problem: `refusing to commit ${file}: outside ${repoRoot}` };
  }
  try {
    // Nothing changed ⇒ nothing to commit. `git commit` would exit 1 on an empty
    // commit and look like a failure; asking first keeps the log honest.
    const { stdout } = await exec("git", ["status", "--porcelain", "--", rel], { cwd: repoRoot });
    if (stdout.trim() === "") return { ok: true };
    await exec("git", ["add", "--", rel], { cwd: repoRoot });
    await exec(
      "git",
      ["-c", "user.name=launchpad", "-c", "user.email=owner@example.com", "commit", "-m", message, "--", rel],
      { cwd: repoRoot },
    );
    return { ok: true };
  } catch (err) {
    const problem = err instanceof Error ? err.message : String(err);
    console.warn(`commitSpecFile: ${rel} was written but not committed — ${problem}`);
    return { ok: false, problem };
  }
}
