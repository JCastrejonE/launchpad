/**
 * Pure decision for the spec-detail page when a BARE id (no `.md`) does NOT
 * resolve to a spec file yet (spec 0029 Part B). During the async `draftSpec`
 * window a UI-started `target: tenant` run (specs 0027/0028) has a live
 * `spec-<id>` workflow but no `specs/NNNN-<slug>.md` on disk yet — the page
 * must show a "Drafting spec…" state that auto-refreshes into the real spec
 * page once Part A commits the file, INSTEAD of a 404 for the whole draft
 * window. A genuinely-missing spec (no file AND no live workflow) still 404s.
 *
 * Split out as a pure function (no I/O) so the drafting-vs-notFound rule is
 * unit-tested without a live Temporal server (spec 0029 Part B tests). The
 * page wires it up: bare id + `resolveSpecFilenameById` → null +
 * `getPipelineViewStateSafe(id, ...)` → this decision.
 */
import type { PipelineViewState } from "./pipeline";

export type UnresolvedSpecDecision = "drafting" | "not_found";

/**
 * Given the pipeline view state for a bare id whose spec file does NOT resolve
 * yet, decide whether to render the "Drafting spec…" state or 404.
 *
 * "drafting" only when a live workflow is genuinely in progress — `running`
 * or `waiting_at_gate` (the async `draftSpec` window, or parked at gate 1
 * before Part A's commit has landed). Everything else falls back to
 * "not_found": `null` (no workflow reachable at all), `not_started` (no
 * workflow yet), and every terminal state (`completed`, `failed`,
 * `promoted_teardown_failed`, `unknown_legacy_run`) — a closed run that still
 * left no spec file on disk is a genuine miss, not a draft-in-progress, so it
 * 404s like any other missing spec rather than showing "Drafting spec…"
 * forever.
 */
export function decideUnresolvedSpecView(
  view: PipelineViewState | null,
): UnresolvedSpecDecision {
  if (view && (view.state === "running" || view.state === "waiting_at_gate")) {
    return "drafting";
  }
  return "not_found";
}
