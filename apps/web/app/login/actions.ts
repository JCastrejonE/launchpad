"use server";

/**
 * Login/logout actions (spec 0073, GitHub-only since 0128 B2). Thin: signIn/signOut
 * do the work; these only translate an AuthError into the `?error=` panel the page
 * renders (spec-0007 discipline — a failed sign-in must never surface as Next's
 * generic error page). NOTE: a SUCCESSFUL signIn/signOut throws NEXT_REDIRECT
 * — that must propagate, so only AuthError is caught.
 *
 * `loginAction` (email + password) was deleted with the Credentials provider: it
 * was orphaned by that removal, and an unreachable sign-in path is exactly the kind
 * of code that gets re-wired by accident later.
 */
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn, signOut } from "../auth";


export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}

/**
 * Sign in with GitHub (spec 0128 B).
 *
 * A refusal by `callbacks.signIn` surfaces as `AccessDenied`, which is a NORMAL
 * outcome here — it is the gate doing its job for an unauthorised account — so it
 * gets its own message rather than the generic "config" panel a caught AuthError
 * would otherwise produce.
 */
export async function githubLoginAction(): Promise<void> {
  try {
    await signIn("github", { redirectTo: "/" });
  } catch (err) {
    if (err instanceof AuthError) {
      redirect(`/login?error=${err.type === "AccessDenied" ? "notauthorized" : "config"}`);
    }
    throw err;
  }
}
