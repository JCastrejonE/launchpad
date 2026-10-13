/** File-backed spec store: specs/NNNN-slug.md with YAML-ish frontmatter. */
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { SpecStatus } from "./spec.js";

export async function findSpecFile(repoRoot: string, specId: string): Promise<string> {
  return findSpecFileInDir(path.join(repoRoot, "specs"), specId);
}

/**
 * Same lookup, given the specs DIRECTORY rather than a repo root (spec 0149).
 *
 * A project's specs live outside its repository (spec 0141), so `<root>/specs`
 * does not describe where they are — but the file layout inside the directory is
 * identical. Splitting the path assumption from the lookup lets both callers use
 * one implementation instead of two that can drift.
 */
export async function findSpecFileInDir(dir: string, specId: string): Promise<string> {
  const files = await readdir(dir);
  const match = files.find((f) => f.startsWith(`${specId}-`) && f.endsWith(".md"));
  if (!match) throw new Error(`No spec file for id ${specId} in ${dir}`);
  return path.join(dir, match);
}

export async function specFileExists(repoRoot: string, specId: string): Promise<boolean> {
  try {
    await findSpecFile(repoRoot, specId);
    return true;
  } catch {
    return false;
  }
}

export function parseStatus(md: string): SpecStatus {
  const m = md.match(/^status:\s*(\S+)\s*$/m);
  if (!m || !m[1]) throw new Error("Spec has no status field");
  return m[1] as SpecStatus;
}

/**
 * Reads the frontmatter `title:` line's value (spec 0042, PR-body item C) —
 * "" when absent, so callers can fall back to a bare `Spec <id>`. Unlike
 * `parseStatus` this never throws: a missing title is a normal, tolerated
 * state (older specs predate the field).
 */
export function readTitle(md: string): string {
  const m = md.match(/^title:\s*(.+?)\s*$/m);
  return m?.[1] ?? "";
}

/**
 * Reads the optional `ui_only: true` frontmatter flag (spec 0031). Absent,
 * `false`, or any non-`true` value ⇒ `false` (today's behavior, unchanged) —
 * only an explicit `ui_only: true` opts a spec into the leaner fast-path. Same
 * regex family as {@link parseStatus}; unrecognized-key tolerance in the rest
 * of the parser means existing specs are unaffected.
 *
 */
export function readUiOnly(md: string): boolean {
  return /^ui_only:\s*true\s*$/m.test(md);
}

/**
 * Whether a spec is archived (spec 0122) — hidden from the workspace's Specs list
 * without being deleted.
 *
 * In FRONTMATTER, not a table: PENDING §5's standing rule is *when the truth is
 * already in a file or in Temporal, add a reader, not a table*, and `spec_files`
 * still has no writer by design (spec 0104). Frontmatter also means archiving shows
 * up in a diff, is reviewable, and reverts like anything else in git.
 *
 * Same regex family as {@link readUiOnly}: absent or any other value ⇒ not archived,
 * so a malformed field can never hide a spec.
 */
export function readArchived(md: string): boolean {
  return /^archived:\s*true\s*$/m.test(md);
}

/**
 * Reads the optional `product: hangar | forge | both` frontmatter facet
 * (spec 0037 / ADR-019) — self-target runs only. Records which product a
 * self-run changes; INFORMATIONAL only this batch (no behavior branches on it).
 * Same regex family as {@link readUiOnly}; any absent/other value ⇒ `undefined`
 * (the field's "no facet declared" contract), consumed via
 * `provisionEphemeralEnv`'s activity OUTPUT onto `EphemeralEnv.product`.
 *
 */
export function readProduct(md: string): "hangar" | "forge" | "both" | undefined {
  const m = md.match(/^product:\s*(hangar|forge|both)\s*$/m);
  return m ? (m[1] as "hangar" | "forge" | "both") : undefined;
}

export async function setStatus(
  repoRoot: string,
  specId: string,
  status: SpecStatus,
): Promise<void> {
  await setStatusInDir(path.join(repoRoot, "specs"), specId, status);
}

/** Spec 0149: `setStatus` given the specs DIRECTORY — see `findSpecFileInDir`. */
export async function setStatusInDir(
  dir: string,
  specId: string,
  status: SpecStatus,
): Promise<void> {
  const file = await findSpecFileInDir(dir, specId);
  const md = await readFile(file, "utf8");
  parseStatus(md); // validate field exists
  await writeFile(file, md.replace(/^status:\s*\S+\s*$/m, `status: ${status}`));
}

/**
 * Sets or clears a spec's `archived:` frontmatter (spec 0122).
 *
 * Unlike {@link setStatus}, the field usually does NOT exist yet — `status:` is
 * written by every spec template, `archived:` is not — so this inserts it when
 * absent and rewrites it when present. Idempotent: archiving an archived spec
 * rewrites the same value rather than appending a second key, which is what makes
 * a double-click on the button harmless.
 *
 * Inserted immediately after `status:` rather than at the end of the block, so the
 * frontmatter stays in a predictable order and diffs stay small.
 */
export async function setArchived(
  repoRoot: string,
  specId: string,
  archived: boolean,
): Promise<void> {
  await setArchivedInDir(path.join(repoRoot, "specs"), specId, archived);
}

/** Spec 0154: `setArchived` given the specs DIRECTORY — see `findSpecFileInDir`. */
export async function setArchivedInDir(
  dir: string,
  specId: string,
  archived: boolean,
): Promise<void> {
  const file = await findSpecFileInDir(dir, specId);
  const md = await readFile(file, "utf8");
  if (/^archived:\s*\S+\s*$/m.test(md)) {
    await writeFile(file, md.replace(/^archived:\s*\S+\s*$/m, `archived: ${archived}`));
    return;
  }
  parseStatus(md); // validates there IS a frontmatter block to insert into
  await writeFile(file, md.replace(/^(status:\s*\S+\s*)$/m, `$1\narchived: ${archived}`));
}

const UNCHECKED_RE = /^\s*- \[ \]\s*(.*)$/gm;
// Optional list numbering ("10.", "3)") is allowed before the (human) marker —
// spec 0007's initializer wrote "- [ ] 10. (human) ..." and the stricter form
// counted it as normal work, looping coders until the maxIterations cap fired
// (2026-07-03). Keep in sync with apps/web/lib/specs.ts.
const HUMAN_ITEM_RE = /^\s*- \[ \] (?:\d+[.)]\s*)?\(human\)\s*(.*)$/gm;
/** Strips optional leading list numbering from an unchecked item's text. */
function stripNumbering(text: string): string {
  return text.replace(/^\d+[.)]\s*/, "");
}

/**
 * The markdown region the coder-loop counters scan. `## Progress` is the
 * canonical checklist (docs/SPEC_FORMAT.md); when that section exists AND
 * already holds checkbox items, only it is counted — so stray `- [ ]` bullets
 * in `## Plan`, `## Acceptance criteria`, or a handoff-log entry never inflate
 * the loop's fuel gauge. That dual-checklist drift (checkboxes duplicated into
 * `## Plan` that coders never tick) made `remaining` never reach 0, so every
 * such run burned two extra no-op "stall" coder sessions before falling through
 * to gate 2 (SPEC-ALIGNMENT §9.1). Falls back to the whole document when there
 * is no `## Progress` checklist yet, so a spec whose checkboxes live only in
 * `## Plan` (the older layout) still drives the loop.
 */
function checklistScope(md: string): string {
  const headingIndex = md.search(/^## Progress\s*$/m);
  if (headingIndex === -1) return md;
  const afterHeading = md.slice(headingIndex).replace(/^## Progress\s*$/m, "");
  const nextHeadingMatch = afterHeading.match(/^## /m);
  const section = nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index)
    : afterHeading;
  return /^\s*- \[[ xX]\]/m.test(section) ? section : md;
}

/**
 * Unchecked "- [ ]" items the coder loop must action — the loop's fuel gauge.
 * Excludes `(human)`-marked items (a human-only marker, see
 * docs/SPEC_FORMAT.md): those require a human action (e.g. clicking a gate)
 * and must never block or be picked up by the coder loop.
 */
export function countUnchecked(md: string): number {
  let count = 0;
  for (const m of checklistScope(md).matchAll(UNCHECKED_RE)) {
    if (!stripNumbering(m[1] ?? "").startsWith("(human)")) count++;
  }
  return count;
}

const CHECKED_RE = /^\s*- \[x\]\s*/gim;
/**
 * Checked "- [x]" items in the spec (Plan/Progress). Compared before/after a
 * coder session (delta) to tell a real checkbox change apart from a
 * handoff-only commit — the spec 0008 stall-detection seam (progress.ts).
 */
export function countChecked(md: string): number {
  return [...checklistScope(md).matchAll(CHECKED_RE)].length;
}

/**
 * Unchecked "- [ ] (human)" items — human-only steps (e.g. clicking a gate)
 * that a coder must never pick up. Surfaced at gate 2 / in the PR body.
 */
export function countHumanPending(md: string): number {
  return [...checklistScope(md).matchAll(HUMAN_ITEM_RE)].length;
}

/**
 * The most recent `## Handoff log` entry, for stall/budget failure messages
 * and the PR body. Entries are top-level "- " bullets (each starting with
 * "- **<date> / <role>:**"); wrapped continuation lines are indented without
 * a leading "- " and belong to the preceding bullet. Returns "" if there is
 * no `## Handoff log` section or it has no entries.
 */
export function lastHandoffEntry(md: string): string {
  const headingIndex = md.search(/^## Handoff log\s*$/m);
  if (headingIndex === -1) return "";
  const afterHeading = md.slice(headingIndex).replace(/^## Handoff log\s*$/m, "");
  const nextHeadingMatch = afterHeading.match(/^## /m);
  const section = nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index)
    : afterHeading;
  const entries = section
    .split(/\n(?=- )/)
    .map((e) => e.trim())
    .filter(Boolean);
  return entries.length > 0 ? (entries[entries.length - 1] ?? "") : "";
}

/**
 * The FIRST paragraph of the `## Intent` section, byte-verbatim (spec 0042,
 * PR-body item C) — the PR body's deterministic "goal" line, no LLM
 * paraphrase. Section-sliced the same way {@link lastHandoffEntry} slices
 * `## Handoff log` (up to the next `## ` heading or end of file); the
 * paragraph itself is everything from the section's first non-blank line up
 * to the first blank line (or the section's end), trimmed at the ends only
 * — internal line breaks are preserved as written. "" when the section is
 * absent or empty.
 */
export function intentGoal(md: string): string {
  const headingIndex = md.search(/^## Intent\s*$/m);
  if (headingIndex === -1) return "";
  const afterHeading = md.slice(headingIndex).replace(/^## Intent\s*$/m, "");
  const nextHeadingMatch = afterHeading.match(/^## /m);
  const section = nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index)
    : afterHeading;
  const fromFirstLine = section.replace(/^\n+/, "");
  const blankLineMatch = fromFirstLine.match(/\n[ \t]*\n/);
  const paragraph = blankLineMatch ? fromFirstLine.slice(0, blankLineMatch.index) : fromFirstLine;
  return paragraph.trim();
}

/**
 * The text of each checked "- [x]" item INSIDE the `## Progress` section only
 * (spec 0042, PR-body item C) — section-sliced the same way
 * {@link lastHandoffEntry} slices `## Handoff log`, so checked items in any
 * other section (e.g. a historical `## Plan`) never leak in. Wrapped
 * continuation lines are folded into the item's single whitespace-collapsed
 * line, mirroring how the PR body renders a "Key changes" bullet list. `[]`
 * when the section is absent or has no checked items.
 */
export function completedProgressItems(md: string): string[] {
  const headingIndex = md.search(/^## Progress\s*$/m);
  if (headingIndex === -1) return [];
  const afterHeading = md.slice(headingIndex).replace(/^## Progress\s*$/m, "");
  const nextHeadingMatch = afterHeading.match(/^## /m);
  const section = nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index)
    : afterHeading;
  const entries = section
    .split(/\n(?=\s*- )/)
    .map((e) => e.trim())
    .filter(Boolean);
  const items: string[] = [];
  for (const entry of entries) {
    const m = entry.match(/^-\s*\[x\]\s*([\s\S]*)$/i);
    if (!m) continue;
    const folded = (m[1] ?? "").replace(/\s+/g, " ").trim();
    if (folded) items.push(folded);
  }
  return items;
}

export async function uncheckedItems(repoRoot: string, specId: string): Promise<number> {
  const file = await findSpecFile(repoRoot, specId);
  return countUnchecked(await readFile(file, "utf8"));
}

/**
 * Per-item model routing tag (spec 0007). The initializer tags each plan item
 * `[docs]` (pure documentation — cheap to run on a smaller model) or `[code]`
 * (implementation — the coder default). Untagged items are treated as
 * `"code"` so routing never downgrades an unmarked item.
 */
export type PlanItemTag = "docs" | "code";

export interface PlanItem {
  /** The item text with the `[docs]`/`[code]` tag stripped. */
  text: string;
  /** Parsed routing tag; `"code"` when absent (safe default). */
  tag: PlanItemTag;
}

/**
 * The first unchecked, non-`(human)` plan item — the one a coder session will
 * pick up next — with its `[docs]`/`[code]` routing tag parsed out, so
 * `runCoder` can resolve the model for that item before spawning the session
 * (spec 0007). Returns null when no actionable item remains.
 */
export function firstUncheckedPlanItem(md: string): PlanItem | null {
  for (const m of checklistScope(md).matchAll(UNCHECKED_RE)) {
    // Numbered plan items ("- [ ] 10. (human)", "- [ ] 1. [code] ...") must
    // parse the same as unnumbered ones — see HUMAN_ITEM_RE's regression note.
    const raw = stripNumbering((m[1] ?? "").trim());
    if (raw.startsWith("(human)")) continue;
    const tagMatch = raw.match(/^\[(docs|code)\]\s*(.*)$/);
    if (tagMatch) {
      return { text: (tagMatch[2] ?? "").trim(), tag: tagMatch[1] as PlanItemTag };
    }
    return { text: raw, tag: "code" };
  }
  return null;
}
