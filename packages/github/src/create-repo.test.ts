import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubClient, type FetchFn } from "./client.js";
import { GithubApiError } from "./errors.js";

// Spec 0148 phase A. `createRepoInOrg` posts to `POST /orgs/{org}/repos` and
// maps GitHub's RESPONSE body into `CreatedRepo` (VERIFICATION #1: assert what
// the API returned, not the payload we sent).

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

test("createRepoInOrg maps the API response (fullName/cloneUrl), not the request", async () => {
  // The response's full_name deliberately DIFFERS from the requested name, so an
  // assertion of `fullName` can only pass if the mapping reads the response.
  const responseBody = {
    id: 987654321,
    full_name: "example-org/acme-front",
    html_url: "https://github.com/example-org/acme-front",
    clone_url: "https://github.com/example-org/acme-front.git",
    ssh_url: "git@github.com:example-org/acme-front.git",
    private: true,
    default_branch: "main",
  };
  const { fetch, calls } = capturingFetch(201, responseBody);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

  const result = await client.createRepoInOrg({
    org: "example-org",
    name: "a-name-that-is-not-echoed-back",
    private: true,
  });

  assert.deepEqual(result, {
    id: 987654321,
    fullName: "example-org/acme-front",
    htmlUrl: "https://github.com/example-org/acme-front",
    cloneUrl: "https://github.com/example-org/acme-front.git",
    sshUrl: "git@github.com:example-org/acme-front.git",
    private: true,
    defaultBranch: "main",
  });

  const [call] = calls();
  assert.equal(call?.method, "POST");
  assert.ok(call?.url.endsWith("/orgs/example-org/repos"));
  assert.deepEqual(call?.body ? JSON.parse(call.body) : undefined, {
    name: "a-name-that-is-not-echoed-back",
    private: true,
  });
});

test("createRepoInOrg reports a name collision as a distinct error", async () => {
  // GitHub's real collision body: generic top-level message, the truth in errors[].
  const collisionBody = {
    message: "Repository creation failed.",
    errors: [
      {
        resource: "Repository",
        code: "custom",
        field: "name",
        message: "name already exists on this account",
      },
    ],
  };
  const { fetch } = capturingFetch(422, collisionBody);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

  await assert.rejects(
    () => client.createRepoInOrg({ org: "example-org", name: "murrsaecommerce", private: true }),
    (err: unknown) => err instanceof GithubApiError && err.kind === "name_taken" && err.retryable === false,
  );
});

test("createRepoInOrg does NOT treat a body-validation 422 as a collision", async () => {
  // A blank name is a 422 too, but its errors[] carries no "already exists" —
  // it must stay a plain client error so the wizard doesn't report "taken".
  const validationBody = {
    message: "Repository creation failed.",
    errors: [{ resource: "Repository", code: "missing_field", field: "name" }],
  };
  const { fetch } = capturingFetch(422, validationBody);
  const client = new GithubClient({ token: "t", owner: "acme", repo: "launchpad", fetch });

  await assert.rejects(
    () => client.createRepoInOrg({ org: "example-org", name: "", private: true }),
    (err: unknown) => err instanceof GithubApiError && err.kind !== "name_taken",
  );
});
