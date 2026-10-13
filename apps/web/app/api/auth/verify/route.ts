/**
 * Spec 0146: the session check nginx calls before serving the Temporal UI.
 *
 * nginx's `auth_request` issues a subrequest here carrying the browser's
 * cookies; 204 lets the original request through, 401 refuses it. That is the
 * whole contract — it exists so a tool with NO authentication of its own can
 * inherit the launchpad's.
 *
 * Deliberately minimal and side-effect free: no audit row (nginx calls it for
 * every asset request on the page), no body, and no information beyond the
 * status code. It never says WHO the caller is or whether an account exists —
 * signed in or not is all a proxy needs, and all it gets.
 *
 * The gate is an OWNER session (the owner, 2026-08-07, tightened from "any signed-in
 * user" before anyone else had used it). Temporal's UI can terminate, cancel
 * and reset workflows — a human back-door around the gate model ADR-007
 * exists to enforce — so it matches the supervisor console's rule (spec 0074)
 * rather than the weaker "is anyone home" test: the two surfaces that hand out
 * destructive power on this box now answer to the same role.
 *
 * A MEMBER keeps everything the product itself offers — chats, runs, gates,
 * promote — and loses only the raw kill switch, which no workflow of theirs
 * needs. `role !== "OWNER"` is deliberately the whole policy: VIEWER and
 * MEMBER are refused by the same branch as signed-out, so there is no ordering
 * to get wrong.
 */
import { sessionRole } from "../../../auth";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const role = await sessionRole();
  // 204, not 200: nginx only reads the status, and an empty body makes it
  // impossible for this endpoint to leak anything by accident. 401 covers
  // signed-out AND signed-in-but-not-OWNER on purpose — nginx turns it into
  // the login redirect either way, and the response never distinguishes "you
  // are not logged in" from "you are not allowed".
  return new Response(null, { status: role === "OWNER" ? 204 : 401 });
}
