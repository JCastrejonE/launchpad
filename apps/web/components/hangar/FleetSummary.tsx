// Hangar dashboard live summary strip (spec 0040 Scope 1). Restrained live
// state — hosts up / tenants running / active deploys — pulled from data the
// `/` server component already has (see lib/fleet-summary.ts). NOT the
// hero-metric template (DESIGN.md §6 ban): small, calm numbers with
// `tabular-nums`; it earns its place because it is REAL live state.
//
// STUB (initializer, spec 0040): the coder wiring Scope 1 renders the strip
// here from the `FleetSummary` object and adds the token-based `.fleet-summary`
// styles in globals.css. Kept a server component (no client state) — the numbers
// come from the server render; #5 value-flash on change is layered via the
// LiveValue client wrapper where a value updates on the 3s poll.
import type { FleetSummary } from "../../lib/fleet-summary";

// Spec 0101: restyled off the `.fleet-summary*` component classes onto the
// template's tokens. `tabular-nums` is retained deliberately — it is why the
// numbers don't jiggle on the 3s poll (the whole point of the original rule).
function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-lg font-semibold tabular-nums text-foreground">{value}</span>
      <span className="text-xs text-faint">{label}</span>
    </div>
  );
}

export function FleetSummary({ summary }: { summary: FleetSummary }) {
  const { hostsUp, hostsTotal, tenantsRunning, activeDeploys } = summary;
  return (
    <div
      className="mb-2 flex flex-wrap gap-8 border-b border-border pt-3 pb-5"
      role="status"
      aria-label="Fleet summary"
    >
      <Stat value={`${hostsUp}/${hostsTotal}`} label="hosts up" />
      <Stat value={tenantsRunning ?? "—"} label="tenants running" />
      <Stat value={activeDeploys} label="active deploys" />
    </div>
  );
}
