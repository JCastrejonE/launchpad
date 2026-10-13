/**
 * The Hangar VPS fleet, re-homed into the platform project's workspace (spec
 * 0085, C.4b — discharging the Q2-B promise made when spec 0080 took over `/`).
 *
 * **Server component on purpose.** The Hostinger token and the fleet SSH
 * identity resolve here and never cross to the browser; only rendered markup
 * does. That is the same discipline the old `/` page held (spec 0022) and the
 * reason this is passed into the client workspace as a slot rather than
 * imported by it.
 *
 * Two-speed data, preserved from the old page: `getFleetSafe()` +
 * `deployingSpecsByHost()` are fast visibility/list calls fetched up front for
 * every card, while the SSH-backed `getHostInventorySafe()` streams in behind a
 * per-card `<Suspense>` — so one slow host renders the rest of the fleet
 * immediately instead of blocking behind it.
 *
 * Restyled onto the mockup primitives (`Card`/`Label`/`Btn`). The parked markup
 * spoke the legacy `.kv`/`.pill`/`.muted` dialect, which would have put two
 * visual languages in one tab — and shrinking legacy-class usage is what C.4c
 * needs before the old `globals.css` layer can be dropped.
 *
 * Capability is unchanged: the deploy form still renders only for the sandbox
 * host, still posts to the OWNER-gated `startTenantPipelineAction`, and the
 * worker's `assertSandboxVps` (ADR-013) remains the real enforcement.
 */
import { Suspense } from "react";
import Link from "next/link";
import { Server, HardDrive } from "lucide-react";
import type { TenantStack, TenantStackStatus } from "@launchpad/fleet-hostinger";
import { deployingSpecsByHost, getFleetSafe, getHostInventorySafe } from "../../lib/fleet";
import type { FleetVps } from "../../lib/fleet";
import { startTenantPipelineAction } from "../../app/actions";
import { Card, Label } from "../ui";
import { DeployTenantForm } from "./DeployTenantForm";

/** Tenant-stack liveness → the mockup palette (was `.pill ok|mut|info`). */
function stackStatusColor(status: TenantStackStatus): string {
  if (status === "running") return "text-brand";
  if (status === "stopped") return "text-faint";
  return "text-cyan"; // unknown
}

/** VPS state → colour. `running` is the healthy steady state; transitional
 * states pulse (the mockup's `mc-live-dot`), matching the old #1 live-dot rule. */
function stateColor(state: FleetVps["state"]): string {
  if (state === "running") return "bg-brand";
  if (state === "error") return "bg-rose";
  if (state === "stopped" || state === "suspended" || state === "destroyed") return "bg-faint";
  return "bg-amber";
}

function isTransitional(state: FleetVps["state"]): boolean {
  return (
    state !== "running" &&
    state !== "error" &&
    state !== "stopped" &&
    state !== "suspended" &&
    state !== "destroyed"
  );
}

/** One host's live tenants+DBs. Its own async component so it can sit inside a
 * per-card `<Suspense>` (see the header note on two-speed data). */
async function HostInventory({ vps }: { vps: FleetVps }) {
  const inventory = await getHostInventorySafe(vps);

  if (!inventory.available) {
    return (
      <p className="mt-1 text-[11px] text-faint">
        {inventory.reason === "production"
          ? "Inventario en vivo no disponible — a los hosts de producción nunca se les hace SSH (ADR-013). Es por diseño, no una caída."
          : "Inventario en vivo no disponible — el SSH falló o expiró. Solo sandbox; reintenta en el siguiente poll."}
      </p>
    );
  }

  if (inventory.stacks.length === 0) {
    return <p className="mt-1 text-[11px] text-faint">Sin stacks desplegados en este host.</p>;
  }

  return (
    <div className="mt-1 space-y-1">
      {inventory.stacks.map((stack: TenantStack) => (
        <div key={stack.tenant} className="flex items-baseline gap-2 text-[11px]">
          <span className="text-foreground">{stack.tenant}</span>
          <span className={stackStatusColor(stack.status)}>{stack.status}</span>
          <span className="ml-auto truncate font-mono text-faint">
            {stack.dbs.length > 0 ? stack.dbs.join(", ") : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

export async function FleetSection() {
  const [fleet, deploying] = await Promise.all([getFleetSafe(), deployingSpecsByHost()]);

  if (!fleet.available) {
    return (
      <div>
        <Label>Flotilla VPS</Label>
        <Card className="p-6 text-center text-sm text-muted">
          No se pudo leer la flotilla.
          <span className="mt-1 block text-xs text-faint">{fleet.reason}</span>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <Label>Flotilla VPS · Hostinger</Label>
      <div className="space-y-3">
        {fleet.vps.map((v) => {
          const specs = deploying.get(v.id) ?? [];
          return (
            <Card key={v.id} className="p-4">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-purple" />
                <span className="text-[13px] text-foreground">{v.hostname}</span>
                <span className="font-mono text-[10px] text-faint">#{v.id}</span>
                <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${stateColor(v.state)} ${
                      isTransitional(v.state) ? "mc-live-dot" : ""
                    }`}
                  />
                  {v.state}
                </span>
              </div>

              <p className="mt-1 text-[11px] text-muted">
                {v.plan ?? "—"} · {v.ipv4 ?? "—"} ·{" "}
                <span className={v.classification === "sandbox" ? "text-brand" : "text-amber"}>
                  {v.classification}
                </span>
              </p>

              {specs.length > 0 && (
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                  Desplegando:
                  {specs.map((specId) => (
                    <Link
                      key={specId}
                      href={`/forge/specs`}
                      className="rounded border border-cyan/30 bg-cyan/10 px-1.5 py-0.5 text-cyan hover:bg-cyan/20"
                    >
                      {specId}
                    </Link>
                  ))}
                </p>
              )}

              <div className="mt-3 border-t border-border pt-2">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-faint">
                  <HardDrive className="h-3 w-3" /> Tenants en vivo
                </div>
                <Suspense
                  fallback={
                    <p className="mt-1 text-[11px] text-faint" role="status" aria-live="polite">
                      Leyendo inventario…
                    </p>
                  }
                >
                  <HostInventory vps={v} />
                </Suspense>
              </div>

              {/* Sandbox only — ADR-013. The worker re-checks; this is presentation. */}
              {v.classification === "sandbox" && (
                <DeployTenantForm vps={v} action={startTenantPipelineAction} />
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
