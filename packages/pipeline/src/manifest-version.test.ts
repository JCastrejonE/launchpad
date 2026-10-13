/**
 * Spec 0170 decision 1. The failure being prevented is specific: a deploy whose
 * manifest version did not increase installs new code and skips its migrations,
 * with nothing anywhere going red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bumpAddonManifests, findManifests, rewriteManifestVersion } from "./manifest-version.js";

const MANIFEST = `{
    "name": "CFDI 4.0 México",
    "version": "18.0.1.0.0",
    "depends": ["account"],
    "installable": True,
}
`;

test("rewrites only the version entry, leaving the rest byte-identical", () => {
  const out = rewriteManifestVersion(MANIFEST, "18.0.1.4.2");
  assert.ok(out);
  assert.equal(out.from, "18.0.1.0.0");
  assert.match(out.source, /"version": "18\.0\.1\.4\.2"/);
  // Everything else must survive: this file is Python, and a broad rewrite would
  // corrupt a dict we cannot parse to check.
  assert.match(out.source, /"name": "CFDI 4\.0 México"/);
  assert.match(out.source, /"depends": \["account"\]/);
  assert.match(out.source, /"installable": True/);
  assert.equal(out.source.split("\n").length, MANIFEST.split("\n").length);
});

test("handles single quotes and an absent trailing comma", () => {
  const out = rewriteManifestVersion("{\n    'version': '17.0.2.1.0'\n}\n", "17.0.2.2.0");
  assert.ok(out);
  assert.match(out.source, /'version': '17\.0\.2\.2\.0'/);
});

test("a manifest with no version entry is left alone, not invented into", () => {
  // Adding the line would put it at an arbitrary place in someone's dict.
  assert.equal(rewriteManifestVersion('{\n    "name": "x",\n}\n', "18.0.1.0.0"), null);
});

function repoWith(addons: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "manifest-"));
  for (const [rel, body] of Object.entries(addons)) {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}

test("finds addons at the root and one conventional level down", () => {
  const root = repoWith({
    "mod_a/__manifest__.py": MANIFEST,
    "addons/mod_b/__manifest__.py": MANIFEST,
    "deep/nested/mod_c/__manifest__.py": MANIFEST,
  });
  const found = findManifests(root);
  assert.deepEqual(found, ["addons/mod_b/__manifest__.py", "mod_a/__manifest__.py"]);
  assert.ok(!found.some((f) => f.includes("mod_c")), "deeper than one level is not an addon path");
});

test("bumps every addon and reports exactly what changed", async () => {
  const root = repoWith({ "mod_a/__manifest__.py": MANIFEST, "addons/mod_b/__manifest__.py": MANIFEST });
  const bumps = await bumpAddonManifests(root, "18.0.1.4.2");
  assert.equal(bumps.length, 2);
  assert.deepEqual(
    bumps.map((b) => b.path).sort(),
    ["addons/mod_b/__manifest__.py", "mod_a/__manifest__.py"],
  );
  for (const b of bumps) assert.equal(b.from, "18.0.1.0.0");
  // Read the FILE back, not the return value (VERIFICATION #1).
  for (const rel of ["mod_a/__manifest__.py", "addons/mod_b/__manifest__.py"]) {
    assert.match(readFileSync(path.join(root, rel), "utf8"), /"version": "18\.0\.1\.4\.2"/);
  }
});

/**
 * The one the caller must be able to see: nothing moved. A release that reports
 * success while every manifest stayed put is exactly the silent-skipped-migration
 * failure, so "no bumps" is a RESULT, never a quiet success.
 */
test("a manifest already at the target version reports NO bump", async () => {
  const root = repoWith({ "mod_a/__manifest__.py": MANIFEST });
  assert.equal((await bumpAddonManifests(root, "18.0.1.0.0")).length, 0);
});

test("a repo with no addons reports no bumps rather than failing", async () => {
  assert.deepEqual(await bumpAddonManifests(repoWith({ "README.md": "hi" }), "18.0.1.0.0"), []);
});
