/**
 * User seed (spec 0072, generalized in 0117): upsert-by-email so re-seeding
 * rotates the password or fixes the role without duplicating the row. The pure
 * value-builder is split out so validation is unit-testable without a database.
 *
 * Spec 0117 widened this from OWNER-only. Before it, the `users.role` enum had
 * three values and this file could produce exactly one of them — so a MEMBER
 * could not be created at all, and the role split it was gating would have been
 * untestable in a live system. `seedOwner` stays as the OWNER-shaped caller
 * (`pnpm seed-owner` is documented in CLAUDE.md and README).
 */
import { users } from "./schema.js";
import type { Db } from "./client.js";

/** Kept in step with `schema.ts`'s `userRole` pgEnum. */
export type SeedRole = "OWNER" | "MEMBER" | "VIEWER";

export interface UserSeed {
  email: string;
  name: string;
  /**
   * Must already be a ./password.js scrypt hash — never a plaintext.
   *
   * OPTIONAL since spec 0128 B2: GitHub OAuth is the only sign-in, so a row is an
   * *authorisation* and no longer carries a way to authenticate. Requiring a
   * password to pre-authorise a colleague would force whoever adds them to invent
   * a value nobody can ever use, and then store its hash forever.
   */
  passwordHash?: string | undefined;
  role: SeedRole;
}

export type OwnerSeed = Omit<UserSeed, "role">;

/** Validates and shapes the row values. Throws on a plaintext-looking
 * `passwordHash` so a CLI wiring mistake can't persist a raw password. */
export function userSeedValues(seed: UserSeed): typeof users.$inferInsert {
  const email = seed.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`user email ${JSON.stringify(seed.email)} is not a valid address`);
  }
  const name = seed.name.trim();
  if (!name) throw new Error("user name must be non-empty");
  // Absent is fine (0128 B2). Present-but-plaintext never is: storing what looks
  // like a password in a hash column is the mistake this guard exists for.
  if (seed.passwordHash !== undefined && !seed.passwordHash.startsWith("scrypt$")) {
    throw new Error("passwordHash is not a scrypt hash — refusing to store what looks like a plaintext");
  }
  // Explicit, not a cast: a typo'd role must not reach the DB as a value the
  // pgEnum rejects at insert time (or worse, a role nothing in the app grants).
  if (seed.role !== "OWNER" && seed.role !== "MEMBER" && seed.role !== "VIEWER") {
    throw new Error(`role ${JSON.stringify(seed.role)} is not one of OWNER, MEMBER, VIEWER`);
  }
  return { email, name, role: seed.role, passwordHash: seed.passwordHash };
}

/** OWNER-shaped caller — unchanged behaviour, kept because `seed-owner` is the
 * documented bootstrap command. */
export function ownerSeedValues(seed: OwnerSeed): typeof users.$inferInsert {
  return userSeedValues({ ...seed, role: "OWNER" });
}

export async function seedUser(db: Db, seed: UserSeed): Promise<void> {
  const values = userSeedValues(seed);
  await db
    .insert(users)
    .values(values)
    .onConflictDoUpdate({
      target: users.email,
      set: {
        name: values.name,
        role: values.role,
        // Only overwrite the hash when one was supplied: re-seeding a role must not
        // silently wipe an existing credential (0128 B2 leaves the column in place
        // until the cutover is settled).
        ...(values.passwordHash === undefined ? {} : { passwordHash: values.passwordHash }),
      },
    });
}

export async function seedOwner(db: Db, seed: OwnerSeed): Promise<void> {
  await seedUser(db, { ...seed, role: "OWNER" });
}
