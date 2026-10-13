#!/usr/bin/env node
/**
 * lint-instruments.mjs — lint the INSTRUMENTS we commit (build-plan item 6).
 *
 * docs/VERIFICATION.md #14: every rule in this repo is about a check inside the
 * product; none covered the throwaway psql/curl/grep/wait-loop commands a session
 * writes to OBSERVE the system. Those are unreviewed and invisible, and on
 * 2026-08-19 they cost a wrong conclusion about prices, two silent deploys, a
 * 52-minute wait for a state that could not arrive, and four separate misreadings
 * of an exit code.
 *
 * SCOPE, and the honest half of this tool: it can only see instruments that are
 * COMMITTED, i.e. `scripts/**`. Six of the seven registry rows in this family were
 * ad-hoc commands typed into a tool call and never written to disk, where no repo
 * lint will ever reach them. The mechanical answer for those is not a lint, it is
 * to promote a repeating probe into a committed script — which this repo has now
 * done five times, each after the hand-rolled version cost something.
 *
 * RULES, only the ones genuinely detectable. Phase 2 taught that a checker which
 * overstates is worse than none:
 *
 *   E1  `$?` read after a pipeline — it is the LAST command's status, in both
 *       directions (rows 22, 91; VERIFICATION #8). Use PIPESTATUS, or capture the
 *       command's own status.
 *   E2  a guard disarmed in the statement that declares it: `|| true` on a line
 *       whose status is then tested (row 1). NOT `2>/dev/null` — the first
 *       version flagged that and it was wrong: redirecting stderr hides output,
 *       it does not mask an exit code, so `if wait "$pid" 2>/dev/null` is fine.
 *   E3  `pg_isready` as a readiness gate — it answers about the server, not the
 *       DATABASE, and passes against a postgres that is about to restart during
 *       init (row 21). Query the target database instead.
 *   E4  `git checkout` used to restore a file — it restores COMMITTED content, so
 *       it deletes an uncommitted fix under test (row 33). Snapshot the bytes.
 *
 * KNOWN IMPRECISION, said plainly rather than discovered later: E1 also looks at
 * the line ABOVE, because
 *
 *     cmd | tail
 *     echo $?
 *
 * is the common two-line form. So a `$?` that legitimately follows an unpiped
 * statement will be flagged when the preceding line happens to contain a pipe.
 * It over-reports there. Suppress with the comment below when that is the case.
 *
 * Suppress a deliberate case with a trailing `# instruments: allow <why>`.
 *
 * Usage:  scripts/lint-instruments.mjs [--strict]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const STRICT = process.argv.slice(2).includes("--strict");
const files = [];
for (const e of readdirSync("scripts")) {
  const p = join("scripts", e);
  // Skip this file: its rule definitions are string literals containing the
  // exact patterns it searches for, so it flags itself 8 times.
  if (p.endsWith("lint-instruments.mjs")) continue;
  if (statSync(p).isFile() && /\.(sh|mjs|js)$/.test(p)) files.push(p);
}

const findings = [];
const flag = (file, line, rule, text, why) =>
  findings.push({ file, line, rule, text: text.trim().slice(0, 96), why });

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const n = i + 1;
    if (/#\s*instruments:\s*allow/.test(raw)) return;
    // Strip comments for matching, so prose about a rule is not a violation.
    const code = raw.replace(/(^|\s)#.*$/, "$1");
    if (!code.trim()) return;

    // E1: `$?` where the nearest command on this line (or the one above) pipes.
    if (/\$\?/.test(code) && !/PIPESTATUS/.test(code)) {
      const SINGLE_PIPE = /(?<!\|)\|(?!\|)/;
      const sameLinePipe = SINGLE_PIPE.test(code.split("$?")[0]);
      const prev = (lines[i - 1] ?? "").replace(/(^|\s)#.*$/, "$1");
      const prevPipe = SINGLE_PIPE.test(prev) && !/PIPESTATUS/.test(prev);
      if (sameLinePipe || prevPipe) {
        flag(file, n, "E1", raw, "`$?` after a pipeline is the LAST command's status");
      }
    }

    // E2: a disarm on a line whose status is then tested.
    if (/\|\|\s*true/.test(code) && /(\$\?|^\s*if\s|&&\s*\[)/.test(code)) {
      flag(file, n, "E2", raw, "guard disarmed in the same statement that checks it");
    }

    // E3: readiness by pg_isready.
    if (/pg_isready/.test(code)) {
      flag(file, n, "E3", raw, "pg_isready passes during init; query the target database");
    }

    // E4: restoring a file with git.
    if (/git\s+checkout\b/.test(code) && !/-b\b/.test(code)) {
      flag(file, n, "E4", raw, "git checkout restores COMMITTED content; snapshot bytes instead");
    }
  });
}

console.log(`lint-instruments: ${files.length} committed instruments in scripts/`);
if (findings.length === 0) {
  console.log("  clean.");
} else {
  for (const f of findings) {
    console.log(`\n  ${f.rule}  ${f.file}:${f.line}`);
    console.log(`      ${f.text}`);
    console.log(`      -> ${f.why}`);
  }
  console.log(`\n${findings.length} finding(s). Suppress a deliberate one with \`# instruments: allow <why>\`.`);
}
console.log("\n(only COMMITTED instruments are visible here — ad-hoc probes typed into a");
console.log(" tool call are not lintable at all; promote a repeating one into a script.)");

if (STRICT && findings.length > 0) process.exit(1);
