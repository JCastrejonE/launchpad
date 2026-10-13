/**
 * Which repository does a Project's work happen in? (spec 0116)
 *
 * v0 serves a customer with **two GitHub repositories**, each with its own deploy
 * target. Before this, the repo was a single global `LAUNCHPAD_REPO_ROOT` read from
 * the worker env — one Launchpad, one repo.
 *
 * The pipeline layer was already ready: `repoRootOf(input)` is just
 * `input.target.repo`, so a run has always carried its own checkout path. The gap was
 * that nothing per-project ever supplied one. This closes that.
 *
 * PURE — takes a row and an env value, returns a value. No DB, no fs, so every branch
 * is unit-testable and it can be called from either side of the server boundary.
 */

/** The repo fields this resolver reads; a structural subset of a `projects` row so
 * callers can pass a full row or a projection. */
export interface ProjectRepoFields {
  slug: string;
  repoOwner?: string | null;
  repoName?: string | null;
  repoRoot?: string | null;
}

export interface RepoIdentity {
  /** Worker-local checkout the pipeline cuts worktrees from. */
  root: string;
  /** GitHub coordinates, when known. Absent for a project with no GitHub remote
   * configured — local-diff mode (ADR-012's offline fallback) still works. */
  owner?: string;
  name?: string;
  /** True when `root` came from the env fallback rather than the project row. */
  fromFallback: boolean;
}

/**
 * Resolve a project's repo identity, falling back to `LAUNCHPAD_REPO_ROOT`.
 *
 * The fallback is what keeps every pre-0116 project working unchanged: `platform`,
 * `acme`, `sandbox` and the rest have no repo columns, and the platform project's
 * repo genuinely *is* the env root — it is this repo, dogfooding itself. So the
 * fallback is not a migration shim to be removed later; it is the correct answer for
 * the platform project permanently.
 *
 * Returns `null` when neither a row value nor a fallback exists, rather than throwing
 * or inventing a path: the caller knows whether a missing repo is fatal (starting a
 * run) or merely means "nothing to show" (rendering a workspace).
 */
export function repoIdentityFor(
  project: ProjectRepoFields,
  fallbackRoot?: string | undefined,
): RepoIdentity | null {
  const root = project.repoRoot?.trim() || fallbackRoot?.trim();
  if (!root) return null;
  const owner = project.repoOwner?.trim();
  const name = project.repoName?.trim();
  return {
    root,
    // Only report GitHub coordinates when BOTH halves are present — an owner
    // without a name cannot address a repo, and half an identity is worse than
    // none because it reads as configured.
    ...(owner && name ? { owner, name } : {}),
    fromFallback: !project.repoRoot?.trim(),
  };
}

/** `owner/repo` for the GitHub API, or undefined when this project has no remote
 * configured. Kept beside the resolver so the two never disagree on what "has a
 * GitHub repo" means. */
export function githubSlugFor(identity: RepoIdentity | null): string | undefined {
  if (!identity?.owner || !identity.name) return undefined;
  return `${identity.owner}/${identity.name}`;
}
