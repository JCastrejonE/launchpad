/**
 * Spec 0144 B: the human's answer to an `AskUserQuestion` card.
 *
 * The question left through the normal event stream (`tool_use` with
 * name `AskUserQuestion`); this is the return path. Same gate as every other
 * supervisor route — the thread's project scopes membership (spec 0135).
 */
import { getThread } from "../../../../lib/chat-store";
import { answerQuestion } from "../../../../lib/run-registry";
import { supervisorAccess } from "../../../auth";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let threadId: string;
  let answers: Record<string, string | string[]>;
  try {
    const body = (await req.json()) as { threadId?: unknown; answers?: unknown };
    if (typeof body.threadId !== "string" || !body.threadId) {
      return new Response("missing threadId", { status: 400 });
    }
    if (typeof body.answers !== "object" || body.answers === null) {
      return new Response("missing answers", { status: 400 });
    }
    threadId = body.threadId;
    answers = body.answers as Record<string, string | string[]>;
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }

  const thread = await getThread(threadId);
  const access = await supervisorAccess(
    thread.ok && thread.data?.projectId ? { projectId: thread.data.projectId } : {},
  );
  if (!access.ok) {
    return new Response(access.reason ?? "supervisor console access denied", { status: 403 });
  }

  const resolved = answerQuestion(threadId, answers);
  return Response.json({ ok: resolved, ...(resolved ? {} : { reason: "no pending question" }) });
}
