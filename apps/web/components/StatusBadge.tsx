// Imports the Node-free module directly (not "../lib/specs", which reads
// spec files off disk) — this component renders inside the client
// `SpecInboxTable` (spec 0032 item 1) and must stay out of that fs-touching
// module's import graph.
import { isKnownStatus, isLiveStatus } from "../lib/spec-status";
import { LiveValue } from "./LiveValue";

/** Maps a spec status to a semantic pill variant (spec 0024). Kept separate
 * from the accent hue: promoted reads "done" (green), in-flight statuses read
 * "info" (blue), draft is neutral, rejected is danger. Unknown statuses fall
 * back to the neutral pill but still carry data-known-status=false so they
 * stand out as unrecognized rather than blending in. */
/* Spec 0101: the same semantic mapping, expressed in the Mission Control
   template's badge idiom (`rounded-md border border-<c>/40 bg-<c>/10 px-2 py-1
   text-[11px] text-<c>`) instead of the retired `.pill` component class. Hue
   choices follow the template's own vocabulary: brand green = done, cyan =
   in-flight (it is the template's "Construyendo" colour), rose = failed, faint =
   neutral. */
const VARIANT: Record<string, string> = {
  promoted: "border-brand/40 bg-brand/10 text-brand",
  approved: "border-cyan/40 bg-cyan/10 text-cyan",
  staged: "border-cyan/40 bg-cyan/10 text-cyan",
  in_progress: "border-cyan/40 bg-cyan/10 text-cyan",
  draft: "border-border bg-surface text-faint",
  rejected: "border-rose/40 bg-rose/10 text-rose",
};
const NEUTRAL = "border-border bg-surface text-faint";

/** Renders a spec's status as a semantic pill. `liveDelay` is the server-
 * computed clock-synced negative `animation-delay` (DESIGN.md §4.2 #1
 * live-dot) — passed down from the inbox page so every live dot on the page,
 * and the same dot across a 3s poll re-render, stays phase-locked instead of
 * visibly restarting (same mechanism as the Hangar fleet dashboard, spec
 * 0040 Scope 3). Only applied while `status` is actually a live one
 * (in_progress) — a static status never gets the animation-delay style. The
 * label itself is wrapped in `LiveValue` so a status change on poll
 * (draft → in_progress → staged, etc.) crossfades via #13 pill-swap instead
 * of snapping. */
export function StatusBadge({ status, liveDelay }: { status: string; liveDelay?: string }) {
  const variant = VARIANT[status] ?? NEUTRAL;
  const live = isLiveStatus(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] ${variant}`}
      data-known-status={isKnownStatus(status)}
    >
      {/* `bg-current` inherits the variant's text colour, as the old `.pill .d`
          did; `mc-live-dot` is the template's own pulse (it replaces the legacy
          `live-dot` keyframe). */}
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current ${live ? "mc-live-dot" : ""}`}
        aria-hidden="true"
        style={live ? { animationDelay: liveDelay } : undefined}
      />
      <LiveValue value={status} mode="swap">
        {status}
      </LiveValue>
    </span>
  );
}
