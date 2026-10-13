-- Spec 0128 B: the GitHub identity that claimed a user row.
--
-- Recorded explicitly rather than re-derived from email at each sign-in: a GitHub
-- profile email can change, and a row that is already claimed must not become
-- claimable by a different account later (decision 3c). `github_id` is the
-- immutable numeric id — a login can be renamed, and after a rename the id is the
-- only thing that still says "the same person".
--
-- NULL until first GitHub sign-in, so every existing row (which authenticated by
-- password) keeps working while both providers coexist. `password_hash` is NOT
-- dropped here: removing the Credentials login is a separate, later step, after a
-- real GitHub sign-in has proven the OWNER's row is claimable — the alternative
-- is a locked console whose only way back in is SSH.
--
-- Hand-written and IDEMPOTENT, same discipline as 0002-0007.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "github_login" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "github_id" text;

-- One GitHub account claims at most one user row. Without this, two rows could
-- name the same identity and "who is signing in?" would have two answers.
CREATE UNIQUE INDEX IF NOT EXISTS "users_github_id_key" ON "users" ("github_id")
  WHERE "github_id" IS NOT NULL;
