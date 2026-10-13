/** Spec 0225 F — the checks that turn a deep-in-the-run failure into a refusal. */
import test from "node:test";
import assert from "node:assert/strict";
import { connectPreflight, inspectRepoShape, preflightBlocks } from "./connect-preflight.js";

const OK = { checkoutsRootWritable: true, specsRootWritable: true };

test("spec 0225: a repo with its own specs/ is BLOCKING — the symlink is skipped silently", () => {
  const shape = inspectRepoShape(["README.md", "specs/0001-theirs.md", "package.json"]);
  assert.equal(shape.hasOwnSpecsDir, true);
  const f = connectPreflight({ shape, ...OK });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.code, "specs_collision");
  assert.equal(f[0]!.blocking, true);
  assert.match(f[0]!.problem, /No spec file/);
  assert.equal(preflightBlocks(f), true);
});

test("spec 0225: a Node repo with no specs/ passes clean", () => {
  const shape = inspectRepoShape(["package.json", "app/page.tsx"]);
  assert.deepEqual(shape, { hasOwnSpecsDir: false, toolchain: "node" });
  assert.deepEqual(connectPreflight({ shape, ...OK }), []);
});

test("spec 0225: an Odoo addons repo is recognised, not mistaken for 'nothing'", () => {
  const shape = inspectRepoShape(["mi_addon/__manifest__.py", "mi_addon/models/x.py"]);
  assert.equal(shape.toolchain, "odoo");
  assert.deepEqual(connectPreflight({ shape, ...OK }), []);
});

test("spec 0225: an unrecognised toolchain WARNS, never blocks — CI skips honestly (0138)", () => {
  const shape = inspectRepoShape(["main.go", "go.mod"]);
  assert.equal(shape.toolchain, "none");
  const f = connectPreflight({ shape, ...OK });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.code, "no_ci_toolchain");
  assert.equal(f[0]!.blocking, false);
  assert.equal(preflightBlocks(f), false, "a skipped CI must not stop a connect");
});

test("spec 0225: an unwritable root is BLOCKING, and names which one (0210)", () => {
  const shape = inspectRepoShape(["package.json"]);
  const f = connectPreflight({ shape, checkoutsRootWritable: false, specsRootWritable: true });
  assert.equal(f[0]!.code, "root_not_writable");
  assert.equal(f[0]!.blocking, true);
  assert.match(f[0]!.problem, /checkouts/);
  assert.doesNotMatch(f[0]!.problem, /y el directorio de specs/);
});

test("spec 0225: both roots unwritable names both", () => {
  const shape = inspectRepoShape(["package.json"]);
  const f = connectPreflight({ shape, checkoutsRootWritable: false, specsRootWritable: false });
  assert.match(f[0]!.problem, /checkouts.*y.*specs/);
});

test("spec 0225: findings accumulate — a bad repo reports every reason at once", () => {
  const shape = inspectRepoShape(["specs/x.md", "main.go"]);
  const f = connectPreflight({ shape, checkoutsRootWritable: false, specsRootWritable: false });
  assert.deepEqual(f.map((x) => x.code).sort(), ["no_ci_toolchain", "root_not_writable", "specs_collision"]);
});

test("spec 0225: a nested path called specs/ inside a package does NOT count", () => {
  // Only the repo's own TOP-LEVEL specs/ shadows the symlink target.
  assert.equal(inspectRepoShape(["pkg/specs/readme.md"]).hasOwnSpecsDir, false);
});

// --- Spec 0225 E: the production host is derived, not typed ------------------

test("spec 0225 E: a fleet project's host is <slug>.odoo.example.com, from the same helper provisioning uses", async () => {
  const { odooHostFor } = await import("@launchpad/pipeline");
  // The column was empty on all eleven rows because /new only sent this for
  // odoo.sh. Pinning the DERIVATION, so the row and the DNS cannot disagree.
  assert.equal(odooHostFor("taqueria-sol"), "taqueria-sol.odoo.example.com");
});

// --- Spec 0225 C3, as it turned out: there is no addons repo to create -------

test("spec 0225: an Odoo project whose repo has no addons WARNS — it may be the wrong repo", () => {
  const shape = inspectRepoShape(["package.json", "app/page.tsx"]);
  const f = connectPreflight({ shape, kind: "odoo_next", ...OK });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.code, "odoo_kind_without_addons");
  assert.equal(f[0]!.blocking, false, "a brand-new tenant has no addons yet; that is normal");
});

test("spec 0225: an Odoo project WITH addons says nothing", () => {
  const shape = inspectRepoShape(["mi_addon/__manifest__.py", "app/page.tsx"]);
  assert.deepEqual(connectPreflight({ shape, kind: "odoo_next", ...OK }), []);
});

test("spec 0225: a custom project is never asked about addons", () => {
  const shape = inspectRepoShape(["package.json"]);
  assert.deepEqual(connectPreflight({ shape, kind: "custom", ...OK }), []);
});
