/** `pnpm --filter @launchpad/db migrate` — apply pending migrations. */
import { createDb, createPool } from "./client.js";
import { runMigrations } from "./migrate.js";

const pool = createPool();
try {
  await runMigrations(createDb(pool));
  console.log("migrations applied");
} finally {
  await pool.end();
}
