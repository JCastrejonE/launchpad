import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coAuthorTrailer,
  hasCoAuthorTrailer,
  ensureCoAuthorTrailer,
  commitTrailerInstruction,
  CO_AUTHOR_NAME,
  HUMAN_AUTHOR_EMAIL,
  isTrailerExempt,
  trailerCoverageViolations,
} from "./commit-trailer.js";

test("CO_AUTHOR_NAME is Claude", () => {
  assert.equal(CO_AUTHOR_NAME, "Claude");
});

test("coAuthorTrailer renders `Co-Authored-By: Claude <model>`", () => {
  assert.equal(coAuthorTrailer("claude-sonnet-5"), "Co-Authored-By: Claude claude-sonnet-5");
});

test("hasCoAuthorTrailer detects an existing trailer (any model id)", () => {
  assert.equal(hasCoAuthorTrailer("feat: x\n\nCo-Authored-By: Claude claude-opus-4-8"), true);
  assert.equal(hasCoAuthorTrailer("feat: x"), false);
});

test("ensureCoAuthorTrailer appends when missing, reporting changed:true", () => {
  const r = ensureCoAuthorTrailer("feat(spec-0009): x", "claude-sonnet-5");
  assert.equal(r.changed, true);
  assert.ok(hasCoAuthorTrailer(r.message));
});

test("ensureCoAuthorTrailer is a no-op when the trailer is present (changed:false)", () => {
  const msg = "feat: x\n\nCo-Authored-By: Claude claude-sonnet-5";
  const r = ensureCoAuthorTrailer(msg, "claude-sonnet-5");
  assert.equal(r.changed, false);
  assert.equal(r.message, msg);
});

test("commitTrailerInstruction names the trailer to append", () => {
  assert.match(commitTrailerInstruction("claude-sonnet-5"), /Co-Authored-By: Claude claude-sonnet-5/);
});

// --- Trailer-coverage exemption policy (spec 0010 item 3) ---

test("isTrailerExempt: markSpec `status -> *` commits are exempt", () => {
  assert.equal(
    isTrailerExempt({ message: "chore(spec-0010): status -> promoted", authorEmail: "agent@bot" }),
    true,
  );
});

test("isTrailerExempt: merge commits are exempt", () => {
  assert.equal(
    isTrailerExempt({ message: "Merge branch 'spec/0010'", authorEmail: "agent@bot", parents: 2 }),
    true,
  );
});

test("isTrailerExempt: human commits (owner@example.com) are exempt", () => {
  assert.equal(isTrailerExempt({ message: "fix(web): x", authorEmail: HUMAN_AUTHOR_EMAIL }), true);
});

test("isTrailerExempt: a plain agent feature commit is NOT exempt", () => {
  assert.equal(isTrailerExempt({ message: "feat(pipeline): x", authorEmail: "agent@bot" }), false);
});

test("trailerCoverageViolations: flags only non-exempt agent commits missing the trailer", () => {
  const violations = trailerCoverageViolations([
    { message: "feat(pipeline): missing", authorEmail: "agent@bot" },
    {
      message: "feat(pipeline): ok\n\nCo-Authored-By: Claude claude-opus-4-8",
      authorEmail: "agent@bot",
    },
    { message: "chore(spec-0010): status -> staged", authorEmail: "agent@bot" }, // exempt
    { message: "fix(web): human", authorEmail: HUMAN_AUTHOR_EMAIL }, // exempt
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /missing/);
});
