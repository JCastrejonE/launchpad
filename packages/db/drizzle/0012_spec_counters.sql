-- Spec 0164: spec ids were allocated by reading the directory and adding one, and
-- the caller's own comment admitted the assumption ("no concurrent sessions").
-- Two chats drafting in one project both computed the same id; the existing
-- unique index on (project_id, name) does not stop it, because 0005-foo.md and
-- 0005-bar.md are different names.
--
-- One counter row per project, claimed with a single INSERT ... ON CONFLICT DO
-- UPDATE ... RETURNING, which Postgres serialises. No lock is held across an
-- agent turn and it does not depend on there being a single web process.
CREATE TABLE IF NOT EXISTS spec_counters (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  -- The highest spec id handed out for this project. Seeded lazily from the
  -- caller's filesystem floor, so a project whose specs predate this table
  -- (every one of them today) can never be handed an id that already exists.
  last_id integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
