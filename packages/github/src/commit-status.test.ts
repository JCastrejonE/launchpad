import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubClient, type FetchFn } from "./client.js";
import { GithubApiError } from "./errors.js";

// Spec 0228 A. `createCommitStatus` POSTs to /repos/{owner}/{repo}/statuses/{sha}.
//
// What these tests CAN prove, said plainly because VERIFICATION #1 is about
// exactly this: a fake proves the call you made, not the contract the world
// imposes. The contract here was proven LIVE on 2026-08-19 — POST returned 201
// and the status was read back off the commit with a JSON parser — so these
// pin the parts that live evidence did NOT exercise: the 140-character
// truncation, the URL shape, and the permission error's identity.

function capturingFetch(status: number, body: unknown) {
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

const client = (fetch: FetchFn) =>
  new GithubClient({ token: "t", owner: "example-org", repo: "launchpad", fetch });

test("posts to the statuses endpoint for that sha", async () => {
  const { fetch, calls } = capturingFetch(201, { id: 1 });
  await client(fetch).createCommitStatus({
    sha: "3e1bfac8c5b3a2cf2c08266fa90fc0c62644b9a3",
    state: "success",
    context: "ci/launchpad",
  });
  const [c] = calls();
  assert.equal(c?.method, "POST");
  assert.match(c?.url ?? "", /\/repos\/example-org\/launchpad\/statuses\/3e1bfac8/);
});

test("a long description is truncated, not rejected", async () => {
  // GitHub caps description at 140 and errors past it. A red gate must stay
  // reportable when the failing step's name is long: losing the tail of a
  // sentence beats losing the status entirely.
  const { fetch, calls } = capturingFetch(201, { id: 1 });
  await client(fetch).createCommitStatus({
    sha: "abc123",
    state: "failure",
    context: "ci/launchpad",
    description: "x".repeat(400),
  });
  const sent = JSON.parse(calls()[0]?.body ?? "{}") as { description: string };
  assert.equal(sent.description.length, 140);
});

test("a 403 surfaces as an error rather than a silent no-op", async () => {
  // The real one, and it is not a billing failure however much it looks like
  // one: "Resource not accessible by personal access token" means the token
  // lacks `statuses: write`. A publisher that swallowed this would report CI
  // green while posting nothing.
  const { fetch } = capturingFetch(403, {
    message: "Resource not accessible by personal access token",
  });
  await assert.rejects(
    () => client(fetch).createCommitStatus({ sha: "abc123", state: "success", context: "ci/launchpad" }),
    (err: unknown) => err instanceof GithubApiError,
  );
});
