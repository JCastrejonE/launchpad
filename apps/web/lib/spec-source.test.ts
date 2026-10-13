import { test } from "node:test";
import assert from "node:assert/strict";
import {
  worktreeDir,
  worktreeSpecsDir,
  resolveSpecReadDir,
  specsDirForProject,
} from "./spec-source.js";

test("worktreeDir / worktreeSpecsDir build the per-run paths under the primary root", () => {
  assert.equal(worktreeDir("0017", "/repo"), "/repo/.worktrees/spec-0017");
  assert.equal(worktreeSpecsDir("0017", "/repo"), "/repo/.worktrees/spec-0017/specs");
});

test("resolveSpecReadDir prefers the worktree specs dir when the worktree exists", () => {
  const dir = resolveSpecReadDir({
    specId: "0017",
    worktreeExists: true,
    primarySpecsDir: "/repo/specs",
    worktreeSpecsDir: "/repo/.worktrees/spec-0017/specs",
  });
  assert.equal(dir, "/repo/.worktrees/spec-0017/specs");
});

test("resolveSpecReadDir falls back to the primary specs dir when no worktree", () => {
  const dir = resolveSpecReadDir({
    specId: "0017",
    worktreeExists: false,
    primarySpecsDir: "/repo/specs",
    worktreeSpecsDir: "/repo/.worktrees/spec-0017/specs",
  });
  assert.equal(dir, "/repo/specs");
});

/**
 * Spec 0149 — the ONE spec page and the Complete action must resolve a spec's
 * directory identically, so this is the single function both call. The bug it
 * guards against is concrete: an earlier draft assumed `<specsRoot>/<slug>/specs`
 * and would have written a project's status into a directory that does not exist.
 */
test("specsDirForProject: the platform reads this repo's committed specs", () => {
  assert.equal(
    specsDirForProject("platform", { LAUNCHPAD_REPO_ROOT: "/srv/launchpad/repo" }),
    "/srv/launchpad/repo/specs",
  );
});

test("specsDirForProject: a project reads the specs root, NOT a `specs/` subdir", () => {
  assert.equal(
    specsDirForProject("ab-test-sandbox", { LAUNCHPAD_SPECS_ROOT: "/srv/launchpad/specs" }),
    "/srv/launchpad/specs/ab-test-sandbox",
  );
});

test("specsDirForProject: no platform root configured → null, never a guess", () => {
  assert.equal(specsDirForProject("platform", {}), null);
});
