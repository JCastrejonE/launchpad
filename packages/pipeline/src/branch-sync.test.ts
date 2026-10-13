/**
 * Branch reconciliation against REAL git (spec 0133 D) — a bare origin plus
 * working clones, asserting resulting SHAs and reasons: git's own behavior,
 * never the argv we passed (docs/VERIFICATION.md #1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, git } from "./git.js";
import { ensureLocalBranchAtOrigin } from "./branch-sync.js";

async function sh(cwd: string, cmd: string, args: string[]): Promise<string> {
  const r = await run(cmd, args, cwd);
  assert.ok(r.ok, `${cmd} ${args.join(" ")} failed: ${r.out}`);
  return r.out;
}

/** A bare origin with one commit on main, plus a working clone. */
async function makeOriginAndClone(): Promise<{ dir: string; origin: string; clone: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "launchpad-branch-sync-"));
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

/** Commit + push a branch from a THROWAWAY second clone, so the branch exists
 * on origin without the working clone having any local ref for it. */
async function pushBranchFromElsewhere(
  dir: string,
  origin: string,
  branch: string,
  file: string,
): Promise<string> {
  const other = path.join(dir, `other-${file.replace(/\W/g, "")}`);
  await sh(dir, "git", ["clone", origin, other]);
  await sh(other, "git", ["config", "user.email", "o@example.com"]);
  await sh(other, "git", ["config", "user.name", "O"]);
  // Start from the branch's CURRENT origin tip when it exists (so consecutive
  // pushes fast-forward), else fork it from main — mirroring a real second
  // machine touching the branch.
  const onOrigin = await run(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    other,
  );
  await sh(
    other,
    "git",
    onOrigin.ok ? ["checkout", "-B", branch, `origin/${branch}`] : ["checkout", "-B", branch],
  );
  await writeFile(path.join(other, file), "x\n");
  await sh(other, "git", ["add", file]);
  await sh(other, "git", ["commit", "-m", `add ${file}`]);
  await sh(other, "git", ["push", "origin", branch]);
  return (await sh(other, "git", ["rev-parse", "HEAD"])).trim();
}

test("a branch that does not exist on origin is a missing_on_origin refusal", async () => {
  const { clone } = await makeOriginAndClone();
  const result = await ensureLocalBranchAtOrigin(clone, "no-such-branch");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "missing_on_origin");
});

test("a branch on origin with no local ref is created AT ORIGIN'S TIP", async () => {
  const { dir, origin, clone } = await makeOriginAndClone();
  const originSha = await pushBranchFromElsewhere(dir, origin, "feature/a", "a.txt");
  const result = await ensureLocalBranchAtOrigin(clone, "feature/a");
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.ok && result.sha, originSha);
  assert.equal(result.ok && result.ahead, 0);
});

test("behind-only fast-forwards the local ref to origin's tip", async () => {
  const { dir, origin, clone } = await makeOriginAndClone();
  await pushBranchFromElsewhere(dir, origin, "feature/b", "b1.txt");
  await ensureLocalBranchAtOrigin(clone, "feature/b"); // local ref at first tip
  const newTip = await pushBranchFromElsewhere(dir, origin, "feature/b", "b2.txt");
  const result = await ensureLocalBranchAtOrigin(clone, "feature/b");
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.ok && result.sha, newTip, "local must move to origin's new tip");
});

test("ahead-only is tolerated: unpushed commits ride along, counted", async () => {
  const { dir, origin, clone } = await makeOriginAndClone();
  await pushBranchFromElsewhere(dir, origin, "feature/c", "c.txt");
  await ensureLocalBranchAtOrigin(clone, "feature/c");
  // A crashed run's leftover: a local commit on the branch, never pushed.
  await sh(clone, "git", ["checkout", "feature/c"]);
  await writeFile(path.join(clone, "local.txt"), "crashed run\n");
  await sh(clone, "git", ["add", "local.txt"]);
  await sh(clone, "git", ["commit", "-m", "unpushed"]);
  const localSha = (await sh(clone, "git", ["rev-parse", "HEAD"])).trim();
  await sh(clone, "git", ["checkout", "main"]);

  const result = await ensureLocalBranchAtOrigin(clone, "feature/c");
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.ok && result.sha, localSha, "the local tip is kept, never reset");
  assert.equal(result.ok && result.ahead, 1);
});

test("diverged refuses with both counts — the operator decides, never a rebase", async () => {
  const { dir, origin, clone } = await makeOriginAndClone();
  await pushBranchFromElsewhere(dir, origin, "feature/d", "d1.txt");
  await ensureLocalBranchAtOrigin(clone, "feature/d");
  // Local commit…
  await sh(clone, "git", ["checkout", "feature/d"]);
  await writeFile(path.join(clone, "mine.txt"), "mine\n");
  await sh(clone, "git", ["add", "mine.txt"]);
  await sh(clone, "git", ["commit", "-m", "mine"]);
  await sh(clone, "git", ["checkout", "main"]);
  // …and a different commit on origin.
  await pushBranchFromElsewhere(dir, origin, "feature/d", "d2.txt");

  const result = await ensureLocalBranchAtOrigin(clone, "feature/d");
  assert.equal(result.ok, false);
  if (!result.ok && result.reason === "diverged") {
    assert.equal(result.ahead, 1);
    assert.equal(result.behind, 1);
  } else {
    assert.fail(`expected diverged, got ${JSON.stringify(result)}`);
  }
});

test("a behind branch HELD BY a worktree is busy — the serializer, not an error", async () => {
  const { dir, origin, clone } = await makeOriginAndClone();
  await pushBranchFromElsewhere(dir, origin, "feature/e", "e1.txt");
  await ensureLocalBranchAtOrigin(clone, "feature/e");
  // Another run's worktree holds the branch…
  await git.worktreeAdd(clone, path.join(clone, ".worktrees", "spec-9999"), "feature/e");
  // …and origin moves.
  await pushBranchFromElsewhere(dir, origin, "feature/e", "e2.txt");

  const result = await ensureLocalBranchAtOrigin(clone, "feature/e");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "busy", JSON.stringify(result));
});

// Spec 0142: a project chat works in the primary checkout and can leave it
// parked on the branch (its Bash policy allows git, spec 0140). Git permits
// one checkout per branch, so the next run would be told the branch is busy
// when nothing holds it. The sync detaches the primary tree first.
test("a primary checkout sitting ON the branch is detached, not reported busy", async () => {
  const { dir, origin, clone } = await makeOriginAndClone();
  await pushBranchFromElsewhere(dir, origin, "feature/x", "a.txt");
  await sh(clone, "git", ["fetch", "origin", "feature/x"]);
  // Park the primary checkout on the branch, exactly as a chat would.
  await sh(clone, "git", ["checkout", "-B", "feature/x", "origin/feature/x"]);
  const before = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], clone);
  assert.equal(before.out.trim(), "feature/x", "precondition: primary is on the branch");

  const result = await ensureLocalBranchAtOrigin(clone, "feature/x");
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`);

  // The OUTCOME that matters (VERIFICATION #1: assert git's response, not our
  // argv): a worktree for that branch can now actually be created.
  const wt = await run(
    "git",
    ["worktree", "add", path.join(clone, ".worktrees", "probe"), "feature/x"],
    clone,
  );
  assert.equal(wt.ok, true, `worktree add must succeed after detach: ${wt.out}`);
});
