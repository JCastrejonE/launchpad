/**
 * `pnpm --filter @launchpad/db seed-owner` — upsert the OWNER user.
 * Inputs via env, not argv (argv leaks into `ps`/shell history):
 *   LAUNCHPAD_OWNER_EMAIL, LAUNCHPAD_OWNER_NAME (optional), and
 *   LAUNCHPAD_OWNER_PASSWORD (plaintext here ONLY — hashed immediately,
 *   never stored or printed).
 */
import { createDb, createPool } from "./client.js";
import { hashPassword } from "./password.js";
import { seedOwner } from "./seed-owner.js";

const email = process.env["LAUNCHPAD_OWNER_EMAIL"];
const name = process.env["LAUNCHPAD_OWNER_NAME"] ?? "Owner";
const password = process.env["LAUNCHPAD_OWNER_PASSWORD"];

if (!email || !password) {
  console.error("set LAUNCHPAD_OWNER_EMAIL and LAUNCHPAD_OWNER_PASSWORD (and optionally LAUNCHPAD_OWNER_NAME)");
  process.exit(1);
}
if (password.length < 12) {
  console.error("LAUNCHPAD_OWNER_PASSWORD must be at least 12 characters");
  process.exit(1);
}

const pool = createPool();
try {
  await seedOwner(createDb(pool), { email, name, passwordHash: hashPassword(password) });
  console.log(`owner ${email} seeded`);
} finally {
  await pool.end();
}
