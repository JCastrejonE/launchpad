/**
 * Spec-content source resolution (spec 0017 — worktree-per-run).
 *
 * While a run is active it works inside an isolated git worktree at
 * `.worktrees/spec-NNNN/`; the run's live spec file (status / plan / handoff
 * feed) lives THERE, not in the primary checkout (which never leaves main).
 * The detail page must therefore read the run's worktree copy when it exists
 * and fall back to the primary checkout otherwise. The inbox listing always
 * reads the primary checkout (main) — it never calls this.
 *
 * Kept as a PURE resolver so it's unit-testable without touching disk: callers
 * pass `worktreeExists`; the resolver only decides which directory to read from.
 */
import path from "node:path";
import { projectSpecsDir } from "@launchpad/pipeline";
import { repoRoot, specsDir } from "./specs";
import { PLATFORM_PROJECT_SLUG } from "./spec-project";

/**
 * Absolute path of the per-run worktree for `specId`
 * (`<repoRoot>/.worktrees/spec-NNNN`). The worktree checkout the run's agents,
 * CI, and spec edits operate on (spec 0017 provisionEphemeralEnv).
 */
export function worktreeDir(specId: string, root: string = repoRoot()): string {
  return path.join(root, ".worktrees", `spec-${specId}`);
}

/** The `specs/` directory inside a run's worktree (where its live spec file
 * lives during the run). */
export function worktreeSpecsDir(specId: string, root: string = repoRoot()): string {
  return path.join(worktreeDir(specId, root), "specs");
}

/**
 * Directory to read a spec's markdown from FOR THE DETAIL PAGE: the run's
 * worktree `specs/` when that worktree exists, else the primary checkout's
 * `specs/`. Pure — the caller supplies `worktreeExists` (a cheap
 * `fs.existsSync(worktreeDir(...))`), so this is unit-testable with no disk.
 */
export function resolveSpecReadDir(opts: {
  specId: string;
  worktreeExists: boolean;
  primarySpecsDir?: string;
  worktreeSpecsDir?: string;
}): string {
  if (opts.worktreeExists) {
    return opts.worktreeSpecsDir ?? worktreeSpecsDir(opts.specId);
  }
  return opts.primarySpecsDir ?? specsDir();
}

/**
 * Spec 0149: the directory holding THIS project's spec `.md` files.
 *
 * The platform's specs are committed in this repo; every other project's live
 * outside any repository (spec 0141), under the specs root. One function, so
 * the page that READS a spec and the action that WRITES its status can never
 * disagree about which of the two it is in.
 *
 * Returns null only when the platform root is unset — a config error the caller
 * reports rather than guessing around.
 */
export function specsDirForProject(
  projectSlug: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (projectSlug !== PLATFORM_PROJECT_SLUG) {
    return projectSpecsDir(projectSlug, env as NodeJS.ProcessEnv);
  }
  const root = env["LAUNCHPAD_REPO_ROOT"];
  return root ? path.join(root, "specs") : null;
}
