import { test } from "node:test";
import assert from "node:assert/strict";
import { projectSlugForSpec, specsForProject, PLATFORM_PROJECT_SLUG } from "./spec-project.js";

// Spec 0104: the mapping that lets a workspace show only its own specs. Mirrors
// projectForTarget()'s run-target mapping so specs and runs agree on ownership.

test("launchpad/self specs belong to the platform project", () => {
  assert.equal(projectSlugForSpec("launchpad"), PLATFORM_PROJECT_SLUG);
  assert.equal(projectSlugForSpec("self"), PLATFORM_PROJECT_SLUG);
  assert.equal(projectSlugForSpec("  launchpad  "), PLATFORM_PROJECT_SLUG);
});

test("a tenant name is taken as the project slug verbatim", () => {
  assert.equal(projectSlugForSpec("sandbox"), "sandbox");
  assert.equal(projectSlugForSpec("acme-staging"), "acme-staging");
});

test("missing or blank tenant falls back to platform rather than throwing", () => {
  // An unreadable `tenant:` must not hide a spec from EVERY workspace — and a
  // repo spec belongs to platform anyway. projectForTarget throws on a bad
  // target because a run cannot proceed without one; a spec can still be read.
  assert.equal(projectSlugForSpec(undefined), PLATFORM_PROJECT_SLUG);
  assert.equal(projectSlugForSpec(""), PLATFORM_PROJECT_SLUG);
  assert.equal(projectSlugForSpec("   "), PLATFORM_PROJECT_SLUG);
});

test("specsForProject partitions a mixed list with no spec lost", () => {
  const specs = [
    { filename: "0104-a.md", tenant: "launchpad" },
    { filename: "0065-b.md", tenant: "sandbox" },
    { filename: "0001-c.md" }, // no tenant → platform
    { filename: "0099-d.md", tenant: "launchpad" },
  ];
  const platform = specsForProject(specs, PLATFORM_PROJECT_SLUG);
  const sandbox = specsForProject(specs, "sandbox");
  assert.deepEqual(platform.map((s) => s.filename), ["0104-a.md", "0001-c.md", "0099-d.md"]);
  assert.deepEqual(sandbox.map((s) => s.filename), ["0065-b.md"]);
  // Every spec lands in exactly one project — no orphans, no duplicates.
  assert.equal(platform.length + sandbox.length, specs.length);
  assert.deepEqual(specsForProject(specs, "nonexistent"), []);
});
