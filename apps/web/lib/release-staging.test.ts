/**
 * Spec 0223 C — against a REAL git repository, because the defect being fixed is
 * a fact about git objects. A fake would prove the arguments I pass, not that a
 * branch head is an ancestor of the merge commit that ate it (verification #1).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { releaseWasStaged } from "./release-staging.js";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

/** A repo shaped like a promoted branch: main, a branch, a --no-ff merge. */
function buildRepo(): { dir: string; branchHead: string; mergeSha: string; unrelated: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "release-staging-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: ENV }).trim();

  git("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "base");
  git("add", "-A"); git("commit", "-qm", "base");
  const unrelated = git("rev-parse", "HEAD");

  git("checkout", "-q", "-b", "feature");
  writeFileSync(path.join(dir, "b.txt"), "work");
  git("add", "-A"); git("commit", "-qm", "the work someone validated on staging");
  const branchHead = git("rev-parse", "HEAD"); // what staging_sha records

  git("checkout", "-q", "main");
  // --no-ff is what GitHub's merge_method:"merge" does: a NEW commit either way.
  git("merge", "--no-ff", "-q", "-m", "Merge pull request #1", "feature");
  const mergeSha = git("rev-parse", "HEAD"); // what the release is cut at

  // No remote — the helper's fetch fails, which must not turn a real answer into
  // a wrong one. Give it an origin pointing at itself so fetch succeeds.
  git("remote", "add", "origin", dir);
  git("fetch", "-q", "origin", "main");
  return { dir, branchHead, mergeSha, unrelated };
}

test("spec 0223: the branch head IS staged for its merge commit — the case broken on 1.0.7", async () => {
  const r = buildRepo();
  try {
    assert.notEqual(r.branchHead, r.mergeSha, "a merge commit is never the branch head");
    // The check this replaces compared these two for equality and always said no.
    assert.equal(await releaseWasStaged(r.dir, [r.branchHead], r.mergeSha), true);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("spec 0223: a staging commit NOT contained in the release still reads false", async () => {
  const r = buildRepo();
  try {
    // The branch head is not an ancestor of the commit that predates it.
    assert.equal(await releaseWasStaged(r.dir, [r.branchHead], r.unrelated), false);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("spec 0223: one matching branch among several is enough", async () => {
  const r = buildRepo();
  try {
    const staged = ["0000000000000000000000000000000000000000", r.branchHead];
    assert.equal(await releaseWasStaged(r.dir, staged, r.mergeSha), true);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("spec 0223: nothing ever staged is an honest false, not an unanswered question", async () => {
  assert.equal(await releaseWasStaged("/nonexistent", [], "abc"), false);
  assert.equal(await releaseWasStaged("/nonexistent", [null, undefined, "  "], "abc"), false);
});

test("spec 0223: a question git cannot answer is undefined — never a claim of 'never staged'", async () => {
  assert.equal(await releaseWasStaged("", ["abc123"], "def456"), undefined);
  assert.equal(await releaseWasStaged("/nonexistent-repo-path", ["abc123"], "def456"), undefined);
});

test("spec 0223: an unknown staging sha does not become a false answer", async () => {
  const r = buildRepo();
  try {
    // 128 (unknown object), not 1 (honest no) — so we never established a "no".
    const unknown = "1234567890123456789012345678901234567890";
    assert.equal(await releaseWasStaged(r.dir, [unknown], r.mergeSha), undefined);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
