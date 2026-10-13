/**
 * Who is asking, resolved once (spec 0128 A).
 *
 * Authorization needs three facts that live in two places: the session knows the
 * email and the control-plane role, and only the database knows the user's row
 * id — which is what membership is keyed on. Every scoped read needs all three,
 * so they are resolved here rather than re-derived at each call site with a
 * slightly different fallback.
 *
 * Returns null when signed out OR when the session's email has no row. That
 * second case is not paranoia: a session JWT outlives the row it names (a
 * removed user keeps a valid cookie until it expires), and treating "signed in
 * with a deleted account" as signed out is the only safe reading.
 */
import { findUserByEmail } from "@launchpad/db";
// The role union lives with the auth decisions, not the DB layer (spec 0073).
import type { UserRole } from "./auth-core";
import { getDb } from "./db";

// NOTE: this module must NOT import `app/auth` — next-auth is ESM-only and `lib`
// also compiles as CJS for `node --test` (the reason auth lives in app/ at all).
// So the session is passed IN: `app/auth.ts`'s `currentViewer()` supplies the
// email, and this resolves the row. Same split as `capabilities.ts`.

export interface Viewer {
  userId: string;
  email: string;
  role: UserRole;
  /** Control-plane OWNER: sees every project, for support (spec 0128 A). */
  isPlatformOwner: boolean;
  /** The GitHub identity that claimed this row, null until first GitHub sign-in.
   * Spec 0128 C asks GitHub about THIS login to decide repo write access. */
  githubLogin: string | null;
}

export async function viewerForEmail(email: string | null | undefined): Promise<Viewer | null> {
  if (!email) return null;
  try {
    const row = await findUserByEmail(getDb(), email);
    if (!row) return null;
    return {
      userId: row.id,
      email: row.email,
      // The DB row is authoritative for the role, not the JWT claim: a role
      // changed after sign-in must take effect on the next request, not when the
      // token happens to expire.
      role: row.role,
      isPlatformOwner: row.role === "OWNER",
      githubLogin: row.githubLogin ?? null,
    };
  } catch {
    // A database outage must not be an authorization bypass. No viewer means no
    // scoped project is listed, which fails closed.
    return null;
  }
}
