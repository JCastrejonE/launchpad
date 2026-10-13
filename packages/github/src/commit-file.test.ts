import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubClient, type FetchFn } from "./client.js";
import { GithubApiError } from "./errors.js";

// Spec 0148 phase E. `commitFileToRepo` PUTs to
// `/repos/{owner}/{repo}/contents/{path}` and maps GitHub's RESPONSE into
// `CommittedFile` (VERIFICATION #1: assert the commit the API returned, not the
// payload we sent).

/** Offline fetch that records each request and returns a fixed response. */
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

test("commitFileToRepo maps the response commit, not the request", async () => {
  // commit.sha / commit.html_url are the API's, absent from our payload, so an
  // assertion of them can only pass by reading the response.
  const responseBody = {
    content: { path: "public/logo.png" },
    commit: {
      sha: "7638417db6d59f3c431d3e1f261cc637155684cd",
      html_url: "https://github.com/example-org/acme-front/commit/7638417db6d59f3c431d3e1f261cc637155684cd",
    },
  };
  const { fetch, calls } = capturingFetch(201, responseBody);
  const client = new GithubClient({ token: "t", owner: "launchpad-owner", repo: "launchpad", fetch });

  const result = await client.commitFileToRepo({
    owner: "example-org",
    name: "acme-front",
    path: "public/logo.png",
    contentBase64: "aGVsbG8=",
    message: "chore: add brand logo",
  });

  assert.deepEqual(result, {
    commitSha: "7638417db6d59f3c431d3e1f261cc637155684cd",
    commitUrl: "https://github.com/example-org/acme-front/commit/7638417db6d59f3c431d3e1f261cc637155684cd",
  });

  const [call] = calls();
  assert.equal(call?.method, "PUT");
  // Targets the ARBITRARY repo (owner/name from the request), not this.cfg.
  assert.ok(call?.url.endsWith("/repos/example-org/acme-front/contents/public/logo.png"));
  assert.deepEqual(call?.body ? JSON.parse(call.body) : undefined, {
    message: "chore: add brand logo",
    content: "aGVsbG8=",
  });
});

test("commitFileToRepo sends the branch only when given", async () => {
  const { fetch, calls } = capturingFetch(201, { content: { path: "logo.png" }, commit: { sha: "abc" } });
  const client = new GithubClient({ token: "t", owner: "o", repo: "r", fetch });

  await client.commitFileToRepo({
    owner: "example-org",
    name: "acme-front",
    path: "logo.png",
    contentBase64: "aGVsbG8=",
    message: "add logo",
    branch: "provision",
  });

  const [call] = calls();
  assert.deepEqual(call?.body ? JSON.parse(call.body) : undefined, {
    message: "add logo",
    content: "aGVsbG8=",
    branch: "provision",
  });
});

test("commitFileToRepo surfaces a 422 (missing sha on update) as a client error", async () => {
  // Updating an existing path without its blob sha is a 422. It must surface,
  // not be swallowed — a re-upload is out of phase E's scope, and a check that
  // cannot fail is worthless (VERIFICATION #2).
  const { fetch } = capturingFetch(422, {
    message: "logo.png does not match ffffff",
  });
  const client = new GithubClient({ token: "t", owner: "o", repo: "r", fetch });

  await assert.rejects(
    () =>
      client.commitFileToRepo({
        owner: "example-org",
        name: "acme-front",
        path: "logo.png",
        contentBase64: "aGVsbG8=",
        message: "add logo",
      }),
    (err: unknown) => err instanceof GithubApiError && err.status === 422 && err.retryable === false,
  );
});
