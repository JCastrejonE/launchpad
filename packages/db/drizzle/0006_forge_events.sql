-- Spec 0127: agent events stored AS THEY HAPPEN, so a chat turn survives the tab
-- that started it.
--
-- `forge_messages.events` holds a COMPLETED turn's log, written once when the
-- stream ends. A turn therefore had two states on disk — absent or complete —
-- which is why closing or switching a tab lost everything: there was no
-- "in progress" for a reconnecting browser to rejoin. This table is that state.
--
-- `(run_id, seq)` is UNIQUE so a resumed tail is exact: the client passes the
-- last seq it rendered and gets precisely what it has not seen. Timestamps could
-- not do this — streamed tokens collide inside the same millisecond.
--
-- Hand-written and IDEMPOTENT, same discipline as 0002-0005: `IF NOT EXISTS`
-- throughout, so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS "forge_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "thread_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "event" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Cascade, matching forge_messages: deleting a thread from the history sidebar
-- must not leave its events orphaned.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'forge_events_thread_id_forge_threads_id_fk'
  ) THEN
    ALTER TABLE "forge_events"
      ADD CONSTRAINT "forge_events_thread_id_forge_threads_id_fk"
      FOREIGN KEY ("thread_id") REFERENCES "forge_threads"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- The exactness guarantee, enforced by the database rather than by the appending
-- code being careful: two writers can never claim the same seq in a run.
CREATE UNIQUE INDEX IF NOT EXISTS "forge_events_run_seq_key" ON "forge_events" ("run_id", "seq");

-- The tail's query shape: one run's events, in order.
CREATE INDEX IF NOT EXISTS "forge_events_thread_run_seq_idx" ON "forge_events" ("thread_id", "run_id", "seq");
