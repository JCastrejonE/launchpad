/**
 * Shared control-plane Db (spec 0073). Lazy so importing this module never
 * throws on a missing DATABASE_URL — the error surfaces on first use, where
 * callers can handle it (the spec-0007 config-panel discipline). One pool per
 * process; chat-store.ts keeps its own until Phase B folds it in.
 */
import { createDb, createPool, type Db } from "@launchpad/db";

let cached: Db | null = null;

export function getDb(): Db {
  cached ??= createDb(createPool());
  return cached;
}
