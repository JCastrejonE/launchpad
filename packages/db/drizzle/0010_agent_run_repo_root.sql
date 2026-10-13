-- Spec 0131 C: record WHICH CHECKOUT a run worked in.
--
-- A run on `LAUNCHPAD_REPO_ROOT` with no project link is exactly what a legitimate
-- platform run looks like, so when the UI's Start button silently fell back to it
-- (spec 0131's Intent) every surface we had — the Agentes tab, this table, the
-- worker log — showed a completely normal run. Nothing was lying; nothing could
-- tell us either. The repo is the one fact that distinguishes the two.
--
-- Defaults to '' rather than NULL: every existing row predates the column and we
-- do not know its repo, which is a different statement from "it had none". The
-- view renders '' as nothing at all.

ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "repo_root" text DEFAULT '' NOT NULL;
