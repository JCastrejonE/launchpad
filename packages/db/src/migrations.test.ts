/**
 * Smoke-guard (spec 0072): the committed drizzle/ SQL baseline actually
 * creates what schema.ts declares — catches "edited schema.ts, forgot
 * `drizzle-kit generate`" for the objects Phase A depends on. Runs against
 * the files only; no database.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { migrationsFolder } from "./migrate.js";

function allMigrationSql(): string {
  const dir = migrationsFolder();
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  assert.ok(files.length > 0, `no .sql migrations found in ${dir}`);
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n").toLowerCase();
}

test("baseline migration creates the Phase-A tables and role enum", () => {
  const sql = allMigrationSql();
  for (const table of ["users", "audit_log", "secrets", "projects", "vps", "spec_files", "agent_runs"]) {
    assert.match(sql, new RegExp(`create table "${table}"`), `missing CREATE TABLE "${table}"`);
  }
  assert.match(sql, /create type "public"\."user_role"/);
  assert.match(sql, /create type "public"\."project_kind"/);
  assert.match(sql, /create type "public"\."health"/);
  for (const role of ["'OWNER'", "'MEMBER'", "'VIEWER'"]) {
    assert.ok(sql.toUpperCase().includes(role), `user_role enum missing ${role}`);
  }
  for (const kind of ["'odoo'", "'odoo_next'", "'custom'", "'platform'"]) {
    assert.ok(sql.includes(kind), `project_kind enum missing ${kind}`);
  }
  // spec_files / agent_runs FK to projects (Phase-B referential integrity).
  assert.match(sql, /alter table "spec_files".*references "public"\."projects"/s);
  assert.match(sql, /alter table "agent_runs".*references "public"\."projects"/s);
});

test("journal exists and references every .sql file", () => {
  const dir = migrationsFolder();
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const sqlFiles = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  assert.equal(journal.entries.length, sqlFiles.length);
  for (const entry of journal.entries) {
    assert.ok(
      sqlFiles.includes(`${entry.tag}.sql`),
      `journal entry ${entry.tag} has no matching .sql file`,
    );
  }
});

// Spec 0126: the production-target migration is hand-written, so its guard is
// asserted here rather than trusted — a CHECK that silently allows anything is
// indistinguishable from no CHECK at all until bad data is already stored.
test("0005 adds both production columns, idempotently, with a NULL-tolerant CHECK", () => {
  const sql = readFileSync(
    new URL("../drizzle/0005_project_production_target.sql", import.meta.url),
    "utf8",
  );
  for (const col of ["production_kind", "production_host"]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS "${col}" text`), col);
  }
  // Exactly the three literals PRODUCTION_KINDS exposes, and NULL still allowed
  // (every pre-0126 row has no recorded target and must keep working).
  assert.match(sql, /"production_kind" IS NULL OR "production_kind" IN \('odoosh', 'fleet', 'none'\)/);
  // Re-runnable: the constraint is added only when absent.
  assert.match(sql, /pg_constraint WHERE conname = 'projects_production_kind_check'/);
});

// --- spec 0194: one row per SESSION, not per run -----------------------------

test("0015 creates agent_sessions with a NON-unique workflow key", () => {
  const sql = readFileSync(new URL("../drizzle/0015_agent_sessions.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "agent_sessions"/);
  // The whole point: many sessions per run. `agent_runs.workflow_id` is UNIQUE
  // and that is exactly what made "how many coder sessions?" unanswerable.
  assert.doesNotMatch(
    sql,
    /"workflow_id"[^,]*UNIQUE/i,
    "workflow_id must NOT be unique here — many sessions per run is the point",
  );
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "agent_sessions_workflow_idx"/);
  // A platform run has no project row, so the FK must survive its absence.
  assert.match(sql, /"project_id" uuid REFERENCES "projects"\("id"\) ON DELETE SET NULL/);
});

test("agent_sessions records arithmetic only — no prompt, no content", () => {
  const sql = readFileSync(new URL("../drizzle/0015_agent_sessions.sql", import.meta.url), "utf8");
  for (const forbidden of ["prompt", "handoff", "content", "message", "note"]) {
    assert.doesNotMatch(
      sql,
      new RegExp(`"${forbidden}[a-z_]*"\\s+(text|jsonb)`, "i"),
      `spec 0075's rule: ${forbidden} does not belong in a telemetry row`,
    );
  }
});

test("0016 adds staging_note idempotently, defaulting to empty", () => {
  const sql = readFileSync(
    new URL("../drizzle/0016_branch_staging_note.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /ALTER TABLE "project_branches" ADD COLUMN IF NOT EXISTS "staging_note"/);
  // NOT NULL DEFAULT '' rather than nullable: "no reason" and "reason unknown"
  // are the same thing here, and a null would make every reader handle both.
  assert.match(sql, /text NOT NULL DEFAULT ''/);
});
