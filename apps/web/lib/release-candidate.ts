/**
 * Recording a release candidate when main moves (spec 0170).
 *
 * "If you shipped now, this is what would go." Created at the moment the trunk
 * changes rather than when someone opens a panel, so a merge nobody watched
 * still produces a version you can point at.
 *
 * ## Where the version comes from, and why it differs by kind
 *
 * **Odoo kinds READ it from the manifests at that commit** (spec 0170 decision 1,
 * revised while building). Odoo migration scripts live in
 * `migrations/<manifest-version>/`, so the manifest version is the DEVELOPER's
 * statement, tied to a folder they wrote by hand. Automation choosing `1.4.3`
 * when they wrote `migrations/18.0.1.5.0/` means the migration never runs — the
 * bump would cause the exact failure versioning exists to prevent. So we record
 * their number instead of inventing ours.
 *
 * **Everything else allocates** a patch bump from the highest recorded version.
 * There is no manifest to be the source of truth, and nothing downstream keys off
 * the number.
 *
 * **And an Odoo-kind commit with no addon at all allocates too** (spec 0193). An
 * odoo-next project is a front AND an Odoo; a change to the website touches
 * neither a manifest nor a migration folder, so there is no developer statement
 * to respect and nothing for the reasoning above to protect. Throwing there —
 * which is what shipped — meant a customer whose changes are their website saw an
 * empty Versiones tab forever, with the reason only in a worker log. Found on A/B
 * run 5: `veterinaria`'s repo has no `__manifest__.py` anywhere, and the four runs
 * before it had all happened to add an addon.
 */
import { createCandidate, highestVersion, type ReleaseRow } from "@launchpad/db";
import { GithubClient } from "@launchpad/github";
import { nextVersion, releaseVersionFromManifests, usesOdooManifest } from "@launchpad/pipeline";
import type { getDb } from "./db";

/** `<addon>/__manifest__.py` or `<subdir>/<addon>/__manifest__.py`, nothing deeper
 * — the same depth rule `discoverAddons` and the CI scaffold use. */
export function manifestPathsIn(paths: readonly string[]): string[] {
  return paths
    .filter((p) => p.endsWith("__manifest__.py") && p.split("/").length <= 3)
    .sort();
}

/** The `version` string a manifest declares, or null. */
export function manifestVersionIn(source: string): string | null {
  const m = /["']version["']\s*:\s*["']([^"']+)["']/.exec(source);
  return m?.[1] ?? null;
}

export interface CandidateInput {
  projectId: string;
  commitSha: string;
  kind?: string | null;
  /** Owner/name, needed only for the Odoo path that reads manifests. */
  repoOwner?: string | null;
  repoName?: string | null;
  /** The project's Odoo major; 18 when unset, never assumed elsewhere. */
  odooSeries?: number;
  githubToken?: string | undefined;
  notes?: string;
  createdBy?: string;
}

/**
 * The whole version rule, as a pure function (spec 0193).
 *
 * Pulled out of the IO so it can be tested for what it DECIDES rather than for
 * the calls it makes — the shipped version could only be exercised against a
 * live GitHub tree, which is why the case that mattered was never covered.
 *
 * - `manifestCount === 0` → the commit carries no Odoo addon. That is a website
 *   change, not a failed read, so allocate a patch bump like any non-Odoo kind.
 * - manifests present → their declared version wins, and every 0170 refusal
 *   stands (disagreement, wrong series, malformed). A contradiction between two
 *   addons decides which module's migrations run; it must not be guessed.
 */
export function versionForCandidate(opts: {
  /** How many `__manifest__.py` files the commit's tree actually has. */
  manifestCount: number;
  /** The versions those manifests declare (a manifest may declare none). */
  declared: readonly string[];
  series: number;
  /** Highest version already recorded for this project, for the allocate path. */
  highest: string | null;
}): string {
  if (opts.manifestCount === 0) return nextVersion(opts.highest, "patch");
  const read = releaseVersionFromManifests(opts.declared, opts.series);
  if (!read.ok) throw new Error(`no se pudo leer la versión del manifiesto: ${read.problem}`);
  return read.version;
}

export async function createCandidateForCommit(
  db: ReturnType<typeof getDb>,
  input: CandidateInput,
): Promise<ReleaseRow> {
  let manifestCount = 0;
  const declared: string[] = [];

  if (usesOdooManifest(input.kind) && input.repoOwner && input.repoName && input.githubToken) {
    const client = new GithubClient({
      token: input.githubToken,
      owner: input.repoOwner,
      repo: input.repoName,
    });
    const tree = await client.listTreePaths(input.commitSha);
    if (tree.truncated) {
      // A partial tree could hide an addon, and a version read from part of the
      // repo is wrong in the only way that matters here.
      throw new Error("el árbol del repo vino truncado; no se puede leer la versión con certeza");
    }
    const manifests = manifestPathsIn(tree.paths);
    manifestCount = manifests.length;
    for (const path of manifests) {
      const source = await client.getFileText(path, input.commitSha);
      const version = source ? manifestVersionIn(source) : null;
      if (version) declared.push(version);
    }
  }

  const version = versionForCandidate({
    manifestCount,
    declared,
    series: input.odooSeries ?? 18,
    // Only read when the allocate path needs it.
    highest: manifestCount === 0 ? await highestVersion(db, input.projectId) : null,
  });

  return createCandidate(db, {
    projectId: input.projectId,
    version,
    commitSha: input.commitSha,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
  });
}
