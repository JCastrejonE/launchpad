/**
 * Session → `ChromeUser` (spec 0209). The ONE identity source for the chrome: the
 * Auth.js session, read on the server.
 *
 * Its own module in `app/` for the reasons `app/viewer.ts` documents: `lib/` cannot
 * import `next-auth`, and putting the bridge inside `auth.ts` created an import
 * cycle webpack "resolved" by reporting the export as missing — a warning
 * `next build` does not fail on.
 *
 * No email ⇒ null ⇒ signed out. Every server call site that renders `TopBar` awaits
 * this; the two client route entries (`/new`, `/connect`) get it from their server
 * `page.tsx` wrapper as a prop, because `auth()` is server-only.
 */
import { auth } from "./auth";
import type { ChromeUser } from "../lib/chrome-user";

export async function sessionChromeUser(): Promise<ChromeUser | null> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;
  return { name: session.user.name ?? null, email, role: session.user.role };
}
