/**
 * The four endings of an `AskUserQuestion` (spec 0220).
 *
 * A question is opened when the agent asks and closed when it is answered, it
 * expires, a newer question replaces it, or the run stops. Every one of those
 * paths UPDATES the row; none removes it, because the whole point is that an
 * expiry — where the agent proceeded with nobody's answer — stays readable
 * afterwards.
 *
 * Only a short summary of the question is stored. Never the answers or the
 * option list (spec 0075's metadata rule).
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import { pendingQuestions } from "./schema.js";

export type PendingQuestionRow = typeof pendingQuestions.$inferSelect;

/** The four endings. Mirrored by the table's CHECK constraint. */
export type QuestionResolution = "answered" | "expired" | "superseded" | "run_stopped";

export interface PendingQuestionOpen {
  threadId: string;
  /** Null for a platform thread. */
  projectId?: string | null;
  /** Null where the asking path knows no actor — shows to everyone, not nobody. */
  askedOf?: string | null;
  /** The question's header/text. NEVER the answers. */
  summary: string;
}

/**
 * Record that a thread is now waiting on a person.
 *
 * A still-pending row for the same thread is closed as `superseded` first: the
 * partial unique index allows one pending question per thread, so the newer
 * question forces that ending rather than merely coexisting with it.
 */
export async function openPendingQuestion(db: Db, q: PendingQuestionOpen): Promise<void> {
  await resolvePendingQuestion(db, q.threadId, "superseded");
  await db.insert(pendingQuestions).values({
    threadId: q.threadId,
    projectId: q.projectId ?? null,
    askedOf: q.askedOf ?? null,
    summary: q.summary,
  });
}

/** Close the thread's pending question with its ending. No-op when there is none. */
export async function resolvePendingQuestion(
  db: Db,
  threadId: string,
  resolution: QuestionResolution,
): Promise<void> {
  await db
    .update(pendingQuestions)
    .set({ resolvedAt: new Date(), resolution })
    .where(and(eq(pendingQuestions.threadId, threadId), isNull(pendingQuestions.resolvedAt)));
}

/**
 * Every question with no ending yet, oldest first.
 *
 * NOT the same as "actionable": a row orphaned by a web-process restart is
 * unresolved forever on purpose (no ending was observed), so the read path
 * intersects this with the live in-process map before showing anything.
 */
export async function listUnresolvedPendingQuestions(db: Db): Promise<PendingQuestionRow[]> {
  return db
    .select()
    .from(pendingQuestions)
    .where(isNull(pendingQuestions.resolvedAt))
    .orderBy(pendingQuestions.askedAt);
}
