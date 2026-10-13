/**
 * Pure sort core for the client-side sortable spec inbox (spec 0032 item 1).
 * `SpecInboxTable` becomes a `"use client"` component holding sort state
 * (column + direction); the actual ordering lives here as a pure function so
 * it's unit-tested without rendering — same split as the rest of the apps/web
 * lib (derivePipelineState, tenant-start helpers).
 *
 * The page passes already-fetched rows as props; sorting is pure client-side
 * over loaded data (no new fetch). Default sort is id-descending.
 */

/** The four sortable columns on `/specs` (ID / Spec title / Status / Pipeline). */
export type SpecSortColumn = "id" | "title" | "status" | "pipeline";

export type SortDirection = "asc" | "desc";

/** Default sort on initial load (spec 0032 acceptance: id-descending). */
export const DEFAULT_SORT: { column: SpecSortColumn; direction: SortDirection } = {
  column: "id",
  direction: "desc",
};

/**
 * The minimal per-row keys sorting compares. The client component builds rows
 * that carry the full render data too (SpecSummary + pipeline view + progress);
 * the generic `<T extends SpecSortRow>` keeps those fields paired through the
 * sort so nothing drifts positionally.
 */
export interface SpecSortRow {
  id: string;
  title: string;
  status: string;
  /** The derived pipeline label (from `formatPipelineLabel`). */
  pipelineLabel: string;
}

/**
 * Toggle helper: clicking a header sorts by it; clicking the active column
 * flips direction. New column starts ascending (id starts descending to match
 * the default). Pure, so header-click behavior is unit-tested.
 */
export function nextSort(
  current: { column: SpecSortColumn; direction: SortDirection },
  clicked: SpecSortColumn,
): { column: SpecSortColumn; direction: SortDirection } {
  if (current.column === clicked) {
    return { column: clicked, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { column: clicked, direction: "asc" };
}

const SORT_KEY: Record<SpecSortColumn, (row: SpecSortRow) => string> = {
  id: (row) => row.id,
  title: (row) => row.title,
  status: (row) => row.status,
  pipeline: (row) => row.pipelineLabel,
};

/**
 * Returns a new array sorted by `column`/`direction` (stable, no mutation).
 * `id` compares as a string (locale-compare) — spec ids are zero-padded
 * (`0002`, `0010`) so lexicographic order matches numeric order; the other
 * columns are plain locale-compares over their display text.
 */
export function sortSpecRows<T extends SpecSortRow>(
  rows: T[],
  column: SpecSortColumn,
  direction: SortDirection,
): T[] {
  const key = SORT_KEY[column];
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => sign * key(a).localeCompare(key(b)));
}
