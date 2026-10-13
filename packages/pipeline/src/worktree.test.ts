/**
 * Worktree lifecycle coverage (spec 0017) — the new git seams and the
 * provision/teardown/merge behavior that rides on them, exercised against a
 * real temp git repo (same discipline as activities.test.ts, but git-backed
 * since worktrees can't be mocked meaningfully). Covers, in landing order:
 *   - git worktree helpers: branchExists / worktreeAdd / worktreeRemove /
 *     listWorktrees against a temp repo.
 *   - provisionEphemeralEnv: creates `.worktrees/spec-NNNN`, workdir = that
 *     path, primary checkout stays on main; reuse-at-tip never resets an
 *     existing branch (make a commit on the branch, re-provision, assert the
 *     tip is unchanged).
 *   - teardownEnv: removes the worktree, retains the branch, dirty-tree guard
 *     fires when the worktree has uncommitted changes.
 *   - mergePullRequest (local-diff mode): merges the worktree's branch into
 *     the PRIMARY checkout's main, never the worktree itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, git } from "./git.js";
import { provisionEphemeralEnv, teardownEnv, openPullRequest, mergePullRequest } from "./activities.js";
import { SPEC_EXCLUDE_LINES } from "./checkout.js";
import type { PipelineInput } from "./spec.js";

/** A minimal git repo with one commit on `main` — enough to exercise the
 * worktree helpers (branch/worktree add/remove/list) against real git. */
async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-worktree-"));
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.email", "test@example.com"], root);
  await run("git", ["config", "user.name", "Test"], root);
  await writeFile(path.join(root, "README.md"), "hello\n");
  // Mirrors the real repo's `.worktrees/` gitignore entry — without it, the
  // primary checkout's own `git status` sees the (untracked) worktree
  // directory as dirt, which would spuriously fail assertCleanTree checks
  // that run against the primary (e.g. mergePullRequest, spec 0017 item 4).
  await writeFile(path.join(root, ".gitignore"), ".worktrees/\n");
  await run("git", ["add", "README.md", ".gitignore"], root);
  await run("git", ["commit", "-m", "init"], root);
  return root;
}

function baseInput(specId: string, repo: string): PipelineInput {
  return {
    specId,
    target: { kind: "self", repo },
    request: "test",
    requestedBy: "test@example.com",
  };
}

function tenantInput(specId: string, repo: string, vpsId: number): PipelineInput {
  return {
    specId,
    target: { kind: "tenant", tenantId: "sandbox", repo, odooVersion: 18, vpsId },
    request: "no code changes; plan only (human) items",
    requestedBy: "owner@example.com",
  };
}

test("git.worktreeAdd creates a worktree; listWorktrees reports it", async () => {
  const root = await makeRepo();
  const wtPath = path.join(root, ".worktrees", "spec-0001");
  try {
    await git.worktreeAdd(root, wtPath, "spec/0001");
    const worktrees = await git.listWorktrees(root);
    // Compare by suffix, not full-path equality: on macOS `tmpdir()` returns a
    // path under a symlink (/var/folders/... -> /private/var/folders/...) that
    // git reports resolved, so a direct `path.resolve` equality would fail.
    const wtSuffix = path.join(".worktrees", "spec-0001");
    assert.ok(
      worktrees.some((w) => w.endsWith(wtSuffix)),
      `expected a worktree ending in ${wtSuffix} in ${JSON.stringify(worktrees)}`,
    );
    // Primary checkout stays on main — worktree add never switches it.
    const primaryBranch = await git.currentBranch(root);
    assert.equal(primaryBranch, "main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git.branchExists is false for a new id, true after the branch exists", async () => {
  const root = await makeRepo();
  try {
    assert.equal(await git.branchExists(root, "spec/0002"), false);
    const wtPath = path.join(root, ".worktrees", "spec-0002");
    await git.worktreeAdd(root, wtPath, "spec/0002");
    assert.equal(await git.branchExists(root, "spec/0002"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisionEphemeralEnv creates .worktrees/spec-NNNN and leaves primary on main", async () => {
  const root = await makeRepo();
  try {
    const env = await provisionEphemeralEnv(baseInput("0001", root));
    assert.equal(env.workdir, path.join(root, ".worktrees", "spec-0001"));
    assert.equal(env.repoRoot, root);
    assert.equal(env.branch, "spec/0001");
    assert.equal(await git.currentBranch(env.workdir), "spec/0001");
    // Primary checkout never switches — provisioning operates entirely via
    // `git worktree add`, independent of whatever the primary has checked out.
    assert.equal(await git.currentBranch(root), "main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisionEphemeralEnv reuses an existing branch at its tip without resetting it", async () => {
  const root = await makeRepo();
  try {
    const input = baseInput("0002", root);
    const env1 = await provisionEphemeralEnv(input);
    // Advance the branch's tip inside the worktree.
    await writeFile(path.join(env1.workdir, "note.txt"), "progress\n");
    await run("git", ["add", "note.txt"], env1.workdir);
    await run("git", ["commit", "-m", "progress"], env1.workdir);
    const tip = await git.headSha(env1.workdir);
    // Remove the worktree (branch retained, per item 3's teardown contract)
    // and re-provision — must reuse the branch at its tip, never reset it.
    await git.worktreeRemove(root, env1.workdir);
    const env2 = await provisionEphemeralEnv(input);
    assert.equal(await git.headSha(env2.workdir), tip);
    assert.equal(await git.currentBranch(root), "main"); // primary untouched
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisionEphemeralEnv: tenant target gets the same launchpad worktree, plus env.vpsId threaded from input.target.vpsId (spec 0026)", async () => {
  const root = await makeRepo();
  try {
    const env = await provisionEphemeralEnv(tenantInput("0005", root, 100001));
    assert.equal(env.workdir, path.join(root, ".worktrees", "spec-0005"));
    assert.equal(env.repoRoot, root);
    assert.equal(env.buildUrl, "local"); // teardownEnv's worktree-removal path applies unchanged
    assert.equal(env.vpsId, 100001);
    assert.equal(await git.currentBranch(root), "main"); // primary untouched
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisionEphemeralEnv: launchpad target leaves env.vpsId undefined", async () => {
  const root = await makeRepo();
  try {
    const env = await provisionEphemeralEnv(baseInput("0006", root));
    assert.equal(env.vpsId, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisionEphemeralEnv: reads ui_only: true from the WORKTREE's spec file onto env.uiOnly (spec 0031)", async () => {
  const root = await makeRepo();
  try {
    await mkdir(path.join(root, "specs"), { recursive: true });
    await writeFile(
      path.join(root, "specs", "0007-ui-only.md"),
      "---\nid: 0007\nstatus: approved\nui_only: true\n---\n## Plan\n",
    );
    await run("git", ["add", "specs"], root);
    await run("git", ["commit", "-m", "add spec 0007"], root);

    const env = await provisionEphemeralEnv(baseInput("0007", root));
    assert.equal(env.uiOnly, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisionEphemeralEnv: no ui_only flag (or no spec file at all) leaves env.uiOnly undefined (spec 0031)", async () => {
  const root = await makeRepo();
  try {
    await mkdir(path.join(root, "specs"), { recursive: true });
    await writeFile(
      path.join(root, "specs", "0008-not-ui-only.md"),
      "---\nid: 0008\nstatus: approved\n---\n## Plan\n",
    );
    await run("git", ["add", "specs"], root);
    await run("git", ["commit", "-m", "add spec 0008"], root);

    const envWithSpec = await provisionEphemeralEnv(baseInput("0008", root));
    assert.equal(envWithSpec.uiOnly, undefined);

    // No specs/ dir at all (e.g. this suite's other fixtures) is also safe —
    // findSpecFile would throw; provisionEphemeralEnv must not propagate that.
    const envNoSpecFile = await provisionEphemeralEnv(baseInput("0009", root));
    assert.equal(envNoSpecFile.uiOnly, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisionEphemeralEnv: reads product: forge from the WORKTREE's spec file onto env.product (spec 0037)", async () => {
  const root = await makeRepo();
  try {
    await mkdir(path.join(root, "specs"), { recursive: true });
    await writeFile(
      path.join(root, "specs", "0010-product.md"),
      "---\nid: 0010\nstatus: approved\nproduct: forge\n---\n## Plan\n",
    );
    await run("git", ["add", "specs"], root);
    await run("git", ["commit", "-m", "add spec 0010"], root);

    const env = await provisionEphemeralEnv(baseInput("0010", root));
    assert.equal(env.product, "forge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisionEphemeralEnv: no product facet (or no spec file at all) leaves env.product undefined (spec 0037)", async () => {
  const root = await makeRepo();
  try {
    await mkdir(path.join(root, "specs"), { recursive: true });
    await writeFile(
      path.join(root, "specs", "0011-no-product.md"),
      "---\nid: 0011\nstatus: approved\n---\n## Plan\n",
    );
    await run("git", ["add", "specs"], root);
    await run("git", ["commit", "-m", "add spec 0011"], root);

    const envWithSpec = await provisionEphemeralEnv(baseInput("0011", root));
    assert.equal(envWithSpec.product, undefined);

    // No specs/ dir at all (e.g. this suite's other fixtures) is also safe —
    // findSpecFile would throw; provisionEphemeralEnv must not propagate that.
    const envNoSpecFile = await provisionEphemeralEnv(baseInput("0012", root));
    assert.equal(envNoSpecFile.product, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("teardownEnv removes the worktree but retains the branch", async () => {
  const root = await makeRepo();
  try {
    const env = await provisionEphemeralEnv(baseInput("0003", root));
    await teardownEnv(env);
    const worktrees = await git.listWorktrees(root);
    const wtSuffix = path.join(".worktrees", "spec-0003");
    assert.ok(
      !worktrees.some((w) => w.endsWith(wtSuffix)),
      `expected no worktree ending in ${wtSuffix}, got ${JSON.stringify(worktrees)}`,
    );
    // Branch retained for reference (per spec lifecycle) — not deleted.
    assert.equal(await git.branchExists(root, "spec/0003"), true);
    // Primary checkout was never touched by teardown either.
    assert.equal(await git.currentBranch(root), "main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mergePullRequest (local-diff): merges the worktree's branch into the PRIMARY checkout's main", async () => {
  const root = await makeRepo();
  try {
    // openPullRequest reads the spec file via findSpecFile — commit one on
    // main before provisioning so it exists in the worktree too.
    await mkdir(path.join(root, "specs"), { recursive: true });
    await writeFile(
      path.join(root, "specs", "0010-test.md"),
      "---\nid: 0010\nstatus: in_progress\n---\n## Plan\n- [x] done\n\n## Handoff log\n- did the thing\n",
    );
    await run("git", ["add", "specs"], root);
    await run("git", ["commit", "-m", "add spec 0010"], root);

    const input = baseInput("0010", root);
    const env = await provisionEphemeralEnv(input);
    await writeFile(path.join(env.workdir, "feature.txt"), "feature\n");
    await run("git", ["add", "feature.txt"], env.workdir);
    await run("git", ["commit", "-m", "feat: add feature"], env.workdir);

    const pr = await openPullRequest(input, env, { stalled: false }, {
      originUrl: async () => null, // no origin configured -> local-diff fallback
      push: async () => {
        throw new Error("should not push in local-diff mode");
      },
      githubToken: () => undefined,
      createGithubClient: () => {
        throw new Error("should not construct a GithubClient in local mode");
      },
    });
    assert.equal(pr.number, 0);
    // repoRoot round-trips from env.repoRoot so mergePullRequest knows to
    // target the primary checkout, not the worktree.
    assert.equal(pr.repoRoot, root);

    // Spec 0023: mergePullRequest now runs a post-merge dependency-freshness
    // check. This fixture has no pnpm-lock.yaml (it's a minimal git repo, not
    // a real package checkout), so stub the freshness seams with a matching
    // hash/stamp — a no-op — to keep this test focused on the merge itself.
    await mergePullRequest(pr, {
      githubToken: () => {
        throw new Error("should not touch githubToken in local-diff mode");
      },
      promoterToken: async () => {
        throw new Error("should not touch promoterToken in local-diff mode");
      },
      createGithubClient: () => {
        throw new Error("should not touch createGithubClient in local-diff mode");
      },
      dirtyFiles: (cwd) => git.dirtyFiles(cwd),
      checkout: (cwd, ref) => git.checkout(cwd, ref),
      pullFfOnly: async () => {
        throw new Error("should not touch pullFfOnly in local-diff mode");
      },
      lockfileExists: async () => true,
      lockfileHash: async () => "no-lockfile-in-this-fixture",
      readDepsStamp: async () => "no-lockfile-in-this-fixture", // matches -> ensureDepsFresh no-ops
      writeDepsStamp: async () => {},
      installFrozen: async () => {
        throw new Error("ensureDepsFresh should no-op here (stamp matches)");
      },
      nudgeWeb: async () => {
        throw new Error("ensureDepsFresh should no-op here (stamp matches)");
      },
    });

    // Merge landed in the PRIMARY checkout, which stays on main throughout.
    assert.equal(await git.currentBranch(root), "main");
    const committedFile = await readFile(path.join(root, "feature.txt"), "utf8");
    assert.equal(committedFile, "feature\n");
    // The worktree's branch is untouched/retained by the merge itself (only
    // teardownEnv removes it, and that's a separate step this test doesn't
    // exercise).
    assert.equal(await git.branchExists(root, "spec/0010"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Spec 0188 A — this test used to assert the opposite, and the opposite was
// wrong. `spec-autopartes-0001` produced correct, reviewed, MERGED code and is
// recorded FAILED because teardown found three files its own CI writes
// (`next-env.d.ts`, `pnpm-lock.yaml`, `package.json`). A teardown error must
// not become the outcome of a run that promoted — spec 0018's lesson, which
// this repo had already written down in scripts/staging-sweep.mjs.
//
// The strict guard that still matters is `mergePullRequest`'s, against the
// PRIMARY checkout: that is the tree a bad merge would corrupt. This one is a
// worktree on its way to being deleted.
test("teardownEnv records a dirty worktree and removes it anyway", async () => {
  const root = await makeRepo();
  try {
    const env = await provisionEphemeralEnv(baseInput("0004", root));
    await writeFile(path.join(env.workdir, "uncommitted.txt"), "dirt\n");
    await teardownEnv(env); // no throw: the run's verdict is the run's, not teardown's
    const worktrees = await git.listWorktrees(root);
    const wtSuffix = path.join(".worktrees", "spec-0004");
    assert.ok(
      !worktrees.some((w) => w.endsWith(wtSuffix)),
      "the worktree must be gone — git needs --force for a dirty one, and teardown supplies it",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Spec 0131 F — an EXCLUDED spec must still reach the run's worktree.
//
// The defect: spec 0129 keeps a customer project's specs out of their git
// history via `.git/info/exclude`, so nothing commits the spec file — and a
// worktree is a checkout of a commit. `runInitializer`'s
// `findSpecFile(env.workdir)` then throws and the run dies right after gate-1
// approval. Real git, because the whole question is what git carries.
// ---------------------------------------------------------------------------

/** Exclude `specs/` the way `ensureProjectCheckout` does for a non-platform
 * project, and drop an authored spec in the root. */
async function excludeSpecs(root: string, specId: string): Promise<string> {
  await mkdir(path.join(root, ".git", "info"), { recursive: true });
  await writeFile(path.join(root, ".git", "info", "exclude"), SPEC_EXCLUDE_LINES.join("\n") + "\n");
  await mkdir(path.join(root, "specs"), { recursive: true });
  const file = path.join(root, "specs", `${specId}-authored.md`);
  await writeFile(file, `---\nid: ${specId}\ntitle: authored by hand\nstatus: draft\n---\n`);
  return file;
}

test("provisionEphemeralEnv: an EXCLUDED spec is reachable from the worktree (spec 0131 F)", async () => {
  const root = await makeRepo();
  try {
    await excludeSpecs(root, "0130");
    // Precondition — the exact reason this is needed: git carries nothing.
    assert.equal((await git.dirtyFiles(root)).length, 0, "an excluded spec is invisible to git");

    const env = await provisionEphemeralEnv(baseInput("0130", root));

    const inWorktree = path.join(env.workdir, "specs", "0130-authored.md");
    const body = await readFile(inWorktree, "utf8");
    assert.match(body, /authored by hand/, "the worktree must see the spec the human wrote");

    // The worktree stays CLEAN: `specs` is a symlink, i.e. a file to git, which
    // is why SPEC_EXCLUDE_LINES carries the no-slash pattern too. Without it
    // this is `?? specs` and teardown's clean-tree assertion fails.
    assert.deepEqual(await git.dirtyFiles(env.workdir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisionEphemeralEnv: a coder's spec edit in the worktree reaches the project's file (spec 0131 F)", async () => {
  const root = await makeRepo();
  try {
    const authored = await excludeSpecs(root, "0131");
    const env = await provisionEphemeralEnv(baseInput("0131", root));
    // What a coder does: tick a Progress item in the spec it was given.
    await writeFile(path.join(env.workdir, "specs", "0131-authored.md"), "ticked\n");
    // One file per project, so the edit survives the worktree that made it —
    // the reason this is a symlink and not a copy.
    assert.equal(await readFile(authored, "utf8"), "ticked\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("teardownEnv: removing the worktree does NOT take the project's specs with it (spec 0131 F)", async () => {
  const root = await makeRepo();
  try {
    const authored = await excludeSpecs(root, "0132");
    const env = await provisionEphemeralEnv(baseInput("0132", root));
    assert.equal(await git.dirtyFiles(env.workdir).then((d) => d.length), 0);
    await teardownEnv(env);
    // `git worktree remove` unlinks the symlink instead of following it. This
    // was MEASURED before choosing a symlink over a copy — the alternative
    // would have deleted a customer project's specs on every teardown.
    assert.match(await readFile(authored, "utf8"), /authored by hand/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
