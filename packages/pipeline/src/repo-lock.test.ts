import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withRepoLock } from "./repo-lock.js";
import { git, run } from "./git.js";
import { commitDraftIfUncommitted } from "./activities.js";

/** A real temp git repo, same discipline as draft-spec.test.ts: this exercises real
 * git concurrency, which a mock cannot reproduce — index.lock IS the phenomenon. */
async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-lock-"));
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.email", "t@e.st"], root);
  await run("git", ["config", "user.name", "T"], root);
  await mkdir(path.join(root, "specs"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "x\n");
  // A tracked placeholder so `specs/` is not an ENTIRELY untracked directory —
  // otherwise `git status --porcelain` collapses new spec files to a single
  // "specs/" line and `commitDraftIfUncommitted`'s `dirty.includes(specFile)`
  // check silently misses. Same workaround, same reason, as draft-spec.test.ts's
  // makeBareRepo; omitting it made this test fail 3/3 on the helper, not the lock.
  await writeFile(path.join(root, "specs", ".gitkeep"), "");
  await run("git", ["add", "."], root);
  await run("git", ["commit", "-m", "init"], root);
  return root;
}

async function draft(root: string, id: string): Promise<void> {
  const f = `specs/${id}-x.md`;
  await writeFile(path.join(root, f), `---\nid: ${id}\n---\n`);
  await git.commit(root, `docs(spec-${id}): draft`, [f]);
}

// NOTE: there is deliberately NO test asserting the UNLOCKED race here. I wrote one
// and it failed on its first run and passed on its second — a test whose subject is a
// timing-dependent interleave is flaky by construction, and a flaky test is worse than
// no test: it trains people to re-run instead of to look. The race is documented in
// repo-lock.ts's module doc with the reproduction (3/3) that motivated this file. What
// is pinned below is the LOCK's behaviour, which is deterministic.

test("withRepoLock serializes them: both commits land, tree clean", async () => {
  const root = await repo();
  const results = await Promise.allSettled([
    withRepoLock(root, () => draft(root, "0900")),
    withRepoLock(root, () => draft(root, "0901")),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "fulfilled"],
    "neither run should fail on a lock it could have waited for",
  );
  const log = await run("git", ["log", "--oneline"], root);
  assert.equal(log.out.trim().split("\n").length, 3, "init + two drafts");
  assert.deepEqual(await git.dirtyFiles(root), [], "no orphaned file left behind");
});

test("a failing holder neither blocks the queue nor poisons the next caller", async () => {
  const root = await repo();
  const boom = withRepoLock(root, async () => {
    throw new Error("holder exploded");
  });
  const after = withRepoLock(root, () => draft(root, "0902"));
  await assert.rejects(() => boom, /holder exploded/, "the owner still sees its error");
  await after; // must not reject with the predecessor's error
  assert.deepEqual(await git.dirtyFiles(root), []);
});

test("different repos do not serialize against each other", async () => {
  // Two customer repos must run in parallel — that is the whole point of v0's
  // multi-repo model, and a global lock would silently destroy it.
  const [a, b] = [await repo(), await repo()];
  let inFlight = 0;
  let sawParallel = false;
  const work = (r: string) =>
    withRepoLock(r, async () => {
      inFlight += 1;
      if (inFlight > 1) sawParallel = true;
      await new Promise((res) => setTimeout(res, 30));
      inFlight -= 1;
    });
  await Promise.all([work(a), work(b)]);
  assert.ok(sawParallel, "locks must be per-repo, not global");
});

test("the lock preserves call order for one repo", async () => {
  const order: string[] = [];
  const root = await repo();
  await Promise.all([
    withRepoLock(root, async () => void order.push("first")),
    withRepoLock(root, async () => void order.push("second")),
    withRepoLock(root, async () => void order.push("third")),
  ]);
  assert.deepEqual(order, ["first", "second", "third"]);
});

// --- The acceptance criterion: the REAL activity, run concurrently ------------

test("two concurrent commitDraftIfUncommitted calls both land, tree clean", async () => {
  // This is spec 0115's acceptance test for concurrency A: not "the lock works" but
  // "two simultaneous runs complete without corrupting the shared checkout". It
  // exercises the real exported activity against a real git repo, because the whole
  // phenomenon (index.lock) lives in git and a fake cannot reproduce it.
  const root = await repo();
  const write = async (id: string) => {
    const f = `specs/${id}-x.md`;
    await writeFile(path.join(root, f), `---\nid: ${id}\n---\n`);
    return f;
  };
  const [fa, fb] = [await write("0900"), await write("0901")];

  const results = await Promise.allSettled([
    commitDraftIfUncommitted(root, fa, "claude-test"),
    commitDraftIfUncommitted(root, fb, "claude-test"),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "fulfilled"],
    "neither concurrent draft-commit should fail",
  );

  assert.deepEqual(await git.dirtyFiles(root), [], "no spec file left untracked");
  const log = await run("git", ["log", "--oneline"], root);
  assert.equal(log.out.trim().split("\n").length, 3, "init + both drafts committed");

  // Each commit must contain only its own spec file — the messages must not lie.
  const names = await run("git", ["log", "--format=%s", "--name-only", "-2"], root);
  for (const id of ["0900", "0901"]) {
    assert.match(names.out, new RegExp(`docs\\(spec-${id}\\): draft`), `${id} has its own commit`);
  }
});
