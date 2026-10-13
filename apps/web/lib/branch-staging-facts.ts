/**
 * The two facts the gate-2 notice needs (spec 0187 A): what the branch's
 * staging server last ran, and what the branch's head is right now.
 *
 * Reads the head from GITHUB, not from a local checkout — the same rule
 * `decideBranchPromote`'s caller follows, and for the same reason: a project
 * checkout's refs are only as fresh as the last fetch, and this notice exists
 * precisely to catch a staging server that is behind.
 *
 * Every hop is tolerant. An unresolvable head produces no notice, because "I
 * could not check" must never render as "your staging is stale".
 */
import { GithubClient } from "@launchpad/github";
import { branchByName, projectBySlug } from "@launchpad/db";
import { getDb } from "./db";
import type { StagingFreshnessFacts } from "./staging-freshness";

export async function branchStagingFacts(
  slug: string,
  branch: string,
): Promise<StagingFreshnessFacts | null> {
  try {
    const project = await projectBySlug(getDb(), slug);
    if (!project) return null;
    const row = await branchByName(getDb(), project.id, branch);
    if (!row) return null;
    const facts: StagingFreshnessFacts = {
      stagingSha: row.stagingSha,
      stagingStatus: row.stagingStatus,
      stagingNote: row.stagingNote,
    };
    // The SERVER token, as everywhere that only READS GitHub: the promoter's own
    // credential is for the merge, and this is a page render.
    const token = process.env["GITHUB_TOKEN"];
    if (!token || !project.repoOwner || !project.repoName) return facts;
    const head = await new GithubClient({
      token,
      owner: project.repoOwner,
      repo: project.repoName,
    })
      .getBranchHeadSha(branch)
      .catch(() => null);
    return head ? { ...facts, branchHead: head } : facts;
  } catch {
    return null;
  }
}
