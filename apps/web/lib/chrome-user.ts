/**
 * The signed-in user as the CHROME shows them (spec 0209): the greeting name and
 * the avatar initials. Distinct from `lib/viewer.ts`, which is the same person as
 * AUTHORIZATION sees them (the DB row id project membership is keyed on) — this
 * one carries no authority at all, only what we may print.
 *
 * Pure, and in `lib/` so `node --test` can cover it: `tsconfig.test.json` compiles
 * `lib` only, and nothing here may import `next-auth` (ESM-only; that is why
 * `auth()` lives in `app/`). The session→ChromeUser bridge is `app/chrome-user.ts`.
 *
 * `name` is the GitHub profile name when the provider supplied one, else null —
 * `email` is the authorised address our `users` table matched, so it is always
 * present for a signed-in session. A NULL ChromeUser means SIGNED OUT, and the
 * chrome must render that state visibly (a neutral glyph, no greeting name) rather
 * than inventing initials: a fallback that looks like the real case is not
 * observable (CLAUDE.md verification rule #9's twin).
 */
import type { UserRole } from "./auth-core";

export type ChromeUser = {
  name: string | null;
  email: string;
  role: UserRole;
};

/** The greeting name: the profile name when we have one, else the email. Null =
 * signed out, and the caller greets with no name at all. */
export function chromeDisplayName(user: ChromeUser | null): string | null {
  if (!user) return null;
  return user.name?.trim() || user.email;
}

/** Avatar initials: up to two from the profile name, else the email's first
 * letter. Null = signed out — the caller renders the neutral glyph, NEVER
 * invented letters. */
export function chromeInitials(user: ChromeUser | null): string | null {
  if (!user) return null;
  const words = (user.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return user.email.slice(0, 1).toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => w.slice(0, 1).toUpperCase())
    .join("");
}
