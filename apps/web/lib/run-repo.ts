/**
 * Which checkout does a run operate on? (spec 0126 D — 0116's deferred item)
 *
 * Until now `startPipeline` hardcoded `process.env.LAUNCHPAD_REPO_ROOT`, so every
 * run — whatever project it belonged to — cut its worktrees from the launchpad's
 * own checkout. `activities.ts` even carries the TODO: *"point tenant runs at
 * real per-tenant repos instead of the launchpad checkout"*. This is that.
 *
 * Two things a project can hold, and they are NOT the same fact:
 *   - `repoRoot` — a path on the worker's filesystem. What git worktrees, the
 *     merge and the agent sessions need.
 *   - `repoOwner`/`repoName` — GitHub coordinates. What the PR calls need.
 *
 * Only `repoRoot` is resolved here, and deliberately so: the pipeline derives the
 * GitHub coordinates from the checkout's OWN `origin` remote
 * (`git remote get-url origin`, see `resolvePrMode`). Pointing a run at the right
 * checkout therefore carries the right PR target automatically — plumbing
 * owner/name separately would create a second source of truth that could disagree
 * with the remote the branch is actually pushed to.
 *
 * Pure. The caller supplies the project row, the fallback and the filesystem
 * check, so every rule here is unit-testable.
 */
import { repoIdentityFor, type ProjectRow } from "@launchpad/db";
import { checkoutPathFor } from "@launchpad/pipeline";

/** The subset of a project row this decision reads. */
export type ProjectRepoFacts = Pick<ProjectRow, "slug" | "repoRoot" | "repoOwner" | "repoName"> & {
  /** `platform` keeps its specs committed; other kinds exclude them (spec 0129). */
  kind?: string | null;
};

export type RunRepoResolution =
  | { ok: true; root: string; fromFallback: boolean }
  | { ok: false; problem: string };

/**
 * Resolve the checkout a run should use.
 *
 * The interesting case is the one a project created through `/new` is in: it has
 * GitHub coordinates but no `repoRoot`, because nothing has cloned it yet.
 * Falling back to the launchpad's checkout there would be actively wrong — the
 * run would edit THIS repo while claiming to work on the customer's — so it is
 * refused with a message that says what is missing. Silence would produce commits
 * in the wrong repository.
 */
export function resolveRunRepoRoot(
  project: ProjectRepoFacts | null,
  fallbackRoot: string | undefined,
): RunRepoResolution {
  if (!project) {
    // No project row for this spec's `tenant:`. The platform/dogfood case and
    // any spec whose project has not been created yet both land here, and the
    // launchpad's own checkout is the honest answer for both.
    if (!fallbackRoot?.trim()) return { ok: false, problem: "LAUNCHPAD_REPO_ROOT no está configurado." };
    return { ok: true, root: fallbackRoot.trim(), fromFallback: true };
  }

  const identity = repoIdentityFor(project, fallbackRoot);
  if (!identity) {
    return { ok: false, problem: `El proyecto "${project.slug}" no tiene un checkout y no hay LAUNCHPAD_REPO_ROOT.` };
  }

  // A GitHub repo is linked but the row has no checkout yet. Spec 0126 D refused a
  // run here, because falling back to the launchpad's own checkout would produce
  // commits in the WRONG repository. Spec 0129 B removes the need to refuse: the
  // path is derived from the slug and the run's FIRST activity clones it, so this
  // returns where the checkout WILL be rather than where it already is.
  //
  // Deriving the path is pure; creating it is minutes of network and disk on the
  // worker. That split is the whole reason this stays a refusal-free pure function.
  if (identity.fromFallback && project.repoOwner && project.repoName) {
    return { ok: true, root: checkoutPathFor(project.slug), fromFallback: false };
  }

  return { ok: true, root: identity.root, fromFallback: identity.fromFallback };
}
