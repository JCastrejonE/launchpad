/**
 * Server-rendered list of what is actually deployed on the fleet (spec 0121),
 * passed into the client workspace as a slot.
 *
 * A SLOT, not an import, for the same reason `FleetSection` is one: this needs the
 * Hostinger token and the SSH identity, which must never reach the client bundle.
 *
 * Reuses `getFleetSafe`/`getHostInventorySafe` rather than opening its own SSH —
 * those already carry the ADR-013 guard (a production host is never SSH'd, even
 * read-only) and already degrade to "unavailable" instead of throwing.
 */
import { getFleetSafe, getHostInventorySafe } from "@/lib/fleet";
import { deriveDeployedStacks, stacksForProject, type DeployedStackView } from "@/lib/deployed-stacks";
import { Card, Label } from "@/components/ui";
import { ExternalLink } from "lucide-react";

export async function DeployedStacksPanel({ slug }: { slug: string }) {
  const fleet = await getFleetSafe();
  if (!fleet.available) {
    return (
      <Card className="p-6 text-sm text-muted">
        Inventario de la flotilla no disponible ({fleet.reason}). No se inventa nada aquí.
      </Card>
    );
  }

  const views: DeployedStackView[] = [];
  let unreadable = 0;
  for (const vps of fleet.vps) {
    const inventory = await getHostInventorySafe(vps);
    if (!inventory.available) {
      // A production host is never SSH'd (ADR-013), so this is expected, not an error.
      if (inventory.reason !== "production") unreadable += 1;
      continue;
    }
    // Spec 0181: this project's environments, not the box's.
    views.push(...deriveDeployedStacks(stacksForProject(inventory.stacks, slug)));
  }

  if (views.length === 0) {
    return (
      <Card className="p-6 text-sm text-muted">
        Este proyecto no tiene entornos desplegados en los VPS que podemos inspeccionar
        {unreadable > 0 ? ` (${unreadable} host(s) no legibles)` : ""}.
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Label>Entornos desplegados · leídos del VPS</Label>
      <Card className="divide-y divide-border">
        {views.map((v) => (
          <div key={v.label} className="flex flex-wrap items-center gap-3 p-4">
            <div className="mr-auto">
              <p className="text-[13px] text-foreground">{v.label}</p>
              <p className="mt-0.5 text-[11px] text-faint">
                {v.kind === "staging" ? "staging por spec" : v.kind === "tenant" ? "entorno de tenant" : "sin identificar"}
                {v.dbs.length > 0 ? ` · ${v.dbs.join(", ")}` : " · sin BD legible"}
              </p>
            </div>
            <span
              className={`rounded border px-2 py-0.5 text-[10px] ${
                v.status === "running"
                  ? "border-brand/30 bg-brand/10 text-brand"
                  : "border-border bg-surface text-muted"
              }`}
            >
              {v.status}
            </span>
            {v.href ? (
              <a
                className="inline-flex items-center gap-1 text-[12px] text-foreground hover:text-brand"
                href={v.href}
                target="_blank"
                rel="noreferrer"
              >
                {v.host} <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <span className="text-[12px] text-muted">{v.host ?? "—"}</span>
            )}
          </div>
        ))}
      </Card>
      {views.some((v) => v.note) && (
        <p className="text-[11px] text-faint">
          {views.find((v) => v.note)?.note}
        </p>
      )}
    </div>
  );
}
