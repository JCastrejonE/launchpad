/**
 * scrypt password hashing (spec 0072; consumed by the 0073 credentials
 * provider and the owner-seed CLI). node:crypto only — no native-module dep
 * (argon2) and no pure-JS bcrypt; scrypt is the built-in memory-hard KDF.
 *
 * Stored format (all parameters self-describing so they can be raised later
 * without invalidating existing hashes):
 *   scrypt$<N>$<r>$<p>$<salt b64>$<key b64>
 *
 * Parameters follow the OWASP password-storage cheat sheet for scrypt:
 * N=2^17, r=8, p=1, 32-byte key, 16-byte random salt (~64 MiB, ~100 ms —
 * a login-path cost, never a request-path cost).
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** scrypt needs maxmem > 128 * N * r; give it double for headroom. */
function maxmemFor(n: number, r: number): number {
  return 256 * n * r;
}

export function hashPassword(password: string): string {
  if (password.length === 0) throw new Error("refusing to hash an empty password");
  const salt = randomBytes(SALT_LENGTH);
  const key = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: maxmemFor(SCRYPT_N, SCRYPT_R),
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/**
 * Fail-closed verify: wrong password, malformed/truncated stored value,
 * unknown algorithm tag, or absurd parameters all return `false` — never
 * throw on user-supplied input (this sits directly on the login path).
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    // Bounds: reject parameters that are trivially weak or a memory-DoS
    // (a hostile stored value must not make the server allocate gigabytes).
    if (n < 2 ** 14 || n > 2 ** 20 || r < 1 || r > 16 || p < 1 || p > 4) return false;
    const salt = Buffer.from(parts[4] ?? "", "base64");
    const expected = Buffer.from(parts[5] ?? "", "base64");
    if (salt.length < 8 || expected.length < 16) return false;
    const actual = scryptSync(password, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: maxmemFor(n, r),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
