/**
 * Per-spec branch reconciliation against main (spec 0159).
 *
 * `git.worktreeAdd` reuses an existing `spec/<id>` branch AT ITS TIP (spec
 * 0017), which is right for resuming a run's own work but wrong across TIME: a
 * branch a run left behind days ago still points at the `main` it was cut from,
 * so the resumed run's CI runs OLD code — anything fixed on main since is still
 * broken inside the run, the fixer escalates a failure that no longer exists,
 * and the loop dies with `ci.green=false` (the 0147 incident, spec 0159 §The
 * mechanism).
 *
 * The cure is the reconciliation the BRANCH model already has
 * (`ensureLocalBranchAtOrigin`, spec 0133) that the per-spec path never got:
 * bring the branch up to `origin/main` before the run builds on it. Unlike the
 * branch model this must MERGE — the prior run's own commits are exactly what
 * resuming is for, so they must survive — and a merge needs a checkout, so this
 * runs INSIDE the worktree where `spec/<id>` is already checked out (spec 0159
 * decision 4's illustration reconciles the branch model BEFORE `worktreeAdd`;
 * the per-spec merge cannot, because there is nothing to merge into until the
 * worktree exists).
 *
 *  - already contains origin/main  → no-op (`up_to_date`; never an empty merge
 *                                    commit)
 *  - behind, no own commits        → fast-forward
 *  - behind, own commits           → merge `origin/main` in, keeping both
 *  - merge conflicts               → refused (`stale_conflict`), branch left
 *                                    UNCHANGED (the merge is aborted); a human
 *                                    resolves, never a silent auto-resolve —
 *                                    the `diverged` precedent in branch-sync.ts
 *
 * Results are a discriminated union, NOT thrown Temporal failures, so this
 * module stays importable anywhere (tests exercise it against real git); the
 * activity maps `stale_conflict` to a non-retryable ApplicationFailure.
 */
import { run } from "./git.js";

export type SpecBranchSyncResult =
  | { ok: true; action: "up_to_date" | "fast_forwarded" | "merged" }
  | { ok: false; reason: "stale_conflict"; paths: string[] };

/**
 * Reconcile the `spec/<id>` branch checked out at `workdir` with `origin/main`.
 *
 * Runs in the worktree (its HEAD is the branch). Fetches `origin/main` first so
 * the target is today's promoted code; if origin has no `main` (origin-less
 * dogfood setups) it is a safe no-op — a run must not be blocked where there is
 * no main to fall behind.
 */
export async function reconcileSpecBranchWithMain(
  workdir: string,
): Promise<SpecBranchSyncResult> {
  // Fetch today's promoted main. A colon-less refspec lands it in FETCH_HEAD;
  // we key every step off FETCH_HEAD so the result never depends on the
  // remote-tracking refspec. A missing origin/main (origin-less dogfood) fails
  // here — a safe no-op, since there is no main to fall behind.
  const fetch = await run("git", ["fetch", "origin", "main"], workdir);
  if (!fetch.ok) return { ok: true, action: "up_to_date" };

  // Already contains main → no-op, and crucially NO empty merge commit.
  const contained = await run(
    "git",
    ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"],
    workdir,
  );
  if (contained.ok) return { ok: true, action: "up_to_date" };

  // No own commits (HEAD is on main's history) → git fast-forwards; otherwise it
  // makes a merge commit that keeps the prior run's work (decision 1). git picks
  // ff-vs-merge itself; this only names the action we report.
  const noOwnCommits = await run(
    "git",
    ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"],
    workdir,
  );

  const merge = await run("git", ["merge", "--no-edit", "FETCH_HEAD"], workdir);
  if (merge.ok) {
    return { ok: true, action: noOwnCommits.ok ? "fast_forwarded" : "merged" };
  }

  // Conflict: name the unmerged paths, then abort to leave the branch UNCHANGED
  // — a human resolves, never a silent auto-resolve (the diverged precedent).
  const conflicted = await run(
    "git",
    ["diff", "--name-only", "--diff-filter=U"],
    workdir,
  );
  await run("git", ["merge", "--abort"], workdir);
  return {
    ok: false,
    reason: "stale_conflict",
    paths: conflicted.out.split("\n").map((l) => l.trim()).filter(Boolean),
  };
}
