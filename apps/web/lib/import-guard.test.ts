import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  GUARDED_IMPORT_EXTENSIONS,
  IMPORT_GUARD_EXEMPT_MARKER,
  isGuardExemptFile,
  scanImportExtensions,
  type ImportViolation,
} from "./import-guard.js";
import { repoRoot } from "./specs.js";

// ---------------------------------------------------------------------------
// Layer 1 — fixture cases (pure; no fs). Scaffolded skipped by the initializer
// (spec 0020); the coder implementing item 1 fills in the assertions and drops
// the `skip`. Each `test(...)` below maps to an acceptance-criteria bullet.
// ---------------------------------------------------------------------------

test("flags the literal 0017 defect line", () => {
  // import { repoRoot, specsDir } from "./specs.js"  <-- the 98f720b defect
  const src = `import { repoRoot, specsDir } from "./specs.js";\n`;
  const violations: ImportViolation[] = scanImportExtensions(src, "lib/foo.ts");
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.specifier, "./specs.js");
  assert.equal(violations[0]?.extension, ".js");
  assert.equal(violations[0]?.line, 1);
});

test("flags export-from and dynamic-import forms", () => {
  assert.equal(
    scanImportExtensions(`export { x } from "./bar.ts";\n`, "lib/foo.ts").length,
    1,
  );
  assert.equal(
    scanImportExtensions(`const m = await import("./baz.tsx");\n`, "lib/foo.ts")
      .length,
    1,
  );
});

test("passes extensionless relative, package, and node: specifiers", () => {
  assert.deepEqual(scanImportExtensions(`import x from "./bar";\n`, "lib/foo.ts"), []);
  assert.deepEqual(scanImportExtensions(`import path from "node:path";\n`, "lib/foo.ts"), []);
  assert.deepEqual(scanImportExtensions(`import { z } from "next/server";\n`, "lib/foo.ts"), []);
});

test("exempts *.test.ts filenames", () => {
  assert.equal(isGuardExemptFile("lib/specs.test.ts"), true);
  assert.equal(isGuardExemptFile("lib/specs.ts"), false);
  assert.deepEqual(
    scanImportExtensions(`import { x } from "./specs.js";\n`, "lib/specs.test.ts"),
    [],
  );
});

test("exempts a line carrying the inline-exemption marker", () => {
  const src = `import x from "./legacy.js"; // ${IMPORT_GUARD_EXEMPT_MARKER}: legit\n`;
  assert.deepEqual(scanImportExtensions(src, "lib/foo.ts"), []);
});

test("all guarded extensions are covered", () => {
  for (const ext of GUARDED_IMPORT_EXTENSIONS) {
    const src = `import x from "./mod${ext}";\n`;
    assert.equal(scanImportExtensions(src, "lib/foo.ts").length, 1, ext);
  }
});

// ---------------------------------------------------------------------------
// Layer 2 — ENFORCEMENT walk (spec 0020 item 2). Walks the REAL bundled
// apps/web sources (app/, components/, lib/; skipping *.test.ts, dist/, .next/,
// node_modules/) and asserts zero violations. Because it rides apps/web's
// `test` script, the mandated local gate, GitHub CI, and the in-app runCi all
// enforce the rule with no new gate plumbing. Scaffolded skipped; the coder
// implementing item 2 supplies the walk and drops the `skip` (and records the
// RED-on-reintroduction observation in the Handoff log).
// ---------------------------------------------------------------------------

const BUNDLED_DIRS = ["app", "components", "lib"];
const SKIP_DIRS = new Set(["dist", ".next", "node_modules"]);

async function walkBundledSources(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await recurse(path.join(dir, e.name));
      } else if (/\.(ts|tsx)$/.test(e.name) && !isGuardExemptFile(e.name)) {
        out.push(path.join(dir, e.name));
      }
    }
  }
  for (const d of BUNDLED_DIRS) await recurse(path.join(root, "apps", "web", d));
  return out;
}

test("real bundled apps/web sources have zero import-extension violations", async () => {
  const files = await walkBundledSources(repoRoot());
  assert.ok(files.length > 0, "expected to find bundled apps/web sources to scan");
  const offenders: string[] = [];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    const violations = scanImportExtensions(src, file);
    for (const v of violations) offenders.push(`${file}:${v.line} ${v.specifier}`);
  }
  assert.deepEqual(offenders, [], `import-extension violations:\n${offenders.join("\n")}`);
});
