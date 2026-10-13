/**
 * Structural guard for a FRESHLY DRAFTED spec (spec 0217, scope item 3).
 *
 * Spec 0217 fixes the spec PROSE in Spanish and freezes the STRUCTURE in
 * English, byte-identical, because the structure is not prose: it is on-disk
 * format that code parses with literal regexes. `PENDING.md` row 166 has
 * carried that as a comment since spec 0005 and it prevented nothing — a
 * comment is not a control (CLAUDE.md verification rule #11). This module is
 * the control.
 *
 * WHAT IT CHECKS (deliberately two rules, each derived from a real parser —
 * not a whitelist of every heading a spec may carry):
 *
 *  1. The DRAFT-TIME required headings are present, byte-exact English:
 *     `## Intent`, `## Scope`, `## Acceptance criteria`,
 *     `## Out of scope / deferred`, `## Handoff log`.
 *     `## Intent` is a literal regex in `packages/pipeline/src/store.ts`
 *     (`intentGoal`, `^## Intent\s*$`) and in `architect-session.ts`
 *     (`parseIntentSummary`); `## Handoff log` likewise (`lastHandoffEntry`,
 *     `^## Handoff log\s*$`). A translated heading (`## Intención`) makes those
 *     return "" silently. `## Plan` and `## Progress` are NOT required here:
 *     `agents/spec-drafter.md` tells the drafter to leave them out, and the
 *     initializer writes them when the spec is approved.
 *
 *  2. No `- [ ]` / `- [x]` checkbox items outside a `## Progress` section.
 *     This is row 166's own proposed mitigation ("make the loop refuse a spec
 *     with items outside `## Progress`"). It is also what catches a translated
 *     `## Progreso`: the items under it land outside `## Progress` and are
 *     rejected by name.
 *
 * SCOPE — draft time only. It runs on the output of a drafting SESSION, never
 * on a spec that was already on disk: 21 historical specs use `## Acceptance`
 * and 31 use `## Out of scope` (measured 2026-08-18), and `draftSpec`'s
 * pre-committed pass-through path carries hand-written Track-1 specs through
 * the same function. Validating those would fail runs over closed history.
 *
 * Returns the list of violations, empty when the draft is well-formed — the
 * same shape as `architectFenceViolations`, whose call sites this one joins.
 */
export const REQUIRED_HEADINGS = [
  "## Intent",
  "## Scope",
  "## Acceptance criteria",
  "## Out of scope / deferred",
  "## Handoff log",
] as const;

/** The checkbox shape `packages/pipeline/src/store.ts#checklistScope` looks for,
 * character for character — this guard must recognise exactly what the coder
 * loop's fuel gauge recognises, including the fact that neither of them makes an
 * exception for a fenced code block. A checkbox inside a fence is counted by the
 * loop, so it is rejected here too rather than quietly diverging. */
const CHECKBOX_RE = /^\s*- \[[ xX]\]/;

export function specStructureViolations(markdown: string): string[] {
  // Trailing whitespace only: `store.ts` matches `^## Progress\s*$`, so a
  // heading with trailing spaces IS the heading. Everything else is byte-exact.
  const lines = markdown.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, ""));
  const violations: string[] = [];

  for (const heading of REQUIRED_HEADINGS) {
    if (!lines.includes(heading)) {
      violations.push(`missing required heading, byte-exact English: "${heading}"`);
    }
  }

  let section = "(no section)";
  lines.forEach((line, i) => {
    if (line.startsWith("## ")) section = line;
    else if (CHECKBOX_RE.test(line) && section !== "## Progress") {
      violations.push(`checkbox item outside "## Progress": line ${i + 1}, under "${section}"`);
    }
  });

  return violations;
}
