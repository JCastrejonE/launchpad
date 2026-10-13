/**
 * Stop a run on purpose (spec 0127).
 *
 * Spec 0127 removed the implicit abort — a closed connection used to kill the
 * agent, which is the bug. Removing it must not remove the *ability* to stop a
 * turn, so that ability becomes explicit and deliberate: a request that says
 * stop, from an OWNER session, rather than a side effect of a tab closing.
 */
import { sessionEmail, supervisorAccess } from "../../../auth";
import { recordAudit } from "../../../../lib/audit";
import { getThread } from "../../../../lib/chat-store";
import { getRun, denyPendingQuestion } from "../../../../lib/run-registry";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let runId: string;
  try {
    const body = (await req.json()) as { runId?: unknown };
    if (typeof body.runId !== "string" || !body.runId) {
      return new Response("missing runId", { status: 400 });
    }
    runId = body.runId;
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }

  // Spec 0135: ONE access check, scoped by the run's thread's project — a
  // member stops their own project's runs; an adhoc (threadless) run, or one
  // this process no longer holds, stays OWNER-only (we cannot scope what we
  // cannot see, and failing closed beats guessing).
  const handle = getRun(runId);
  let projectId: string | null = null;
  if (handle?.threadId) {
    const thread = await getThread(handle.threadId);
    projectId = thread.ok ? (thread.data?.projectId ?? null) : null;
  }
  const access = await supervisorAccess(projectId ? { projectId } : {});
  if (!access.ok) {
    return new Response(access.reason ?? "supervisor console access denied", { status: 403 });
  }
  if (!handle) {
    // Already finished, already forgotten, or never in this process. Idempotent
    // by design: the caller wanted it stopped, and it is not running.
    return Response.json({ stopped: false, reason: "not running here" });
  }

  handle.stop();
  // Spec 0144 B: a stop while a question waits on the human resolves it null,
  // so the blocked canUseTool promise releases instead of waiting out its
  // timeout on a run that is already dead.
  if (handle.threadId) denyPendingQuestion(handle.threadId);
  // Stopping a turn that can run Bash is an effectful act by a person, so it is
  // attributed like every other one (spec 0075). No prompt text, only shape.
  await recordAudit({
    actor: (await sessionEmail()) ?? "owner-session",
    action: "console.stop",
    target: handle.threadId ?? "adhoc",
    metadata: { runId },
  });
  return Response.json({ stopped: true });
}
