#!/usr/bin/env node
/**
 * lint-agent-rules.mjs — a rule given to ONE agent is a rule that will not hold
 * (build-plan item 13, from docs/COMPLIANCE-REGISTRY.md rows 14, 15, 61).
 *
 * The evidence, all of it the same shape:
 *   row 61  spec 0217 put the Spanish-prose rule in agents/spec-drafter.md and
 *           nowhere else. The chat narrated in English and the coder committed
 *           `feat(spec-0001): create CONTRIBUTING.md…` on a Spanish project.
 *   row 15  the coder RE-DERIVED the specs-outside-the-repo rule and wrote its
 *           own explanation into nine spec files across six projects.
 *   row 14  the drafter wrote `status: staged`, which its own prompt forbids.
 *
 * WHAT THIS CAN AND CANNOT DO, because item 13 is the weakest channel in the plan
 * and pretending otherwise would be the failure this repo keeps paying for:
 *   IT CAN     tell you an agent was never GIVEN a rule it needs (rows 61, 15).
 *   IT CANNOT  tell you an agent has the rule and ignored it (row 14). That needs
 *              an output check, not a prompt check.
 *
 * Matching is by phrase, so rewording a prompt can break a check. That is the
 * cost of the mechanism and it is the reason each rule below carries SEVERAL
 * alternative phrasings: the test is "is this rule present in some form", not "is
 * this exact sentence present".
 *
 * Usage:  scripts/lint-agent-rules.mjs [--strict]
 */
import { readFileSync, existsSync } from "node:fs";

const STRICT = process.argv.slice(2).includes("--strict");

/**
 * Each rule names the agents that must state it, and why those and not others.
 * `HANDOFF.md` is deliberately absent from every list: it documents the handoff
 * FORMAT, it is not an agent's prompt. `supervisor.md` is absent from `language`
 * because the chat session is told its language by the request context line in
 * `apps/web/app/api/supervisor/route.ts`, not by its role prompt.
 */
const RULES = [
  {
    id: "language",
    why: "every agent that writes prose a person reads, or a commit message",
    any: [/español/i, /spanish/i],
    required: ["coder.md", "spec-drafter.md", "initializer.md", "fixer.md"],
  },
  {
    id: "specs-outside-repo",
    why: "every agent that writes or commits inside a CUSTOMER checkout — spec 0141/0222",
    // Broadened after the first run failed on my OWN added text: "OUTSIDE the
    // customer's repo" does not match `outside (the )?repo`. The header promises
    // this tests whether the rule is present in SOME form; the first version
    // tested for one sentence. Exactly the brittleness the header warns about,
    // demonstrated a minute after being written.
    any: [/fuera del repo/i, /outside[^.\n]{0,40}repo/i, /nunca los commitees/i],
    required: ["coder.md", "spec-drafter.md", "initializer.md", "fixer.md"],
  },
  {
    id: "human-marker",
    why: "every agent that reads or writes a Progress checklist — only the literal (human) is excluded from the done-condition",
    any: [/\(human\)/],
    required: ["coder.md", "initializer.md", "fixer.md"],
  },
];

let missing = 0;
for (const rule of RULES) {
  const gaps = [];
  for (const file of rule.required) {
    const path = `agents/${file}`;
    if (!existsSync(path)) { gaps.push(`${file} (MISSING FILE)`); continue; }
    const body = readFileSync(path, "utf8");
    if (!rule.any.some((re) => re.test(body))) gaps.push(file);
  }
  const status = gaps.length === 0 ? "ok  " : "GAP ";
  console.log(`${status} ${rule.id.padEnd(20)} ${rule.required.length - gaps.length}/${rule.required.length}  ${rule.why}`);
  if (gaps.length) {
    missing += gaps.length;
    for (const g of gaps) console.log(`       missing in agents/${g}`);
  }
}

console.log(
  missing === 0
    ? "\nevery listed rule reaches every agent that needs it."
    : `\n${missing} gap(s). A rule one agent has and its sibling does not is the shape of rows 14, 15 and 61.`,
);
console.log("\n(prompt PRESENCE only — this cannot tell you an agent read the rule and ignored it)");

if (STRICT && missing > 0) process.exit(1);
