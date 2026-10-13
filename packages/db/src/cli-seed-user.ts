/**
 * `pnpm --filter @launchpad/db seed-user` — upsert a user at any role
 * (spec 0117). The sibling of `seed-owner`, which can only ever make an OWNER;
 * v0 puts three people on one Launchpad, so MEMBER and VIEWER need a way in.
 *
 * Inputs via env, not argv (argv leaks into `ps` and shell history):
 *   LAUNCHPAD_USER_EMAIL, LAUNCHPAD_USER_ROLE (OWNER|MEMBER|VIEWER),
 *   LAUNCHPAD_USER_NAME (optional), and LAUNCHPAD_USER_PASSWORD (plaintext
 *   here ONLY — hashed immediately, never stored or printed).
 *
 * The role is REQUIRED with no default. A defaulted role is how you end up
 * granting OWNER by omission, and the failure is silent.
 */
import { createDb, createPool } from "./client.js";
import { hashPassword } from "./password.js";
import { seedUser, type SeedRole } from "./seed-owner.js";

const email = process.env["LAUNCHPAD_USER_EMAIL"];
const name = process.env["LAUNCHPAD_USER_NAME"] ?? "User";
const password = process.env["LAUNCHPAD_USER_PASSWORD"];
const role = process.env["LAUNCHPAD_USER_ROLE"];

if (!email || !role) {
  console.error(
    "set LAUNCHPAD_USER_EMAIL and LAUNCHPAD_USER_ROLE (OWNER|MEMBER|VIEWER; " +
      "optionally LAUNCHPAD_USER_NAME, and LAUNCHPAD_USER_PASSWORD which is no " +
      "longer used for sign-in — see spec 0128 B2)",
  );
  process.exit(1);
}
// Spec 0128 B2: GitHub OAuth is the only sign-in, so this command's job is
// AUTHORISATION — the row is the allowlist, and the GitHub identity claims it on
// first sign-in. A password is therefore optional; when one is given it still has
// to be a real one, since a 6-character "temporary" password outlives every
// intention to change it.
if (password !== undefined && password.length < 12) {
  console.error("LAUNCHPAD_USER_PASSWORD, if given at all, must be at least 12 characters");
  process.exit(1);
}
if (role !== "OWNER" && role !== "MEMBER" && role !== "VIEWER") {
  console.error(`LAUNCHPAD_USER_ROLE must be OWNER, MEMBER or VIEWER (got ${JSON.stringify(role)})`);
  process.exit(1);
}

const pool = createPool();
try {
  await seedUser(createDb(pool), {
    email,
    name,
    ...(password === undefined ? {} : { passwordHash: hashPassword(password) }),
    role: role as SeedRole,
  });
  console.log(
    `user ${email} authorised as ${role}` +
      (password === undefined ? " (no password — they sign in with GitHub)" : ""),
  );
} finally {
  await pool.end();
}
