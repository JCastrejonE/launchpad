/**
 * Reconciling a spec's recorded status with what actually shipped (spec 0165).
 *
 * Four times in one day a spec said `draft` or `approved` while its code was on
 * `main`: spec 0147, sandbox 0002, 0162, and 0148. Every one had the same cause —
 * a run died *after* its merge landed, so nothing wrote the status — and every one
 * was repaired by hand. Spec 0160 fixed the cause; nothing repairs the records an
 * incident already corrupted, and the UI, the roll-up and the spec keep describing
 * shipped code as unshipped until a human notices.
 *
 * This module is the DECISION, kept pure so every combination is testable without
 * git, GitHub or a database. The caller gathers the evidence.
 *
 * ## What counts as evidence
 *
 * - **Track 2 — `merged`.** The spec's branch is an ancestor of `origin/main`.
 *   That is a local git fact, not a GitHub API call, and it cannot be true unless
 *   the code really shipped.
 * - **Track 1 — `allWorkDone`.** There is no branch and no run: Track-1 code goes
 *   straight to main. The only available signal is the spec's own checklist, and
 *   `(human)` items are excluded from it exactly as the done-condition excludes
 *   them (CLAUDE.md's verification discipline).
 *
 * The Track-1 rule is a HEURISTIC and is written down as one. The owner chose to
 * auto-repair on it anyway, which is a reasonable trade: the failure mode is a
 * spec marked `completed` slightly early, which a human can see and revert in
 * frontmatter, versus a permanent lie about production code.
 */

/** Statuses that already describe a finished spec — never re-decided. */
const TERMINAL = new Set(["promoted", "completed", "rejected"]);

export interface SpecRepairInput {
  /** Frontmatter `track:`. Absent ⇒ 1, matching `deriveSpecProgress`. */
  track?: 1 | 2;
  /** Frontmatter `status:`. */
  status: string;
  /**
   * Track 2 only: is the spec's branch an ancestor of `origin/main`? `undefined`
   * means "not determined" — a git failure must never be read as "not merged",
   * because that direction silently does nothing rather than guessing wrong.
   */
  merged?: boolean;
  /** Track 1 only: every non-`(human)` checklist item is ticked, and there was
   * at least one. An empty checklist is NOT done — a spec nobody has started has
   * zero unchecked items too. */
  allWorkDone?: boolean;
}

/**
 * The status this spec should have, or null to leave it alone.
 *
 * Null is the safe answer and the common one: anything already terminal, anything
 * whose evidence is missing, and anything genuinely still in flight.
 */
export function decideSpecStatusRepair(input: SpecRepairInput): "promoted" | "completed" | null {
  if (TERMINAL.has(input.status.trim())) return null;
  const track = input.track ?? 1;
  if (track === 2) {
    // Only a real merge promotes. `undefined` (git could not answer) is not a no.
    return input.merged === true ? "promoted" : null;
  }
  return input.allWorkDone === true ? "completed" : null;
}

/**
 * Are all non-`(human)` checklist items done? Takes the spec body's `## Progress`
 * section.
 *
 * `(human)` items are excluded deliberately: they are the checks a machine cannot
 * run, and a spec that is otherwise finished should not sit in `draft` forever
 * waiting for someone to tick a pixel check. Requires at least one non-human item,
 * so a spec with no checklist — or one holding ONLY `(human)` items — is never
 * called done on the strength of an empty set.
 */
export function allNonHumanItemsChecked(progressSection: string): boolean {
  const items = [...progressSection.matchAll(/^\s*- \[([ xX])\]\s*(.*)$/gm)];
  const machine = items.filter(([, , text]) => !/^(?:\d+[.)]\s*)?\(human\)/.test(text ?? ""));
  if (machine.length === 0) return false;
  return machine.every(([, mark]) => mark !== " ");
}
