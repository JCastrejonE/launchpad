/**
 * Spec 0170 decision 3: the word is banned in what a user can READ.
 *
 * Odoo data migrations are one-way, so deploying an earlier version runs old
 * code against migrated data. Calling that "rollback" or "revertir" would promise
 * an undo that does not exist — the most dangerous label this product could grow.
 *
 * Checks the strings, not the prose: the comments explaining the ban naturally
 * contain the word, and a test that failed on those would be deleted within a
 * week.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const BANNED = /rollback|revertir|revert\b/i;

/** String and JSX-text literals — what a user can actually read. */
function userVisibleText(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const strings = [...withoutComments.matchAll(/(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g)].map((m) => m[2] ?? "");
  const jsxText = [...withoutComments.matchAll(/>([^<>{}]{3,})</g)].map((m) => m[1] ?? "");
  return [...strings, ...jsxText];
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

test("nothing a user can read promises an undo", () => {
  const root = path.join(__dirname, "..", "app", "projects", "[id]");
  const targets = [
    ...filesUnder(path.join(root, "versiones")),
    path.join(root, "release-actions.ts"),
  ];
  assert.ok(targets.length >= 3, "expected the versiones panel and its action");
  for (const file of targets) {
    for (const text of userVisibleText(readFileSync(file, "utf8"))) {
      assert.doesNotMatch(
        text,
        BANNED,
        `${path.basename(file)} shows the user: ${JSON.stringify(text.slice(0, 80))}`,
      );
    }
  }
});

test("the check can fail — a planted string is caught", () => {
  // Guards the extractor itself: a regex that matched nothing would make the
  // test above pass forever without reading anything.
  const planted = 'const label = "Hacer rollback a la versión anterior";';
  assert.ok(userVisibleText(planted).some((t) => BANNED.test(t)));
  // …and a comment mentioning it is correctly ignored.
  assert.ok(!userVisibleText("// never call it rollback\n").some((t) => BANNED.test(t)));
});
