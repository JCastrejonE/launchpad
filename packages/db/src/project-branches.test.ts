import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Same posture as project-members.test.ts: assert the SQL SHAPE the rules
// reduce to. The behavioural end-to-end (two runs on one branch grow one PR,
// a promote flips the rows) is a live check in specs 0133/0136 — a fake db
// returning what we hand it would prove the call, not the rule
// (docs/VERIFICATION.md #1).
// `../src/`, not `./`: these run from dist/ after tsc.
const src = readFileSync(new URL("../src/project-branches.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../drizzle/0011_branch_model.sql", import.meta.url), "utf8");

function fn(name: string, next?: string): string {
  const start = src.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing export ${name}`);
  const end = next ? src.indexOf(`export async function ${next}`) : src.length;
  return src.slice(start, end);
}

// Two concurrent creates of the same name must not both "succeed" — a
// pre-flight SELECT would race; the unique index decides, and losing is a
// typed refusal, never an overwrite (the 0126 createProject shape).
test("createProjectBranch is insert-only: conflict throws, never overwrites", () => {
  const body = fn("createProjectBranch", "listBranchesForProject");
  assert.match(body, /onConflictDoNothing\(\)\.returning\(\)/);
  assert.match(body, /throw new DuplicateBranchError/);
  assert.equal(/onConflictDoUpdate/.test(body), false, "creation must never update");
});

// A promote that compares a fresh head to a stale base blocks (or passes) on a
// fiction — the two attestation SHAs are only writable TOGETHER with a deploy.
test("setBranchStaging writes the attestation pair only on status ready", () => {
  const body = fn("setBranchStaging", "clearBranchStaging");
  const readyBranch = body.slice(body.indexOf('if (staging.status === "ready")'), body.indexOf("return;"));
  assert.match(readyBranch, /stagingSha: staging\.sha/);
  assert.match(readyBranch, /stagingBaseSha: staging\.baseSha/);
  const otherBranch = body.slice(body.indexOf("return;"));
  assert.equal(/stagingSha/.test(otherBranch), false, "non-ready transitions must not touch the attestation");
});

// A destroyed stack must not leave attestation behind: stale SHAs on a
// stackless branch would read as promote evidence.
test("clearBranchStaging clears the attestation with the stack", () => {
  const body = fn("clearBranchStaging", "markBranchMerged");
  for (const field of ["stagingStatus", "stagingStack", "stagingHost", "stagingSha", "stagingBaseSha"]) {
    assert.match(body, new RegExp(field), `must clear ${field}`);
  }
});

// A repeated promote's bookkeeping must never rewrite who merged first.
test("markBranchMerged is guarded on merged_at IS NULL and reports whether it marked", () => {
  const body = fn("markBranchMerged");
  assert.match(body, /isNull\(projectBranches\.mergedAt\)/);
  assert.match(body, /updated\.length > 0/);
});

test("migration 0011 is idempotent, unique per (project, name), with the status CHECK", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "project_branches"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "project_branches_project_name_key"/);
  assert.match(migration, /pg_constraint WHERE conname = 'project_branches_staging_status_check'/);
  assert.match(migration, /'none', 'deploying', 'ready', 'failed', 'destroying'/);
  // The two column adds ride the same migration (0135 consumes the thread one).
  assert.match(migration, /ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "branch" text DEFAULT '' NOT NULL/);
  assert.match(migration, /ALTER TABLE "forge_threads" ADD COLUMN IF NOT EXISTS "branch" text/);
  // FK cleans up with the project, like every other child table.
  assert.match(migration, /ON DELETE CASCADE/);
});

// Spec 0142 C: the roll-up inverts a workflow id to a spec id. Namespaced ids
// (`spec-<slug>-<id>`) broke the old prefix-strip, so the first namespaced
// promote merged to main and left its spec on `staged` — silently, because the
// roll-up is best-effort and "0 rows updated" looks identical to "nothing to
// update".
test("a workflow id inverts to its spec id for BOTH id shapes", () => {
  const invert = (id: string) => id.split("-").pop() ?? id;
  assert.equal(invert("spec-ab-test-sandbox-0003"), "0003");
  assert.equal(invert("spec-0130"), "0130");
  // The old prefix-strip is what failed — kept as the counter-example.
  assert.notEqual("spec-ab-test-sandbox-0003".replace(/^spec-/, ""), "0003");
});
