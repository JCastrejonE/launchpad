/**
 * Local↔origin branch reconciliation for branch-model runs (spec 0133
 * decision 3). Runs SHARE the branch and each cuts its own worktree from it,
 * so before a worktree can check the branch out, the local ref must be
 * brought to a state a run may build on:
 *
 *  - missing locally            → created at origin's tip
 *  - behind origin only         → fast-forwarded (`git fetch origin B:B`,
 *                                 which refuses non-ff by construction)
 *  - AHEAD of origin only       → tolerated: a crashed run's unpushed commits
 *                                 ride along and get pushed at gate 2
 *  - diverged (ahead AND behind)→ refused; a rebase here would strand the
 *                                 worktree mid-operation, so the operator
 *                                 decides
 *  - missing on origin          → refused; another attempt cannot create a
 *                                 ref someone deleted — recreate it in the UI
 *
 * Results are a discriminated union, NOT thrown Temporal failures — this
 * module stays importable anywhere (tests exercise it against real git); the
 * activity maps reasons to retryable/non-retryable ApplicationFailures.
 */
import { run, git } from "./git.js";

export type BranchSyncResult =
  /** Local branch ready at `sha`; `ahead` > 0 means unpushed commits ride along. */
  | { ok: true; sha: string; ahead: number }
  | { ok: false; reason: "missing_on_origin"; detail: string }
  | { ok: false; reason: "diverged"; ahead: number; behind: number }
  /** The branch's ref is held by a checkout (another run's worktree) — the
   * git-level serializer firing during sync instead of at worktree add. */
  | { ok: false; reason: "busy"; detail: string }
  /** Network/infrastructure — the retryable class. */
  | { ok: false; reason: "fetch_failed"; detail: string };

/** Git's own words for "no such ref on the remote" — a deleted branch, not an
 * outage. Both spellings observed across git versions. */
const MISSING_REMOTE_REF = /couldn't find remote ref|could not find remote ref/i;

/** Git's refusal to move a ref that a checkout currently holds. */
const CHECKED_OUT = /checked out|refusing to fetch into/i;

export async function ensureLocalBranchAtOrigin(
  root: string,
  branch: string,
): Promise<BranchSyncResult> {
  // Spec 0142: the PRIMARY checkout must not be sitting on the branch we are
  // about to cut a worktree for — git allows one checkout per branch, so it
  // would refuse with "already checked out" and the run would report the
  // branch busy when no run holds it.
  //
  // This is not hypothetical: a project chat (spec 0140) has git in its Bash
  // policy and works in this very checkout, so `git checkout <branch>` there
  // leaves the primary tree parked on it and blocks EVERY run of that branch
  // afterwards. Detaching is safe — the primary checkout is our workspace, its
  // HEAD carries no meaning between runs, and worktrees are what the pipeline
  // actually works in.
  const current = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  if (current.ok && current.out.trim() === branch) {
    const detach = await run("git", ["checkout", "--detach"], root);
    if (!detach.ok) return { ok: false, reason: "busy", detail: detach.out.trim() };
  }

  const fetch = await run("git", ["fetch", "origin", branch], root);
  if (!fetch.ok) {
    if (MISSING_REMOTE_REF.test(fetch.out)) {
      return { ok: false, reason: "missing_on_origin", detail: fetch.out.trim() };
    }
    return { ok: false, reason: "fetch_failed", detail: fetch.out.trim() };
  }

  let ahead = 0;
  if (!(await git.branchExists(root, branch))) {
    const create = await run("git", ["branch", branch, `origin/${branch}`], root);
    if (!create.ok) return { ok: false, reason: "fetch_failed", detail: create.out.trim() };
  } else {
    const counts = await run(
      "git",
      ["rev-list", "--left-right", "--count", `${branch}...origin/${branch}`],
      root,
    );
    if (!counts.ok) return { ok: false, reason: "fetch_failed", detail: counts.out.trim() };
    const [aheadRaw, behindRaw] = counts.out.trim().split(/\s+/);
    ahead = Number(aheadRaw ?? "0") || 0;
    const behind = Number(behindRaw ?? "0") || 0;
    if (ahead > 0 && behind > 0) return { ok: false, reason: "diverged", ahead, behind };
    if (behind > 0) {
      // Spec 0158: ask whether a worktree holds the branch instead of waiting
      // for git to refuse. Git only started refusing this fetch in 2.36; the
      // worker runs 2.34.1, where it SUCCEEDS and moves the ref under a running
      // worktree — the serializer this function exists to be, silently absent.
      const holder = await git.worktreeHoldingBranch(root, branch);
      if (holder) {
        return { ok: false, reason: "busy", detail: `branch ${branch} is checked out at ${holder}` };
      }
      const ff = await run("git", ["fetch", "origin", `${branch}:${branch}`], root);
      if (!ff.ok) {
        if (CHECKED_OUT.test(ff.out)) return { ok: false, reason: "busy", detail: ff.out.trim() };
        return { ok: false, reason: "fetch_failed", detail: ff.out.trim() };
      }
    }
  }

  const sha = await git.headSha(root, `refs/heads/${branch}`);
  return { ok: true, sha, ahead };
}
