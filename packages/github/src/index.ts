/**
 * GitHub integration. Two paths live here:
 *
 *  - The launchpad-repo dev path (spec 0015 / ADR-012): a real REST client
 *    (`GithubClient` in client.ts) authenticated with a fine-grained PAT
 *    (`GITHUB_TOKEN`), used to open/inspect/merge the launchpad's own PRs for
 *    gate 2. This is the concrete, tested path today.
 *  - The GitHub App integration (ADR-009, Phase 4): clients connect their
 *    GitHub account and install the App on their EXISTING repo, using
 *    short-lived installation tokens — never user PATs. The free functions
 *    below are the Phase-4 stubs for that flow and are NOT the gate-2 path.
 */

export * from "./client.js";
// Typed failures (kind + retryable) — exported so pipeline activities can map a
// GitHub failure to a retryable vs non-retryable Temporal ApplicationFailure,
// which is the whole reason errors.ts's doc says it exists (SPEC-ALIGNMENT §9.2).
export * from "./errors.js";
// Spec 0126 B: project linking VERIFIES the repo instead of storing two strings.
export * from "./repo-access.js";
// Spec 0128 C: a specific person's permission on a repo, asked with the server token.
export * from "./collaborator.js";
export { loadFixture } from "./fixtures.js";

export interface RepoRef {
  owner: string;
  repo: string;
  installationId: number;
}

export interface PrRef {
  repo: RepoRef;
  number: number;
  url: string;
}

/** OAuth-ish connect flow: user installs the App, we store installationId. */
export async function connectRepository(tenantId: string): Promise<RepoRef> {
  throw new Error(`TODO(phase-4): GitHub App install flow for ${tenantId}`);
}

/** Constructs the branch name a spec is developed on. Throws on an empty specId. */
export function specBranchRef(specId: string): string {
  if (specId.trim() === "") {
    throw new Error("specBranchRef: specId must not be empty");
  }
  return `spec/${specId}`;
}

// `createSpecBranch` (a phase-4 stub that only threw) was retired by spec
// 0133: real branch creation is `GithubClient.createBranchRef`, driven from
// the web's branch-create action — not the App-installation flow this block
// stubs.

export async function openPr(repo: RepoRef, specId: string, body: string): Promise<PrRef> {
  throw new Error(`TODO(phase-4): PR spec/${specId} -> production`);
}

export async function mergePr(pr: PrRef): Promise<void> {
  throw new Error(`TODO(phase-4): merge PR #${pr.number} (requires green checks)`);
}

/** Registers CI status (module install/upgrade + Odoo unit tests) on a SHA. */
export async function reportCheck(repo: RepoRef, sha: string, green: boolean): Promise<void> {
  throw new Error(`TODO(phase-4): check-run on ${sha}: ${green ? "success" : "failure"}`);
}
