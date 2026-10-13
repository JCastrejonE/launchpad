-- Spec 0129 A: one row per spec per project.
--
-- `spec_files` has existed since 0077 with NO writer, so nothing ever needed this.
-- It does now: the row is the DURABLE record of a spec whose file is excluded from
-- the customer's repository (the owner's choice, spec 0129), and an upsert needs something
-- to conflict on. Without it a status change would append a second row and "what is
-- this spec's status?" would have two answers.

CREATE UNIQUE INDEX IF NOT EXISTS "spec_files_project_name_key"
  ON "spec_files" ("project_id", "name");
