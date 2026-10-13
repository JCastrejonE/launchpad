-- Spec 0170: a version you can point at.
--
-- Merging accepts a change into the trunk; shipping moves a VERSION of that
-- trunk onto a customer's live system. Only the first had a name, which is why
-- gate 3 read as ceremony — it asked "promote?" without naming a thing to
-- promote. This table is that thing.
CREATE TABLE IF NOT EXISTS "project_releases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  -- "1.4.2". Three components; the Odoo series prefix is added at render time
  -- from the project's own version, never stored here.
  "version" text NOT NULL,
  -- What the release IS. Immutable: a release that could point somewhere else
  -- later would make "what is in production" unanswerable again.
  "commit_sha" text NOT NULL,
  "notes" text DEFAULT '' NOT NULL,
  -- candidate | deployed | superseded | failed
  "status" text DEFAULT 'candidate' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deployed_by" text DEFAULT '' NOT NULL,
  "deployed_at" timestamp with time zone,
  -- Whatever the target returns to identify the deploy: an odoo.sh build id, a
  -- stack name. Free text on purpose — each target names things its own way.
  "deploy_ref" text DEFAULT '' NOT NULL
);

-- A version is unique within its project, and monotonic allocation depends on
-- that being enforced here rather than assumed by the allocator (spec 0164's
-- lesson: two users must never be handed the same id).
CREATE UNIQUE INDEX IF NOT EXISTS "project_releases_project_version_uniq"
  ON "project_releases" ("project_id", "version");

-- One candidate per commit: a merge replayed, or two merges landing the same
-- tree, must not produce two releases of the same thing.
CREATE UNIQUE INDEX IF NOT EXISTS "project_releases_project_sha_uniq"
  ON "project_releases" ("project_id", "commit_sha");

-- "What is live?" and "what is newest?" are both list-by-project-newest-first.
CREATE INDEX IF NOT EXISTS "project_releases_project_created_idx"
  ON "project_releases" ("project_id", "created_at" DESC);
