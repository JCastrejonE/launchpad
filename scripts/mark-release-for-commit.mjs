#!/usr/bin/env node
/**
 * Mark the release that NAMES a commit as deployed — or say plainly that none
 * does (spec 0213 D's sibling, added 2026-08-24).
 *
 * `mark-release-deployed.mjs` needs a version, and `deploy-here.sh` has one
 * because the Versiones panel passes it. A deploy run from a laptop has no
 * version, correctly: the owner's 2026-08-12 decision is that **automation never picks
 * a number the developer did not write**. So this does not invent one. It looks
 * for a candidate row whose `commitSha` IS the commit that was just verified,
 * and marks that.
 *
 * The other half matters more. When no row names the commit it SAYS SO, loudly,
 * because silence is how `project_releases` stopped at 1.0.13 while the box was
 * deployed many times past it — which quietly made CLAUDE.md's hard rule 9
 * ("every recorded defect names the release it was found on") impossible to
 * satisfy, and nobody noticed for a week.
 *
 * Usage: mark-release-for-commit.mjs <projectSlug> <sha> <actor> [deployRef]
 * Exit 0 whether or not a row was found — a laptop deploy without a named
 * version is normal, not an error. Exit 1 only on a real failure.
 */
// Imported by PATH, not by package name — scripts/ is not a workspace package,
// so Node cannot resolve "@launchpad/db" from here. The sibling file says this
// in a comment because getting it wrong killed a deploy at its very last step,
// and I wrote `from "@launchpad/db"` anyway on the first pass.
import {
  createDb,
  createPool,
  projectBySlug,
  listReleases,
  markDeployed,
} from "../packages/db/dist/index.js";

const [slug, sha, actor, deployRef] = process.argv.slice(2);
if (!slug || !sha || !actor) {
  console.error("usage: mark-release-for-commit.mjs <projectSlug> <sha> <actor> [deployRef]");
  process.exit(2);
}

const db = createDb(createPool());
try {
  const project = await projectBySlug(db, slug);
  if (!project) throw new Error(`no such project: ${slug}`);

  const releases = await listReleases(db, project.id, 200);
  const match = releases.find((r) => r.commitSha === sha);

  if (!match) {
    const latest = releases[0];
    console.log(
      `NOTE  no release row names ${sha.slice(0, 8)} — nothing marked.\n` +
        `      The version ledger is now behind the box` +
        (latest ? ` (latest row: ${latest.version}, ${latest.status}).` : ".") +
        `\n      Name a version in Versiones if this deploy should be citable, because` +
        `\n      "found on" in PENDING.md has no answer until one exists (hard rule 9).`,
    );
  } else if (match.status === "deployed") {
    console.log(`ok    ${slug}@${match.version} already marked deployed`);
  } else {
    await markDeployed(db, {
      projectId: project.id,
      releaseId: match.id,
      deployedBy: actor,
      ...(deployRef ? { deployRef } : {}),
    });
    console.log(`ok    marked ${slug}@${match.version} deployed (${sha.slice(0, 8)})`);
  }
} catch (err) {
  console.error(`mark-release-for-commit: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
process.exit(0);
