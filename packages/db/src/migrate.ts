/**
 * Migration runner (spec 0072): applies the committed `drizzle/` SQL folder
 * via drizzle-orm's migrator (tracked in the `__drizzle_migrations` table, so
 * re-running is a no-op). Run from a worker/CLI context only — apps/web must
 * never migrate at request time.
 */
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./client.js";

/** Resolves `packages/db/drizzle` relative to the compiled `dist/` file. */
export function migrationsFolder(): string {
  return fileURLToPath(new URL("../drizzle", import.meta.url));
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}
