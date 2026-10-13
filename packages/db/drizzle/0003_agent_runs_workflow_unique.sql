-- Spec 0088 (Phase D): make `agent_runs.workflow_id` UNIQUE so the pipeline can
-- upsert one advancing projection row per Temporal run (`onConflictDoUpdate`
-- needs a unique conflict target) instead of appending a row per phase.
--
-- Hand-written to be IDEMPOTENT and safe on a table that already has rows,
-- following the same discipline as migration 0002:
--   * `CREATE UNIQUE INDEX IF NOT EXISTS` rather than `ALTER TABLE … ADD
--     CONSTRAINT`, which has no IF NOT EXISTS form and would abort a re-run.
--   * Duplicate `workflow_id` values are collapsed FIRST, keeping the most
--     recently started row per workflow — without that, creating the index
--     would fail outright on any DB that already had two rows for one run.
--     Nothing writes this table before this migration (spec 0077 created it
--     empty; the writer arrives with this spec), so in practice the delete is a
--     no-op — it is here so the migration cannot fail on a DB where someone
--     inserted rows by hand.

DELETE FROM "agent_runs" a
USING "agent_runs" b
WHERE a."workflow_id" = b."workflow_id"
  AND (a."started_at", a."id") < (b."started_at", b."id");

CREATE UNIQUE INDEX IF NOT EXISTS "agent_runs_workflow_id_unique"
  ON "agent_runs" ("workflow_id");
