#!/usr/bin/env node
/**
 * Add the platform owner to every existing project (spec 0190 B).
 *
 * `/new` does this for projects created from now on. Without a backfill the rule
 * would only be true going forward, which is the shape of a rule nobody can rely
 * on — and the project that prompted it (`client-b`, created by another user)
 * is one of the old ones.
 *
 * Idempotent: `putProjectMember` upserts on (project, user), so a second run
 * writes nothing new. Report-only by default; `--apply` performs the writes.
 *
 *   node scripts/backfill-default-owner.mjs            # report
 *   node scripts/backfill-default-owner.mjs --apply    # add the memberships
 *
 * Resolves @launchpad/db through its own package.json, like the other scripts
 * here (open-pipeline-workflows.mjs's reason: these deps belong to the workspace
 * packages, not the repo root).
 */
import { createRequire } from "node:module";

const dbRequire = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { createDb, createPool, listProjects, putProjectMember, userIdsByEmail, membershipFor } =
  dbRequire("./dist/index.js");

// Kept in step with apps/web/lib/project-access.ts's DEFAULT_PROJECT_OWNER. Two
// copies because a script cannot import from the Next app; the comment is the
// link, and there is exactly one other place to look.
const DEFAULT_PROJECT_OWNER = "owner@example.com";

const APPLY = process.argv.includes("--apply");

const pool = createPool();
try {
  const db = createDb(pool);
  const ids = await userIdsByEmail(db, [DEFAULT_PROJECT_OWNER]);
  const userId = ids.get(DEFAULT_PROJECT_OWNER);
  if (!userId) {
    console.error(`no account for ${DEFAULT_PROJECT_OWNER} — nothing to add`);
    process.exit(1);
  }

  const projects = await listProjects(db);
  let already = 0;
  const missing = [];
  for (const p of projects) {
    const role = await membershipFor(db, p.id, userId);
    if (role) {
      already += 1;
      continue;
    }
    missing.push(p);
  }

  for (const p of missing) {
    if (APPLY) {
      await putProjectMember(db, {
        projectId: p.id,
        userId,
        role: "owner",
        addedBy: "spec-0190 (default owner backfill)",
      });
    }
    console.log(`${APPLY ? "added" : "would add"} ${DEFAULT_PROJECT_OWNER} as owner of ${p.slug}`);
  }

  console.log(
    `backfill: ${projects.length} project(s), ${already} already owned, ${missing.length} ` +
      `${APPLY ? "added" : "pending (run with --apply)"}`,
  );
} finally {
  await pool.end();
}
