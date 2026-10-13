-- Spec 0116 (v0 / spec 0115 F1): give a Project its own GitHub repo identity, so
-- one Launchpad can serve a customer's TWO repositories with different deploy
-- targets instead of the single global `LAUNCHPAD_REPO_ROOT`.
--
-- Only identity lands here. `production_branch` and the staging-branch pool are
-- deliberately NOT added: nothing reads them yet ("main" is hardcoded and correct
-- for this customer), and an unused column is a claim the schema cannot honour.
-- They arrive with the specs that use them.
--
-- Hand-written and IDEMPOTENT, same discipline as 0002/0003: `ADD COLUMN IF NOT
-- EXISTS` so a re-run is a no-op. All three are NULLABLE on purpose — every
-- existing row (platform, acme, sandbox, …) predates this and must keep working
-- via the `LAUNCHPAD_REPO_ROOT` fallback in `repoIdentityFor`. A NOT NULL default
-- would have to invent a repo for projects that have none.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "repo_owner" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "repo_name" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "repo_root" text;
