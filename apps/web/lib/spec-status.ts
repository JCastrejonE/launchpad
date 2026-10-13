/**
 * The spec status enum, split out from `lib/specs.ts` (spec 0032 item 1) so
 * it has zero Node built-in imports — `lib/specs.ts` reads spec files off
 * disk (`node:fs/promises`, `node:path`) and can never be pulled into a
 * client bundle, but `StatusBadge` (rendered inside the now-client
 * `SpecInboxTable`) needs `isKnownStatus` at render time. `lib/specs.ts`
 * re-exports these for every existing server-side import.
 */

/** Statuses the pipeline is known to emit. Anything else is still rendered
 * (see isKnownStatus) with a fallback badge — specs must never crash the
 * inbox just because a status value is new/unexpected. */
export const KNOWN_STATUSES = [
  "draft",
  "approved",
  "in_progress",
  "staged",
  "promoted",
  "rejected",
  // Spec 0122: Track-1 work is done without a pipeline promote. Two specs already
  // carried this value in frontmatter while the type did not allow it; this closes
  // that gap rather than rewriting them to a status they did not earn.
  "completed",
] as const;

export type KnownStatus = (typeof KNOWN_STATUSES)[number];

export function isKnownStatus(status: string): status is KnownStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(status);
}

/** Statuses that mean "the pipeline is actively mid-flight for this spec" —
 * DESIGN.md §4.2 #1 live-dot's "running pipeline" trigger, applied to the
 * inbox's per-row status pill (spec 0041 item 2; StatusBadge.tsx). Only
 * `in_progress` qualifies: draft/approved/staged are resting at a gate
 * waiting on a human, promoted/rejected are terminal — `in_progress` is the
 * one status that means a run is actually in flight for this spec. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["in_progress"]);

export function isLiveStatus(status: string): boolean {
  return LIVE_STATUSES.has(status);
}
