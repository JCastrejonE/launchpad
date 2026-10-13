/**
 * `pnpm --filter @launchpad/db seed-projects [tenantId…]` — upsert the platform
 * project (always) plus an `odoo` project for each tenant id passed in argv.
 * Tenant ids are not secrets, so argv (not env) is fine here — unlike the
 * owner password in seed-owner. Idempotent (upsert by slug).
 */
import { createDb, createPool } from "./client.js";
import { projectForTarget, seedPlatformProject, upsertProject } from "./projects.js";

const tenantIds = process.argv.slice(2).filter((a) => !a.startsWith("-"));

const pool = createPool();
try {
  const db = createDb(pool);
  await seedPlatformProject(db);
  console.log("seeded project: platform");
  for (const tenantId of tenantIds) {
    await upsertProject(db, projectForTarget({ kind: "tenant", tenantId }));
    console.log(`seeded project: ${tenantId} (odoo)`);
  }
} finally {
  await pool.end();
}
