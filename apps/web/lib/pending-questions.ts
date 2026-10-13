/**
 * A pending `AskUserQuestion`, made visible outside its thread (spec 0220).
 *
 * Today the question exists ONLY as an entry in `run-registry.ts`'s
 * `pendingQuestions` map — process memory. Nothing is queryable, so no surface
 * anywhere can say "a run is waiting on a person", and when the 15-minute
 * timeout fires (`resolve(null)`) the agent proceeds alone and NOTHING
 * distinguishes that from a decision made with a human's answer.
 *
 * This module is the seam that turns that map entry into a fact: the four
 * endings a question can have, the deps run-registry writes them through, and
 * the two thread notices that make the two SILENT endings readable in the chat.
 *
 * Decisions recorded here because the coder needs them before the first commit:
 *
 *  - **Actionable = unresolved row AND a live entry in THIS process's map.**
 *    The web process owns the question end-to-end (spec 0220 non-goals: no
 *    Temporal signal), so intersecting the rows with the map is both the
 *    cheapest and the only honest rule. It also handles the restart case for
 *    free: after a deploy the map is empty, so no stale row is ever presented
 *    as pending. Those rows stay unresolved forever ON PURPOSE — we never
 *    observed an ending, and writing `expired` would be a claim about something
 *    nobody watched.
 *
 *  - **The notice is a thread MESSAGE, not a run event.** `forge_messages`'s
 *    assistant rows render through `foldSupervisorEvents` (see
 *    `lib/forge-chat-runtime.ts`), so a one-event `text` message is visible on
 *    every read path — live reload, thread reopen, history — without touching
 *    the run's seq counter or depending on the run still being alive. The
 *    timeout fires while the turn is blocked; the run-stopped path can fire
 *    after it has finished. One mechanism has to work for both.
 */
import { openPendingQuestion, resolvePendingQuestion } from "@launchpad/db";
import type { PendingQuestionOpen, PendingQuestionRow, QuestionResolution } from "@launchpad/db";
import { appendMessage } from "./chat-store";
import { getDb } from "./db";

/**
 * The three writes the four endings need, injectable so a test can watch them
 * without a database.
 *
 * `chat-store`'s `ChatStoreDeps` pattern, and for its reason: the real
 * implementation is the DEFAULT argument, so a call site that passes nothing is
 * still correct in production (verification rule #12). Only `awaitAnswer` takes
 * it — the three exit paths read it back off the map entry, so there is no
 * second call site that can silently omit it.
 */
export interface PendingQuestionDeps {
  open(question: PendingQuestionOpen): Promise<unknown>;
  resolve(threadId: string, resolution: QuestionResolution): Promise<unknown>;
  /** The thread notice that makes a SILENT ending readable afterwards. */
  notice(threadId: string, text: string): Promise<unknown>;
}

/** Real I/O: the row in `pending_questions`, the notice as a thread message. */
export const defaultPendingQuestionDeps: PendingQuestionDeps = {
  open: (question) => openPendingQuestion(getDb(), question),
  resolve: (threadId, resolution) => resolvePendingQuestion(getDb(), threadId, resolution),
  notice: (threadId, text) =>
    appendMessage(threadId, { role: "assistant", content: "", events: [{ type: "text", delta: text }] }),
};

/** Appended to the thread when the 15-minute timeout fires. The agent's own
 * deny-with-reason (run-registry) tells the AGENT; this tells the human, later,
 * that the answer it acted on was nobody's. Verification rule #9's twin: a
 * fallback that looks identical to the deliberate case is not observable. */
export const QUESTION_EXPIRED_NOTICE =
  "⏱ La pregunta se venció sin respuesta (15 min) — el agente siguió con su mejor criterio.";

/** Appended when a run is stopped (or ends) with a question still pending. */
export const QUESTION_RUN_STOPPED_NOTICE =
  "⛔ La corrida terminó con una pregunta sin responder — nadie la contestó.";

// --- the read path ---------------------------------------------------------

/** One actionable question, as the chip renders it. Never the answers. */
export interface PendingQuestionView {
  threadId: string;
  /** Null only for a platform thread (no project row). */
  projectSlug: string | null;
  projectName: string | null;
  /** Null ⇒ nobody in particular was asked, so it is everyone's. */
  askedOf: string | null;
  /** Addressed to the viewer — a null `askedOf` counts, because "everyone"
   * includes them. Fail visible: the alternative is a question styled as
   * somebody else's that belongs to nobody. */
  mine: boolean;
  summary: string;
  /** ISO — the chip crosses a JSON boundary. */
  askedAt: string;
}

/**
 * Unresolved ∩ live ∩ visible-to-this-viewer.
 *
 * Pure, so the two rules that matter can be tested without a database or a
 * session:
 *
 *  - **live**: a row whose thread has no entry in this process's question map
 *    is NOT actionable (a deploy orphans rows, and those stay unresolved on
 *    purpose — see the module header). Clicking it would land on a run that is
 *    not waiting for anything, which is exactly the stale "revísame" spec 0122
 *    deleted.
 *  - **visible**: same scoping as every other project read — the viewer's own
 *    projects, and a project-less (platform) thread only for a platform member.
 */
export function actionablePendingQuestions(input: {
  rows: readonly PendingQuestionRow[];
  liveThreadIds: readonly string[];
  projects: readonly { id: string; slug: string; name: string }[];
  viewerEmail: string;
  isPlatformMember: boolean;
}): PendingQuestionView[] {
  const live = new Set(input.liveThreadIds);
  const byId = new Map(input.projects.map((p) => [p.id, p]));
  const views: PendingQuestionView[] = [];
  for (const row of input.rows) {
    if (!live.has(row.threadId)) continue;
    const project = row.projectId ? byId.get(row.projectId) : undefined;
    if (row.projectId ? !project : !input.isPlatformMember) continue;
    views.push({
      threadId: row.threadId,
      projectSlug: project?.slug ?? null,
      projectName: project?.name ?? null,
      askedOf: row.askedOf,
      mine: row.askedOf === null || row.askedOf === input.viewerEmail,
      summary: row.summary,
      askedAt: row.askedAt.toISOString(),
    });
  }
  return views;
}
