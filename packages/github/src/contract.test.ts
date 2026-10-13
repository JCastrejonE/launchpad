import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubClient, latestStatusForContext, type FetchFn } from "./client.js";
import { interpretRepoAccess, isRepoUsable } from "./repo-access.js";
import { interpretCollaboratorPermission } from "./collaborator.js";
import { GithubApiError } from "./errors.js";
import { loadFixture } from "./fixtures.js";

// Contract tests (spec 0015): every method covered against checked-in JSON
// fixtures via an injected fetch — zero network, same discipline as
// fleet-hostinger/contract.test.ts.

/** A ready-made offline fetch stub. */
export function stubFetch(status: number, body: unknown): FetchFn {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

/** Like `stubFetch`, but records every request's method/url/body for assertions. */
function capturingFetch(
  status: number,
  body: unknown,
): { fetch: FetchFn; calls: () => Array<{ method: string; url: string; body?: string }> } {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls: () => calls };
}

/** Queues one response per call, in order — for methods that make multiple requests. */
function sequencedFetch(
  responses: Array<{ status: number; body: unknown }>,
): { fetch: FetchFn; calls: () => Array<{ method: string; url: string; body?: string }> } {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetch: FetchFn = async (url, init) => {
    const index = calls.length;
    calls.push({ method: init.method, url, body: init.body });
    const next = responses[Math.min(index, responses.length - 1)];
    if (!next) throw new Error("sequencedFetch: no response queued for this call");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls: () => calls };
}

test("GithubClient constructs with an injected fetch (no network)", () => {
  const client = new GithubClient({
    token: "t",
    owner: "acme",
    repo: "launchpad",
    fetch: stubFetch(200, {}),
  });
  assert.ok(client instanceof GithubClient);
});

test("openPr posts spec/NNNN -> base and returns number + html_url", async () => {
  const fixture = await loadFixture("open-pr");
  const { fetch, calls } = capturingFetch(200, fixture);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

  const result = await client.openPr({
    head: "spec/0016",
    base: "main",
    title: "spec/0016",
    body: "PR body",
  });

  assert.deepEqual(result, { number: 42, url: "https://github.com/example-org/launchpad/pull/42" });
  const [call] = calls();
  assert.equal(call?.method, "POST");
  assert.ok(call?.url.endsWith("/repos/acme/launchpad/pulls"));
  assert.deepEqual(call?.body ? JSON.parse(call.body) : undefined, {
    title: "spec/0016",
    head: "spec/0016",
    base: "main",
    body: "PR body",
  });
});

test("getPrState maps state/merged/mergeable + review decision (approved) + approver + checks (success)", async () => {
  const pull = await loadFixture("get-pull-open");
  const reviews = await loadFixture("reviews-approved");
  const actionsRuns = await loadFixture("actions-runs-success");
  const { fetch, calls } = sequencedFetch([
    { status: 200, body: pull },
    { status: 200, body: reviews },
    { status: 200, body: actionsRuns },
  ]);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

  const result = await client.getPrState(42);

  assert.deepEqual(result, {
    number: 42,
    state: "open",
    merged: false,
    mergeable: true,
    reviewDecision: "approved",
    checks: "success",
    approvedBy: "owner",
    mergedBy: null,
    mergeCommitSha: null,
  });

  const [pullCall, reviewsCall, checksCall] = calls();
  assert.ok(pullCall?.url.endsWith("/repos/acme/launchpad/pulls/42"));
  assert.ok(reviewsCall?.url.endsWith("/repos/acme/launchpad/pulls/42/reviews"));
  assert.ok(
    checksCall?.url.endsWith(
      "/repos/acme/launchpad/actions/runs?head_sha=a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    ),
  );
});

test("getPrState reduces a later CHANGES_REQUESTED over an earlier APPROVED, and pending checks", async () => {
  const pull = await loadFixture("get-pull-open");
  const reviews = await loadFixture("reviews-changes-requested");
  const actionsRuns = await loadFixture("actions-runs-pending");
  const { fetch } = sequencedFetch([
    { status: 200, body: pull },
    { status: 200, body: reviews },
    { status: 200, body: actionsRuns },
  ]);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

  const result = await client.getPrState(42);

  assert.equal(result.reviewDecision, "changes_requested");
  assert.equal(result.approvedBy, null);
  assert.equal(result.checks, "pending");
});

test("getPrState maps a failed Actions run to checks: failure (ADR-014 Actions-API source)", async () => {
  const pull = await loadFixture("get-pull-open");
  const actionsRuns = await loadFixture("actions-runs-failure");
  const { fetch } = sequencedFetch([
    { status: 200, body: pull },
    { status: 200, body: [] },
    { status: 200, body: actionsRuns },
  ]);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

  const result = await client.getPrState(42);

  assert.equal(result.checks, "failure");
});

test("getPrState treats zero workflow runs (Actions not reported yet) as pending", async () => {
  const pull = await loadFixture("get-pull-open");
  const { fetch } = sequencedFetch([
    { status: 200, body: pull },
    { status: 200, body: [] },
    { status: 200, body: { total_count: 0, workflow_runs: [] } },
  ]);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

  const result = await client.getPrState(42);

  assert.equal(result.checks, "pending");
});

test("getPrState distinguishes a closed (rejected) PR from a merged one", async () => {
  const pull = await loadFixture("close-pr");
  const { fetch } = sequencedFetch([
    { status: 200, body: pull },
    { status: 200, body: [] },
    { status: 200, body: { total_count: 0, workflow_runs: [] } },
  ]);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

  const result = await client.getPrState(42);

  assert.equal(result.state, "closed");
  assert.equal(result.merged, false);
  // null case (ADR-016 / spec 0019): merged_by absent from the payload -> null.
  assert.equal(result.mergedBy, null);
  // null case (spec 0043): merge_commit_sha absent from the payload -> null.
  assert.equal(result.mergeCommitSha, null);
});

test("getPrState parses mergedBy from merged_by.login on a merged PR (ADR-016 / spec 0019)", async () => {
  const pull = await loadFixture("get-pull-merged");
  const { fetch } = sequencedFetch([
    { status: 200, body: pull },
    { status: 200, body: [] },
    { status: 200, body: { total_count: 0, workflow_runs: [] } },
  ]);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

  const result = await client.getPrState(42);

  assert.equal(result.merged, true);
  assert.equal(result.mergedBy, "owner-gh");
  assert.equal(result.mergeCommitSha, "9f8e7d6c5b4a30201928374655463728190abcd");
});

test("getCommitChecksConclusion returns success/failure/pending from the actions/runs fixtures", async () => {
  for (const [fixtureName, expected] of [
    ["actions-runs-success", "success"],
    ["actions-runs-failure", "failure"],
    ["actions-runs-pending", "pending"],
  ] as const) {
    const actionsRuns = await loadFixture(fixtureName);
    const { fetch, calls } = capturingFetch(200, actionsRuns);
    const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

    const result = await client.getCommitChecksConclusion("9f8e7d6c5b4a30201928374655463728190abcd");

    assert.equal(result, expected);
    const [call] = calls();
    assert.ok(
      call?.url.endsWith(
        "/repos/acme/launchpad/actions/runs?head_sha=9f8e7d6c5b4a30201928374655463728190abcd",
      ),
    );
  }
});

test("getCommitChecksConclusion treats zero workflow runs as pending (honesty property, client.ts:239)", async () => {
  const { fetch } = capturingFetch(200, { total_count: 0, workflow_runs: [] });
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

  const result = await client.getCommitChecksConclusion("deadbeef");

  assert.equal(result, "pending");
});

test("mergePr merges with the merge-commit method", async () => {
  const fixture = await loadFixture("merge-pr");
  const { fetch, calls } = capturingFetch(200, fixture);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

  await client.mergePr(42);

  const [call] = calls();
  assert.equal(call?.method, "PUT");
  assert.ok(call?.url.endsWith("/repos/acme/launchpad/pulls/42/merge"));
  assert.deepEqual(call?.body ? JSON.parse(call.body) : undefined, { merge_method: "merge" });
});

test("mergePr throws when GitHub 200s but declines to merge", async () => {
  const fixture = await loadFixture("merge-pr-declined");
  const client = new GithubClient({
    token: "t",
    owner: "acme",
    repo: "launchpad",
    fetch: stubFetch(200, fixture),
  });

  await assert.rejects(client.mergePr(42), (err: unknown) => {
    assert.ok(err instanceof GithubApiError);
    assert.equal(err.retryable, false);
    return true;
  });
});

test("closePr patches the PR to state=closed", async () => {
  const fixture = await loadFixture("close-pr");
  const { fetch, calls } = capturingFetch(200, fixture);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

  await client.closePr(42);

  const [call] = calls();
  assert.equal(call?.method, "PATCH");
  assert.ok(call?.url.endsWith("/repos/acme/launchpad/pulls/42"));
  assert.deepEqual(call?.body ? JSON.parse(call.body) : undefined, { state: "closed" });
});

// Resilience: retry/backoff behavior, same contract as the Hostinger client.
type PrivateRequest = { request: (m: string, p: string) => Promise<unknown> };

function countingFetch(status: number, body: unknown): { fetch: FetchFn; callCount: () => number } {
  let calls = 0;
  const fetch: FetchFn = async () => {
    calls++;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, callCount: () => calls };
}

test("429 is retried up to maxRetries then surfaces as retryable", async () => {
  const { fetch, callCount } = countingFetch(429, { message: "slow down" });
  const client = new GithubClient({
    token: "t",
    owner: "acme",
    repo: "launchpad",
    fetch,
    maxRetries: 2,
    retryBaseDelayMs: 1,
  });

  await assert.rejects(
    (client as unknown as PrivateRequest).request("GET", "/repos/acme/launchpad/pulls/1"),
    (err: unknown) => {
      assert.ok(err instanceof GithubApiError);
      assert.equal(err.kind, "rate_limited");
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(callCount(), 3);
});

test("5xx is retried; 4xx (401/404) is NOT retried and is fatal", async () => {
  const serverError = countingFetch(503, { message: "unavailable" });
  const serverClient = new GithubClient({
    token: "t",
    owner: "acme",
    repo: "launchpad",
    fetch: serverError.fetch,
    maxRetries: 2,
    retryBaseDelayMs: 1,
  });
  await assert.rejects(
    (serverClient as unknown as PrivateRequest).request("GET", "/repos/acme/launchpad/pulls/1"),
    (err: unknown) => {
      assert.ok(err instanceof GithubApiError);
      assert.equal(err.kind, "server");
      assert.equal(err.retryable, true);
      return true;
    },
  );
  assert.equal(serverError.callCount(), 3);

  const notFound = countingFetch(404, { message: "not found" });
  const notFoundClient = new GithubClient({
    token: "t",
    owner: "acme",
    repo: "launchpad",
    fetch: notFound.fetch,
    maxRetries: 2,
    retryBaseDelayMs: 1,
  });
  await assert.rejects(
    (notFoundClient as unknown as PrivateRequest).request("GET", "/repos/acme/launchpad/pulls/1"),
    (err: unknown) => {
      assert.ok(err instanceof GithubApiError);
      assert.equal(err.kind, "not_found");
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(notFound.callCount(), 1);
});

test("a request timeout surfaces as a retryable GithubApiError", async () => {
  const timeoutFetch: FetchFn = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  const client = new GithubClient({
    token: "t",
    owner: "acme",
    repo: "launchpad",
    fetch: timeoutFetch,
    timeoutMs: 5,
    maxRetries: 1,
    retryBaseDelayMs: 1,
  });

  await assert.rejects(
    (client as unknown as PrivateRequest).request("GET", "/repos/acme/launchpad/pulls/1"),
    (err: unknown) => {
      assert.ok(err instanceof GithubApiError);
      assert.equal(err.kind, "timeout");
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

// Acceptance criteria: GITHUB_TOKEN never appears in a thrown message, and
// never appears in any checked-in fixture.
test("the GITHUB_TOKEN never appears in a thrown error message or any fixture", async () => {
  const secretToken = "github-secret-abc123";
  const client = new GithubClient({
    token: secretToken,
    owner: "acme",
    repo: "launchpad",
    fetch: stubFetch(401, { message: "Bad credentials" }),
  });

  await assert.rejects(
    (client as unknown as PrivateRequest).request("GET", "/repos/acme/launchpad/pulls/1"),
    (err: unknown) => {
      assert.ok(err instanceof GithubApiError);
      assert.equal(err.kind, "auth");
      assert.equal(err.retryable, false);
      assert.ok(!err.message.includes(secretToken));
      assert.ok(!JSON.stringify(err).includes(secretToken));
      return true;
    },
  );

  const fixtureNames = [
    "open-pr",
    "get-pull-open",
    "get-pull-merged",
    "reviews-approved",
    "reviews-changes-requested",
    "actions-runs-success",
    "actions-runs-pending",
    "actions-runs-failure",
    "merge-pr",
    "merge-pr-declined",
    "close-pr",
    // spec 0115 — odoo.sh reports through the Status API, not Actions.
    "commit-statuses-odoosh-success",
    "commit-statuses-odoosh-pending",
    "commit-statuses-odoosh-failure",
    "commit-statuses-no-odoosh",
  ];
  for (const name of fixtureNames) {
    const raw = JSON.stringify(await loadFixture(name));
    assert.ok(!raw.toLowerCase().includes("token"), `${name}.json must not mention a token`);
    assert.ok(!raw.includes(secretToken), `${name}.json must not contain the secret token`);
  }
});

// ---------------------------------------------------------------------------
// Spec 0115 — commit statuses. odoo.sh is an external reporter, so it publishes
// through the Status API rather than Actions; `getCommitChecksConclusion` cannot
// see it at all and would report "pending" forever on a working repo.
// ---------------------------------------------------------------------------

test("getCommitStatuses hits the statuses endpoint for the SHA, not actions/runs", async () => {
  const { fetch, calls } = capturingFetch(200, await loadFixture("commit-statuses-odoosh-pending"));
  const client = new GithubClient({ token: "t", owner: "acme", repo: "erp", fetch });
  await client.getCommitStatuses("abc123");
  assert.equal(calls().length, 1);
  assert.match(calls()[0]!.url, /repos\/acme\/erp\/commits\/abc123\/statuses$/);
  assert.equal(calls()[0]!.method, "GET");
});

test("getCommitStatuses maps target_url and description into the domain shape", async () => {
  const fetch = stubFetch(200, await loadFixture("commit-statuses-odoosh-failure"));
  const client = new GithubClient({ token: "t", owner: "acme", repo: "erp", fetch });
  const [status] = await client.getCommitStatuses("abc123");
  assert.equal(status?.state, "failure");
  assert.equal(status?.context, "ci/odoo.sh");
  assert.equal(status?.description, "Build failed: module install error");
  assert.equal(status?.targetUrl, "https://acme.odoo.com/paas#/build/1236");
});

test("getCommitStatuses on a commit with no statuses yields an empty list, not an error", async () => {
  const fetch = stubFetch(200, []);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "erp", fetch });
  assert.deepEqual(await client.getCommitStatuses("abc123"), []);
});

test("latestStatusForContext takes the NEWEST entry — a pending→success commit has both", async () => {
  // The API returns newest-first; the success fixture carries the earlier pending
  // entry too, which is exactly the shape that makes "just find the context" wrong
  // if the order is ignored.
  const fetch = stubFetch(200, await loadFixture("commit-statuses-odoosh-success"));
  const client = new GithubClient({ token: "t", owner: "acme", repo: "erp", fetch });
  const statuses = await client.getCommitStatuses("abc123");
  assert.equal(statuses.length, 2, "fixture should contain both entries");
  assert.equal(latestStatusForContext(statuses, "ci/odoo.sh")?.state, "success");
});

test("latestStatusForContext returns null when that context never reported", async () => {
  // Null, not a fabricated pending: the commit HAS statuses, just not odoo.sh's.
  const fetch = stubFetch(200, await loadFixture("commit-statuses-no-odoosh"));
  const client = new GithubClient({ token: "t", owner: "acme", repo: "erp", fetch });
  const statuses = await client.getCommitStatuses("abc123");
  assert.equal(statuses.length, 1);
  assert.equal(latestStatusForContext(statuses, "ci/odoo.sh"), null);
});

// ---------------------------------------------------------------------------
// Spec 0126 B: linking a project VERIFIES the repo. These assert the API's
// RESPONSE, not the request we sent (docs/VERIFICATION.md #1).
// ---------------------------------------------------------------------------

const PUSHABLE = {
  full_name: "example-org/launchpad",
  private: true,
  archived: false,
  default_branch: "main",
  permissions: { admin: true, maintain: true, push: true, pull: true },
};

test("getRepoAccess: a pushable repo is usable, and reports GitHub's own casing", async () => {
  const { fetch, calls } = capturingFetch(200, PUSHABLE);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });
  const access = await client.getRepoAccess("example-org", "launchpad");

  assert.equal(access.exists, true);
  assert.equal(access.pushable, true);
  assert.equal(access.problem, null);
  assert.equal(isRepoUsable(access), true);
  assert.equal(access.fullName, "example-org/launchpad");
  assert.equal(access.defaultBranch, "main");
  assert.equal(access.private, true);
  // The path uses the ARGUMENTS, not the client's configured owner/repo — the
  // whole point is asking about a repo this launchpad does not own.
  assert.match(calls()[0]?.url ?? "", /\/repos\/example-org\/launchpad$/);
  assert.equal(calls()[0]?.method, "GET");
});

// A 404 is an answer. GitHub 404s a private repo the token cannot see rather
// than admitting it exists, and "I cannot use this repo" is what was asked.
test("getRepoAccess: 404 returns absent instead of throwing", async () => {
  const client = new GithubClient({
    token: "t",
    owner: "acme",
    repo: "launchpad",
    fetch: stubFetch(404, { message: "Not Found" }),
  });
  const access = await client.getRepoAccess("example-org", "does-not-exist");
  assert.equal(access.exists, false);
  assert.equal(isRepoUsable(access), false);
  assert.match(access.problem ?? "", /no tiene acceso|No existe/);
});

// But only 404. A rate limit or a network blip must never be reported to a user
// as "that repo does not exist" — that would turn a transient failure into a
// wrong permanent answer.
test("getRepoAccess: a non-404 failure still throws", async () => {
  const client = new GithubClient({
    token: "t",
    owner: "acme",
    repo: "launchpad",
    fetch: stubFetch(401, { message: "Bad credentials" }),
    maxRetries: 0,
  });
  await assert.rejects(() => client.getRepoAccess("example-org", "launchpad"), /GithubApiError|credential|401|auth/i);
});

// The ordering that matters: GitHub keeps reporting push:true on an ARCHIVED
// repo while refusing every write, so a permissions-only check would call it
// linkable and then fail on the first push.
test("interpretRepoAccess: archived beats push:true", () => {
  const access = interpretRepoAccess({ ...PUSHABLE, archived: true });
  assert.equal(access.exists, true);
  assert.equal(access.archived, true);
  assert.equal(access.pushable, false, "archived is not pushable, whatever permissions say");
  assert.equal(isRepoUsable(access), false);
  assert.match(access.problem ?? "", /archivado/);
});

test("interpretRepoAccess: read-only access is refused with a specific reason", () => {
  const access = interpretRepoAccess({
    ...PUSHABLE,
    permissions: { admin: false, maintain: false, push: false, pull: true },
  });
  assert.equal(access.exists, true);
  assert.equal(access.pushable, false);
  assert.equal(isRepoUsable(access), false);
  assert.match(access.problem ?? "", /push/);
});

test("interpretRepoAccess: a payload missing permissions is NOT assumed pushable", () => {
  const access = interpretRepoAccess({ full_name: "a/b", default_branch: "main" });
  assert.equal(access.exists, true);
  assert.equal(access.pushable, false, "absent permissions must fail closed");
  assert.equal(isRepoUsable(access), false);
});

// ---------------------------------------------------------------------------
// Spec 0128 C: a specific PERSON's permission, asked with the server token so
// user tokens never need the `repo` scope.
// ---------------------------------------------------------------------------

test("getCollaboratorPermission: write levels can push", async () => {
  for (const level of ["admin", "maintain", "write"]) {
    const client = new GithubClient({
      token: "t", owner: "o", repo: "r",
      fetch: stubFetch(200, { permission: "write", role_name: level }),
    });
    const access = await client.getCollaboratorPermission("example-org", "launchpad", "owner-gh");
    assert.equal(access.reachable, true, level);
    assert.equal(access.canWrite, true, level);
    assert.equal(access.problem, null, level);
  }
});

// `triage` can manage issues and PRs but not write code. Treating it as write
// would let someone start a run that cannot possibly land.
test("getCollaboratorPermission: read and triage cannot push, and say so", async () => {
  for (const level of ["read", "triage", "none"]) {
    const client = new GithubClient({
      token: "t", owner: "o", repo: "r",
      fetch: stubFetch(200, { permission: "read", role_name: level }),
    });
    const access = await client.getCollaboratorPermission("example-org", "launchpad", "someone");
    assert.equal(access.canWrite, false, level);
    assert.match(access.problem ?? "", /Solicita acceso a los dueños del repo/, level);
    assert.match(access.problem ?? "", /someone/, "names whose access is the problem");
  }
});

// "We could not check" must never be reported as "you do not have access" — that
// would send someone to argue with a repo owner about a problem that is ours.
test("getCollaboratorPermission: 404 is UNKNOWN, not a denial", async () => {
  const client = new GithubClient({
    token: "t", owner: "o", repo: "r",
    fetch: stubFetch(404, { message: "Not Found" }),
  });
  const access = await client.getCollaboratorPermission("example-org", "nope", "owner-gh");
  assert.equal(access.reachable, false);
  assert.equal(access.canWrite, false);
  assert.match(access.problem ?? "", /no lo alcanzamos desde el servidor/);
});

test("interpretCollaboratorPermission: an unrecognised level fails closed", () => {
  const access = interpretCollaboratorPermission({ role_name: "brand_new_role" }, "u");
  assert.equal(access.permission, "none");
  assert.equal(access.canWrite, false);
});

test("interpretCollaboratorPermission: role_name wins over the flattened permission", () => {
  // GitHub's `permission` flattens maintain->write and triage->read; role_name is
  // the precise one, and triage must not be read as write.
  const access = interpretCollaboratorPermission({ permission: "write", role_name: "triage" }, "u");
  assert.equal(access.canWrite, false);
});

// --- Spec 0133: branch refs + one-PR-per-branch primitives ------------------

test("getBranchHeadSha returns the SHA and encodes segments individually", async () => {
  const { fetch, calls } = capturingFetch(200, { object: { sha: "abc123" } });
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });
  const sha = await client.getBranchHeadSha("feature/pos-fixes");
  assert.equal(sha, "abc123");
  const [call] = calls();
  // The branch's own `/` survives as path structure; each segment is encoded.
  assert.ok(call?.url.endsWith("/repos/acme/launchpad/git/ref/heads/feature/pos-fixes"));
});

test("getBranchHeadSha: a 404 is an answer (null), never a throw", async () => {
  const client = new GithubClient({
    token: "t", owner: "acme", repo: "launchpad",
    fetch: stubFetch(404, { message: "Not Found" }),
  });
  assert.equal(await client.getBranchHeadSha("nope"), null);
});

test("getBranchHeadSha: a 500 still throws — an outage is not 'no branch'", async () => {
  const client = new GithubClient({
    token: "t", owner: "acme", repo: "launchpad", maxRetries: 0,
    fetch: stubFetch(500, { message: "boom" }),
  });
  await assert.rejects(() => client.getBranchHeadSha("b"), GithubApiError);
});

test("createBranchRef posts refs/heads/<name> at the SHA", async () => {
  const { fetch, calls } = capturingFetch(201, { ref: "refs/heads/b", object: { sha: "abc" } });
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });
  await client.createBranchRef("tester/pos", "abc");
  const [call] = calls();
  assert.equal(call?.method, "POST");
  assert.ok(call?.url.endsWith("/repos/acme/launchpad/git/refs"));
  assert.deepEqual(call?.body ? JSON.parse(call.body) : undefined, {
    ref: "refs/heads/tester/pos",
    sha: "abc",
  });
});

test("createBranchRef adopts a 422 'Reference already exists' as success", async () => {
  const client = new GithubClient({
    token: "t", owner: "acme", repo: "launchpad",
    fetch: stubFetch(422, { message: "Reference already exists" }),
  });
  await client.createBranchRef("b", "abc"); // must not throw
});

test("createBranchRef: any OTHER 422 still throws — an invalid SHA is not 'already exists'", async () => {
  const client = new GithubClient({
    token: "t", owner: "acme", repo: "launchpad",
    fetch: stubFetch(422, { message: "Object does not exist" }),
  });
  await assert.rejects(() => client.createBranchRef("b", "bogus"), GithubApiError);
});

test("findOpenPrByHead filters with the MANDATORY owner: prefix and returns the first match", async () => {
  const { fetch, calls } = capturingFetch(200, [
    { number: 7, html_url: "https://github.com/acme/launchpad/pull/7" },
  ]);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });
  const pr = await client.findOpenPrByHead("feature/pos", "main");
  assert.deepEqual(pr, { number: 7, url: "https://github.com/acme/launchpad/pull/7" });
  const [call] = calls();
  // Without `owner:` GitHub silently ignores the filter and returns EVERY open
  // PR — the caller would adopt an unrelated one.
  assert.ok(call?.url.includes(`head=${encodeURIComponent("acme:feature/pos")}`));
  assert.ok(call?.url.includes("state=open"));
  assert.ok(call?.url.includes("base=main"));
});

test("findOpenPrByHead: an empty list is null, not an error", async () => {
  const client = new GithubClient({
    token: "t", owner: "acme", repo: "launchpad", fetch: stubFetch(200, []),
  });
  assert.equal(await client.findOpenPrByHead("b", "main"), null);
});

test("commentOnPr posts to the issues comments endpoint", async () => {
  const { fetch, calls } = capturingFetch(201, { id: 1 });
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });
  await client.commentOnPr(7, "spec 0142: resumen del run");
  const [call] = calls();
  assert.equal(call?.method, "POST");
  assert.ok(call?.url.endsWith("/repos/acme/launchpad/issues/7/comments"));
  assert.deepEqual(call?.body ? JSON.parse(call.body) : undefined, {
    body: "spec 0142: resumen del run",
  });
});
