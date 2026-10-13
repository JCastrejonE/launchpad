-- Spec 0128 A: who may see and act on a project.
--
-- Until now `listProjects` was unscoped — every signed-in user saw every project.
-- This table is the axis that makes a project belong to people, kept SEPARATE
-- from `users.role`: the control-plane role says what kind of account this is,
-- membership says which projects it reaches.
--
-- `role` is its own vocabulary ('owner' | 'member'), not users.role's
-- OWNER/MEMBER/VIEWER. Reusing that enum would imply a VIEWER membership and a
-- deploy permission this table does not grant — since spec 0128 decision 2 a
-- promotion is authorised by GitHub at merge time with the promoter's own
-- credential, so 'owner' here means "may manage members", never "may deploy".
--
-- Hand-written and IDEMPOTENT, same discipline as 0002-0006.

CREATE TABLE IF NOT EXISTS "project_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text DEFAULT 'member' NOT NULL,
  "added_by" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_members_project_id_fk') THEN
    ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_members_user_id_fk') THEN
    ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_members_role_check') THEN
    ALTER TABLE "project_members" ADD CONSTRAINT "project_members_role_check"
      CHECK ("role" IN ('owner', 'member'));
  END IF;
END $$;

-- One membership per person per project: a second row would make "what is their
-- role here?" ambiguous, and authorization must never have two answers.
CREATE UNIQUE INDEX IF NOT EXISTS "project_members_project_user_key"
  ON "project_members" ("project_id", "user_id");
CREATE INDEX IF NOT EXISTS "project_members_user_idx" ON "project_members" ("user_id");

-- BACKFILL, and it is load-bearing (spec 0128 decision 7): the moment the project
-- list is scoped, a project with no members vanishes from every dashboard —
-- including `platform`. Every control-plane OWNER becomes owner of every project
-- that predates this migration. Verify by COUNTING members per project, not by
-- this migration exiting 0.
INSERT INTO "project_members" ("project_id", "user_id", "role", "added_by")
SELECT p."id", u."id", 'owner', 'migration:0007'
FROM "projects" p
CROSS JOIN "users" u
WHERE u."role" = 'OWNER'
ON CONFLICT DO NOTHING;
