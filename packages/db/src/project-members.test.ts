import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// These assert the SQL SHAPE of the membership queries, which is what the
// scoping rule reduces to. The behavioural end-to-end (a second user sees a
// project only after being added) is a live check in the spec — a fake db that
// returns whatever we hand it would prove the call, not the rule
// (docs/VERIFICATION.md #1).
// `../src/`, not `./`: these run from dist/ after tsc.
const src = readFileSync(new URL("../src/project-members.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../drizzle/0007_project_members.sql", import.meta.url), "utf8");

test("listProjectsFor scopes by the caller's memberships", () => {
  const fn = src.slice(src.indexOf("export async function listProjectsFor"), src.indexOf("export async function membershipFor"));
  assert.match(fn, /eq\(projectMembers\.userId, userId\)/, "must filter by the caller");
  assert.match(fn, /innerJoin\(projects/, "inner join so a project without a membership cannot appear");
});

/**
 * Spec 0168 removed the support path this asserted. It returned every project to
 * a control-plane OWNER, which was harmless while OWNER meant one person — v0
 * makes all five users OWNERs, and `isProjectMember` no longer honours the role,
 * so the escape would have listed projects the viewer cannot open.
 */
test("listProjectsFor has NO see-everything escape", () => {
  const fn = src.slice(src.indexOf("export async function listProjectsFor"), src.indexOf("export async function membershipFor"));
  assert.equal(
    /select\(\)\.from\(projects\)/.test(fn),
    false,
    "an unscoped branch here lists projects the caller cannot open",
  );
});

// Conflating "can see it" with "is its owner" would report an OWNER as owner of
// every project in the install, which is the wrong answer to a different question.
test("membershipFor does NOT special-case the control-plane OWNER", () => {
  const fn = src.slice(src.indexOf("export async function membershipFor"), src.indexOf("export async function listProjectMembers"));
  assert.equal(/isPlatformOwner|OWNER/.test(fn), false);
});

test("putProjectMember is idempotent per (project, user)", () => {
  const fn = src.slice(src.indexOf("export async function putProjectMember"), src.indexOf("export async function removeProjectMember"));
  assert.match(fn, /onConflictDoUpdate/);
  assert.match(fn, /projectMembers\.projectId, projectMembers\.userId/);
});

// A project with no owner can never have members added again — nobody holds the
// permission — so the removal refuses rather than creating a dead end.
test("removeProjectMember refuses to remove the last owner", () => {
  const fn = src.slice(src.indexOf("export async function removeProjectMember"), src.indexOf("export async function userIdsByEmail"));
  assert.match(fn, /owners\.length <= 1/);
  assert.match(fn, /cannot remove the last owner/);
});

test("migration 0007 is idempotent and unique per (project, user)", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "project_members"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "project_members_project_user_key"/);
  assert.match(migration, /IN \('owner', 'member'\)/);
  assert.match(migration, /ON DELETE CASCADE/);
});

// Decision 7, and the one that would break every dashboard if it were wrong.
test("migration 0007 backfills existing projects to the control-plane OWNER", () => {
  assert.match(migration, /INSERT INTO "project_members"/);
  assert.match(migration, /CROSS JOIN "users" u/);
  assert.match(migration, /WHERE u\."role" = 'OWNER'/);
  assert.match(migration, /'owner'/);
  assert.match(migration, /ON CONFLICT DO NOTHING/, "re-running the migration must not fail");
});
