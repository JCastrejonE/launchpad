/**
 * The signed-in user as authorization sees them (spec 0128 A): the session email
 * plus the DB row id, which is what project membership is keyed on.
 *
 * Its own module, not part of `auth.ts`, for two reasons. `lib/viewer.ts` cannot
 * import next-auth (it must also compile as CJS for `node --test`, which is why
 * auth lives in `app/` at all), so something in `app/` has to bridge them. And
 * putting that bridge inside `auth.ts` created an import cycle webpack resolved by
 * reporting `currentViewer` as "not exported" — a warning `next build` does not
 * fail on, which would have shipped as an empty dashboard for everyone.
 */
import { auth } from "./auth";
import { viewerForEmail, type Viewer } from "../lib/viewer";

export type { Viewer };

export async function currentViewer(): Promise<Viewer | null> {
  const session = await auth();
  return viewerForEmail(session?.user?.email);
}
