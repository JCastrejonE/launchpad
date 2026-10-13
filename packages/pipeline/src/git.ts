/** Minimal git/exec helpers for launchpad-target (local dogfood) activities. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export async function run(
  cmd: string,
  args: string[],
  cwd: string,
  /** Extra env vars overlaid on `process.env` for this invocation (spec 0010
   * item 1: `runCi` passes `TEMPORAL_TEST=1` so the workflow harness executes).
   * Omit to inherit the parent env unchanged. */
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; out: string; execError?: boolean }> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return { ok: true, out: stdout + stderr };
  } catch (e) {
    const err = e as {
      code?: string | number;
      signal?: NodeJS.Signals | null;
      stdout?: string;
      stderr?: string;
      message: string;
    };
    // A NUMERIC `code` is the child's own non-zero EXIT status — a real command
    // verdict (tests red, git rejected the merge). A STRING `code`
    // (ENOENT / EACCES / ERR_CHILD_PROCESS_STDIO_MAXBUFFER) or a `signal` means
    // the process never ran to completion (binary missing, killed, output
    // overflowed): an INFRASTRUCTURE failure, not a verdict. `runCi` reads
    // `execError` to avoid treating "pnpm not found" as "tests failed"
    // (SPEC-ALIGNMENT §9.3). Existing callers read only `ok`, so are unaffected.
    const execError = typeof err.code !== "number";
    return {
      ok: false,
      out: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message}`,
      execError,
    };
  }
}

export const git = {
  async checkout(cwd: string, ref: string): Promise<void> {
    const r = await run("git", ["checkout", ref], cwd);
    if (!r.ok) throw new Error(`git checkout ${ref} failed: ${r.out}`);
  },
  async mergeNoFf(cwd: string, branch: string): Promise<void> {
    const r = await run("git", ["merge", "--no-ff", "--no-edit", branch], cwd);
    if (!r.ok) throw new Error(`git merge ${branch} failed: ${r.out}`);
  },
  async currentBranch(cwd: string): Promise<string> {
    const r = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    if (!r.ok) throw new Error(r.out);
    return r.out.trim();
  },
  /** SHA of `ref` (default HEAD) — compared before/after a coder session to
   * detect a stall (no new commit) for spec 0006's convergence loop. */
  async headSha(cwd: string, ref = "HEAD"): Promise<string> {
    const r = await run("git", ["rev-parse", ref], cwd);
    if (!r.ok) throw new Error(r.out);
    return r.out.trim();
  },
  /** Short HEAD SHA (`git rev-parse --short HEAD`) — the worker's build id
   * (spec 0008 worker hygiene), logged at startup and used to spot a stale
   * second worker still running pre-rebuild code. */
  async shortHeadSha(cwd: string, ref = "HEAD"): Promise<string> {
    const r = await run("git", ["rev-parse", "--short", ref], cwd);
    if (!r.ok) throw new Error(r.out);
    return r.out.trim();
  },
  /** Repo-relative paths changed between two commits
   * (`git diff --name-only <from>..<to>`) — the raw fact feeding the spec 0008
   * stall-detection seam (progress.ts). Empty when the two SHAs are equal. */
  async changedFiles(cwd: string, from: string, to: string): Promise<string[]> {
    const r = await run("git", ["diff", "--name-only", `${from}..${to}`], cwd);
    if (!r.ok) throw new Error(r.out);
    return r.out.split("\n").map((l) => l.trim()).filter(Boolean);
  },
  /** Repo-relative paths with uncommitted changes (`git status --porcelain`) —
   * for the spec 0008 dirty-tree guard (mergePullRequest/teardownEnv fail
   * loudly, naming these files, instead of surfacing git's raw checkout error).
   * Empty ⇒ a clean working tree. */
  async dirtyFiles(cwd: string): Promise<string[]> {
    const r = await run("git", ["status", "--porcelain"], cwd);
    if (!r.ok) throw new Error(r.out);
    // Each porcelain line is "XY <path>"; the path starts at column 3.
    return r.out.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
  },
  /** Stage `paths` and commit them with `message` (spec 0008: markSpec commits
   * its own status edit instead of leaving the spec file dirty). Stages only
   * the given paths so an otherwise-dirty tree isn't swept into the commit. */
  async commit(cwd: string, message: string, paths: string[]): Promise<void> {
    const add = await run("git", ["add", ...paths], cwd);
    if (!add.ok) throw new Error(`git add failed: ${add.out}`);
    const c = await run("git", ["commit", "-m", message], cwd);
    if (!c.ok) throw new Error(`git commit failed: ${c.out}`);
  },
  /** URL of the `origin` remote (`git remote get-url origin`), or null when no
   * origin is configured — feeds spec 0015's PR-mode resolution (a GitHub
   * origin + GITHUB_TOKEN ⇒ real-PR gate 2, else local-diff fallback). */
  async originUrl(cwd: string): Promise<string | null> {
    const r = await run("git", ["remote", "get-url", "origin"], cwd);
    if (!r.ok) return null;
    return r.out.trim() || null;
  },
  /** Push `branch` and set upstream (`git push -u origin <branch>`) — spec 0015
   * step in openPullRequest before the PR is opened via @launchpad/github. */
  async push(cwd: string, branch: string): Promise<void> {
    const r = await run("git", ["push", "-u", "origin", branch], cwd);
    if (!r.ok) throw new Error(`git push -u origin ${branch} failed: ${r.out}`);
  },
  /** Fast-forward-only pull of `branch` (`git pull --ff-only`) — spec 0015 uses
   * this to sync local `main` after mergePullRequest merges via the API. */
  async pullFfOnly(cwd: string, branch = "main"): Promise<void> {
    const r = await run("git", ["pull", "--ff-only", "origin", branch], cwd);
    if (!r.ok) throw new Error(`git pull --ff-only origin ${branch} failed: ${r.out}`);
  },
  /** Full message (subject + body) of `ref`'s commit (default HEAD) — the
   * spec 0009 trailer check/repair reads this to decide whether the agent
   * already wrote the `Co-Authored-By` trailer. */
  async lastCommitMessage(cwd: string, ref = "HEAD"): Promise<string> {
    const r = await run("git", ["log", "-1", "--pretty=%B", ref], cwd);
    if (!r.ok) throw new Error(r.out);
    return r.out.trim();
  },
  /** Subjects of the commits in `before..after`, newest first (spec 0113). The
   * stall detector reads these to recognise a justified plan revision, which
   * touches only the spec file and so would otherwise read as a stall. Empty when
   * the range has no commits. */
  async commitSubjects(cwd: string, before: string, after: string): Promise<string[]> {
    const r = await run("git", ["log", "--pretty=%s", `${before}..${after}`], cwd);
    if (!r.ok) throw new Error(r.out);
    return r.out.split("\n").map((l) => l.trim()).filter(Boolean);
  },
  /** Rewrite the last commit's message only (`commit --amend -m`) — no files
   * are staged first, so the tree/content of the commit is untouched. Used by
   * the spec 0009 trailer safety net to append a missing `Co-Authored-By`
   * trailer without altering what the agent actually committed. */
  async amendCommitMessage(cwd: string, message: string): Promise<void> {
    const r = await run("git", ["commit", "--amend", "-m", message], cwd);
    if (!r.ok) throw new Error(`git commit --amend failed: ${r.out}`);
  },
  /** Messages of every commit in `(from, to]` (`git log --pretty=%B`), newest
   * first — the spec 0009 trailer verify step's view of "new commits this
   * session made" so it can check each one for the trailer. Empty when `from`
   * and `to` are equal (no new commits). Commit messages are split on a NUL
   * separator so multi-line/multi-paragraph messages don't get mangled. */
  async commitMessagesBetween(cwd: string, from: string, to: string): Promise<string[]> {
    const r = await run("git", ["log", "--pretty=format:%B%x00", `${from}..${to}`], cwd);
    if (!r.ok) throw new Error(r.out);
    return r.out
      .split("\u0000")
      .map((m) => m.trim())
      .filter(Boolean);
  },
  /**
   * True when `branch` already exists locally (`git rev-parse --verify`)
   * — spec 0017 worktree provisioning reuses an existing branch AT ITS TIP
   * (never reset), so it must first know whether the branch is there.
   */
  async branchExists(cwd: string, branch: string): Promise<boolean> {
    const r = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
    return r.ok;
  },
  /**
   * The worktree currently holding `branch`, or null (spec 0158).
   *
   * Git allows one checkout per branch, and the pipeline leans on that as its
   * serializer. Leaning on git's *refusal message* to detect it does not travel:
   * refusing `git fetch origin <b>:<b>` when a worktree holds `<b>` arrived in
   * git 2.36, and the deployed worker runs **2.34.1** — where the same fetch
   * silently succeeds and moves a ref out from under a running worktree.
   *
   * `git worktree list --porcelain` reports the same fact on every version, so
   * the guard is asked directly instead of being inferred from an error string.
   * The primary checkout is excluded: `ensureLocalBranchAtOrigin` detaches it
   * itself (spec 0142), and it is not another run.
   */
  async worktreeHoldingBranch(cwd: string, branch: string): Promise<string | null> {
    const r = await run("git", ["worktree", "list", "--porcelain"], cwd);
    if (!r.ok) return null;
    let current: string | null = null;
    let primary: string | null = null;
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) {
        current = line.slice("worktree ".length).trim();
        primary ??= current;
      } else if (line.startsWith("branch ") && current && current !== primary) {
        if (line.slice("branch ".length).trim() === `refs/heads/${branch}`) return current;
      }
    }
    return null;
  },

  /**
   * Add a worktree at `worktreePath` checked out on `branch` (spec 0017:
   * `git worktree add <path> <branch>`, creating the branch from main when it
   * doesn't exist yet, reusing it at its tip when it does). The primary
   * checkout is never switched — `git worktree add` operates independently of
   * whatever ref the primary checkout currently has checked out.
   */
  async worktreeAdd(cwd: string, worktreePath: string, branch: string): Promise<void> {
    const exists = await git.branchExists(cwd, branch);
    const r = exists
      ? await run("git", ["worktree", "add", worktreePath, branch], cwd)
      : await run("git", ["worktree", "add", "-b", branch, worktreePath, "main"], cwd);
    if (!r.ok) throw new Error(`git worktree add ${worktreePath} ${branch} failed: ${r.out}`);
  },
  /**
   * Remove the worktree at `worktreePath` (spec 0017: `git worktree remove`)
   * — teardown detaches the run's checkout while retaining its branch.
   *
   * `force` passes `--force`, which is what git requires for a worktree with
   * modified or untracked files. Spec 0188 A: teardown now RECORDS dirt instead
   * of failing the run over it, and a plain `remove` would just move the same
   * failure from our message to git's. The worktree is disposable by
   * construction — its commits are pushed and its branch is retained — so
   * forcing removes a directory, never work.
   */
  async worktreeRemove(cwd: string, worktreePath: string, force = false): Promise<void> {
    const args = force
      ? ["worktree", "remove", "--force", worktreePath]
      : ["worktree", "remove", worktreePath];
    const r = await run("git", args, cwd);
    if (!r.ok) throw new Error(`git worktree remove ${worktreePath} failed: ${r.out}`);
  },
  /**
   * Absolute paths of every registered worktree (`git worktree list --porcelain`,
   * the `worktree ` lines) — lets provision detect/reuse and teardown verify.
   */
  async listWorktrees(cwd: string): Promise<string[]> {
    const r = await run("git", ["worktree", "list", "--porcelain"], cwd);
    if (!r.ok) throw new Error(`git worktree list failed: ${r.out}`);
    return r.out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim());
  },
};
