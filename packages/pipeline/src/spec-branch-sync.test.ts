/**
 * Per-spec branch reconciliation against REAL git (spec 0159) — a bare origin
 * plus a working clone, asserting the resulting WORKTREE contents and branch
 * SHAs, never the argv we passed (docs/VERIFICATION.md #1). Version-independent
 * (unlike 0158): this behaviour does not depend on the worker's git 2.34.1, so
 * the break-it check runs on a dev machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./git.js";
import { reconcileSpecBranchWithMain } from "./spec-branch-sync.js";

async function sh(cwd: string, cmd: string, args: string[]): Promise<string> {
  const r = await run(cmd, args, cwd);
  assert.ok(r.ok, `${cmd} ${args.join(" ")} failed: ${r.out}`);
  return r.out;
}

/** A bare origin with one commit on main, plus a working clone (the "root"
 * checkout the pipeline provisions worktrees from). */
async function makeOriginAndClone(): Promise<{ dir: string; origin: string; clone: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "launchpad-spec-branch-sync-"));
  const origin = path.join(dir, "origin.git");
  await sh(dir, "git", ["init", "--bare", "-b", "main", origin]);

  const seed = path.join(dir, "seed");
  await sh(dir, "git", ["clone", origin, seed]);
  await sh(seed, "git", ["config", "user.email", "t@example.com"]);
  await sh(seed, "git", ["config", "user.name", "T"]);
  await writeFile(path.join(seed, "README.md"), "hello\n");
  await sh(seed, "git", ["add", "README.md"]);
  await sh(seed, "git", ["commit", "-m", "init"]);
  await sh(seed, "git", ["push", "origin", "main"]);

  const clone = path.join(dir, "work");
  await sh(dir, "git", ["clone", origin, clone]);
  await sh(clone, "git", ["config", "user.email", "t@example.com"]);
  await sh(clone, "git", ["config", "user.name", "T"]);
  return { dir, origin, clone };
}

/** Advance `origin/main` by one commit from a THROWAWAY clone, so the working
 * clone's `spec/<id>` branch falls behind exactly as it does in the incident.
 * `content` writes/overwrites `file` — pass a distinct value to force a conflict
 * against a branch that touched the same path. */
async function advanceMain(
  dir: string,
  origin: string,
  file: string,
  content: string,
): Promise<void> {
  const other = path.join(dir, `adv-${file.replace(/\W/g, "")}`);
  await sh(dir, "git", ["clone", origin, other]);
  await sh(other, "git", ["config", "user.email", "o@example.com"]);
  await sh(other, "git", ["config", "user.name", "O"]);
  await writeFile(path.join(other, file), content);
  await sh(other, "git", ["add", file]);
  await sh(other, "git", ["commit", "-m", `main: ${file}`]);
  await sh(other, "git", ["push", "origin", "main"]);
}

test("a stale branch behind main is brought up so the worktree sees today's code", async () => {
  const { dir, origin, clone } = await makeOriginAndClone();
  // Cut spec/0159 from main's tip, THEN advance main — the branch ref stays at
  // the old main, reproducing the leftover-branch incident.
  await sh(clone, "git", ["branch", "spec/0159"]);
  await advanceMain(dir, origin, "on-newer-main.txt", "today\n");

  const wt = path.join(dir, "wt-a");
  await sh(clone, "git", ["worktree", "add", wt, "spec/0159"]);
  const result = await reconcileSpecBranchWithMain(wt);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.action, "fast_forwarded");
  // Assert by READING the newer-main-only file now present in the worktree —
  // not by trusting the merge's exit code (VERIFICATION #1/#2).
  assert.equal(await readFile(path.join(wt, "on-newer-main.txt"), "utf8"), "today\n");
});

test("a genuinely conflicting branch is refused with stale_conflict, branch UNCHANGED", async () => {
  const { dir, origin, clone } = await makeOriginAndClone();
  await sh(clone, "git", ["branch", "spec/0159"]);

  // The branch does its own work on README.md (what resuming is for)...
  const wt = path.join(dir, "wt-b");
  await sh(clone, "git", ["worktree", "add", wt, "spec/0159"]);
  await sh(wt, "git", ["config", "user.email", "t@example.com"]);
  await sh(wt, "git", ["config", "user.name", "T"]);
  await writeFile(path.join(wt, "README.md"), "branch version\n");
  await sh(wt, "git", ["commit", "-am", "branch edits README"]);
  const before = (await sh(wt, "git", ["rev-parse", "HEAD"])).trim();

  // ...and main independently changes the SAME path → an unresolvable merge.
  await advanceMain(dir, origin, "README.md", "main version\n");

  const result = await reconcileSpecBranchWithMain(wt);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "stale_conflict");
  assert.deepEqual(!result.ok && result.paths, ["README.md"]);
  // merge --abort left the branch exactly as it was — a human resolves, never us.
  const after = (await sh(wt, "git", ["rev-parse", "HEAD"])).trim();
  assert.equal(after, before);
});

test("a branch already containing main is a no-op (no empty merge commit)", async () => {
  const { dir, clone } = await makeOriginAndClone();
  // Branch cut from main's tip, main never advances → branch already contains it.
  await sh(clone, "git", ["branch", "spec/0159"]);
  const wt = path.join(dir, "wt-c");
  await sh(clone, "git", ["worktree", "add", wt, "spec/0159"]);
  const before = (await sh(wt, "git", ["rev-parse", "HEAD"])).trim();

  const result = await reconcileSpecBranchWithMain(wt);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.action, "up_to_date");
  const after = (await sh(wt, "git", ["rev-parse", "HEAD"])).trim();
  assert.equal(after, before);
});
