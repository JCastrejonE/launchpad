// Pure summary computation for the Hangar dashboard's live summary strip
// (spec 0040 Scope 1). Restrained live state — NOT the hero-metric template
// (DESIGN.md §6 ban): small, calm numbers rendered with `tabular-nums`.
//
// Derived entirely from data the `/` server component already has:
//   - hosts up / total   ← the fleet VPS list (synchronous, never SSH)
//   - active deploys      ← the deployingSpecsByHost map (synchronous)
//   - tenants running     ← per-host live inventory (SSH-streamed per card, so
//                           it may not be resolved when the strip first paints;
//                           `tenantsRunning: null` renders as "—" until known)
//
// Kept pure + unit-tested so the counts can never drift from the cards below.

export interface FleetSummary {
  /** VPSes in the `running` state. */
  hostsUp: number;
  /** Total VPSes on the account. */
  hostsTotal: number;
  /** Distinct specs currently deploying into any host. */
  activeDeploys: number;
  /**
   * Running tenant stacks across all hosts, or `null` when the SSH-backed
   * live inventory has not resolved yet (the strip shows "—" until then).
   */
  tenantsRunning: number | null;
}

/**
 * Compute the summary-strip counts from the page's already-fetched data.
 * `deployingByHost` is keyed by VPS id → spec ids deploying into it; a spec
 * targets exactly one host, so the active-deploy count is the flattened total.
 */
export function summarizeFleet(
  vps: ReadonlyArray<{ state: string }>,
  deployingByHost: ReadonlyMap<number, ReadonlyArray<string>>,
  tenantsRunning: number | null = null,
): FleetSummary {
  let activeDeploys = 0;
  for (const specIds of deployingByHost.values()) activeDeploys += specIds.length;
  return {
    hostsUp: vps.filter((v) => v.state === "running").length,
    hostsTotal: vps.length,
    activeDeploys,
    tenantsRunning,
  };
}
