import { test } from "node:test";
import assert from "node:assert/strict";
import { repoIdentityFor, githubSlugFor } from "./repo-identity.js";

const platform = { slug: "platform" };
const customer = {
  slug: "acme-erp",
  repoOwner: "acme",
  repoName: "erp",
  repoRoot: "/srv/checkouts/acme-erp",
};

test("a project with its own repo uses it, not the env fallback", () => {
  const id = repoIdentityFor(customer, "/srv/launchpad");
  assert.equal(id?.root, "/srv/checkouts/acme-erp");
  assert.equal(id?.fromFallback, false);
  assert.equal(githubSlugFor(id), "acme/erp");
});

test("two projects resolve to DIFFERENT repos — the whole point of v0", () => {
  const a = repoIdentityFor(customer, "/srv/launchpad");
  const b = repoIdentityFor(
    { slug: "acme-site", repoOwner: "acme", repoName: "site", repoRoot: "/srv/checkouts/acme-site" },
    "/srv/launchpad",
  );
  assert.notEqual(a?.root, b?.root);
  assert.notEqual(githubSlugFor(a), githubSlugFor(b));
});

test("a project with no repo columns falls back to LAUNCHPAD_REPO_ROOT", () => {
  // This is not a migration shim: the platform project's repo genuinely IS the env
  // root — it is this repo, dogfooding itself — so the fallback is permanently correct
  // for it, and every pre-0116 project keeps working unchanged.
  const id = repoIdentityFor(platform, "/srv/launchpad");
  assert.equal(id?.root, "/srv/launchpad");
  assert.equal(id?.fromFallback, true);
  assert.equal(githubSlugFor(id), undefined, "no GitHub coordinates without them stored");
});

test("no row value and no fallback yields null, not a guessed path", () => {
  assert.equal(repoIdentityFor(platform, undefined), null);
  assert.equal(repoIdentityFor(platform, "   "), null, "whitespace is not a path");
});

test("half an identity is treated as none — an owner without a name cannot address a repo", () => {
  const half = repoIdentityFor({ slug: "x", repoOwner: "acme", repoRoot: "/srv/x" }, undefined);
  assert.equal(half?.root, "/srv/x", "the checkout is still usable for local-diff mode");
  assert.equal(half?.owner, undefined);
  assert.equal(githubSlugFor(half), undefined, "must not read as configured");
});

test("blank strings are treated as absent, not as values", () => {
  const id = repoIdentityFor(
    { slug: "x", repoOwner: "  ", repoName: "", repoRoot: "  " },
    "/srv/launchpad",
  );
  assert.equal(id?.root, "/srv/launchpad");
  assert.equal(id?.fromFallback, true);
  assert.equal(githubSlugFor(id), undefined);
});
