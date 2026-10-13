import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSpecId } from "./spec-counters.js";

/**
 * Spec 0164. The ALLOCATOR's correctness is SQL semantics — one statement,
 * serialised by Postgres — so it is proven against a real database (see the
 * spec's live check), not here. What is pure and worth pinning is the format:
 * a spec id is a zero-padded 4-digit string, because every reader on disk,
 * in a workflow id and in a URL assumes that shape.
 */
test("formatSpecId pads to the width every reader assumes", () => {
  assert.equal(formatSpecId(1), "0001");
  assert.equal(formatSpecId(164), "0164");
  assert.equal(formatSpecId(1234), "1234");
  // Never truncates past the width — a 5-digit project is unlikely but a
  // silently shortened id would collide with a real one.
  assert.equal(formatSpecId(12345), "12345");
});
