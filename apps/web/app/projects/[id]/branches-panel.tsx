/**
 * Ramas & builds → the branch registry (spec 0134 F).
 *
 * Server component, the `members-panel.tsx` slot pattern: rows are read here
 * and passed down, so the browser learns this project's branches and nothing
 * else. The buttons' actions re-check membership themselves — hiding a form
 * is not a permission.
 *
 * The staging URL renders only for a `ready` stack; a `deploying`/`failed`/
 * `destroying` status is shown as itself rather than as a link that would 404
 * — an environment that appears only after it works is the point.
 */
import { listBranchesForProject, membershipFor, projectBySlug } from "@launchpad/db";
import { currentRole } from "../../auth";
import { capabilityDenial } from "../../../lib/capabilities";
import { Card } from "../../../components/ui";
import { getDb } from "../../../lib/db";
import { currentViewer } from "../../viewer";
import { BranchRowActions, CreateBranchForm } from "./branches-form";

const STATUS_LABEL: Record<string, string> = {
  none: "sin staging",
  deploying: "desplegando…",
  ready: "staging listo",
  failed: "staging falló",
  destroying: "destruyendo…",
};

const STATUS_CLASS: Record<string, string> = {
  none: "bg-surface text-muted",
  deploying: "bg-amber-500/10 text-amber-500",
  ready: "bg-emerald-500/10 text-emerald-500",
  failed: "bg-red-500/10 text-red-500",
  destroying: "bg-amber-500/10 text-amber-500",
};

export async function BranchesPanel({ slug }: { slug: string }) {
  const viewer = await currentViewer();
  if (!viewer) {
    return <Card className="p-6 text-center text-sm text-muted">Sesión no válida.</Card>;
  }

  let rows: Awaited<ReturnType<typeof listBranchesForProject>> = [];
  let isMember = false;
  // Spec 0166: promoting is OWNER-only, and this panel was the one promote
  // surface that never asked. Computed here, on the server, with the same
  // helper the action gates on.
  let promoteDenial: string | null = "Sign in with OWNER to do this.";
  let repoLinked = false;
  let isPlatform = false;
  try {
    const db = getDb();
    const project = await projectBySlug(db, slug);
    if (!project) {
      return (
        <Card className="p-6 text-sm text-muted">
          Este proyecto todavía no existe en el control plane, así que no tiene ramas.
        </Card>
      );
    }
    isPlatform = project.kind === "platform";
    repoLinked = Boolean(project.repoOwner && project.repoName);
    const mine = await membershipFor(db, project.id, viewer.userId);
    isMember = viewer.isPlatformOwner || mine !== null;
    promoteDenial = capabilityDenial(await currentRole(), "promote");
    rows = await listBranchesForProject(db, project.id);
  } catch {
    return <Card className="p-6 text-sm text-muted">No pudimos leer las ramas ahora mismo.</Card>;
  }

  if (isPlatform) {
    return (
      <Card className="p-6 text-sm text-muted">
        El proyecto plataforma usa el flujo por spec (PR por spec a <code>main</code>), no ramas.
      </Card>
    );
  }
  if (!repoLinked) {
    return (
      <Card className="p-6 text-sm text-muted">
        Vincula un repositorio al proyecto para poder crear ramas.
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <Card className="divide-y divide-border">
        {rows.length === 0 ? (
          <p className="p-4 text-[13px] text-muted">
            Sin ramas todavía — crea la primera abajo. Cada rama puede tener su propio servidor de
            staging, y se promueve completa a <code>main</code> cuando está validada.
          </p>
        ) : (
          rows.map((b) => (
            <div key={b.id} className="flex flex-wrap items-center gap-3 p-3.5 text-[13px]">
              <code className="min-w-0 flex-1 truncate text-foreground">{b.name}</code>
              {b.mergedAt ? (
                <span className="rounded-md bg-surface px-2 py-0.5 text-[11px] text-muted">
                  promovida
                </span>
              ) : (
                <span
                  className={`rounded-md px-2 py-0.5 text-[11px] ${STATUS_CLASS[b.stagingStatus] ?? STATUS_CLASS["none"]}`}
                >
                  {STATUS_LABEL[b.stagingStatus] ?? b.stagingStatus}
                </span>
              )}
              {b.stagingStatus === "ready" && b.stagingHost ? (
                <a
                  className="text-[12px] text-brand underline-offset-2 hover:underline"
                  href={`https://${b.stagingHost}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  abrir staging
                </a>
              ) : null}
              {b.prNumber ? (
                <span className="text-[11px] text-faint">PR #{b.prNumber}</span>
              ) : null}
              {/* Spec 0195 B: WHY the last staging op failed. Without it the
                  reviewer's only move was "Reintentar staging" and hope, with
                  the reason sitting in a worker journal they cannot read. */}
              {b.stagingNote ? (
                <span className="basis-full font-mono text-[11px] leading-relaxed text-amber-500">
                  {b.stagingNote}
                </span>
              ) : null}
              {/* Spec 0187 B: a MERGED branch keeps its actions row, for the one
                  action that still applies — tearing the server down. Before
                  this it rendered nothing, so a promoted branch's staging lived
                  forever with no way out of the UI, and two such leftovers are
                  what filled the box and refused `autopartes` at gate 2. */}
              {isMember ? (
                <BranchRowActions
                  slug={slug}
                  branch={b.name}
                  status={b.stagingStatus}
                  merged={Boolean(b.mergedAt)}
                  promoteDenial={promoteDenial}
                />
              ) : null}
            </div>
          ))
        )}
      </Card>

      {isMember ? (
        <CreateBranchForm slug={slug} />
      ) : (
        <p className="text-[11px] text-faint">Solo miembros del proyecto pueden crear ramas.</p>
      )}
    </div>
  );
}
