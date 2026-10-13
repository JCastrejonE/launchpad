/**
 * Spec 0216 — the project workspace has ONE loading boundary.
 *
 * What this test can and cannot prove, said plainly (verification rule #1, and
 * the spec's own acceptance criterion 2): it is a SOURCE check, not a render.
 * `apps/web`'s test harness compiles `lib/**` only (`tsconfig.test.json`:
 * `rootDir: "lib"`, `include: ["lib"]`) to CommonJS and runs it under
 * `node --test` — there is no JSX transform and no DOM in that pipeline, so a
 * `.tsx` file under `app/` cannot be imported, let alone rendered. Reading the
 * source is the same idiom `lib/project-access.test.ts` and `lib/release-ui.test.ts`
 * already use for files under `app/`.
 *
 * So this pins that the file exists at the one path that covers every panel and
 * that it is built from the repo's existing primitives. It says NOTHING about
 * whether the App Router actually paints it on a tab click — that is acceptance
 * criterion 3, a `(human)` before/after on `ramas`, and it is the load-bearing
 * check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// `import.meta.url` is unavailable under the CJS test build; `__dirname` is the
// compiled test's directory (`apps/web/dist`), so `..` is `apps/web`.
const BOUNDARY = path.join(__dirname, "..", "app", "projects", "[id]", "loading.tsx");

type BoundaryFacts = {
  hasDefaultExport: boolean;
  usesUiPrimitive: boolean;
};

/**
 * The two facts criterion 1 names. Kept as a pure function of the source text so
 * the control test below can feed it a known-bad string — a checker that matched
 * nothing would pass forever without reading anything (verification rule #2).
 */
function boundaryFacts(source: string): BoundaryFacts {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return {
    hasDefaultExport: /export\s+default\s/.test(withoutComments),
    usesUiPrimitive:
      /from\s+"(?:\.\.\/)+components\/ui"/.test(withoutComments) &&
      /<(?:Card|Label)\b/.test(withoutComments),
  };
}

// --- the two facts criterion 1 names ---------------------------------------

test("app/projects/[id]/loading.tsx exists — one boundary above every panel segment", () => {
  assert.ok(
    existsSync(BOUNDARY),
    "expected apps/web/app/projects/[id]/loading.tsx — placed at [id] so the changing segment is always below it and the fallback renders inside WorkspaceChrome",
  );
});

test("it is a default-exported component built from components/ui primitives", () => {
  const facts = boundaryFacts(readFileSync(BOUNDARY, "utf8"));
  assert.ok(facts.hasDefaultExport, "loading.tsx must default-export the fallback component");
  assert.ok(
    facts.usesUiPrimitive,
    "the skeleton must reuse Card/Label from components/ui, not a new bespoke component",
  );
});

// --- the control: this one runs now, and proves the checker can say "no" ------

test("the checker rejects a file that has neither fact", () => {
  const planted = boundaryFacts("function Loading() {\n  return null;\n}\n");
  assert.equal(planted.hasDefaultExport, false);
  assert.equal(planted.usesUiPrimitive, false);
});

test("the checker is not fooled by a comment or a foreign Card", () => {
  // A comment mentioning the primitives is not a use of them.
  assert.equal(
    boundaryFacts('// export default a <Card> from components/ui\n').usesUiPrimitive,
    false,
  );
  // An import from somewhere else is not the repo's idiom.
  assert.equal(
    boundaryFacts('import { Card } from "./elsewhere";\nexport default () => <Card />;\n')
      .usesUiPrimitive,
    false,
  );
});
