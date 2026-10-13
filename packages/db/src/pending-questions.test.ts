/**
 * Spec 0220: guards on the hand-written 0018 migration and on the one property
 * the module must never lose — that an ending is written, never erased.
 *
 * Files only, no database (the live check is the spec's `(human)` item).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const sql = readFileSync(new URL("../drizzle/0018_pending_questions.sql", import.meta.url), "utf8");
const source = readFileSync(new URL("../src/pending-questions.ts", import.meta.url), "utf8");

test("0018 creates pending_questions with the four endings in a CHECK", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "pending_questions"/);
  assert.match(sql, /CONSTRAINT "pending_questions_resolution_check" CHECK/);
  for (const ending of ["'answered'", "'expired'", "'superseded'", "'run_stopped'"]) {
    assert.ok(sql.includes(ending), `resolution CHECK missing ${ending}`);
  }
  // A platform thread has no project row, so the FK must survive its absence.
  assert.match(sql, /"project_id" uuid REFERENCES "projects"\("id"\) ON DELETE SET NULL/);
});

test("the thread index is PARTIAL — one PENDING question, not one row, per thread", () => {
  // A plain unique index would force the next question to overwrite the row,
  // erasing the `superseded` ending that same insert creates.
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS "pending_questions_thread_pending_key"\s*\n?\s*ON "pending_questions" \("thread_id"\) WHERE "resolved_at" IS NULL;/,
  );
});

test("pending_questions stores what was asked, never the answers", () => {
  for (const forbidden of ["answer", "answers", "options", "choices", "response"]) {
    assert.doesNotMatch(
      sql,
      new RegExp(`"${forbidden}"\\s+(text|jsonb)`, "i"),
      `spec 0075's rule: ${forbidden} does not belong in this row`,
    );
  }
});

test("no code path removes a row — an ending is recorded by UPDATE only", () => {
  assert.doesNotMatch(source, /\.delete\(/, "the row must be updated, never removed");
  assert.doesNotMatch(source, /DELETE\s+FROM/i);
  assert.match(source, /\.update\(pendingQuestions\)/);
});

test("opening supersedes the thread's live question BEFORE inserting the new one", () => {
  // The `superseded` ending is written HERE, not by run-registry's stale branch
  // (spec 0220 item 2): the partial unique index refuses a second pending row,
  // so the open has to close the old one — and it must do so first.
  const open = /export async function openPendingQuestion[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  const supersede = open.indexOf('"superseded"');
  const insert = open.indexOf(".insert(");
  assert.ok(supersede > -1, "openPendingQuestion must resolve the live row as superseded");
  assert.ok(insert > supersede, "the supersede must be awaited BEFORE the insert");
});

test("the journal lists 0018", () => {
  const journal = JSON.parse(
    readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entry = journal.entries.find((e) => e.tag === "0018_pending_questions");
  assert.ok(entry, "0018_pending_questions missing from meta/_journal.json");
  assert.equal(entry.idx, 18);
});
