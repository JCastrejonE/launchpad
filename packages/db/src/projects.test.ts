import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProject,
  DuplicateProjectSlugError,
  isValidProjectSlug,
  PLATFORM_PROJECT,
  PRODUCTION_KINDS,
  projectForTarget,
} from "./projects.js";

test("self and the legacy launchpad literal both map to the platform project", () => {
  assert.deepEqual(projectForTarget({ kind: "self" }), PLATFORM_PROJECT);
  assert.deepEqual(projectForTarget({ kind: "launchpad" }), PLATFORM_PROJECT);
  assert.equal(PLATFORM_PROJECT.kind, "platform");
  assert.equal(PLATFORM_PROJECT.slug, "platform");
});

test("a tenant maps to an odoo project keyed by tenantId", () => {
  assert.deepEqual(projectForTarget({ kind: "tenant", tenantId: "acme" }), {
    slug: "acme",
    name: "acme",
    kind: "odoo",
    client: "acme",
  });
  // trims
  assert.equal(projectForTarget({ kind: "tenant", tenantId: "  sandbox " }).slug, "sandbox");
});

test("a tenant target without a tenantId throws", () => {
  assert.throws(() => projectForTarget({ kind: "tenant" }), /requires a tenantId/);
  assert.throws(() => projectForTarget({ kind: "tenant", tenantId: "   " }), /requires a tenantId/);
});

test("an unknown target kind throws", () => {
  assert.throws(() => projectForTarget({ kind: "bogus" }), /unknown target kind/);
});

test("PLATFORM_PROJECT supplies every required (non-defaulted) column", () => {
  for (const key of ["slug", "name", "kind", "client"] as const) {
    assert.ok(PLATFORM_PROJECT[key].length > 0, `PLATFORM_PROJECT.${key} must be non-empty`);
  }
});

// ---------------------------------------------------------------------------
// Spec 0126: creation (as opposed to the idempotent seed upsert above).
// ---------------------------------------------------------------------------

test("a valid slug is lowercase, 2-40 chars, hyphens only on the inside", () => {
  for (const ok of ["acme", "client-c-mx", "a1", "x".repeat(40), "odoo-17-migration"]) {
    assert.equal(isValidProjectSlug(ok), true, ok);
  }
});

// The negatives are the reason this exists: each one would otherwise reach a URL
// path, a Traefik router rule and a tenant database name.
test("an invalid slug is REFUSED rather than quietly rewritten", () => {
  for (const bad of [
    "Acme", // uppercase
    "-acme", // leading hyphen
    "acme-", // trailing hyphen
    "a", // 1 char
    "x".repeat(41), // 41 chars
    "", // empty
    "ac me", // space
    "acme_mx", // underscore
    "acme.mx", // dot
    "../etc/passwd", // traversal
    "acme/prod", // path separator
    "acmé", // non-ascii
  ]) {
    assert.equal(isValidProjectSlug(bad), false, JSON.stringify(bad));
  }
});

/** Minimal drizzle-shaped insert chain: records what it was given and returns
 * `rows`, so a test can assert the RESPONSE handling (docs/VERIFICATION.md #1)
 * and not merely the call we made. */
function fakeInsertDb(rows: { id: string }[]) {
  const seen: { values?: Record<string, unknown>; conflictTarget?: unknown } = {};
  const db = {
    insert() {
      return {
        values(v: Record<string, unknown>) {
          seen.values = v;
          return {
            onConflictDoNothing(cfg: { target: unknown }) {
              seen.conflictTarget = cfg.target;
              return { returning: async () => rows };
            },
          };
        },
      };
    },
  };
  return { db, seen };
}

test("createProject inserts and returns the new id", async () => {
  const { db, seen } = fakeInsertDb([{ id: "proj-1" }]);
  const id = await createProject(db as never, {
    slug: "client-c",
    name: "Distribuidora Client-C",
    kind: "odoo",
    client: "Client-C",
    repoOwner: "example-org",
    repoName: "client-c",
    productionKind: "odoosh",
    productionHost: "client@example.com",
  });
  assert.equal(id, "proj-1");
  assert.equal(seen.values?.["slug"], "client-c");
  assert.equal(seen.values?.["repoOwner"], "example-org");
  assert.equal(seen.values?.["productionKind"], "odoosh");
});

// The distinction from upsertProject, which is the entire reason this function
// exists: a taken slug must be an ERROR, never a silent overwrite of another
// project's name/kind/client.
test("createProject on a taken slug raises DuplicateProjectSlugError", async () => {
  const { db } = fakeInsertDb([]); // onConflictDoNothing -> no row returned
  await assert.rejects(
    () => createProject(db as never, { slug: "platform", name: "x", kind: "odoo", client: "y" }),
    (e: Error) => e instanceof DuplicateProjectSlugError && e.slug === "platform",
  );
});

test("createProject validates the slug BEFORE touching the database", async () => {
  let touched = false;
  const db = {
    insert() {
      touched = true;
      throw new Error("must not reach the database");
    },
  };
  await assert.rejects(
    () => createProject(db as never, { slug: "Bad Slug", name: "x", kind: "odoo", client: "y" }),
    /invalid project slug/,
  );
  assert.equal(touched, false);
});

test("omitted optional columns are not sent at all, so DB defaults apply", async () => {
  const { db, seen } = fakeInsertDb([{ id: "p" }]);
  await createProject(db as never, { slug: "bare", name: "Bare", kind: "custom", client: "c" });
  for (const absent of ["domain", "repoOwner", "repoName", "repoRoot", "productionKind", "productionHost"]) {
    assert.equal(absent in (seen.values ?? {}), false, `${absent} should be omitted`);
  }
});

test("PRODUCTION_KINDS is exactly the vocabulary the migration's CHECK allows", () => {
  assert.deepEqual([...PRODUCTION_KINDS], ["odoosh", "fleet", "none"]);
});
