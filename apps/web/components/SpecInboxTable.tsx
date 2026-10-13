"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { SpecSummary } from "../lib/specs";
import { DEFAULT_SORT, nextSort, sortSpecRows, type SpecSortColumn } from "../lib/spec-sort";
import { StatusBadge } from "./StatusBadge";

/** A pre-formatted pipeline column value — plain/serializable so this client
 * component never needs to import `lib/pipeline` (which pulls in
 * `@temporalio/client`, a server-only dependency that breaks the client
 * webpack bundle). The server page computes this via `formatPipelineLabel`. */
export interface PipelineLabelView {
  label: string;
  unknown: boolean;
}

/**
 * The ID/Title/Status/Pipeline list on the spec inbox (`/specs`) — a client
 * component (spec 0032 item 1) so it can hold its own sort state over the
 * already-fetched rows the server component passes in (no new fetch per
 * click). `pipelineLabels[i]` pairs positionally with `specs[i]` (same
 * contract as before: one `getPipelineViewStateSafe` call per spec on the
 * server, `null` on failure, pre-formatted to "Unknown" via
 * `formatPipelineLabel`).
 *
 * Spec 0024: rendered as a `.panel` of clickable `.row`s (each an anchor to
 * the spec detail page) instead of a bare `<table>`, styled by the design
 * system in globals.css.
 */
const COLUMNS: { key: SpecSortColumn; label: string }[] = [
  { key: "id", label: "ID" },
  { key: "title", label: "Spec" },
  { key: "status", label: "Status" },
  { key: "pipeline", label: "Pipeline" },
];

// Spec 0101: the `.panel`/`.row` component classes are retired. The grid tracks
// (and the old @media rule that dropped the pipeline + chevron columns on narrow
// screens) are now Tailwind responsive variants on this one shared string.
const ROW =
  "grid grid-cols-[52px_1fr_110px] items-center gap-4 px-5 md:grid-cols-[66px_1fr_140px_150px_40px]";
const HEAD_CELL =
  "inline-flex cursor-pointer select-none items-center gap-1 text-[11px] font-semibold uppercase " +
  "tracking-[0.08em] text-faint hover:text-foreground focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-border-strong";

export function SpecInboxTable({
  specs,
  pipelineLabels,
  liveDelay,
}: {
  specs: SpecSummary[];
  pipelineLabels: PipelineLabelView[];
  /** Server-computed clock-synced negative `animation-delay` (DESIGN.md
   * §4.2 #1 live-dot) — see SpecInboxPoller/page.tsx for why this is
   * computed once per request rather than per row. */
  liveDelay: string;
}) {
  const [sort, setSort] = useState(DEFAULT_SORT);

  const rows = useMemo(
    () =>
      specs.map((spec, i) => {
        const view = pipelineLabels[i] ?? { label: "Unknown", unknown: true };
        return {
          spec,
          view,
          id: spec.id,
          title: spec.title,
          status: spec.status,
          pipelineLabel: view.label,
        };
      }),
    [specs, pipelineLabels],
  );

  const sorted = useMemo(
    () => sortSpecRows(rows, sort.column, sort.direction),
    [rows, sort],
  );

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className={`${ROW} border-b border-border bg-surface py-3`}>
        {COLUMNS.map(({ key, label }) => {
          const active = sort.column === key;
          return (
            <span
              key={key}
              className={`${HEAD_CELL} ${active ? "text-foreground" : ""} ${
                key === "pipeline" ? "hidden md:inline-flex" : ""
              }`}
              role="button"
              tabIndex={0}
              onClick={() => setSort((current) => nextSort(current, key))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSort((current) => nextSort(current, key));
                }
              }}
              aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
            >
              {label}
              {active && (
                <span className="text-[9px]" aria-hidden="true">
                  {sort.direction === "asc" ? "▲" : "▼"}
                </span>
              )}
            </span>
          );
        })}
        <span className="hidden md:inline" />
      </div>
      {sorted.map(({ spec, view, pipelineLabel }) => {
        // Inlined rather than imported from `lib/specs#progressPercent`: that
        // module reads spec files from disk (node:fs) and must never enter
        // the client bundle. Same guard-and-round formula.
        const { checked, total } = spec.progress;
        const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
        return (
          <Link
            key={spec.filename}
            href={`/forge/specs/${spec.filename}`}
            className={`${ROW} group border-b border-border py-4 text-foreground transition-colors last:border-b-0 hover:bg-card-hover`}
          >
            <div className="tabular-nums text-[13px] text-muted">{spec.id}</div>
            <div className="flex flex-col gap-1 font-medium tracking-[-0.01em] text-foreground">
              <span className="flex items-baseline gap-2">
                {spec.title}
                {spec.progress.total > 0 && (
                  <span className="text-[11.5px] font-semibold tabular-nums text-faint">{pct}%</span>
                )}
              </span>
              {/* #4 progress-fill (DESIGN.md §4.2): a plain CSS width
                  TRANSITION on the same DOM node across the 3s poll re-render
                  (SpecInboxPoller) — never a keyframe, so it's interruptible
                  and needs no remount trick. `transition-[width]` keeps that
                  property after the restyle. */}
              {spec.progress.total > 0 && (
                <span className="block h-[3px] overflow-hidden rounded-full bg-surface" aria-hidden="true">
                  <span
                    className="block h-full rounded-[inherit] bg-brand transition-[width] duration-500 ease-out"
                    style={{ width: `${pct}%` }}
                  />
                </span>
              )}
            </div>
            <div>
              <StatusBadge status={spec.status} liveDelay={liveDelay} />
              {spec.product && (
                <span className="ml-2 inline-flex items-center rounded-md border border-border bg-surface px-2 py-1 text-[10.5px] uppercase text-faint">
                  {spec.product}
                </span>
              )}
            </div>
            <div
              className={`hidden tabular-nums text-[12.5px] md:block ${
                view.unknown ? "text-amber italic" : "text-muted"
              }`}
            >
              {pipelineLabel}
            </div>
            <div
              className="hidden justify-self-end text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-foreground md:block"
              aria-hidden="true"
            >
              <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
