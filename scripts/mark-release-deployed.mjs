#!/usr/bin/env node
/**
 * Record a platform deploy's OUTCOME on its release row (spec 0213 D).
 *
 * Called by deploy-here.sh, at the end, after the build stamp and the health
 * check have already passed — so the row is written from evidence rather than
 * from intent. The web action cannot do this itself: it returns long before the
 * deploy finishes, and a row written at click time would claim a result nobody
 * had yet.
 *
 * Usage: mark-release-deployed.mjs <projectSlug> <version> <deployedBy> <ok|failed> [deployRef]
 */
// Imported by PATH, not by package name: this file lives in scripts/, which is
// not a workspace package, so Node cannot resolve "@launchpad/db" from here.
import {
  createDb,
  createPool,
  projectBySlug,
  releaseByVersion,
  markDeployed,
  markDeployFailed,
} from "../packages/db/dist/index.js";

const [slug, version, deployedBy, outcome, deployRef] = process.argv.slice(2);
if (!slug || !version || !deployedBy || !outcome) {
  console.error("usage: mark-release-deployed.mjs <slug> <version> <deployedBy> <ok|failed> [ref]");
  process.exit(2);
}

// createDb(createPool()), not getDb(): that helper belongs to apps/web, not to
// @launchpad/db. The first attempt imported it from the package and the deploy
// died at the very last step with "does not provide an export named 'getDb'" —
// after a successful build, restart and health check.
const db = createDb(createPool());
const project = await projectBySlug(db, slug);
if (!project) throw new Error(`no such project: ${slug}`);
const release = await releaseByVersion(db, project.id, version);
if (!release) throw new Error(`no such version: ${version}`);

if (outcome === "ok") {
  await markDeployed(db, {
    projectId: project.id,
    releaseId: release.id,
    deployedBy,
    ...(deployRef ? { deployRef } : {}),
  });
  console.log(`marked ${slug}@${version} deployed`);
} else {
  await markDeployFailed(db, release.id, deployedBy);
  console.log(`marked ${slug}@${version} failed`);
}
process.exit(0);
