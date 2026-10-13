#!/usr/bin/env node
/**
 * lint-specs.mjs — run the repo's OWN spec validator over the specs this change
 * touches (build-plan Phase 1b).
 *
 * `specStructureViolations` has existed since spec 0217 and is wired into the
 * DRAFTER path (`packages/agents/src/architect-session.ts`), so an agent-drafted
 * spec is checked and a hand-written one never is. That is the Track 1 gap: on
 * 2026-08-19 all four specs written by hand that day failed it — `## Out of
 * scope` where the required heading is `## Out of scope / deferred`, which the
 * drafter prompt warns about by name, because a wrong heading does not read
 * differently, it parses as ABSENT, silently.
 *
 * SCOPED TO CHANGED SPECS, deliberately. 215 of the 226 specs here fail this
 * validator and 11 pass; gating the tree would red-gate every commit in the
 * repo. Measuring that before wiring it is the only reason this is usable.
 *
 * Usage:
 *   scripts/lint-specs.mjs         specs changed vs origin/main, plus uncommitted
 *   scripts/lint-specs.mjs --all   whole corpus, reported, never fatal
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ALL = process.argv.slice(2).includes("--all");

let specStructureViolations;
try {
  ({ specStructureViolations } = require("../packages/agents/dist/spec-structure.js"));
} catch {
  // The validator lives in a BUILT package, so this must run after the build
  // step — the same stale-dist trap as docs/VERIFICATION.md #7.
  console.error("lint-specs: packages/agents is not built. Run `pnpm -r build` first.");
  process.exit(2);
}

const git = (args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" });
  } catch {
    return "";
  }
};
const isSpec = (p) => /^specs\/[^/]+\.md$/.test(p);

let BASE = null;

/**
 * Is there a git repository here at all?
 *
 * Not the same question as "did any spec change", and conflating them is a
 * defect this shipped with: run inside a `git archive` tree (no `.git`), this
 * printed its narrower-check warning and then exited 0 — a gate step passing
 * while inspecting nothing, which is the shape of registry rows 74 and 55. The
 * warning was right and the exit code was wrong.
 */
function insideGitRepo() {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function changedSpecs() {
  // A "changed since" check whose baseline is missing must SAY so, not quietly
  // pass with an empty list (registry rows 5, 51: a label with nothing behind it).
  let base = null;
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], { stdio: "ignore" });
    base = "origin/main";
    BASE = base;
  } catch {
    console.warn(
      "lint-specs: origin/main does not resolve, so I cannot see committed-but-unpushed\n" +
      "            specs. Checking UNCOMMITTED changes only — this is a narrower check\n" +
      "            than intended, said out loud rather than reported as clean.",
    );
  }
  const sets = [
    ...(base ? [git(["diff", "--name-only", `${base}...HEAD`])] : []),
    git(["diff", "--name-only", "HEAD"]),
    git(["diff", "--name-only", "--cached"]),
    // UNTRACKED files. A brand-new spec is untracked until `git add`, and no
    // `git diff` lists it — so the check that exists to validate new specs could
    // not see a new spec. Found by writing spec 0229 and watching this report
    // "nothing to check".
    git(["ls-files", "--others", "--exclude-standard"]),
  ];
  const paths = new Set(
    sets.join("\n").split("\n").map((s) => s.trim()).filter(isSpec).filter(existsSync),
  );
  return [...paths].sort();
}

if (!ALL && !insideGitRepo()) {
  console.error(
    "lint-specs: no git repository here, so I cannot tell which specs changed.\n" +
      "            Refusing to report a pass for a check that did not run. If this is a\n" +
      "            CI job, it needs the repository's history, not just its files.",
  );
  process.exit(2);
}

const targets = ALL
  ? readdirSync("specs").filter((f) => f.endsWith(".md")).map((f) => `specs/${f}`).sort()
  : changedSpecs();

if (targets.length === 0) {
  console.log("lint-specs: no spec files in this change — nothing to check.");
  process.exit(0);
}

/**
 * Violations this file had BEFORE the change, so we can fail only on new ones.
 *
 * Why this exists: 213 of 226 specs fail this validator, and a spec becomes
 * "changed" when the harness rewrites a single `status:` line during a promote
 * roll-up. On 2026-08-24 exactly that happened — `status: approved` ->
 * `status: promoted` on spec 0226 — and the gate went red for two missing
 * headings the commit did not touch and did not introduce. A gate that fires on
 * work you did not do is a gate people learn to push past, which is spec 0188
 * C's lesson in a different costume.
 *
 * So the question is not "does this spec comply" but "did this change make it
 * worse". A brand-new spec has no base, so every violation counts as new, which
 * is exactly right.
 */
function baseViolations(file, base) {
  if (!base) return null;
  try {
    const prior = execFileSync("git", ["show", `${base}:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const v = specStructureViolations(prior);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return null; // not in the base tree: the file is new
  }
}

let offenders = 0;
let carried = 0;
for (const file of targets) {
  const now = specStructureViolations(readFileSync(file, "utf8"));
  const nowList = Array.isArray(now) ? now.map(String) : [];
  const before = ALL ? null : baseViolations(file, BASE);
  const fresh = before === null ? nowList : nowList.filter((v) => !before.includes(v));
  carried += nowList.length - fresh.length;
  if (fresh.length > 0) {
    offenders++;
    if (!ALL) {
      console.error(`\n  ${file}`);
      for (const v of fresh) console.error(`    - ${v}`);
    }
  }
}

if (ALL) {
  console.log(`lint-specs --all: ${targets.length} specs, ${offenders} violating, ${targets.length - offenders} clean`);
  console.log("(reported, never fatal: the corpus predates the validator)");
  process.exit(0);
}

console.log(
  `lint-specs: checked ${targets.length} changed spec(s), ${offenders} with NEW violations` +
    (carried > 0 ? ` (${carried} pre-existing, not yours)` : ""),
);
if (offenders > 0) {
  console.error(
    "\nThese headings are parsed by literal regexes, so a near-miss is read as ABSENT,\n" +
    "not as different. See agents/spec-drafter.md for the closed list.",
  );
  process.exit(1);
}
