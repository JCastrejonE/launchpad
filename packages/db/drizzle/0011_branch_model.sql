-- Spec 0133 A: branches as a first-class thing (the odoo.sh model).
--
-- A branch = a staging environment = the unit of promotion. This table stores
-- ONLY what cannot be re-asked: identity, who created it, its terminal state,
-- the literal staging stack name (teardown and the sweep need the exact
-- string), and the promote attestation — staging_sha (what staging actually
-- ran) + staging_base_sha (the main content inside the tested tree), recorded
-- at deploy time because that is the only moment they are true. A branch
-- accumulates over N runs, so by promote time the last run's workflow may be
-- long closed — workflow state (0118's gate2Attestation query) cannot carry
-- these facts to the merge; a row can.
--
-- pr_number / staging_host / staging_status are CACHES for the UI; the truth
-- is GitHub and the box, and promote re-derives the PR by head when the cache
-- is stale. Branch head SHA and PR/checks state are never stored.
--
-- agent_runs.branch: '' for every pre-existing row (same "predates the column"
-- reasoning as 0010's repo_root). It is what the promote roll-up uses to find
-- which specs rode the branch.
--
-- forge_threads.branch: the chat binding (spec 0135 consumes it) — one
-- migration for the model, not two. Nullable: platform threads have no branch.
--
-- Hand-written and IDEMPOTENT, same discipline as 0002-0010.

CREATE TABLE IF NOT EXISTS "project_branches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "name" text NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "pr_number" integer,
  "staging_stack" text,
  "staging_host" text,
  "staging_status" text DEFAULT 'none' NOT NULL,
  "staging_sha" text,
  "staging_base_sha" text,
  "merged_at" timestamp with time zone,
  "merged_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_branches_project_id_fk') THEN
    ALTER TABLE "project_branches" ADD CONSTRAINT "project_branches_project_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_branches_staging_status_check') THEN
    ALTER TABLE "project_branches" ADD CONSTRAINT "project_branches_staging_status_check"
      CHECK ("staging_status" IN ('none', 'deploying', 'ready', 'failed', 'destroying'));
  END IF;
END $$;

-- One row per (project, name): "which branch is this?" must never have two
-- answers — the same reasoning as project_members' unique pair.
CREATE UNIQUE INDEX IF NOT EXISTS "project_branches_project_name_key"
  ON "project_branches" ("project_id", "name");

ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "branch" text DEFAULT '' NOT NULL;
ALTER TABLE "forge_threads" ADD COLUMN IF NOT EXISTS "branch" text;
