import test from "node:test";
import assert from "node:assert/strict";
import { resolveRunRepoRoot, type ProjectRepoFacts } from "./run-repo";

const FALLBACK = "/srv/launchpad/repo";
const project = (over: Partial<ProjectRepoFacts> = {}): ProjectRepoFacts => ({
  slug: "client-c",
  repoRoot: null,
  repoOwner: null,
  repoName: null,
  ...over,
});

test("a project with its own checkout uses it, not the launchpad's", () => {
  const res = resolveRunRepoRoot(project({ repoRoot: "/srv/checkouts/client-c" }), FALLBACK);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.root, "/srv/checkouts/client-c");
  assert.equal(res.fromFallback, false);
});

// The platform/dogfood case: a spec whose project has no repo of its own IS this
// repo, so the fallback is the right answer, not a compromise.
test("no project row falls back to the launchpad checkout", () => {
  const res = resolveRunRepoRoot(null, FALLBACK);
  assert.equal(res.ok && res.root, FALLBACK);
  assert.equal(res.ok && res.fromFallback, true);
});

test("a project with neither a checkout nor a linked repo falls back", () => {
  const res = resolveRunRepoRoot(project(), FALLBACK);
  assert.equal(res.ok && res.root, FALLBACK);
  assert.equal(res.ok && res.fromFallback, true);
});

// THE case this file exists for, and its answer changed with spec 0129 B.
//
// 0126 D REFUSED here, because falling back to the launchpad's own checkout would
// produce commits in the wrong repository. B removes the need to refuse: the path
// is derived from the slug and the run's first activity clones it. What must still
// hold — and is what the original bug was about — is that the answer is NOT the
// launchpad's checkout.
test("a linked repo with no local checkout resolves to its OWN derived path", () => {
  const res = resolveRunRepoRoot(project({ repoOwner: "example-org", repoName: "client-c" }), FALLBACK);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.notEqual(res.root, FALLBACK, "must never be the launchpad's own checkout");
  assert.match(res.root, /client-c$/, "derived from the slug");
  assert.equal(res.fromFallback, false);
});

test("a linked repo WITH a checkout is fine — that is the fully-configured project", () => {
  const res = resolveRunRepoRoot(
    project({ repoOwner: "example-org", repoName: "client-c", repoRoot: "/srv/checkouts/client-c" }),
    FALLBACK,
  );
  assert.equal(res.ok && res.root, "/srv/checkouts/client-c");
  assert.equal(res.ok && res.fromFallback, false);
});

test("half a GitHub identity does not trigger the refusal", () => {
  // repoIdentityFor only reports coordinates when BOTH halves exist, so an owner
  // with no name is "no repo linked" and the fallback is correct.
  const owner = resolveRunRepoRoot(project({ repoOwner: "example-org" }), FALLBACK);
  assert.equal(owner.ok && owner.root, FALLBACK);
  const name = resolveRunRepoRoot(project({ repoName: "client-c" }), FALLBACK);
  assert.equal(name.ok && name.root, FALLBACK);
});

test("no fallback and no project checkout is an error, never an empty path", () => {
  for (const fb of [undefined, "", "   "]) {
    assert.equal(resolveRunRepoRoot(null, fb).ok, false, JSON.stringify(fb));
    assert.equal(resolveRunRepoRoot(project(), fb).ok, false, JSON.stringify(fb));
  }
});

test("whitespace-only repoRoot is not a checkout", () => {
  const res = resolveRunRepoRoot(project({ repoRoot: "   " }), FALLBACK);
  assert.equal(res.ok && res.root, FALLBACK, "falls back rather than using a blank path");
  assert.equal(res.ok && res.fromFallback, true);
});
