/**
 * SSE view of a run (spec 0127). Shared by `POST /api/supervisor`, which starts a
 * run and watches it, and `GET /api/supervisor/stream`, which reattaches to one
 * that is already going.
 *
 * The frame format is deliberately the OLD one plus a field: `data: {…event,
 * seq}`. The existing client parses `data: <json>` straight into a
 * `SupervisorEvent` and switches on `.type`, so an extra `seq` key costs it
 * nothing — while a reconnecting client can use it to ask for exactly what it
 * has not seen. No versioned envelope, no client rewrite.
 */
import type { SupervisorEvent } from "@launchpad/agents";
import type { RunHandle, SequencedEvent } from "./run-registry";
import { forgetRun } from "./run-registry";

/** One SSE frame: the event as before, plus its sequence number. */
export function encodeRunEvent(seq: number, event: SupervisorEvent): string {
  return `data: ${JSON.stringify({ ...event, seq })}\n\n`;
}

/**
 * A stream of `handle`'s events from `sinceSeq` (exclusive) until the run ends.
 *
 * `cancel()` unsubscribes and NOTHING ELSE. That single line is the fix the owner
 * reported: the previous version aborted the agent when the browser went away,
 * so switching tabs destroyed the work instead of merely stopping the view of
 * it.
 */
export function sseFromRun(handle: RunHandle, runId: string, sinceSeq: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by a cancel that raced the run's end — harmless.
        }
        forgetRun(runId);
      };

      unsubscribe = handle.subscribe(sinceSeq, (next: SequencedEvent | null) => {
        if (next === null) {
          close();
          return;
        }
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeRunEvent(next.seq, next.event)));
        } catch {
          // The client vanished mid-enqueue. Stop writing; do NOT stop the run.
          closed = true;
        }
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });
}
