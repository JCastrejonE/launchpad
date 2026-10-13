-- Spec 0220: a pending AskUserQuestion, as a queryable fact.
--
-- The question used to exist ONLY as an entry in the Next process's
-- `pendingQuestions` map (apps/web/lib/run-registry.ts), so nothing outside the
-- chat thread could say a run was parked on a person — one measured case sat 10
-- minutes — and when the 15-minute timeout fired, nothing distinguished "the
-- agent proceeded alone" from "a human decided".
--
-- `resolution` is the ending. A question has exactly four, every exit path
-- writes one, and no path removes the row: that is what makes an expiry
-- readable afterwards.
--
-- Only a short summary of what was asked. Never the answers, never the option
-- list — spec 0075's metadata rule, for the same reason.
CREATE TABLE IF NOT EXISTS "pending_questions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "thread_id" uuid NOT NULL REFERENCES "forge_threads"("id") ON DELETE CASCADE,
  -- Null for a platform thread, which has no project row.
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  -- The signed-in email whose turn asked. Null where the path knows no actor:
  -- the signal then shows to everyone on the project, never to nobody.
  "asked_of" text,
  "summary" text NOT NULL DEFAULT '',
  "asked_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz,
  "resolution" text,
  CONSTRAINT "pending_questions_resolution_check" CHECK (
    "resolution" IS NULL
    OR "resolution" IN ('answered', 'expired', 'superseded', 'run_stopped')
  )
);

-- One PENDING question per thread, matching what the in-memory map already
-- enforces. PARTIAL, not plain: a plain unique index would make the next
-- question overwrite the row and erase the `superseded` ending that the very
-- same insert creates.
CREATE UNIQUE INDEX IF NOT EXISTS "pending_questions_thread_pending_key"
  ON "pending_questions" ("thread_id") WHERE "resolved_at" IS NULL;
