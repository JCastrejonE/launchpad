import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, git } from "./git.js";
import {
  openPullRequest,
  awaitPrApproval,
  markSpec,
  mergePullRequest,
  runCi,
  ensureDepsFresh,
  repoRootOf,
  accountIdOf,
  deployToProduction,
  deployStaging,
  destroyStaging,
  readOdooShBuild,
  writeTenantDeployManifest,
  FLEET_SSH_IDENTITY_ENV,
  FLEET_SSH_USER_ENV,
  TENANT_DEPLOY_DOMAIN,
  STAGING_DOMAIN_ENV,
  ODOO_MASTER_PASSWORD_ENV,
  ODOO_ADMIN_PASSWORD_ENV,
  TENANT_DOMAIN_ENV,
  PNPM_INSTALL_ARGV,
  PNPM_NONINTERACTIVE_ENV,
} from "./activities.js";
import type {
  EphemeralEnv,
  OpenPullRequestDeps,
  AwaitPrApprovalDeps,
  MergePullRequestDeps,
  PullRequestRef,
  DeployToProductionDeps,
  DeployStagingDeps,
  DestroyStagingDeps,
  ReadOdooShBuildDeps,
  RunCiDeps,
} from "./activities.js";
import type { PipelineInput, PipelineTarget } from "./spec.js";
import type { PrState } from "@launchpad/github";
import { GithubApiError } from "@launchpad/github";
import { FleetError, destroyStagingStack, deployStagingStack } from "@launchpad/fleet-hostinger";
import type { HostingerClient, SshRunner } from "@launchpad/fleet-hostinger";
import { ApplicationFailure } from "@temporalio/common";
import { parseStatus, readTitle, findSpecFile } from "./store.js";
import { HARNESS_COUNT_ENV } from "./harness-exec.js";
import { PR_APPROVAL_NONRETRYABLE_ERROR_TYPE } from "./activity-options.js";
import { isOdooShBuildInFlight } from "./odoosh-status.js";

/** A minimal on-disk spec (no human-pending items, no stall) — just enough
 * for findSpecFile/buildPullRequestBody to have something to read. */
async function makeSpecRepo(specId: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-openpr-"));
  await mkdir(path.join(root, "specs"), { recursive: true });
  await writeFile(
    path.join(root, "specs", `${specId}-test.md`),
    `---\nid: ${specId}\nstatus: in_progress\n---\n## Plan\n- [x] done\n\n## Handoff log\n- did the thing\n`,
  );
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

function baseEnv(repo: string, branch: string, repoRoot?: string): EphemeralEnv {
  return { envId: "test", branch, buildUrl: "local", workdir: repo, repoRoot };
}

function tenantInput(specId: string, repo: string, vpsId: number): PipelineInput {
  return {
    specId,
    target: { kind: "tenant", tenantId: "sandbox", repo, odooVersion: 18, vpsId },
    request: "no code changes; plan only (human) items",
    requestedBy: "owner@example.com",
  };
}

// Tenant-branch coverage for the env-setup helpers (spec 0026 step 2): the
// MVP tenant path resolves to the same launchpad checkout/credential as a
// launchpad run — see repoRootOf/accountIdOf doc comments in activities.ts.
test("repoRootOf: tenant target resolves to input.target.repo, same as launchpad", () => {
  assert.equal(repoRootOf(baseInput("0001", "/repo")), "/repo");
  assert.equal(repoRootOf(tenantInput("0001", "/repo", 100001)), "/repo");
});

test('accountIdOf: tenant target resolves to "owner" (Vault-backed per-tenant creds are phase-5)', async () => {
  assert.equal(await accountIdOf(baseInput("0001", "/repo")), "owner");
  assert.equal(await accountIdOf(tenantInput("0001", "/repo", 100001)), "owner");
});

test("openPullRequest: local-diff fallback when no GitHub origin/token configured", async () => {
  const root = await makeSpecRepo("0099");
  try {
    const calls: string[] = [];
    const deps: OpenPullRequestDeps = {
      originUrl: async () => null, // no origin configured
      push: async () => {
        calls.push("push");
      },
      githubToken: () => undefined,
      createGithubClient: () => {
        throw new Error("should not construct a GithubClient in local mode");
      },
    };
    const pr = await openPullRequest(
      baseInput("0099", root),
      baseEnv(root, "spec/0099"),
      { stalled: false },
      deps,
    );
    assert.equal(pr.number, 0);
    assert.equal(pr.url, "local-diff:spec/0099");
    assert.equal(pr.workdir, root);
    assert.deepEqual(calls, []); // never pushed
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openPullRequest: local-diff fallback when token set but origin isn't GitHub", async () => {
  const root = await makeSpecRepo("0099");
  try {
    const deps: OpenPullRequestDeps = {
      originUrl: async () => "https://gitlab.com/owner/repo.git",
      push: async () => {
        throw new Error("should not push in local mode");
      },
      githubToken: () => "gh-secret-token",
      createGithubClient: () => {
        throw new Error("should not construct a GithubClient in local mode");
      },
    };
    const pr = await openPullRequest(
      baseInput("0099", root),
      baseEnv(root, "spec/0099"),
      { stalled: false },
      deps,
    );
    assert.equal(pr.number, 0);
    assert.equal(pr.url, "local-diff:spec/0099");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openPullRequest: GitHub PR mode pushes the branch and opens a real PR", async () => {
  const root = await makeSpecRepo("0100");
  try {
    const calls: string[] = [];
    const openPrCalls: unknown[] = [];
    const deps: OpenPullRequestDeps = {
      originUrl: async () => "https://github.com/acme/launchpad.git",
      push: async (cwd, branch) => {
        assert.equal(cwd, root);
        assert.equal(branch, "spec/0100");
        calls.push("push");
      },
      githubToken: () => "gh-secret-token",
      createGithubClient: (config) => {
        assert.equal(config.token, "gh-secret-token");
        assert.equal(config.owner, "acme");
        assert.equal(config.repo, "launchpad");
        return {
          openPr: async (req) => {
            openPrCalls.push(req);
            return { number: 42, url: "https://github.com/acme/launchpad/pull/42" };
          },
          // A per-spec run must never touch the branch-PR path (spec 0133).
          findOpenPrByHead: async () => {
            throw new Error("per-spec runs must not look up a branch PR");
          },
          commentOnPr: async () => {
            throw new Error("per-spec runs must not comment on a branch PR");
          },
        };
      },
    };
    const pr = await openPullRequest(
      baseInput("0100", root),
      baseEnv(root, "spec/0100"),
      { stalled: false },
      deps,
    );
    assert.deepEqual(calls, ["push"]); // pushed before opening the PR
    assert.equal(openPrCalls.length, 1);
    assert.deepEqual(openPrCalls[0], {
      head: "spec/0100",
      base: "main",
      title: "Spec 0100",
      body: pr.body,
    });
    assert.equal(pr.number, 42);
    assert.equal(pr.url, "https://github.com/acme/launchpad/pull/42");
    assert.equal(pr.repo, "acme/launchpad");
    assert.equal(pr.branch, "spec/0100");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Spec 0133 decision 5: a BRANCH run feeds the branch's ONE accumulating PR.

test("openPullRequest (branch mode): adopts the existing branch PR and comments the run's summary", async () => {
  const root = await makeSpecRepo("0142");
  try {
    const comments: Array<{ number: number; body: string }> = [];
    let openPrCalled = false;
    const pr = await openPullRequest(
      { ...baseInput("0142", root), branch: "feature/pos" },
      baseEnv(root, "feature/pos"),
      { stalled: false },
      {
        originUrl: async () => "https://github.com/acme/launchpad.git",
        push: async (_cwd, branch) => assert.equal(branch, "feature/pos"),
        githubToken: () => "t",
        createGithubClient: () => ({
          openPr: async () => {
            openPrCalled = true;
            throw new Error("must adopt the existing PR, never open a second one");
          },
          findOpenPrByHead: async (branch, base) => {
            assert.equal(branch, "feature/pos");
            assert.equal(base, "main");
            return { number: 7, url: "https://github.com/acme/launchpad/pull/7" };
          },
          commentOnPr: async (number, body) => void comments.push({ number, body }),
        }),
      },
    );
    assert.equal(openPrCalled, false);
    assert.equal(pr.number, 7);
    assert.equal(pr.branch, "feature/pos");
    assert.equal(comments.length, 1, "each run comments its summary on the PR timeline");
    assert.equal(comments[0]?.number, 7);
    assert.ok(comments[0]?.body.includes("0142"), "the comment is the run's spec summary");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openPullRequest (branch mode): no PR yet — creates ONE, base main, and comments on it", async () => {
  const root = await makeSpecRepo("0143");
  try {
    const openPrCalls: unknown[] = [];
    const comments: number[] = [];
    const pr = await openPullRequest(
      { ...baseInput("0143", root), branch: "tester/checkout" },
      baseEnv(root, "tester/checkout"),
      { stalled: false },
      {
        originUrl: async () => "https://github.com/acme/launchpad.git",
        push: async () => {},
        githubToken: () => "t",
        createGithubClient: () => ({
          openPr: async (req) => {
            openPrCalls.push(req);
            return { number: 9, url: "https://github.com/acme/launchpad/pull/9" };
          },
          findOpenPrByHead: async () => null,
          commentOnPr: async (number) => void comments.push(number),
        }),
      },
    );
    assert.equal(pr.number, 9);
    assert.equal(openPrCalls.length, 1);
    const req = openPrCalls[0] as { head: string; base: string; title: string };
    assert.equal(req.head, "tester/checkout");
    assert.equal(req.base, "main");
    assert.ok(req.title.includes("tester/checkout"), "the PR is titled for the BRANCH, not a spec");
    assert.deepEqual(comments, [9]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openPullRequest (branch mode): loses the create race — re-finds and adopts the winner", async () => {
  const root = await makeSpecRepo("0144");
  try {
    const finds: number[] = [];
    const pr = await openPullRequest(
      { ...baseInput("0144", root), branch: "feature/race" },
      baseEnv(root, "feature/race"),
      { stalled: false },
      {
        originUrl: async () => "https://github.com/acme/launchpad.git",
        push: async () => {},
        githubToken: () => "t",
        createGithubClient: () => ({
          openPr: async () => {
            throw new GithubApiError("client", "A pull request already exists for acme:feature/race.", {
              status: 422,
              retryable: false,
            });
          },
          findOpenPrByHead: async () => {
            finds.push(1);
            // First lookup: nothing yet; after the 422, the winner's PR.
            return finds.length === 1
              ? null
              : { number: 11, url: "https://github.com/acme/launchpad/pull/11" };
          },
          commentOnPr: async () => {},
        }),
      },
    );
    assert.equal(pr.number, 11, "the racer that lost the create adopts the winner's PR");
    assert.equal(finds.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openPullRequest: populates repoRoot from env.repoRoot in both modes (spec 0017)", async () => {
  const root = await makeSpecRepo("0101");
  const primary = "/tmp/primary-checkout"; // never touched — repoRoot just round-trips
  try {
    const localPr = await openPullRequest(
      baseInput("0101", root),
      baseEnv(root, "spec/0101", primary),
      { stalled: false },
      {
        originUrl: async () => null,
        push: async () => {
          throw new Error("should not push in local mode");
        },
        githubToken: () => undefined,
        createGithubClient: () => {
          throw new Error("should not construct a GithubClient in local mode");
        },
      },
    );
    assert.equal(localPr.repoRoot, primary);
    assert.equal(localPr.workdir, root); // workdir stays the worktree, distinct from repoRoot

    const githubPr = await openPullRequest(
      baseInput("0101", root),
      baseEnv(root, "spec/0101", primary),
      { stalled: false },
      {
        originUrl: async () => "https://github.com/acme/launchpad.git",
        push: async () => {},
        githubToken: () => "gh-secret-token",
        createGithubClient: () => ({
          openPr: async () => ({ number: 1, url: "https://github.com/acme/launchpad/pull/1" }),
          findOpenPrByHead: async () => {
            throw new Error("per-spec runs must not look up a branch PR");
          },
          commentOnPr: async () => {
            throw new Error("per-spec runs must not comment on a branch PR");
          },
        }),
      },
    );
    assert.equal(githubPr.repoRoot, primary);
    assert.equal(githubPr.workdir, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function basePrRef(overrides: Partial<PullRequestRef> = {}): PullRequestRef {
  return {
    repo: "acme/launchpad",
    branch: "spec/0101",
    workdir: "/tmp/unused",
    number: 7,
    url: "https://github.com/acme/launchpad/pull/7",
    ...overrides,
  };
}

/** A `getPrState`-shaped fixture with sane "still open, nothing decided yet"
 * defaults — tests override just the fields that matter to their scenario. */
function basePrState(overrides: Partial<PrState> = {}): PrState {
  return {
    number: 7,
    state: "open",
    merged: false,
    mergeable: true,
    reviewDecision: null,
    checks: "pending",
    approvedBy: null,
    mergedBy: null,
    mergeCommitSha: null,
    ...overrides,
  };
}

/** No-op delay/heartbeat so the poll loop runs at test speed with no real
 * Temporal activity Context (both `sleep` and `heartbeat` require one). */
function instantDeps(
  getPrState: (n: number) => Promise<PrState>,
  hasAnyWorkflows: () => Promise<boolean> = async () => true,
): AwaitPrApprovalDeps {
  return {
    githubToken: () => "gh-secret-token",
    createGithubClient: (config) => {
      assert.equal(config.token, "gh-secret-token");
      assert.equal(config.owner, "acme");
      assert.equal(config.repo, "launchpad");
      return { getPrState, hasAnyWorkflows };
    },
    delay: async () => {},
    heartbeat: () => {},
  };
}

test("awaitPrApproval: approving review + green checks resolves approved with the reviewer login", async () => {
  const outcome = await awaitPrApproval(
    basePrRef(),
    {},
    instantDeps(async () =>
      basePrState({ reviewDecision: "approved", checks: "success", approvedBy: "octocat" }),
    ),
  );
    assert.deepEqual(outcome, { outcome: "approved", actor: "octocat", via: "review" });
});

/**
 * Spec 0167. A repo with no `.github/workflows` can never report `checks:
 * "success"` — `aggregateChecks` reads an empty runs list as "pending" — so the
 * approving-review path above was unsatisfiable there and the run polled forever.
 * Sandbox spec 0002 hit it and only escaped because a human merged the PR.
 *
 * The pair of tests matters more than either alone: the SAME `checks: "pending"`
 * state must resolve or keep polling purely on whether the repo HAS workflows,
 * which is what makes this immune to a reviewer approving before Actions has
 * registered a run.
 */
test("awaitPrApproval: approved + no workflows in the repo at all resolves, recording noCi", async () => {
  const outcome = await awaitPrApproval(
    basePrRef(),
    {},
    instantDeps(
      async () => basePrState({ reviewDecision: "approved", checks: "pending", approvedBy: "octocat" }),
      async () => false, // the repo defines no workflows
    ),
  );
  assert.deepEqual(outcome, { outcome: "approved", actor: "octocat", via: "review", noCi: true });
});

test("awaitPrApproval: approved + pending checks in a repo that HAS workflows keeps polling", async () => {
  // Identical PR state; only the repo answer differs. If the implementation ever
  // resolved on "pending" alone, this would return instead of hitting the cap.
  let polls = 0;
  await assert.rejects(
    () =>
      awaitPrApproval(
        basePrRef(),
        {},
        instantDeps(
          async () => {
            if (++polls > 5) throw new Error("still polling, as it should be");
            return basePrState({ reviewDecision: "approved", checks: "pending", approvedBy: "octocat" });
          },
          async () => true, // CI exists — "pending" means not finished YET
        ),
      ),
    /still polling/,
  );
});

test("awaitPrApproval: if the workflows lookup fails, it keeps polling (the cautious direction)", async () => {
  let polls = 0;
  await assert.rejects(
    () =>
      awaitPrApproval(
        basePrRef(),
        {},
        instantDeps(
          async () => {
            if (++polls > 5) throw new Error("still polling, as it should be");
            return basePrState({ reviewDecision: "approved", checks: "pending", approvedBy: "octocat" });
          },
          async () => {
            throw new GithubApiError("server", "GitHub 503", { status: 503, retryable: true });
          },
        ),
      ),
    /still polling/,
  );
});

// SPEC-ALIGNMENT §9.2: a non-retryable GitHub error (401/403 auth, 404, other
// 4xx) becomes a non-retryable ApplicationFailure so Temporal stops instead of
// looping a broken poll; a transient one propagates unchanged so the (now
// unbounded) retry policy re-issues the stateless poll on the next attempt.
test("awaitPrApproval: a non-retryable GitHub error → non-retryable ApplicationFailure", async () => {
  const authErr = new GithubApiError("auth", "bad or missing token", { status: 401, retryable: false });
  await assert.rejects(
    () => awaitPrApproval(basePrRef(), {}, instantDeps(async () => { throw authErr; })),
    (err: unknown) =>
      err instanceof ApplicationFailure &&
      err.nonRetryable === true &&
      err.type === PR_APPROVAL_NONRETRYABLE_ERROR_TYPE,
  );
});

test("awaitPrApproval: a retryable GitHub error propagates as-is (Temporal retries the poll)", async () => {
  const serverErr = new GithubApiError("server", "GitHub 503", { status: 503, retryable: true });
  await assert.rejects(
    () => awaitPrApproval(basePrRef(), {}, instantDeps(async () => { throw serverErr; })),
    (err: unknown) => err instanceof GithubApiError && err.retryable === true,
  );
});

test("awaitPrApproval: closed without merge resolves rejected", async () => {
  const outcome = await awaitPrApproval(
    basePrRef(),
    {},
    instantDeps(async () => basePrState({ state: "closed", merged: false })),
  );
  assert.deepEqual(outcome, { outcome: "rejected", actor: "(closed)" });
});

test("awaitPrApproval: merged PR resolves approved with actor = mergedBy (ADR-016), regardless of checks", async () => {
  const outcome = await awaitPrApproval(
    basePrRef(),
    {},
    instantDeps(async () =>
      basePrState({ state: "closed", merged: true, mergedBy: "owner-gh", checks: "pending" }),
    ),
  );
    assert.deepEqual(outcome, { outcome: "approved", actor: "owner-gh", via: "merge" });
});

test('awaitPrApproval: merged PR with no mergedBy falls back to actor "(merged)"', async () => {
  const outcome = await awaitPrApproval(
    basePrRef(),
    {},
    instantDeps(async () => basePrState({ state: "closed", merged: true, mergedBy: null })),
  );
    assert.deepEqual(outcome, { outcome: "approved", actor: "(merged)", via: "merge" });
});

test("awaitPrApproval: keeps polling through pending checks/no decision, heartbeating each time", async () => {
  const states: PrState[] = [
    basePrState(), // nothing decided yet
    basePrState({ reviewDecision: "approved", checks: "pending", approvedBy: "octocat" }), // approved but CI still running
    basePrState({ reviewDecision: "approved", checks: "success", approvedBy: "octocat" }), // now green
  ];
  let heartbeats = 0;
  let call = 0;
  const outcome = await awaitPrApproval(basePrRef(), { pollIntervalMs: 1 }, {
    ...instantDeps(async () => {
      const state = states[call];
      call++;
      return state ?? states[states.length - 1]!;
    }),
    heartbeat: () => void heartbeats++,
  });
  assert.equal(call, 3);
  assert.equal(heartbeats, 3);
    assert.deepEqual(outcome, { outcome: "approved", actor: "octocat", via: "review" });
});

test("awaitPrApproval: throws if called without a GitHub token or owner/repo (local-diff ref)", async () => {
  await assert.rejects(
    () =>
      awaitPrApproval(basePrRef({ repo: "/tmp/local-checkout", number: 0 }), {}, {
        githubToken: () => undefined,
        createGithubClient: () => {
          throw new Error("should not construct a GithubClient");
        },
        delay: async () => {},
        heartbeat: () => {},
      }),
    /GitHub PR/,
  );
});

/** No-op checkout/pullFfOnly/dirtyFiles so mergePullRequest's GitHub-mode
 * branch is exercised with no real git repo needed. `getPrState` defaults to
 * "not yet merged" (the pre-0019 common case); pass one via `overrides` (or
 * the dedicated `getPrState` param) for the already-merged idempotency
 * tests. */
function mergeDeps(
  // Spec 0170: mergePr returns the merge commit sha, which a release candidate points at.
  mergePr: (n: number) => Promise<string>,
  overrides: Partial<MergePullRequestDeps> = {},
  getPrState: (n: number) => Promise<PrState> = async (n) => basePrState({ number: n }),
): MergePullRequestDeps {
  return {
    githubToken: () => "gh-secret-token",
    // Spec 0128 F: these fakes exercise the pre-0128 path (no promoter), where the
    // server token merges. `promotedBy` is never passed, so this is never called.
    promoterToken: async () => null,
    createGithubClient: (config) => {
      assert.equal(config.token, "gh-secret-token");
      assert.equal(config.owner, "acme");
      assert.equal(config.repo, "launchpad");
      return { mergePr, getPrState };
    },
    dirtyFiles: async () => [],
    checkout: async () => {},
    pullFfOnly: async () => {},
    // Spec 0023 freshness seams — no-op stubs so the existing merge tests
    // compile; the dep-sync tests below (step 1/2) override the ones they
    // assert on.
    lockfileExists: async () => true,
    lockfileHash: async () => "stub-hash",
    readDepsStamp: async () => "stub-hash",
    writeDepsStamp: async () => {},
    installFrozen: async () => {},
    nudgeWeb: async () => {},
    ...overrides,
  };
}

// -------------------------------------------------------------------------
// Spec 0023 — post-merge dependency sync (scope item 4). Scaffolded skipped;
// the coder unskips + fills each as the matching Plan step lands.
//   4a hash != stamp -> install at repoRoot (NOT workdir), stamp AFTER install,
//      web nudged — in BOTH merge modes.
//   4b hash == stamp -> no install, no stamp write, no nudge.
//   4c install fails -> activity throws naming the command; stamp NOT written;
//      web NOT nudged.
//   4d missing web pidfile -> install + stamp still succeed, no throw.
//   4e already-merged PR (ADR-016 path) still runs the freshness check.
// -------------------------------------------------------------------------

/** Minimal MergePullRequestDeps for exercising ensureDepsFresh directly —
 * the git/GitHub seams are never touched by ensureDepsFresh, so they throw if
 * reached (a bug in the function under test, not in these tests). */
function freshDeps(overrides: Partial<MergePullRequestDeps> = {}): MergePullRequestDeps {
  return {
    githubToken: () => {
      throw new Error("ensureDepsFresh should never touch githubToken");
    },
    promoterToken: async () => {
      throw new Error("ensureDepsFresh should never touch promoterToken");
    },
    createGithubClient: () => {
      throw new Error("ensureDepsFresh should never touch createGithubClient");
    },
    dirtyFiles: async () => {
      throw new Error("ensureDepsFresh should never touch dirtyFiles");
    },
    checkout: async () => {
      throw new Error("ensureDepsFresh should never touch checkout");
    },
    pullFfOnly: async () => {
      throw new Error("ensureDepsFresh should never touch pullFfOnly");
    },
    lockfileExists: async () => true,
    lockfileHash: async () => "hash-a",
    readDepsStamp: async () => "hash-a",
    writeDepsStamp: async () => {},
    installFrozen: async () => {},
    nudgeWeb: async () => {},
    ...overrides,
  };
}

test("ensureDepsFresh: hash != stamp installs, stamps after success, nudges web (4a)", async () => {
  const calls: string[] = [];
  const deps = freshDeps({
    lockfileHash: async () => "hash-b",
    readDepsStamp: async () => "hash-a",
    installFrozen: async () => {
      calls.push("installFrozen");
    },
    writeDepsStamp: async (root, hash) => {
      assert.equal(root, "/tmp/root");
      assert.equal(hash, "hash-b");
      calls.push("writeDepsStamp");
    },
    nudgeWeb: async () => {
      calls.push("nudgeWeb");
    },
  });
  await ensureDepsFresh("/tmp/root", deps);
  // Install first, stamp written only AFTER it succeeds, then the nudge.
  assert.deepEqual(calls, ["installFrozen", "writeDepsStamp", "nudgeWeb"]);
});

test("ensureDepsFresh: hash == stamp is a no-op — no install, no stamp write, no nudge (4b)", async () => {
  const calls: string[] = [];
  const deps = freshDeps({
    lockfileHash: async () => "same-hash",
    readDepsStamp: async () => "same-hash",
    installFrozen: async () => {
      calls.push("installFrozen");
    },
    writeDepsStamp: async () => {
      calls.push("writeDepsStamp");
    },
    nudgeWeb: async () => {
      calls.push("nudgeWeb");
    },
  });
  await ensureDepsFresh("/tmp/root", deps);
  assert.deepEqual(calls, []);
});

test("ensureDepsFresh: absent lockfile skips cleanly — no hash, install, stamp, or nudge (0162)", async () => {
  const calls: string[] = [];
  const deps = freshDeps({
    lockfileExists: async () => false,
    lockfileHash: async () => {
      calls.push("lockfileHash");
      return "hash";
    },
    readDepsStamp: async () => {
      calls.push("readDepsStamp");
      return null;
    },
    installFrozen: async () => {
      calls.push("installFrozen");
    },
    writeDepsStamp: async () => {
      calls.push("writeDepsStamp");
    },
    nudgeWeb: async () => {
      calls.push("nudgeWeb");
    },
  });
  await ensureDepsFresh("/tmp/root", deps);
  assert.deepEqual(calls, []); // returned before hashing — nothing else ran
});

test("ensureDepsFresh: present-but-unreadable lockfile still rejects (0162 — not swallowed)", async () => {
  const deps = freshDeps({
    lockfileExists: async () => true,
    lockfileHash: async () => {
      throw new Error("EACCES: permission denied, open '/tmp/root/pnpm-lock.yaml'");
    },
  });
  await assert.rejects(() => ensureDepsFresh("/tmp/root", deps), /EACCES/);
});

test("ensureDepsFresh: install failure throws naming the command; stamp NOT written; web NOT nudged (4c)", async () => {
  const calls: string[] = [];
  const deps = freshDeps({
    lockfileHash: async () => "hash-b",
    readDepsStamp: async () => "hash-a",
    installFrozen: async () => {
      calls.push("installFrozen");
      throw new Error("pnpm install --frozen-lockfile failed at /tmp/root: exit 1");
    },
    writeDepsStamp: async () => {
      calls.push("writeDepsStamp");
    },
    nudgeWeb: async () => {
      calls.push("nudgeWeb");
    },
  });
  await assert.rejects(
    () => ensureDepsFresh("/tmp/root", deps),
    /pnpm install --frozen-lockfile/,
  );
  assert.deepEqual(calls, ["installFrozen"]); // stamp not written, web not nudged
});

test("ensureDepsFresh: missing web pidfile still installs + stamps, no throw (4d)", async () => {
  const calls: string[] = [];
  const deps = freshDeps({
    lockfileHash: async () => "hash-b",
    readDepsStamp: async () => "hash-a",
    installFrozen: async () => {
      calls.push("installFrozen");
    },
    writeDepsStamp: async (root, hash) => {
      assert.equal(hash, "hash-b");
      calls.push("writeDepsStamp");
    },
    // Real nudgeWeb tolerates a missing/stale pidfile by resolving without
    // throwing (never fails the merge over the web not running) — this stub
    // models exactly that contract.
    nudgeWeb: async () => {
      calls.push("nudgeWeb");
    },
  });
  await ensureDepsFresh("/tmp/root", deps);
  assert.deepEqual(calls, ["installFrozen", "writeDepsStamp", "nudgeWeb"]);
});

/** A minimal git repo with `main` plus a feature branch ready to merge —
 * for exercising mergePullRequest's local-diff mode (pr.number === 0)
 * against real git: `git.mergeNoFf` is called directly in that branch, not
 * through an injectable seam, same discipline as worktree.test.ts. */
async function makeMergeableRepo(featureBranch: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-merge-"));
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.email", "test@example.com"], root);
  await run("git", ["config", "user.name", "Test"], root);
  await writeFile(path.join(root, "README.md"), "hello\n");
  await run("git", ["add", "README.md"], root);
  await run("git", ["commit", "-m", "init"], root);
  await run("git", ["checkout", "-b", featureBranch], root);
  await writeFile(path.join(root, "feature.txt"), "feature\n");
  await run("git", ["add", "feature.txt"], root);
  await run("git", ["commit", "-m", "feat: add feature"], root);
  await run("git", ["checkout", "main"], root);
  return root;
}

test("mergePullRequest: local-diff mode runs the freshness check at repoRoot (4a)", async () => {
  const repoRoot = await makeMergeableRepo("spec/0101");
  try {
    const calls: string[] = [];
    const deps = freshDeps({
      checkout: (cwd, ref) => {
        assert.equal(cwd, repoRoot);
        assert.equal(ref, "main");
        return git.checkout(cwd, ref);
      },
      dirtyFiles: (cwd) => {
        assert.equal(cwd, repoRoot);
        return git.dirtyFiles(cwd);
      },
      lockfileHash: async (root) => {
        assert.equal(root, repoRoot);
        return "hash-b";
      },
      readDepsStamp: async (root) => {
        assert.equal(root, repoRoot);
        return "hash-a"; // mismatch -> install must run
      },
      installFrozen: async (root) => {
        assert.equal(root, repoRoot); // NEVER pr.workdir (spec 0017)
        calls.push("installFrozen");
      },
      writeDepsStamp: async (root, hash) => {
        assert.equal(root, repoRoot);
        assert.equal(hash, "hash-b");
        calls.push("writeDepsStamp");
      },
      nudgeWeb: async (root) => {
        assert.equal(root, repoRoot);
        calls.push("nudgeWeb");
      },
    });
    await mergePullRequest(
      basePrRef({
        number: 0,
        branch: "spec/0101",
        workdir: "/tmp/should-not-be-touched",
        repoRoot,
      }),
      deps,
    );
    // Install then stamp (only after success) then nudge — same order as 4a's
    // ensureDepsFresh-only coverage above, now proven through the real merge.
    assert.deepEqual(calls, ["installFrozen", "writeDepsStamp", "nudgeWeb"]);
    // The merge itself actually happened against the PRIMARY checkout.
    assert.equal(await git.currentBranch(repoRoot), "main");
    assert.equal(await readFile(path.join(repoRoot, "feature.txt"), "utf8"), "feature\n");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("mergePullRequest: GitHub already-merged (ADR-016) path still runs the freshness check (4e)", async () => {
  const calls: string[] = [];
  const deps = mergeDeps(
    async () => {
      calls.push("mergePr"); // should never run — already merged
      return "mergesha";
    },
    {
      checkout: async (cwd, ref) => {
        assert.equal(cwd, "/tmp/unused");
        assert.equal(ref, "main");
        calls.push("checkout");
      },
      pullFfOnly: async (cwd, branch) => {
        assert.equal(cwd, "/tmp/unused");
        assert.equal(branch, "main");
        calls.push("pullFfOnly");
      },
      lockfileHash: async () => "hash-b",
      readDepsStamp: async () => "hash-a", // mismatch -> install must run
      installFrozen: async (root) => {
        assert.equal(root, "/tmp/unused");
        calls.push("installFrozen");
      },
      writeDepsStamp: async (root, hash) => {
        assert.equal(root, "/tmp/unused");
        assert.equal(hash, "hash-b");
        calls.push("writeDepsStamp");
      },
      nudgeWeb: async (root) => {
        assert.equal(root, "/tmp/unused");
        calls.push("nudgeWeb");
      },
    },
    async (n) => basePrState({ number: n, state: "closed", merged: true, mergedBy: "owner-gh" }),
  );
  await mergePullRequest(basePrRef(), deps);
  // No API merge call, but the freshness check still runs — this IS the 0016
  // incident's human-merged-on-GitHub flow (ADR-016 merge-as-approval).
  assert.deepEqual(calls, [
    "checkout",
    "pullFfOnly",
    "installFrozen",
    "writeDepsStamp",
    "nudgeWeb",
  ]);
});

test("mergePullRequest: GitHub mode merges via the API then syncs local main", async () => {
  const calls: string[] = [];
  let mergedNumber: number | undefined;
  const deps = mergeDeps(
    async (n) => {
      mergedNumber = n;
      calls.push("mergePr");
      return "mergesha";
    },
    {
      checkout: async (cwd, ref) => {
        assert.equal(cwd, "/tmp/unused");
        assert.equal(ref, "main");
        calls.push("checkout");
      },
      pullFfOnly: async (cwd, branch) => {
        assert.equal(cwd, "/tmp/unused");
        assert.equal(branch, "main");
        calls.push("pullFfOnly");
      },
    },
  );
  await mergePullRequest(basePrRef(), deps);
  assert.equal(mergedNumber, 7);
  // Merge before syncing main, checkout before pull.
  assert.deepEqual(calls, ["mergePr", "checkout", "pullFfOnly"]);
});

test("mergePullRequest: GitHub mode targets pr.repoRoot (the PRIMARY checkout), not pr.workdir (spec 0017)", async () => {
  const dirtyFilesCalls: string[] = [];
  const deps = mergeDeps(
    async () => "mergesha",
    {
      dirtyFiles: async (cwd) => {
        dirtyFilesCalls.push(cwd);
        return [];
      },
      checkout: async (cwd, ref) => {
        assert.equal(cwd, "/tmp/primary-checkout");
        assert.equal(ref, "main");
      },
      pullFfOnly: async (cwd, branch) => {
        assert.equal(cwd, "/tmp/primary-checkout");
        assert.equal(branch, "main");
      },
    },
  );
  await mergePullRequest(basePrRef({ workdir: "/tmp/worktree", repoRoot: "/tmp/primary-checkout" }), deps);
  assert.deepEqual(dirtyFilesCalls, ["/tmp/primary-checkout"]);
});

test("mergePullRequest: GitHub mode refuses to merge over a dirty working tree", async () => {
  const calls: string[] = [];
  const deps = mergeDeps(
    async () => {
      calls.push("mergePr");
      return "mergesha";
    },
    { dirtyFiles: async () => ["specs/0101-foo.md"] },
  );
  await assert.rejects(
    () => mergePullRequest(basePrRef(), deps),
    /working tree unexpectedly dirty/,
  );
  assert.deepEqual(calls, []); // never reached the API
});

test("mergePullRequest: already-merged PR (ADR-016 merge-as-approval) skips the API merge but still syncs main", async () => {
  const calls: string[] = [];
  const deps = mergeDeps(
    async () => {
      calls.push("mergePr"); // should never run
      return "mergesha";
    },
    {
      checkout: async (cwd, ref) => {
        assert.equal(cwd, "/tmp/unused");
        assert.equal(ref, "main");
        calls.push("checkout");
      },
      pullFfOnly: async (cwd, branch) => {
        assert.equal(cwd, "/tmp/unused");
        assert.equal(branch, "main");
        calls.push("pullFfOnly");
      },
    },
    async (n) => basePrState({ number: n, state: "closed", merged: true, mergedBy: "owner-gh" }),
  );
  await mergePullRequest(basePrRef(), deps);
  // No API merge call — checkout + sync still happen (same post-condition).
  assert.deepEqual(calls, ["checkout", "pullFfOnly"]);
});

test("mergePullRequest: throws if called without a GitHub token or owner/repo (local-diff ref shouldn't reach here)", async () => {
  await assert.rejects(
    () =>
      mergePullRequest(basePrRef({ repo: "/tmp/local-checkout" }), {
        githubToken: () => undefined,
        promoterToken: async () => null,
        createGithubClient: () => {
          throw new Error("should not construct a GithubClient");
        },
        dirtyFiles: async () => [],
        checkout: async () => {},
        pullFfOnly: async () => {},
        lockfileExists: async () => true,
        lockfileHash: async () => "stub-hash",
        readDepsStamp: async () => "stub-hash",
        writeDepsStamp: async () => {},
        installFrozen: async () => {},
        nudgeWeb: async () => {},
      }),
    /GitHub PR/,
  );
});

// -------------------------------------------------------------------------
// Spec 0026 step 5 — `deployToProduction` tenant path, with fake
// `DeployToProductionDeps` (NO live SSH/Hostinger API). Covers: launchpad
// short-circuit, happy-path call order + argument threading, the missing-
// SSH-identity config error, the sandbox refusal mapping to a non-retryable
// `ApplicationFailure`, dbPassword read-or-create reuse across repeat
// deploys, and that no secret ever reaches an error message.

/** Sane, always-succeeding defaults for `DeployToProductionDeps` — each test
 * overrides only the fields it asserts on, following `mergeDeps`'s pattern
 * above. Defaults thread `opts` straight through so untouched fields still
 * produce a self-consistent happy path. */
function deployDeps(overrides: Partial<DeployToProductionDeps> = {}): DeployToProductionDeps {
  return {
    readOdooReadonly: async () => ({ user: "front_readonly", password: "ro-pass-not-a-real-secret" }),
    env: { [FLEET_SSH_IDENTITY_ENV]: "/id_ed25519" , [ODOO_MASTER_PASSWORD_ENV]: "master-not-a-real-secret", [ODOO_ADMIN_PASSWORD_ENV]: "admin-not-a-real-secret"},
    resolveHostingerToken: () => "hostinger-secret-token",
    createHostingerClient: () =>
      ({ getVps: async () => ({ ipv4: [{ address: "203.0.113.5" }] }) }) as unknown as HostingerClient,
    createSshRunner: () => ({
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      writeFile: async () => {},
    }),
    provisionClientVps: async (opts) => ({
      tenantId: opts.tenantId,
      vpsId: opts.vpsId,
      version: 1,
      alreadyBootstrapped: false,
      stepsRun: [],
    }),
    readOrCreateDbPassword: async () => "db-secret-password",
    deployProductionStack: async (opts) => ({
      tenantId: opts.tenantId,
      stack: opts.stack ?? "prod",
      odooVersion: opts.odooVersion,
      healthy: true,
      odooHttpOk: true,
      ingressOk: true,
    }),
    heartbeat: () => {},
    ...overrides,
  };
}

test("deployToProduction: launchpad target returns immediately — merge IS the deploy, no fleet deps touched", async () => {
  const deps = deployDeps({
    resolveHostingerToken: () => {
      throw new Error("should not resolve a Hostinger token for a launchpad target");
    },
    provisionClientVps: async () => {
      throw new Error("should not provision a VPS for a launchpad target");
    },
    deployProductionStack: async () => {
      throw new Error("should not deploy a stack for a launchpad target");
    },
  });
  await deployToProduction(baseInput("0026", "/repo"), deps);
});

// Spec 0036's whole reason for isSelfTarget(): a run started before the
// "launchpad" -> "self" target-kind rename has its `target` persisted
// verbatim in Temporal workflow input/history, so a worker redeployed onto
// a build where the rename has landed may still see `{ kind: "launchpad" }`
// for an in-flight run. The `as unknown as PipelineTarget` below simulates
// that persisted-before-rename shape: item 4 narrowed PipelineTarget's self
// variant to `{ kind: "self"; repo }` only, so this legacy literal no longer
// overlaps the union closely enough for a direct `as` — routing through
// `unknown` is the deliberate escape hatch, not a mistake. Proves the gate-3
// early-return still fires and does NOT fall through to the tenant branch.
test("deployToProduction: legacy launchpad target (persisted pre-rename value) still returns immediately — does not fall through to the tenant deploy path", async () => {
  const legacyInput = {
    specId: "0026",
    target: { kind: "launchpad", repo: "/repo" } as unknown as PipelineTarget,
    request: "test",
    requestedBy: "test@example.com",
  } as PipelineInput;
  const deps = deployDeps({
    resolveHostingerToken: () => {
      throw new Error("should not resolve a Hostinger token for a legacy launchpad target");
    },
    provisionClientVps: async () => {
      throw new Error("should not provision a VPS for a legacy launchpad target");
    },
    deployProductionStack: async () => {
      throw new Error("should not deploy a stack for a legacy launchpad target");
    },
  });
  await deployToProduction(legacyInput, deps);
});

test("deployToProduction: tenant target — happy-path call order and argument threading", async () => {
  const calls: string[] = [];
  const sshMarker = {
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    writeFile: async () => {},
  };
  const clientMarker = {
    getVps: async (id: number) => {
      assert.equal(id, 100001);
      return { ipv4: [{ address: "203.0.113.5" }] };
    },
  } as unknown as HostingerClient;

  const deps = deployDeps({
    env: { [FLEET_SSH_IDENTITY_ENV]: "/id_ed25519" , [ODOO_MASTER_PASSWORD_ENV]: "master-not-a-real-secret", [ODOO_ADMIN_PASSWORD_ENV]: "admin-not-a-real-secret"}, // FLEET_SSH_USER_ENV unset -> defaults to "root"
    resolveHostingerToken: (tenantId) => {
      assert.equal(tenantId, "sandbox");
      calls.push("resolveHostingerToken");
      return "hostinger-secret-token";
    },
    createHostingerClient: (token) => {
      assert.equal(token, "hostinger-secret-token");
      calls.push("createHostingerClient");
      return clientMarker;
    },
    createSshRunner: (target) => {
      assert.deepEqual(target, { host: "203.0.113.5", user: "root", identityFile: "/id_ed25519" });
      calls.push("createSshRunner");
      return sshMarker;
    },
    provisionClientVps: async (opts) => {
      assert.equal(opts.tenantId, "sandbox");
      assert.equal(opts.vpsId, 100001);
      assert.equal(opts.ssh, sshMarker);
      assert.equal(opts.client, clientMarker);
      calls.push("provisionClientVps");
      return {
        tenantId: opts.tenantId,
        vpsId: opts.vpsId,
        version: 1,
        alreadyBootstrapped: false,
        stepsRun: [],
      };
    },
    heartbeat: () => {
      calls.push("heartbeat");
    },
    readOrCreateDbPassword: async (tenantId) => {
      assert.equal(tenantId, "sandbox");
      calls.push("readOrCreateDbPassword");
      return "db-secret-password";
    },
    deployProductionStack: async (opts) => {
      assert.equal(opts.tenantId, "sandbox");
      assert.equal(opts.vpsId, 100001);
      assert.equal(opts.odooVersion, 18);
      assert.equal(opts.domain, TENANT_DEPLOY_DOMAIN);
      assert.equal(opts.dbPassword, "db-secret-password");
      assert.equal(opts.ssh, sshMarker);
      calls.push("deployProductionStack");
      return {
        tenantId: opts.tenantId,
        stack: opts.stack ?? "prod",
        odooVersion: opts.odooVersion,
        healthy: true,
        odooHttpOk: true,
        ingressOk: true,
      };
    },
  });

  await deployToProduction(tenantInput("0026", "/repo", 100001), deps);
  assert.deepEqual(calls, [
    "resolveHostingerToken",
    "createHostingerClient",
    "createSshRunner",
    "provisionClientVps",
    "heartbeat",
    "readOrCreateDbPassword",
    "deployProductionStack",
  ]);
});

test("deployToProduction: missing SSH identity env throws a config error naming both var names, before any fleet call", async () => {
  const calls: string[] = [];
  const deps = deployDeps({
    env: {}, // LAUNCHPAD_FLEET_SSH_IDENTITY unset
    resolveHostingerToken: () => {
      calls.push("resolveHostingerToken");
      return "hostinger-secret-token";
    },
  });
  await assert.rejects(
    () => deployToProduction(tenantInput("0026", "/repo", 100001), deps),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationFailure);
      assert.equal(err.nonRetryable, true);
      const message = err.message ?? "";
      assert.ok(message.includes(FLEET_SSH_IDENTITY_ENV));
      assert.ok(message.includes(FLEET_SSH_USER_ENV));
      return true;
    },
  );
  assert.deepEqual(calls, []); // never reached a fleet call
});

test('deployToProduction: sandbox refusal (FleetError kind "sandbox") surfaces as a non-retryable ApplicationFailure', async () => {
  const deps = deployDeps({
    provisionClientVps: async () => {
      throw new FleetError(
        "sandbox",
        'refusing "provisionClientVps" on VPS 999999: not on the fleet sandbox allowlist ' +
          "(infra/fleet-sandbox.json, ADR-013)",
        { retryable: false },
      );
    },
    deployProductionStack: async () => {
      throw new Error("should not deploy a stack once provisioning is refused");
    },
  });
  await assert.rejects(
    () => deployToProduction(tenantInput("0026", "/repo", 999999), deps),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationFailure);
      assert.equal(err.nonRetryable, true);
      assert.equal(err.type, "FleetError:sandbox");
      const message = err.message ?? "";
      assert.ok(message.includes("999999"));
      assert.ok(message.includes("sandbox allowlist"));
      return true;
    },
  );
});

test("deployToProduction: dbPassword from readOrCreateDbPassword is threaded unchanged into deployProductionStack across repeat deploys", async () => {
  // Mirrors readOrCreateDbPassword's own read-or-create contract (spec 0014):
  // the first call "creates" a password, every later call for the same
  // tenant must return the SAME one, and deployToProduction must pass
  // whatever it gets straight through — never regenerate its own.
  let stored: string | null = null;
  const passwordsSeenByDeploy: string[] = [];
  const deps = deployDeps({
    readOrCreateDbPassword: async () => {
      if (stored === null) stored = "generated-once-password";
      return stored;
    },
    deployProductionStack: async (opts) => {
      passwordsSeenByDeploy.push(opts.dbPassword);
      return {
        tenantId: opts.tenantId,
        stack: opts.stack ?? "prod",
        odooVersion: opts.odooVersion,
        healthy: true,
        odooHttpOk: true,
        ingressOk: true,
      };
    },
  });
  await deployToProduction(tenantInput("0026", "/repo", 100001), deps);
  await deployToProduction(tenantInput("0026", "/repo", 100001), deps); // simulated redeploy
  assert.deepEqual(passwordsSeenByDeploy, ["generated-once-password", "generated-once-password"]);
});

test("deployToProduction: a failure's message never contains the resolved token, SSH identity path, or dbPassword", async () => {
  const secretToken = "hostinger-tok-super-secret-123";
  const secretDbPassword = "db-super-secret-password-456";
  const identityPath = "/home/deploy/.ssh/very-secret-launchpad-id";
  const deps = deployDeps({
    env: { [FLEET_SSH_IDENTITY_ENV]: identityPath , [ODOO_MASTER_PASSWORD_ENV]: "master-not-a-real-secret", [ODOO_ADMIN_PASSWORD_ENV]: "admin-not-a-real-secret"},
    resolveHostingerToken: () => secretToken,
    readOrCreateDbPassword: async () => secretDbPassword,
    deployProductionStack: async () => {
      throw new FleetError(
        "deploy",
        "docker compose up failed (exit 1): connection refused",
        { retryable: true },
      );
    },
  });
  await assert.rejects(
    () => deployToProduction(tenantInput("0026", "/repo", 100001), deps),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationFailure);
      assert.equal(err.nonRetryable, false); // FleetError "deploy" is retryable
      const message = err.message ?? "";
      assert.equal(message.includes(secretToken), false);
      assert.equal(message.includes(secretDbPassword), false);
      assert.equal(message.includes(identityPath), false);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// deployStaging (spec 0119) — the create half. What matters here is what the
// reviewer ends up testing: the reviewed WORKTREE's addons (not `main`), on the
// tenant's own box, under a name derived from the spec id.
// ---------------------------------------------------------------------------

function stagingDeployDeps(overrides: Partial<DeployStagingDeps> = {}): DeployStagingDeps {
  return {
    readOdooReadonly: async () => ({ user: "front_readonly", password: "ro-pass-not-a-real-secret" }),
    env: { [FLEET_SSH_IDENTITY_ENV]: "/id_ed25519" , [ODOO_MASTER_PASSWORD_ENV]: "master-not-a-real-secret", [ODOO_ADMIN_PASSWORD_ENV]: "admin-not-a-real-secret"},
    resolveHostingerToken: () => "hostinger-secret-token",
    createHostingerClient: () =>
      ({ getVps: async () => ({ ipv4: [{ address: "203.0.113.5" }] }) }) as unknown as HostingerClient,
    createSshRunner: () => ({
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      writeFile: async () => {},
    }),
    readOrCreateDbPassword: async () => "db-secret-password",
    deployStagingStack: async (opts) => ({
      tenantId: opts.tenantId,
      stack: `spec-${opts.specId}`,
      odooVersion: opts.odooVersion,
      healthy: true,
      odooHttpOk: true,
      ingressOk: true,
      specId: opts.specId,
      addons: ["sale_custom"],
      host: `spec-${opts.specId}.${opts.tenantId}.${opts.domain}`,
    }),
    heartbeat: () => {},
    ...overrides,
  };
}

test("deployStaging: self target returns null — a dogfood run has no Odoo stack to stand up", async () => {
  const deps = stagingDeployDeps({
    resolveHostingerToken: () => {
      throw new Error("should not touch the fleet for a self target");
    },
    deployStagingStack: async () => {
      throw new Error("should not deploy anything for a self target");
    },
  });
  const env = baseEnv("/repo", "spec/0119");
  assert.equal(await deployStaging(baseInput("0119", "/repo"), env, deps), null);
});

test("deployStaging: deploys the REVIEWED worktree's addons, not the primary checkout", async () => {
  // The whole point of creating this at gate 2: what the reviewer tests must be
  // the code they are about to approve.
  let seenRepoRoot: string | undefined;
  const deps = stagingDeployDeps({
    deployStagingStack: async (opts) => {
      seenRepoRoot = opts.repoRoot;
      return {
        tenantId: opts.tenantId,
        stack: `spec-${opts.specId}`,
        odooVersion: opts.odooVersion,
        healthy: true,
        odooHttpOk: true,
        ingressOk: true,
        specId: opts.specId,
        addons: [],
        host: "h",
      };
    },
  });
  const env = baseEnv("/tmp/worktrees/spec-0119", "spec/0119", "/repo/primary");
  await deployStaging(tenantInput("0119", "/repo/primary", 100001), env, deps);
  assert.equal(seenRepoRoot, "/tmp/worktrees/spec-0119");
});

test("deployStaging: threads the tenant's identity + version through and returns the fleet's own answer", async () => {
  const deps = stagingDeployDeps();
  const env = baseEnv("/wt", "spec/0119");
  const ref = await deployStaging(tenantInput("0119", "/repo", 100001), env, deps);
  // Every field is the fleet's report, never a value this layer invented.
  // Spec 0120 added `ingressOk` to the fleet's DeployResult, but StagingRef
  // deliberately does not carry it forward yet — the ref is what the UI renders,
  // and changing what it claims about reachability belongs with the panel copy
  // (see 0120's follow-up item), not smuggled in here.
  assert.deepEqual(ref, {
    specId: "0119",
    stack: "spec-0119",
    host: `spec-0119.sandbox.${TENANT_DEPLOY_DOMAIN}`,
    addons: ["sale_custom"],
    healthy: true,
    odooHttpOk: true,
  });
});

test("deployStaging: STAGING_DOMAIN_ENV overrides the unresolvable .test default", async () => {
  // The default domain is `.test`, which can never resolve (spec 0119's open DNS
  // item). This is the one knob that makes a staging host reachable once a
  // wildcard record exists — with no code change.
  const deps = stagingDeployDeps({
    env: { [FLEET_SSH_IDENTITY_ENV]: "/id_ed25519", [ODOO_MASTER_PASSWORD_ENV]: "master-not-a-real-secret", [ODOO_ADMIN_PASSWORD_ENV]: "admin-not-a-real-secret", [STAGING_DOMAIN_ENV]: "staging.example.com" },
  });
  const env = baseEnv("/wt", "spec/0119");
  const ref = await deployStaging(tenantInput("0119", "/repo", 100001), env, deps);
  assert.equal(ref?.host, "spec-0119.sandbox.staging.example.com");
});

test("deployStaging: the REAL deployStagingStack refuses an UNLISTED VPS before any SSH (ADR-013)", async () => {
  const deps = stagingDeployDeps({
    createSshRunner: () => unusableSsh("the sandbox guard must refuse first"),
    deployStagingStack, // the real one — the guard under test
  });
  const env = baseEnv("/wt", "spec/0119");
  await assert.rejects(
    () => deployStaging(tenantInput("0119", "/repo", 999999), env, deps),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationFailure);
      assert.equal(err.nonRetryable, true, "a sandbox refusal must never be retried");
      assert.match(err.message, /999999/);
      return true;
    },
  );
});

test("deployStaging: a failure message never contains the token, identity path, or db password", async () => {
  const secretToken = "hostinger-live-token-value";
  const identityPath = "/very/secret/id_ed25519";
  const secretDbPassword = "db-password-value";
  const deps = stagingDeployDeps({
    env: { [FLEET_SSH_IDENTITY_ENV]: identityPath , [ODOO_MASTER_PASSWORD_ENV]: "master-not-a-real-secret", [ODOO_ADMIN_PASSWORD_ENV]: "admin-not-a-real-secret"},
    resolveHostingerToken: () => secretToken,
    readOrCreateDbPassword: async () => secretDbPassword,
    deployStagingStack: async () => {
      throw new FleetError("deploy", "compose up failed", { retryable: true });
    },
  });
  const env = baseEnv("/wt", "spec/0119");
  await assert.rejects(
    () => deployStaging(tenantInput("0119", "/repo", 100001), env, deps),
    (err: unknown) => {
      const message = (err as Error).message ?? "";
      assert.equal(message.includes(secretToken), false);
      assert.equal(message.includes(identityPath), false);
      assert.equal(message.includes(secretDbPassword), false);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// destroyStaging (spec 0119) — the teardown half, tested first because a create
// without a matching destroy leaks a database volume per spec onto one box.
//
// The sandbox refusal below runs the REAL `destroyStagingStack`, not a stub: a
// test that asserts the vpsId we passed would prove our own call and nothing
// about the guard (docs/VERIFICATION.md #1). The SSH runner throws if touched,
// so "refused before any SSH" is proven rather than assumed.
// ---------------------------------------------------------------------------

/** An SSH runner that fails the test if anything reaches it. */
function unusableSsh(why: string): SshRunner {
  return {
    exec: async () => {
      throw new Error(`SSH must not be reached: ${why}`);
    },
    writeFile: async () => {
      throw new Error(`SSH must not be reached: ${why}`);
    },
  };
}

function destroyDeps(overrides: Partial<DestroyStagingDeps> = {}): DestroyStagingDeps {
  return {
    env: { [FLEET_SSH_IDENTITY_ENV]: "/id_ed25519" , [ODOO_MASTER_PASSWORD_ENV]: "master-not-a-real-secret", [ODOO_ADMIN_PASSWORD_ENV]: "admin-not-a-real-secret"},
    resolveHostingerToken: () => "hostinger-secret-token",
    createHostingerClient: () =>
      ({ getVps: async () => ({ ipv4: [{ address: "203.0.113.5" }] }) }) as unknown as HostingerClient,
    createSshRunner: () => ({
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      writeFile: async () => {},
    }),
    destroyStagingStack: async (opts) => ({ stack: `spec-${opts.specId}`, existed: true }),
    heartbeat: () => {},
    ...overrides,
  };
}

test("destroyStaging: self target returns null — a dogfood run has no Odoo stack to take down", async () => {
  const deps = destroyDeps({
    resolveHostingerToken: () => {
      throw new Error("should not touch the fleet for a self target");
    },
    destroyStagingStack: async () => {
      throw new Error("should not destroy anything for a self target");
    },
  });
  assert.equal(await destroyStaging(baseInput("0119", "/repo"), deps), null);
});

test("destroyStaging: derives tenant/spec/vps from input, NOT from a create result", async () => {
  // This is the property that makes teardown survive a crash between create and
  // teardown: there is no create result to pass, and none is needed.
  let seen: { tenantId: string; specId: string; vpsId: number } | undefined;
  const deps = destroyDeps({
    destroyStagingStack: async (opts) => {
      seen = { tenantId: opts.tenantId, specId: opts.specId, vpsId: opts.vpsId };
      return { stack: "spec-0119", existed: true };
    },
  });
  const result = await destroyStaging(tenantInput("0119", "/repo", 100001), deps);
  assert.deepEqual(seen, { tenantId: "sandbox", specId: "0119", vpsId: 100001 });
  assert.deepEqual(result, { stack: "spec-0119", existed: true });
});

test("destroyStaging: an already-gone stack reports existed:false rather than failing", async () => {
  // Teardown runs on a terminal path that Temporal may retry, so a second
  // destroy must be a no-op, not an error.
  const deps = destroyDeps({
    destroyStagingStack: async () => ({ stack: "spec-0119", existed: false }),
  });
  const result = await destroyStaging(tenantInput("0119", "/repo", 100001), deps);
  assert.deepEqual(result, { stack: "spec-0119", existed: false });
});

// The refused example is a SYNTHETIC id (999999), absent from infra/fleet-sandbox.json and
// unallowlistable by anyone — spec 0125 briefly listed a real id and had to revert it. The
// property is unchanged: an unlisted VPS is refused before any SSH.
test("destroyStaging: the REAL destroyStagingStack refuses an UNLISTED VPS before any SSH (ADR-013)", async () => {
  const deps = destroyDeps({
    createSshRunner: () => unusableSsh("the sandbox guard must refuse first"),
    destroyStagingStack, // the real one — the guard under test
  });
  await assert.rejects(
    () => destroyStaging(tenantInput("0119", "/repo", 999999), deps),
    (err: unknown) => {
      assert.ok(err instanceof ApplicationFailure);
      assert.equal(err.nonRetryable, true, "a sandbox refusal must never be retried");
      assert.match(err.message, /999999/);
      return true;
    },
  );
});

test("destroyStaging: missing SSH identity is a config error naming both env vars, before any fleet call", async () => {
  const deps = destroyDeps({
    env: {},
    resolveHostingerToken: () => {
      throw new Error("must not resolve a token without an SSH identity");
    },
  });
  await assert.rejects(
    () => destroyStaging(tenantInput("0119", "/repo", 100001), deps),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, new RegExp(FLEET_SSH_IDENTITY_ENV));
      assert.match(message, new RegExp(FLEET_SSH_USER_ENV));
      return true;
    },
  );
});

test("destroyStaging: a failure message never contains the token or the SSH identity path", async () => {
  const secretToken = "hostinger-live-token-value";
  const identityPath = "/very/secret/id_ed25519";
  const deps = destroyDeps({
    env: { [FLEET_SSH_IDENTITY_ENV]: identityPath , [ODOO_MASTER_PASSWORD_ENV]: "master-not-a-real-secret", [ODOO_ADMIN_PASSWORD_ENV]: "admin-not-a-real-secret"},
    resolveHostingerToken: () => secretToken,
    destroyStagingStack: async () => {
      throw new FleetError("deploy", "compose down failed", { retryable: true });
    },
  });
  await assert.rejects(
    () => destroyStaging(tenantInput("0119", "/repo", 100001), deps),
    (err: unknown) => {
      const message = (err as Error).message ?? "";
      assert.equal(message.includes(secretToken), false);
      assert.equal(message.includes(identityPath), false);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// writeTenantDeployManifest (spec 0047 item A) — exercised against a real temp
// git repo (same discipline as draft-spec.test.ts / handoff-dirt.test.ts: this
// commits/inspects with real git, so a mock buys nothing).
// ---------------------------------------------------------------------------

/** A git repo with a committed `specs/` dir but no manifest file for `specId`
 * yet — same shape as draft-spec.test.ts's `makeBareRepo`. The tracked
 * `.gitkeep` placeholder keeps `specs/` from collapsing to a single
 * untracked-dir line in `git status --porcelain` once the manifest is added. */
async function makeBareTenantRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-tenant-manifest-"));
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.email", "test@example.com"], root);
  await run("git", ["config", "user.name", "Test"], root);
  await mkdir(path.join(root, "specs"), { recursive: true });
  await writeFile(path.join(root, "specs", ".gitkeep"), "");
  await run("git", ["add", "."], root);
  await run("git", ["commit", "-m", "init"], root);
  return root;
}

test("writeTenantDeployManifest: content is deterministic for a given input", async () => {
  const rootA = await makeBareTenantRepo();
  const rootB = await makeBareTenantRepo();
  try {
    const input = tenantInput("0048", rootA, 100001);
    await writeTenantDeployManifest(input);
    await writeTenantDeployManifest({ ...input, target: { ...input.target, repo: rootB } });
    const contentA = await readFile(await findSpecFile(rootA, "0048"), "utf8");
    const contentB = await readFile(await findSpecFile(rootB, "0048"), "utf8");
    assert.equal(contentA, contentB); // byte-equal — no Date.now()/randomUUID leakage
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("writeTenantDeployManifest: frontmatter parses (parseStatus etc.) + id-prefix resolves", async () => {
  const root = await makeBareTenantRepo();
  try {
    await writeTenantDeployManifest(tenantInput("0048", root, 100001));
    const file = await findSpecFile(root, "0048"); // resolves the bare id
    assert.equal(path.basename(file), "0048-tenant-sandbox-deploy.md");
    const content = await readFile(file, "utf8");
    assert.equal(parseStatus(content), "draft");
    assert.equal(readTitle(content), "Tenant deploy: sandbox — vanilla Odoo 18");
    assert.deepEqual(await git.dirtyFiles(root), []); // committed by the activity
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeTenantDeployManifest: idempotent re-run is a no-op (activity retry)", async () => {
  const root = await makeBareTenantRepo();
  try {
    const input = tenantInput("0048", root, 100001);
    await writeTenantDeployManifest(input);
    const contentFirst = await readFile(await findSpecFile(root, "0048"), "utf8");
    const shaFirst = await git.headSha(root);
    await writeTenantDeployManifest(input); // retry — must reconcile without failing
    const contentRetry = await readFile(await findSpecFile(root, "0048"), "utf8");
    const shaRetry = await git.headSha(root);
    assert.equal(contentRetry, contentFirst); // manifest unchanged
    assert.equal(shaRetry, shaFirst); // no new commit
    assert.deepEqual(await git.dirtyFiles(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// spec 0055 AC1: runCi rebuilds packages/*/dist before the typecheck so the
// checks see fresh dist, and a red build folds into `green: false` without
// ever flipping back true, via the RunCiDeps injectable-`run` seam
// (baseInput/baseEnv above build the args).

/** A recording `deps.run` fake: logs every (cmd, args) call to `calls`, and
 * for the `pnpm -r test` call writes a harness-exec-count file (mirroring
 * writeHarnessCountOnExit) so the skip-proof check reads a real count instead
 * of hitting the missing-file fallback — everything else returns `ok`. */
function fakeRunCiDeps(
  calls: string[][],
  overrides: { build?: boolean; typecheck?: boolean; test?: boolean } = {},
): RunCiDeps {
  const { build = true, typecheck = true, test: testOk = true } = overrides;
  return {
    run: async (cmd, args, _cwd, env) => {
      calls.push([cmd, ...args]);
      const isBuild = args.includes("--filter=./packages/*");
      const isTypecheck = args.includes("typecheck");
      const countFile = env?.[HARNESS_COUNT_ENV];
      if (countFile) {
        await writeFile(countFile, "1", "utf8"); // pretend one harness case executed
      }
      const ok = isBuild ? build : isTypecheck ? typecheck : testOk;
      return { ok, out: "" };
    },
  };
}

/** A real temp dir WITH a package.json — spec 0138 made runCi skip repos
 * without one, so the pnpm-path tests need a workdir that HAS the toolchain
 * marker (the fake `run` still intercepts every command). */
async function nodeRepoDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "runci-node-"));
  await writeFile(path.join(dir, "package.json"), "{}\n");
  return dir;
}

test(
  "runCi: runs `pnpm --filter='./packages/*' -r build` in env.workdir BEFORE `pnpm -r typecheck` (spec 0055 AC1a)",
  async () => {
    const calls: string[][] = [];
    const deps = fakeRunCiDeps(calls);
    const repo = await nodeRepoDir();
    await runCi(baseInput("0055", repo), baseEnv(repo, "spec/0055"), deps);
    const buildIdx = calls.findIndex((c) => c.includes("--filter=./packages/*"));
    const typecheckIdx = calls.findIndex((c) => c.includes("typecheck"));
    assert.ok(buildIdx >= 0, "build call recorded");
    assert.ok(typecheckIdx >= 0, "typecheck call recorded");
    assert.ok(buildIdx < typecheckIdx, "build runs before typecheck");
  },
);

test(
  "runCi: a red packages build yields green:false and typecheck/test cannot flip it back to true (spec 0055 AC1b)",
  async () => {
    const calls: string[][] = [];
    // build fails; typecheck + test + skip-proof would otherwise all be green.
    const deps = fakeRunCiDeps(calls, { build: false, typecheck: true, test: true });
    const repo = await nodeRepoDir();
    const res = await runCi(baseInput("0055", repo), baseEnv(repo, "spec/0055"), deps);
    assert.equal(res.green, false);
  },
);

test(
  "runCi: a green build leaves the existing typecheck/test/skip-proof behavior unchanged (spec 0055 AC1c)",
  async () => {
    const calls: string[][] = [];
    // build green, typecheck green, test red -> green must track typecheck && test as before.
    const redTest = fakeRunCiDeps(calls, { build: true, typecheck: true, test: false });
    const repo = await nodeRepoDir();
    const redTestRes = await runCi(baseInput("0055", repo), baseEnv(repo, "spec/0055"), redTest);
    assert.equal(redTestRes.green, false);

    // build green, typecheck red -> still red, exactly as before the build step existed.
    const redTypecheck = fakeRunCiDeps(calls, { build: true, typecheck: false, test: true });
    const redTypecheckRes = await runCi(
      baseInput("0055", repo),
      baseEnv(repo, "spec/0055"),
      redTypecheck,
    );
    assert.equal(redTypecheckRes.green, false);

    // build, typecheck, test all green -> green:true.
    const allGreen = fakeRunCiDeps(calls);
    const allGreenRes = await runCi(baseInput("0055", repo), baseEnv(repo, "spec/0055"), allGreen);
    assert.equal(allGreenRes.green, true);
  },
);

// SPEC-ALIGNMENT §9.3: an infrastructure failure (the process could not run —
// e.g. `pnpm` not on PATH, surfaced by `run()` as `execError`) must throw a
// RETRYABLE ApplicationFailure, NOT fold into green:false (which would send the
// workflow into LLM repair rounds on a worker-config problem). A real non-zero
// exit (execError falsy) still folds into green:false.
test("runCi: an execError (spawn/infra failure) throws a retryable CiInfrastructureError, not green:false", async () => {
  const infraDeps: RunCiDeps = {
    run: async (_cmd, args) => {
      if (args.includes("--filter=./packages/*")) {
        return { ok: false, out: "spawn pnpm ENOENT", execError: true };
      }
      return { ok: true, out: "" };
    },
  };
  await assert.rejects(
    async () => {
      const repo = await nodeRepoDir();
      return runCi(baseInput("0068", repo), baseEnv(repo, "spec/0068"), infraDeps);
    },
    (err: unknown) =>
      err instanceof ApplicationFailure &&
      err.type === "CiInfrastructureError" &&
      err.nonRetryable === false,
  );
});

test("runCi: a real non-zero exit (execError falsy) still folds into green:false, not a throw", async () => {
  const calls: string[][] = [];
  // test step returns ok:false with NO execError — a genuine test-red verdict.
  const redTest = fakeRunCiDeps(calls, { build: true, typecheck: true, test: false });
  const repo = await nodeRepoDir();
  const res = await runCi(baseInput("0068", repo), baseEnv(repo, "spec/0068"), redTest);
  assert.equal(res.green, false);
});

// ── spec 0096: a failed post-merge local sync must not fail a merged run ─────

test(
  "mergePullRequest: a throwing pullFfOnly does NOT fail the run (the merge already happened)",
  async () => {
    // THE incident (spec 0095): local `main` had an unpushed markSpec status
    // commit, so `git pull --ff-only` could not fast-forward. The PR had ALREADY
    // merged server-side, yet the activity threw and failed the whole run —
    // reporting an irreversible success as a failure, and unretryable (a retry
    // re-runs the same impossible pull).
    const calls: string[] = [];
    const deps = mergeDeps(
      async () => {
        calls.push("mergePr");
        return "mergesha";
      },
      {
        checkout: async () => void calls.push("checkout"),
        pullFfOnly: async () => {
          calls.push("pullFfOnly");
          throw new Error("git pull --ff-only origin main failed: Not possible to fast-forward");
        },
        lockfileHash: async () => "hash-x",
        readDepsStamp: async () => "hash-x",
      },
    );

    // Must RESOLVE, not reject.
    await mergePullRequest(basePrRef(), deps);

    assert.ok(calls.includes("mergePr"), "the API merge must still happen");
    assert.ok(calls.includes("pullFfOnly"), "the sync must still be attempted");
  },
);

test(
  "mergePullRequest: a throwing mergePr STILL fails (spec 0096 is scoped to the sync only)",
  async () => {
    // Scope guard: 0096 makes only the post-merge SYNC best-effort. The merge
    // itself failing is a real failure and must keep failing, or the change
    // would have quietly become a blanket catch.
    const deps = mergeDeps(async () => {
      throw new Error("mergePr blew up");
    });
    await assert.rejects(() => mergePullRequest(basePrRef(), deps), /mergePr blew up/);
  },
);

// ---------------------------------------------------------------------------
// Spec 0121 — the deploy refuses to run on Odoo's default passwords, and the
// tenant domain is a seam so a tenant host can actually resolve.
// ---------------------------------------------------------------------------

test("deployToProduction: a missing Odoo password fails BEFORE any fleet call, naming the variable", async () => {
  // Failing halfway would leave a stack running on the image's defaults, which is
  // the exact state this spec exists to end.
  for (const missing of [ODOO_MASTER_PASSWORD_ENV, ODOO_ADMIN_PASSWORD_ENV]) {
    const env: NodeJS.ProcessEnv = {
      [FLEET_SSH_IDENTITY_ENV]: "/id_ed25519",
      [ODOO_MASTER_PASSWORD_ENV]: "master-not-a-real-secret",
      [ODOO_ADMIN_PASSWORD_ENV]: "admin-not-a-real-secret",
    };
    delete env[missing];
    const deps = deployDeps({
      env,
      deployProductionStack: async () => {
        throw new Error("must not deploy without both Odoo passwords");
      },
    });
    await assert.rejects(
      () => deployToProduction(tenantInput("0121", "/repo", 100001), deps),
      (err: unknown) => {
        assert.match((err as Error).message, new RegExp(missing));
        return true;
      },
      `should refuse when ${missing} is unset`,
    );
  }
});

test("deployToProduction: TENANT_DOMAIN_ENV overrides the unresolvable .test default", async () => {
  let seenDomain: string | undefined;
  const deps = deployDeps({
    env: {
      [FLEET_SSH_IDENTITY_ENV]: "/id_ed25519",
      [ODOO_MASTER_PASSWORD_ENV]: "master-not-a-real-secret",
      [ODOO_ADMIN_PASSWORD_ENV]: "admin-not-a-real-secret",
      [TENANT_DOMAIN_ENV]: "203.0.113.20.sslip.io",
    },
    deployProductionStack: async (opts) => {
      seenDomain = opts.domain;
      return {
        tenantId: opts.tenantId,
        stack: opts.stack ?? "prod",
        odooVersion: opts.odooVersion,
        healthy: true,
        odooHttpOk: true,
        ingressOk: true,
      };
    },
  });
  await deployToProduction(tenantInput("0121", "/repo", 100001), deps);
  assert.equal(seenDomain, "203.0.113.20.sslip.io");
});

test("deployToProduction: both Odoo passwords are threaded to the fleet unchanged", async () => {
  let seen: { master?: string; admin?: string } = {};
  const deps = deployDeps({
    deployProductionStack: async (opts) => {
      seen = { master: opts.masterPassword, admin: opts.adminPassword };
      return {
        tenantId: opts.tenantId,
        stack: opts.stack ?? "prod",
        odooVersion: opts.odooVersion,
        healthy: true,
        odooHttpOk: true,
        ingressOk: true,
      };
    },
  });
  await deployToProduction(tenantInput("0121", "/repo", 100001), deps);
  assert.deepEqual(seen, { master: "master-not-a-real-secret", admin: "admin-not-a-real-secret" });
});

test("deployStaging: falls back tenant domain -> .test when only TENANT_DOMAIN_ENV is set", async () => {
  // A throwaway staging env and a long-lived tenant may sit on different domains;
  // the chain says which wins when only one is configured.
  let seenDomain: string | undefined;
  const deps = stagingDeployDeps({
    env: {
      [FLEET_SSH_IDENTITY_ENV]: "/id_ed25519",
      [ODOO_MASTER_PASSWORD_ENV]: "master-not-a-real-secret",
      [ODOO_ADMIN_PASSWORD_ENV]: "admin-not-a-real-secret",
      [TENANT_DOMAIN_ENV]: "tenants.example.com",
    },
    deployStagingStack: async (opts) => {
      seenDomain = opts.domain;
      return {
        tenantId: opts.tenantId,
        stack: `spec-${opts.specId}`,
        odooVersion: opts.odooVersion,
        healthy: true,
        odooHttpOk: true,
        ingressOk: true,
        specId: opts.specId,
        addons: [],
        host: "h",
      };
    },
  });
  await deployStaging(tenantInput("0121", "/repo", 100001), baseEnv("/wt", "spec/0121"), deps);
  assert.equal(seenDomain, "tenants.example.com");
});

// ---------------------------------------------------------------------------
// Spec 0115 — readOdooShBuild. The activity owns the IO; `interpretOdooShStatus`
// owns the meaning. What is tested here is that silence stays silence: it must
// never become a green build.
// ---------------------------------------------------------------------------

function odooShDeps(
  statuses: Array<{ state: string; context: string; description: string | null; targetUrl: string | null }>,
  overrides: Partial<ReadOdooShBuildDeps> = {},
): ReadOdooShBuildDeps {
  return {
    githubToken: () => "gh-secret-token",
    createGithubClient: () => ({ getCommitStatuses: async () => statuses as never }),
    ...overrides,
  };
}

test("readOdooShBuild: reads the ci/odoo.sh context and interprets it", async () => {
  const build = await readOdooShBuild(
    "acme/erp",
    "abc123",
    odooShDeps([
      { state: "success", context: "ci/odoo.sh", description: "Build 9", targetUrl: "https://x/9" },
    ]),
  );
  assert.equal(build.status, "success");
  assert.equal(build.status === "success" ? build.url : null, "https://x/9");
});

test("readOdooShBuild: another reporter's status is NOT read as odoo.sh's", async () => {
  // A repo with GitHub Actions green and no odoo.sh status must report absent, or a
  // promote guard would clear on the wrong signal entirely.
  const build = await readOdooShBuild(
    "acme/erp",
    "abc123",
    odooShDeps([
      { state: "success", context: "continuous-integration/other", description: null, targetUrl: null },
    ]),
  );
  assert.deepEqual(build, { status: "absent" });
});

test("readOdooShBuild: a non-GitHub repo ref reports absent instead of throwing", async () => {
  // Local-diff runs carry a workdir path here, not `owner/repo`. A caller needs a
  // fact it can act on, not an exception.
  const build = await readOdooShBuild(
    "/tmp/launchpad-worktree",
    "abc123",
    odooShDeps([], {
      createGithubClient: () => {
        throw new Error("must not construct a client without owner/repo");
      },
    }),
  );
  assert.deepEqual(build, { status: "absent" });
});

test("readOdooShBuild: a missing token reports absent and never builds a client", async () => {
  const build = await readOdooShBuild(
    "acme/erp",
    "abc123",
    odooShDeps([], {
      githubToken: () => undefined,
      createGithubClient: () => {
        throw new Error("must not construct a client without a token");
      },
    }),
  );
  assert.deepEqual(build, { status: "absent" });
});

test("readOdooShBuild: a pending build is in flight — the promote guard's clause 4", async () => {
  const build = await readOdooShBuild(
    "acme/erp",
    "abc123",
    odooShDeps([
      { state: "pending", context: "ci/odoo.sh", description: "Building", targetUrl: null },
    ]),
  );
  assert.equal(isOdooShBuildInFlight(build), true);
});

// ---------------------------------------------------------------------------
// Spec 0128 F: a promotion is performed with the PROMOTER's own credential.
// ---------------------------------------------------------------------------

/** Merge deps that RECORD the token the client was built with — `mergeDeps`
 * asserts the server token, which is precisely what these tests must not assume. */
function promoterDeps(overrides: Partial<MergePullRequestDeps> = {}) {
  const seen: { token?: string } = {};
  const deps: MergePullRequestDeps = {
    githubToken: () => "server-token",
    promoterToken: async () => null,
    createGithubClient: (config) => {
      seen.token = config.token;
      return { mergePr: async (): Promise<string> => "mergesha", getPrState: async (n: number) => basePrState({ number: n }) };
    },
    dirtyFiles: async () => [],
    checkout: async () => {},
    pullFfOnly: async () => {},
    lockfileExists: async () => true,
    lockfileHash: async () => "stub-hash",
    readDepsStamp: async () => "stub-hash",
    writeDepsStamp: async () => {},
    installFrozen: async () => {},
    nudgeWeb: async () => {},
    ...overrides,
  };
  return { deps, seen };
}

test("mergePullRequest: merges with the PROMOTER's token, not the server's", async () => {
  const { deps, seen } = promoterDeps({
    promoterToken: async (actor) => (actor === "owner@example.com" ? "owner-personal-token" : null),
  });
  await mergePullRequest(basePrRef(), deps, "owner@example.com");
  // The whole point: GitHub sees the PERSON, so branch protection applies to them.
  assert.equal(seen.token, "owner-personal-token");
  assert.notEqual(seen.token, "server-token");
});

// Falling back to the server token here would silently re-create the
// unattributable production deploy this design exists to remove.
test("mergePullRequest: no stored credential REFUSES — it does not fall back to the bot", async () => {
  const { deps, seen } = promoterDeps({ promoterToken: async () => null });
  await assert.rejects(
    () => mergePullRequest(basePrRef(), deps, "newcomer@example.com"),
    (err: unknown) => {
      const e = err as { type?: string; nonRetryable?: boolean; message?: string };
      assert.equal(e.type, "PromoterCredentialMissing");
      assert.equal(e.nonRetryable, true, "retrying cannot conjure a credential");
      assert.match(e.message ?? "", /newcomer@example\.com/, "names whose credential is missing");
      return true;
    },
  );
  assert.equal(seen.token, undefined, "must not reach GitHub at all");
});

// A 403 with a user credential means "this person may not merge this". Retrying
// never succeeds; it stalls the run and buries the message.
test("mergePullRequest: a permission failure with a user token is NON-retryable", async () => {
  const { deps } = promoterDeps({
    promoterToken: async () => "owner-personal-token",
    createGithubClient: () => ({
      getPrState: async (n: number) => basePrState({ number: n }),
      mergePr: async (): Promise<string> => {
        throw new GithubApiError("auth", "403 Forbidden", { status: 403, retryable: false });
      },
    }),
  });
  await assert.rejects(
    () => mergePullRequest(basePrRef(), deps, "owner@example.com"),
    (err: unknown) => {
      const e = err as { type?: string; nonRetryable?: boolean; message?: string };
      assert.equal(e.type, "PromoterMergeRefused");
      assert.equal(e.nonRetryable, true);
      assert.match(e.message ?? "", /owner@example\.com/);
      assert.match(e.message ?? "", /scope needed to merge/, "names the likely fix");
      return true;
    },
  );
});

// Without a promoter (the dogfood/self path), nothing changes — the server token
// merges, exactly as before this spec.
test("mergePullRequest: no promoter given ⇒ the server token merges (pre-0128 path)", async () => {
  const { deps, seen } = promoterDeps({
    promoterToken: async () => {
      throw new Error("must not be consulted when no promoter is given");
    },
  });
  await mergePullRequest(basePrRef(), deps);
  assert.equal(seen.token, "server-token");
});

// ---------------------------------------------------------------------------
// Spec 0129 C: markSpec operates on the RUN's repo, not on whatever
// LAUNCHPAD_REPO_ROOT happens to be.
// ---------------------------------------------------------------------------

test("markSpec: writes to the repo root it is GIVEN, not the env", async () => {
  const envRoot = await mkdtemp(path.join(tmpdir(), "env-root-"));
  const runRoot = await mkdtemp(path.join(tmpdir(), "run-root-"));
  const prev = process.env["LAUNCHPAD_REPO_ROOT"];
  process.env["LAUNCHPAD_REPO_ROOT"] = envRoot;
  try {
    // The spec exists ONLY in the run's repo — which is the situation spec 0126 D
    // created for a project with its own checkout, and the bug this fixes: markSpec
    // used to look in the env's repo and fail to find it.
    for (const root of [envRoot, runRoot]) {
      await mkdir(path.join(root, "specs"), { recursive: true });
      await run("git", ["init", "-q"], root);
      await run("git", ["config", "user.email", "t@t.t"], root);
      await run("git", ["config", "user.name", "t"], root);
    }
    const file = path.join(runRoot, "specs", "0129-probe.md");
    await writeFile(file, "---\nid: 0129\nstatus: draft\n---\n\n# probe\n", "utf8");
    await run("git", ["add", "."], runRoot);
    await run("git", ["commit", "-q", "-m", "spec"], runRoot);

    const result = await markSpec("0129", "approved", runRoot);
    assert.equal(result, "approved");
    assert.match(await readFile(file, "utf8"), /status: approved/);
  } finally {
    if (prev === undefined) delete process.env["LAUNCHPAD_REPO_ROOT"];
    else process.env["LAUNCHPAD_REPO_ROOT"] = prev;
    await rm(envRoot, { recursive: true, force: true });
    await rm(runRoot, { recursive: true, force: true });
  }
});

// The fallback keeps a pre-0129 workflow history replaying with its original
// behaviour, and is also correct for the platform project, whose checkout IS the
// env var.
test("markSpec: with no root given, still uses LAUNCHPAD_REPO_ROOT", async () => {
  const envRoot = await mkdtemp(path.join(tmpdir(), "env-only-"));
  const prev = process.env["LAUNCHPAD_REPO_ROOT"];
  process.env["LAUNCHPAD_REPO_ROOT"] = envRoot;
  try {
    await mkdir(path.join(envRoot, "specs"), { recursive: true });
    await run("git", ["init", "-q"], envRoot);
    await run("git", ["config", "user.email", "t@t.t"], envRoot);
    await run("git", ["config", "user.name", "t"], envRoot);
    const file = path.join(envRoot, "specs", "0129-fallback.md");
    await writeFile(file, "---\nid: 0129\nstatus: draft\n---\n", "utf8");
    await run("git", ["add", "."], envRoot);
    await run("git", ["commit", "-q", "-m", "spec"], envRoot);

    assert.equal(await markSpec("0129", "staged"), "staged");
    assert.match(await readFile(file, "utf8"), /status: staged/);
  } finally {
    if (prev === undefined) delete process.env["LAUNCHPAD_REPO_ROOT"];
    else process.env["LAUNCHPAD_REPO_ROOT"] = prev;
    await rm(envRoot, { recursive: true, force: true });
  }
});

// --- Spec 0138: CI reality for non-Node repos --------------------------------

test("runCi SKIPS with a recorded note when the repo has no package.json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "no-node-repo-"));
  try {
    const env = baseEnv(root, "feature/pos");
    const result = await runCi(baseInput("0150", root), env, {
      run: async () => {
        throw new Error("pnpm must never run in a repo with no Node toolchain");
      },
    });
    assert.equal(result.green, true, "the coder loop must not repair against a missing toolchain");
    assert.match(result.skipped ?? "", /sin toolchain Node/);
    assert.match(result.skipped ?? "", /staging/, "the note names the verification that DOES exist");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCi still runs pnpm when package.json exists — the skip is not a default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "node-repo-"));
  try {
    await writeFile(path.join(root, "package.json"), "{}\n");
    const commands: string[] = [];
    const env = baseEnv(root, "spec/0151");
    const result = await runCi(baseInput("0151", root), env, {
      run: async (cmd, args) => {
        commands.push(`${cmd} ${args.join(" ")}`);
        return { ok: false, out: "red", execError: false };
      },
    });
    assert.equal(result.green, false);
    assert.equal(result.skipped, undefined);
    assert.ok(commands.some((c) => c.includes("pnpm")), commands.join(" | "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Spec 0160. The exact incident: a human merged the PR on GitHub, and this
 * activity then refused because two spec files an Archivar click had left
 * uncommitted made the primary checkout dirty — recording FAILED for a spec
 * whose code was already on main. An already-merged PR needs no local git work,
 * so it must not be gated on the local tree.
 */
test("mergePullRequest: an ALREADY-MERGED PR succeeds even with a dirty tree (0160)", async () => {
  let merged = 0;
  await mergePullRequest(
    { repo: "acme/launchpad", number: 57, branch: "spec/0147", url: "u", repoRoot: "/repo", workdir: "/repo" },
    mergeDeps(
      async () => {
        merged += 1;
        return "mergesha";
      },
      // The tree is dirty exactly as it was on the box.
      { dirtyFiles: async () => ["specs/0001-launchpad-foundations.md", "specs/0002-spec-inbox-page.md"] },
      async (n) => basePrState({ number: n, merged: true }),
    ),
  );
  // No second merge attempt (a 405 would wedge the run), and no refusal.
  assert.equal(merged, 0);
});

test("mergePullRequest: an UNMERGED PR still refuses a dirty tree (0160)", async () => {
  await assert.rejects(
    () =>
      mergePullRequest(
        { repo: "acme/launchpad", number: 58, branch: "spec/0161", url: "u", repoRoot: "/repo", workdir: "/repo" },
        mergeDeps(
          async () => "mergesha",
          { dirtyFiles: async () => ["packages/pipeline/src/activities.ts"] },
          async (n) => basePrState({ number: n, merged: false }),
        ),
      ),
    /working tree unexpectedly dirty/,
  );
});

/**
 * Spec 0163. An activity has no TTY and nobody writes to the child's stdin, so a
 * pnpm prompt is an infinite hang. `spec-0162`'s merge sat on
 * "The modules directories will be removed and reinstalled from scratch.
 * Proceed? (Y/n)" for 18 minutes across two attempts, at 0% CPU, and burned its
 * last retry — while the same command in a login shell finished in 1.8s because
 * a terminal answered the prompt.
 *
 * The spawn's SHAPE is the checkable contract: there is no way to assert "it did
 * not hang" without hanging the suite.
 */
test("the pnpm install spawn cannot prompt — argv + env (0163)", () => {
  assert.ok(PNPM_INSTALL_ARGV.includes("--frozen-lockfile"), "still a frozen install");
  // The specific prompt that wedged a run…
  assert.ok(
    PNPM_INSTALL_ARGV.includes("--config.confirmModulesPurge=false"),
    `expected the purge-confirm flag, got ${JSON.stringify(PNPM_INSTALL_ARGV)}`,
  );
  // …and the general "never prompt" signal, for the next prompt pnpm invents.
  assert.equal(PNPM_NONINTERACTIVE_ENV.CI, "true");
});

// ---------------------------------------------------------------------------
// spec 0171 — CI in a CUSTOMER's repo runs THAT repo's scripts.
//
// The gap 0138 half-closed: it fixed the repo with NO package.json (a pure
// addons repo) and left the odoo-next shape — a front scaffold that DOES commit
// one — falling into the launchpad's own body (`pnpm --filter=./packages/*`,
// `pnpm -r typecheck`, the Temporal harness proof). None of that exists in a
// customer's repo, so every coder iteration went red against a toolchain that
// was never there.
// ---------------------------------------------------------------------------

/** A run in a customer's repo: `project` present with a non-platform kind — the
 * same discriminator `provisionEphemeralEnv` uses for the specs link. */
function projectInput(specId: string, repo: string, kind = "odoo_next"): PipelineInput {
  return { ...baseInput(specId, repo), project: { slug: "sushi", kind, repoRoot: repo } };
}

async function scriptRepo(scripts: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "runci-project-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts }, null, 2));
  return dir;
}

test("spec 0171: a project repo runs ITS OWN scripts — never the launchpad's", async () => {
  const root = await scriptRepo({ build: "next build", test: "node --test" });
  try {
    const cmds: string[] = [];
    const result = await runCi(projectInput("0171-a", root), baseEnv(root, "owner/menu"), {
      run: async (cmd, args) => {
        cmds.push(`${cmd} ${args.join(" ")}`);
        return { ok: true, out: "", execError: false };
      },
    });
    assert.equal(result.green, true);
    // What it DID run.
    assert.deepEqual(cmds, [
      "pnpm install --no-frozen-lockfile",
      "pnpm run build",
      "pnpm run test",
    ]);
    // And, more importantly, what it did NOT: every launchpad-shaped command.
    for (const forbidden of ["--filter=./packages/*", "-r typecheck", "-r test"]) {
      assert.ok(
        !cmds.some((c) => c.includes(forbidden)),
        `the launchpad's own CI leaked into a customer repo: ${cmds.join(" | ")}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("spec 0171: a script the repo does not define is RECORDED absent, not counted as a pass", async () => {
  const root = await scriptRepo({ build: "next build" });
  try {
    const result = await runCi(projectInput("0171-b", root), baseEnv(root, "owner/menu"), {
      run: async () => ({ ok: true, out: "", execError: false }),
    });
    assert.equal(result.green, true, "a repo with no tests still builds and merges");
    assert.match(result.note ?? "", /sin script: typecheck, test/);
    assert.match(result.note ?? "", /no ejecutado, no aprobado/, "the absence is stated as absence");
    assert.equal(result.skipped, undefined, "CI DID run — `skipped` would say the opposite");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("spec 0171: a project repo whose test script FAILS is red — the check can fail", async () => {
  // VERIFICATION #2: before trusting the green above, break the thing it guards.
  const root = await scriptRepo({ build: "next build", test: "node --test" });
  try {
    const result = await runCi(projectInput("0171-c", root), baseEnv(root, "owner/menu"), {
      run: async (_cmd, args) => ({
        ok: !args.includes("test"),
        out: args.includes("test") ? "1 failing" : "",
        execError: false,
      }),
    });
    assert.equal(result.green, false);
    assert.match(result.note ?? "", /test RED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("spec 0171: a failed install stops there rather than reporting a build verdict", async () => {
  const root = await scriptRepo({ build: "next build", test: "node --test" });
  try {
    const cmds: string[] = [];
    const result = await runCi(projectInput("0171-d", root), baseEnv(root, "owner/menu"), {
      run: async (cmd, args) => {
        cmds.push(`${cmd} ${args.join(" ")}`);
        return { ok: false, out: "ERR_PNPM_NO_MATCHING_VERSION", execError: false };
      },
    });
    assert.equal(result.green, false);
    assert.deepEqual(cmds, ["pnpm install --no-frozen-lockfile"], cmds.join(" | "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("spec 0171: the addon CI runs ALONGSIDE the node scripts in a repo that has both", async () => {
  // An odoo-next project is exactly this shape: a Next front and Odoo addons in
  // one repo. Before 0171 the addon CI was reachable ONLY when there was no
  // package.json, so this repo could never have run it.
  const root = await scriptRepo({ build: "next build" });
  try {
    const result = await runCi(projectInput("0171-e", root), baseEnv(root, "owner/menu"), {
      run: async () => ({ ok: true, out: "", execError: false }),
      runAddonCi: async () => ({ green: false, note: "l10n_mx: 1 test rojo" }),
    });
    assert.equal(result.green, false, "a red addon suite must fail the run");
    assert.match(result.note ?? "", /addons RED/);
    assert.match(result.note ?? "", /l10n_mx: 1 test rojo/, "the addon CI's own note survives");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("spec 0171: the PLATFORM's own CI is untouched — same commands, same order", async () => {
  // The regression that matters most: `input.project` is present for our own
  // runs too (apps/web resolves the platform project row), so a discriminator
  // keyed on its mere presence would have rerouted the launchpad's own CI.
  const root = await nodeRepoDir();
  try {
    const cmds: string[] = [];
    const platform: PipelineInput = {
      ...baseInput("0171-f", root),
      project: { slug: "platform", kind: "platform", repoRoot: root },
    };
    await runCi(platform, baseEnv(root, "spec/0171"), {
      run: async (cmd, args) => {
        cmds.push(`${cmd} ${args.join(" ")}`);
        return { ok: true, out: "", execError: false };
      },
    });
    assert.deepEqual(cmds, [
      "pnpm --filter=./packages/* -r build",
      "pnpm -r typecheck",
      "pnpm -r test",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Spec 0180 — a WIRING guard, and honest about being one.
 *
 * `deployBranchStagingStack` only deploys a front when the caller passes
 * `packCheckout` + `deployFront` (spec 0172 made them optional so no existing
 * caller changed). The explicit deploy passes them; the gate-2 refresh did not,
 * and the result was a branch whose Odoo carried four commits of new addon while
 * its front still served spec 0169's scaffold — the exact state measured on
 * `owner/menu-sushi`.
 *
 * The BEHAVIOUR is proven where it belongs: 0172's fleet tests assert the front
 * is requested on the branch host and pointed at the branch's own Odoo, and the
 * spec's live item watches it happen. What no test covered is the seam that
 * broke: a second call site of an optional-dep function. This reads the source
 * for it, because the alternative is a mock of a dynamic DB import that proves
 * less and breaks more often.
 */
test("spec 0180: the gate-2 staging refresh passes the front deps", async () => {
  // Tests execute from `dist/`, so the SOURCE is one level out. Tried both, and
  // a miss is a loud failure rather than a silent skip — the first version of
  // this guard read `./activities.ts` from dist and failed ENOENT, which is not
  // a verdict about the code and must never be mistaken for one.
  const candidates = [
    new URL("../src/activities.ts", import.meta.url),
    new URL("./activities.ts", import.meta.url),
  ];
  let src = "";
  for (const url of candidates) {
    src = await readFile(url, "utf8").catch(() => "");
    if (src) break;
  }
  assert.ok(src, `could not read activities.ts from any of: ${candidates.map(String).join(", ")}`);
  const start = src.indexOf("async function deployStagingForBranchRun");
  assert.ok(start > 0, "the gate-2 refresh function moved — update this guard");
  // Bound the window to that function, so a match somewhere else in the file
  // cannot make this pass (the fake-that-proves-the-call trap, VERIFICATION #1).
  const end = src.indexOf("\n}", src.indexOf("deployBranchStagingStack", start));
  const body = src.slice(start, end);
  assert.match(body, /packCheckout:\s*deps\.packCheckout/, "the front's build context");
  assert.match(body, /deployFront:\s*deps\.deployFrontStack/, "the front deployer");
});

/**
 * Spec 0200 — a WIRING guard, and the reason it exists is that the last one of
 * these caught nothing: an optional parameter is silent at exactly the call site
 * that forgets it (docs/VERIFICATION.md #12). Every pipeline session that reads
 * a role file must pass `promptRoot`, or it runs with an empty role prompt in a
 * customer checkout, which is what happened on every A/B run to date.
 */
test("spec 0200: every role session passes promptRoot", async () => {
  const candidates = [
    new URL("../src/activities.ts", import.meta.url),
    new URL("./activities.ts", import.meta.url),
  ];
  let src = "";
  for (const url of candidates) {
    src = await readFile(url, "utf8").catch(() => "");
    if (src) break;
  }
  assert.ok(src, "could not read activities.ts");
  const roles = src.match(/role: "(spec-drafter|initializer|coder|fixer)",/g) ?? [];
  const wired = src.match(/role: "(spec-drafter|initializer|coder|fixer)",\s*\n\s*promptRoot:/g) ?? [];
  assert.equal(
    wired.length,
    roles.length,
    `${roles.length - wired.length} role session(s) do not pass promptRoot — they would run with an empty role prompt`,
  );
  assert.ok(roles.length >= 4, `expected at least 4 role sessions, found ${roles.length}`);
});
