/**
 * Pure auth logic (spec 0073): credentials authorization + JWT/session
 * shaping. Framework-free (no `next-auth` import — it's ESM-only and this
 * file must also compile as CJS for `node --test`; the same
 * lib-holds-the-logic split as supervisor-console.ts). The one NextAuth()
 * binding lives in app/auth.ts and delegates every decision here.
 */
import { verifyPassword, type UserRow } from "@launchpad/db";

export type UserRole = "OWNER" | "MEMBER" | "VIEWER";

/** What a successful sign-in yields — becomes the NextAuth `User`. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

/** Injectable I/O seam (real drizzle lookup + scrypt verify by default in
 * app/auth.ts; fakes in tests — the ChatToolDeps/SupervisorGateDeps pattern). */
export interface AuthorizeDeps {
  findUserByEmail: (email: string) => Promise<UserRow | null>;
  verify: (password: string, storedHash: string) => boolean;
}

/**
 * A real (but meaningless) scrypt hash verified when the email is unknown or
 * the row has no password, so "no such user" costs the same ~100 ms as
 * "wrong password" — response timing doesn't enumerate accounts. The preimage
 * is not a secret; only the work factor matters.
 */
export const TIMING_EQUALIZER_HASH =
  "scrypt$131072$8$1$Yr6jnIjxDZpIq+UspNC6RQ==$DcBUR7FkDvt4zWapRlOc5DttUmG/oud9QPFreGrJ8xI=";

/** Trim+lowercase an email-ish credential; null for non-strings and
 * obviously-not-an-email values (fail closed on FormData Files etc.). */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const email = input.trim().toLowerCase();
  return email.includes("@") ? email : null;
}

/**
 * The credentials-provider `authorize`. Fail-closed to `null` (never throw —
 * NextAuth turns throws into config errors, not sign-in failures) on:
 * non-string/empty input, unknown email, a row with no password hash (an
 * OAuth-only user can't password-sign-in), or a wrong password.
 */
export async function authorizeUser(
  emailInput: unknown,
  passwordInput: unknown,
  deps: AuthorizeDeps,
): Promise<AuthUser | null> {
  const email = normalizeEmail(emailInput);
  if (email === null || typeof passwordInput !== "string" || passwordInput.length === 0) {
    return null;
  }
  const user = await deps.findUserByEmail(email);
  if (!user?.passwordHash) {
    deps.verify(passwordInput, TIMING_EQUALIZER_HASH);
    return null;
  }
  if (!deps.verify(passwordInput, user.passwordHash)) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

/** Default deps for app/auth.ts (the drizzle lookup is bound there — it needs
 * the shared Db, which is app-side wiring, not logic). */
export const defaultVerify = verifyPassword;

/**
 * jwt-callback shaper: on sign-in (user present) stamp role + uid onto the
 * token; on later refreshes (user undefined) pass the token through.
 */
export function tokenWithUser<T extends object>(
  token: T,
  user: { id?: string; role?: UserRole } | undefined,
): T & { role?: UserRole; uid?: string } {
  if (!user?.role) return token;
  return { ...token, role: user.role, ...(user.id ? { uid: user.id } : {}) };
}

/**
 * session-callback shaper: only the three known roles pass through; anything
 * else (missing claim, tampered/stale token) degrades to VIEWER — least
 * privilege, never OWNER.
 */
export function sessionRoleFromToken(role: unknown): UserRole {
  return role === "OWNER" || role === "MEMBER" ? role : "VIEWER";
}
