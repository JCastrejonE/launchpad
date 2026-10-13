/**
 * User queries (spec 0073). Lives here — not in apps/web — so drizzle stays
 * confined to this package (one DB layer; web code doesn't hand-write SQL).
 */
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { users } from "./schema.js";

export type UserRow = typeof users.$inferSelect;

/** Case-preserving exact-match lookup; callers normalize (seed + auth both
 * lowercase emails, so the stored value is already canonical). */
export async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0] ?? null;
}

/**
 * Record the GitHub identity that claimed this row (spec 0128 B).
 *
 * Idempotent by email, and it does NOT clear an existing link: overwriting one
 * would be the identity transfer `admitGithubSignIn` exists to refuse, so the
 * admission check decides whether this is allowed and this only writes the
 * result.
 */
export async function linkGithubIdentity(
  db: Db,
  email: string,
  identity: { login: string; githubId: string },
): Promise<void> {
  await db
    .update(users)
    .set({ githubLogin: identity.login, githubId: identity.githubId })
    .where(eq(users.email, email));
}
