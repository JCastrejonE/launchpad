/**
 * Reattach to a run in progress (spec 0127).
 *
 * `POST /api/supervisor` starts a turn and watches it; this is how a browser that
 * came back — new tab, switched tab, reload — picks the same turn up again. It is
 * a GET because it creates nothing: it is a view of work already happening.
 *
 * Two cases, and the second is the one that makes this honest:
 *  - **the run is live in this process** → subscribe to it from `sinceSeq`, so
 *    the client sees the rest of the turn as it happens;
 *  - **it is not live** → replay what was stored. If the stored log has no
 *    terminal event, the run was interrupted (this process restarted mid-turn),
 *    and the stream says so instead of leaving a spinner running forever.
 */
import { supervisorAccess } from "../../../auth";
import { getThread, latestRunForThread, readRunEvents } from "../../../../lib/chat-store";
import { getRun } from "../../../../lib/run-registry";
import { encodeRunEvent, sseFromRun } from "../../../../lib/run-sse";

export const runtime = "nodejs";
export const maxDuration = 300;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const threadId = url.searchParams.get("threadId") ?? undefined;

  // The same gate as POST, scoped by the thread's project since spec 0135. A
  // run's event log is agent output on this host — it is not less sensitive
  // because reading it creates nothing; a stream WITHOUT a thread stays
  // OWNER-only.
  let projectId: string | null = null;
  if (threadId) {
    const thread = await getThread(threadId);
    projectId = thread.ok ? (thread.data?.projectId ?? null) : null;
  }
  const access = await supervisorAccess(projectId ? { projectId } : {});
  if (!access.ok) {
    return new Response(access.reason ?? "supervisor console access denied", { status: 403 });
  }

  const sinceSeqRaw = Number(url.searchParams.get("sinceSeq") ?? "0");
  const sinceSeq = Number.isFinite(sinceSeqRaw) && sinceSeqRaw > 0 ? Math.floor(sinceSeqRaw) : 0;

  // A runId may be given directly; otherwise the thread's most recent run is the
  // one the user was looking at.
  let runId = url.searchParams.get("runId") ?? undefined;
  let finishedInStore = false;
  if (!runId) {
    if (!threadId) return new Response("runId or threadId required", { status: 400 });
    const latest = await latestRunForThread(threadId);
    if (!latest.ok) return new Response("run store unavailable", { status: 503 });
    if (!latest.data) return new Response("no run for this thread", { status: 404 });
    runId = latest.data.runId;
    finishedInStore = latest.data.finished;
  }

  const live = getRun(runId);
  if (live) {
    return new Response(sseFromRun(live, runId, sinceSeq), {
      headers: { ...SSE_HEADERS, "X-Run-Id": runId, "X-Run-Live": "1" },
    });
  }

  // Not live here. Replay from the store — this is the path that makes a closed
  // tab, or a tab reopened after a deploy, lose nothing that was written.
  const stored = await readRunEvents(runId, sinceSeq);
  if (!stored.ok) return new Response("run store unavailable", { status: 503 });

  const encoder = new TextEncoder();
  const events = stored.data;
  const hasTerminal =
    finishedInStore || events.some((e) => e.event.type === "result" || e.event.type === "error");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of events) {
        controller.enqueue(encoder.encode(encodeRunEvent(item.seq, item.event)));
      }
      if (!hasTerminal) {
        // Neither running nor finished: the producer died with the process. Say
        // it, rather than rendering an agent that appears to still be thinking.
        const lastSeq = events.at(-1)?.seq ?? sinceSeq;
        controller.enqueue(
          encoder.encode(
            encodeRunEvent(lastSeq + 1, {
              type: "error",
              message: "La ejecución se interrumpió (el servidor se reinició). El progreso anterior se conservó.",
            }),
          ),
        );
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { ...SSE_HEADERS, "X-Run-Id": runId, "X-Run-Live": "0" },
  });
}
