/**
 * Spec 0193 B. Every promote logged
 * `ENOENT … scandir '/srv/launchpad/specs/<slug>/specs'` and marked nothing on
 * disk, because `branch-actions.ts` handed a specs DIRECTORY to `setStatus` —
 * the REPO-ROOT variant, which appends `specs` itself. `setStatusInDir` is the
 * directory variant and has been since spec 0149.
 *
 * A source test, and worth naming as weaker than a behavioural one: it pins that
 * the promote path calls the directory variant, not that the file gets written.
 * Nothing stronger is available here — both functions take `(string, string,
 * status)`, so the types cannot tell them apart, which is the whole reason this
 * was silent (docs/VERIFICATION.md #12). The behavioural half is the spec's live
 * check: promote a branch and read the spec file's frontmatter on the box.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.join(__dirname, "..", "app", "projects", "[id]", "branch-actions.ts"),
  "utf8",
);

test("the promote marker calls setStatusInDir with the specs directory", () => {
  assert.match(
    src,
    /setStatusInDir\(projectSpecsDir\(project\.slug\), specId, "promoted"\)/,
    "the promote path must use the DIRECTORY variant",
  );
});

test("nothing in branch-actions passes a specs directory to the repo-root variant", () => {
  assert.doesNotMatch(
    src,
    /\bsetStatus\(projectSpecsDir/,
    "setStatus takes a repo ROOT and appends `specs` — this doubles the path",
  );
});
