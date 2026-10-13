/**
 * Spec 0221 C — the deploy's rescue rule, tested against the SHELL SCRIPT that
 * actually runs it. A TypeScript copy of the rule would prove nothing about the
 * artifact: `deploy-here.sh` is what ships, and a wrong regex there pushes
 * unreviewed code to main.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const SCRIPT = path.resolve(process.cwd(), "../../scripts/box-divergence-safe.sh");

/** Returns { safe, offending } by running the real script. */
function classify(paths: string[]): { safe: boolean; output: string } {
  try {
    const out = execFileSync(SCRIPT, { input: paths.join("\n"), encoding: "utf8" });
    return { safe: true, output: out.trim() };
  } catch (err) {
    return { safe: false, output: String((err as { stdout?: string }).stdout ?? "").trim() };
  }
}

test("spec 0221: a spec-only divergence is rescuable — the case that blocked 1.0.7", () => {
  assert.equal(classify(["specs/0220-pending-question-signal.md"]).safe, true);
});

test("spec 0221: several spec files are still rescuable", () => {
  assert.equal(classify(["specs/0220-a.md", "specs/0221-b.md"]).safe, true);
});

test("spec 0221: a code commit is NOT auto-pushed — that would put unreviewed work on the trunk", () => {
  const r = classify(["specs/0220-a.md", "packages/pipeline/src/activities.ts"]);
  assert.equal(r.safe, false);
  assert.equal(r.output, "packages/pipeline/src/activities.ts");
});

test("spec 0221: nothing outside specs/ rides along, not even docs", () => {
  for (const p of ["PENDING.md", "CLAUDE.md", "specs/sub/dir/x.md", "specs/0220.txt", ".github/workflows/ci.yml"]) {
    assert.equal(classify([p]).safe, false, `${p} must not be auto-pushed`);
  }
});

test("spec 0221: an empty divergence is not a rescue — there is nothing to push", () => {
  assert.equal(classify([]).safe, false);
  assert.equal(classify(["", "  "]).safe, false);
});
