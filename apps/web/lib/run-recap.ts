/**
 * The four-part recap — did / found / next / needs-you — for one spec (spec 0112).
 *
 * The owner wanted the end-of-session narrative these terminal sessions produce, visible
 * in the product so progress can be retaken cold.
 *
 * **Assembled, not authored, and not stored.** The authored narrative already lives
 * in the spec's `## Handoff log`: every role appends an entry (`agents/coder.md`
 * step 6, `fixer.md` step 4) and the convention closes it
 * with `Next:` / `Surprises:` (`agents/HANDOFF.md`) — followed in practice by 63 and
 * 49 specs respectively. `parseHandoffEntry` already extracts all three parts. So a
 * recap is a *presentation* of judgment that is already durable and git-tracked;
 * storing a snapshot would duplicate a version-controlled file.
 *
 * That is the same conclusion specs 0104 (no `spec_files` writer) and 0107 (no
 * `next_step` column) reached: **when the truth is already in a file or in Temporal,
 * add a reader, not a table.**
 *
 * No model call. The agents wrote the prose; paraphrasing it with another model
 * would add cost and latency for a chance to distort what they actually said.
 *
 * PURE: a function of parsed entries the caller already has, so every branch is
 * unit-testable with no fs, no DB and no network.
 */
import type { HandoffEntryParts } from "./specs";
import type { NextStep } from "./next-step";

/** How many entries/surprises a recap shows. Handoff entries in this repo run to
 * paragraphs, and spec 0109 already found that long text defeats scanning in a
 * summary card — the same failure would apply here, worse. */
export const RECAP_CAP = 3;

export interface RunRecapInput {
  /** This spec's handoff entries in DOCUMENT order, already through
   * `parseHandoffEntry`. This function sorts them; see {@link sortNewestFirst}. */
  entries: HandoffEntryParts[];
  /**
   * The live next step from spec 0107's `deriveNextStep`.
   *
   * Deliberately NOT read out of the prose. A `Next:` field records what an agent
   * thought when it wrote the entry; this records what is actually outstanding now.
   * A stale actionable line is worse than none — that is precisely the failure spec
   * 0109 defect 1 produced when a promoted spec's pending item stayed hidden.
   */
  nextStep: NextStep;
}

export interface RunRecap {
  /** Entry leads ("date / role / first clause"), newest first, capped. */
  did: string[];
  /** `Surprises:` fields — the part most worth surfacing, since it is where an
   * agent recorded what would otherwise be lost. Capped. */
  found: string[];
  /** The newest entry's `Next:` field, if it has one. */
  next?: string;
  /** What needs a human right now — from `deriveNextStep`, never from prose.
   * Absent when nothing is outstanding. */
  needsYou?: string;
  /** True when there is no handoff log at all: render an honest empty state rather
   * than inventing narrative. */
  empty: boolean;
}

/**
 * Newest first, by the `YYYY-MM-DD` that opens each entry's lead.
 *
 * Do NOT trust document order, in either direction. `agents/HANDOFF.md` says
 * sessions "append", but agents in practice PREPEND (spec 0107's log runs coder
 * item 4 → 3 → 2 → 1 top-down) while hand-authored and later-added entries land
 * wherever their author put them — spec 0105's log reads 07-29, 07-30, 07-29 in
 * file order. So neither the order nor its reverse is chronological, which is
 * exactly the bug the first render of this card showed: it led with the
 * initializer's oldest entry.
 *
 * Undated leads keep their relative position (stable sort) rather than being
 * dropped or floated — an entry without a date is still something that happened.
 */
function sortNewestFirst(entries: HandoffEntryParts[]): HandoffEntryParts[] {
  const dateOf = (e: HandoffEntryParts): string => e.lead.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
  return entries
    .map((e, i) => ({ e, i, d: dateOf(e) }))
    .sort((a, b) => (a.d === b.d ? a.i - b.i : b.d.localeCompare(a.d)))
    .map((x) => x.e);
}

/** Pull one labelled field out of a parsed entry's `fields` (case-insensitive,
 * since the convention is written by hand). */
function field(entry: HandoffEntryParts | undefined, key: string): string | undefined {
  const hit = entry?.fields.find((f) => f.key.toLowerCase() === key.toLowerCase());
  const value = hit?.value.trim();
  return value ? value : undefined;
}

/** Build the recap. See the module doc for why each part comes from where. */
export function deriveRunRecap(input: RunRecapInput): RunRecap {
  const { nextStep } = input;
  const entries = sortNewestFirst(input.entries);
  const did = entries.slice(0, RECAP_CAP).map((e) => e.lead.trim()).filter(Boolean);
  const found = entries
    .map((e) => field(e, "Surprises"))
    .filter((s): s is string => s !== undefined)
    .slice(0, RECAP_CAP);
  const next = field(entries[0], "Next");
  // `kind: "none"` is deriveNextStep's honest terminal state ("Nothing to do") —
  // surfacing it as a call to action would manufacture work.
  const needsYou = nextStep.kind === "none" ? undefined : nextStep.label;
  return {
    did,
    found,
    ...(next ? { next } : {}),
    ...(needsYou ? { needsYou } : {}),
    empty: entries.length === 0,
  };
}
