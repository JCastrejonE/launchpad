/**
 * Single-thread routes for the Forge chat rebuild (spec 0067 phase 1, item 2).
 * Node runtime, behind the SAME fail-closed `supervisorAccess` guard as every
 * supervisor surface (flag off / signed out / non-OWNER ⇒ 403; spec 0074).
 * Owner-scoped via the OWNER session.
 *
 *  - GET    → `getThreadMessages(id)` as JSON (replay a thread on open).
 *  - DELETE → `deleteThread(id)` (history-sidebar delete).
 *
 * A `{ok:false}` `lib/chat-store` result (Postgres unreachable) surfaces as
 * 503 so the UI degrades to the ephemeral "not saving" notice (spec §3)
 * instead of a hard failure; the guard matrix is covered by
 * `checkSupervisorAccess`'s lib tests.
 */
import { sessionEmail, supervisorAccess } from "../../../../auth";
import { recordAudit } from "../../../../../lib/audit";
import { deleteThread, getThread, getThreadMessages } from "../../../../../lib/chat-store";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/** Spec 0135: the scope is the THREAD's project — a member reaches their
 * project's threads; an unscoped (platform) thread stays OWNER-only. A thread
 * that does not exist scopes as unscoped and 404s after the gate, so the
 * refusal never reveals whether an id exists. */
async function threadAccess(id: string) {
  const thread = await getThread(id);
  const projectId = thread.ok ? (thread.data?.projectId ?? null) : null;
  const access = await supervisorAccess(projectId ? { projectId } : {});
  return { access, exists: thread.ok && thread.data !== null };
}

export async function GET(_req: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  const { access } = await threadAccess(id);
  if (!access.ok) {
    return new Response(access.reason ?? "supervisor console access denied", { status: 403 });
  }
  const result = await getThreadMessages(id);
  return Response.json(result, { status: result.ok ? 200 : 503 });
}

export async function DELETE(_req: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  const { access } = await threadAccess(id);
  if (!access.ok) {
    return new Response(access.reason ?? "supervisor console access denied", { status: 403 });
  }
  const result = await deleteThread(id);
  if (result.ok) {
    // Spec 0075: destroying stored history is an effectful action.
    await recordAudit({ actor: (await sessionEmail()) ?? "owner-session", action: "thread.delete", target: id });
    return new Response(null, { status: 204 });
  }
  return Response.json(result, { status: 503 });
}
