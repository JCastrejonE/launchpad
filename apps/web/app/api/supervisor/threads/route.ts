/**
 * Thread-list routes for the Forge chat rebuild (spec 0067 phase 1, item 2).
 * Node runtime, and — like every supervisor surface — behind the SAME
 * fail-closed `supervisorAccess` guard as `POST /api/supervisor` (flag off /
 * signed out / non-OWNER ⇒ 403; spec 0074). Owner-scoped: no user column —
 * the OWNER session is the scope.
 *
 *  - GET  → `listThreads()` as JSON (history sidebar, newest-first).
 *  - POST → `createThread(firstPrompt)` — a new empty conversation.
 *
 * Spec 0081 (C.2) adds an optional `projectId` to both — `?projectId=` on GET,
 * a body field on POST — so the workspace "Chats · sdd" tab sees only its own
 * project's threads. Omitted keeps the unscoped behaviour the standalone
 * `/forge` console still relies on (C.3 retires that surface). This adds no
 * trust boundary: the OWNER session is still the scope, and `projectId` only
 * selects among that same owner's threads. A malformed id is rejected with 400
 * rather than handed to the FK; a well-formed but unknown one trips the
 * foreign key and degrades through the existing `{ok:false}` → 503 path.
 *
 * Only stored chat text crosses the wire — the same owner-session, flag-gated
 * trust domain that can already run Bash via the bridge, so no new exposure
 * class. A `{ok:false}` `lib/chat-store` result (Postgres unreachable)
 * surfaces as 503 so the UI degrades to the ephemeral "not saving" notice
 * (spec §3) instead of a hard failure; the guard matrix is covered by
 * `checkSupervisorAccess`'s lib tests.
 */
import { branchByName } from "@launchpad/db";
import { supervisorAccess } from "../../../auth";
import { createThread, listThreads } from "../../../../lib/chat-store";
import { getDb } from "../../../../lib/db";
import { isUuid } from "../../../../lib/uuid";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (projectId !== null && !isUuid(projectId)) {
    return new Response("projectId must be a UUID", { status: 400 });
  }
  // Spec 0135: a project-scoped list admits that project's members; the
  // unscoped list (the platform console's sidebar) stays OWNER-only.
  const access = await supervisorAccess(projectId ? { projectId } : {});
  if (!access.ok) {
    return new Response(access.reason ?? "supervisor console access denied", { status: 403 });
  }
  // {ok:false} (store unreachable) surfaces as 503 so the UI degrades to the
  // ephemeral "not saving" notice rather than a hard error.
  const result = await listThreads(projectId);
  return Response.json(result, { status: result.ok ? 200 : 503 });
}

export async function POST(req: Request): Promise<Response> {
  const body = await req
    .json()
    .catch(() => ({}) as { firstPrompt?: unknown; projectId?: unknown; branch?: unknown });
  const firstPrompt = typeof body.firstPrompt === "string" ? body.firstPrompt : "";
  const projectId = typeof body.projectId === "string" ? body.projectId : null;
  const branch = typeof body.branch === "string" && body.branch ? body.branch : null;
  if (projectId !== null && !isUuid(projectId)) {
    return new Response("projectId must be a UUID", { status: 400 });
  }
  const access = await supervisorAccess(projectId ? { projectId } : {});
  if (!access.ok) {
    return new Response(access.reason ?? "supervisor console access denied", { status: 403 });
  }
  // Spec 0135 B: a project thread is born bound to a branch. The branch must
  // exist (created in Ramas & builds) and be unmerged; a branch without a
  // project has nothing to bind to.
  if (branch) {
    if (!projectId) return new Response("branch requires a projectId", { status: 400 });
    const row = await branchByName(getDb(), projectId, branch).catch(() => null);
    if (!row) {
      return new Response(`la rama "${branch}" no existe en este proyecto — créala en Ramas & builds`, {
        status: 400,
      });
    }
    if (row.mergedAt) {
      return new Response(`la rama "${branch}" ya fue promovida — crea una rama nueva`, { status: 400 });
    }
  }
  const result = await createThread(firstPrompt, projectId, branch);
  return Response.json(result, { status: result.ok ? 200 : 503 });
}
