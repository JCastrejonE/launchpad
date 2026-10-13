import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePrMode, parseGithubOrigin } from "./github-config.js";

// Spec 0015 item 3: PR-mode resolution and GitHub origin parsing.

test("resolvePrMode falls back to local-diff when no token is configured", () => {
  assert.deepEqual(resolvePrMode({ originUrl: "git@github.com:acme/launchpad.git" }), {
    mode: "local",
  });
});

test("resolvePrMode falls back to local-diff when no origin is configured", () => {
  assert.deepEqual(resolvePrMode({ token: "ghp_x", originUrl: null }), { mode: "local" });
});

test("resolvePrMode returns github mode with owner/repo/token when both are present", () => {
  assert.deepEqual(
    resolvePrMode({ token: "ghp_x", originUrl: "git@github.com:acme/launchpad.git" }),
    { mode: "github", config: { token: "ghp_x", owner: "acme", repo: "launchpad" } },
  );
});

test("resolvePrMode falls back to local-diff when the origin isn't GitHub", () => {
  assert.deepEqual(
    resolvePrMode({ token: "ghp_x", originUrl: "git@gitlab.com:acme/launchpad.git" }),
    { mode: "local" },
  );
});

test("parseGithubOrigin handles https and ssh GitHub remote URL forms", () => {
  assert.deepEqual(parseGithubOrigin("https://github.com/acme/launchpad"), {
    owner: "acme",
    repo: "launchpad",
  });
  assert.deepEqual(parseGithubOrigin("https://github.com/acme/launchpad.git"), {
    owner: "acme",
    repo: "launchpad",
  });
  assert.deepEqual(parseGithubOrigin("git@github.com:acme/launchpad.git"), {
    owner: "acme",
    repo: "launchpad",
  });
  assert.deepEqual(parseGithubOrigin("git@github.com:acme/launchpad"), {
    owner: "acme",
    repo: "launchpad",
  });
});

test("parseGithubOrigin returns null for non-GitHub or unparseable remotes", () => {
  assert.equal(parseGithubOrigin("git@gitlab.com:acme/launchpad.git"), null);
  assert.equal(parseGithubOrigin("https://example.com/acme/launchpad"), null);
  assert.equal(parseGithubOrigin("not a url"), null);
});
