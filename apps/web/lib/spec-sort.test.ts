import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SORT,
  nextSort,
  sortSpecRows,
  type SpecSortRow,
} from "./spec-sort.js";

// ---------------------------------------------------------------------------
// spec 0032 item 1: sortSpecRows/nextSort implement the comparator + toggle
// logic used by the client-side sortable `/specs` table. Each test maps to
// an acceptance bullet.
// ---------------------------------------------------------------------------

const rows: SpecSortRow[] = [
  { id: "0002", title: "Beta", status: "approved", pipelineLabel: "Coding" },
  { id: "0010", title: "Alpha", status: "draft", pipelineLabel: "Promoted" },
  { id: "0007", title: "Gamma", status: "staged", pipelineLabel: "Review" },
];

// Default load is id-descending.
test("DEFAULT_SORT is id descending", () => {
  assert.deepEqual(DEFAULT_SORT, { column: "id", direction: "desc" });
});

test("sortSpecRows orders by id descending by default", () => {
  const out = sortSpecRows(rows, "id", "desc").map((r) => r.id);
  assert.deepEqual(out, ["0010", "0007", "0002"]);
});

test("sortSpecRows sorts title ascending by locale", () => {
  const out = sortSpecRows(rows, "title", "asc").map((r) => r.title);
  assert.deepEqual(out, ["Alpha", "Beta", "Gamma"]);
});

test("sortSpecRows does not mutate its input", () => {
  const before = rows.map((r) => r.id);
  sortSpecRows(rows, "status", "asc");
  assert.deepEqual(rows.map((r) => r.id), before);
});

test("nextSort toggles direction on the active column, else switches column", () => {
  assert.deepEqual(nextSort({ column: "id", direction: "desc" }, "id"), {
    column: "id",
    direction: "asc",
  });
  assert.deepEqual(nextSort({ column: "id", direction: "desc" }, "title"), {
    column: "title",
    direction: "asc",
  });
});
