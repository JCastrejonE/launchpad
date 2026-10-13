/**
 * Pool + Drizzle client factories (spec 0072). Deliberately factories, not
 * module-level singletons: apps/web already learned the promise-poisoning
 * lesson in chat-store.ts, and workers/CLIs want their own lifecycle. A
 * `new Pool()` does not connect until first query, so constructing one at
 * startup is safe even before Postgres is up.
 */
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

/** Fails fast (throws) on a missing DATABASE_URL rather than letting pg fall
 * back to libpq defaults and fail obscurely on first query. */
export function createPool(env: Record<string, string | undefined> = process.env): pg.Pool {
  const connectionString = env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (see .env.example — the launchpad compose Postgres)");
  }
  return new pg.Pool({ connectionString });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}
