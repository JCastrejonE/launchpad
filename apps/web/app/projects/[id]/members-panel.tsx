/**
 * Ajustes → Miembros (spec 0128 E).
 *
 * Server component, like `specs-tab.tsx` and `deployed-stacks-panel.tsx`: the
 * membership rows and the caller's own role are read here and passed down, so the
 * browser never learns who else exists in the control plane — only who is on this
 * project, which its members may legitimately see.
 *
 * `canManage` is resolved SERVER-side and used only to decide what to render. It is
 * not the security boundary: `addProjectMemberAction` / `removeProjectMemberAction`
 * re-check ownership themselves, because a server action is a public POST endpoint
 * and hiding a form is not a permission.
 */
import { listProjectMembers, membershipFor, projectBySlug } from "@launchpad/db";
import { Card } from "../../../components/ui";
import { getDb } from "../../../lib/db";
import { currentViewer } from "../../viewer";
import { AddMemberForm, RemoveMemberButton } from "./members-form";

export async function MembersPanel({ slug }: { slug: string }) {
  const viewer = await currentViewer();
  if (!viewer) {
    return <Card className="p-6 text-center text-sm text-muted">Sesión no válida.</Card>;
  }

  let rows: Awaited<ReturnType<typeof listProjectMembers>> = [];
  let canManage = false;
  let unavailable = false;
  try {
    const db = getDb();
    const project = await projectBySlug(db, slug);
    if (!project) {
      // A mockup project (no control-plane row) has nobody to manage. Saying so
      // beats an empty list that looks like "this project has no members".
      return (
        <Card className="p-6 text-sm text-muted">
          Este proyecto todavía no existe en el control plane, así que no tiene miembros.
        </Card>
      );
    }
    const mine = await membershipFor(db, project.id, viewer.userId);
    canManage = viewer.isPlatformOwner || mine === "owner";
    rows = await listProjectMembers(db, project.id);
  } catch {
    unavailable = true;
  }

  if (unavailable) {
    // Degrade, don't block (the chat-store contract, applied here): a DB blip
    // must not take the whole Ajustes tab down.
    return <Card className="p-6 text-sm text-muted">No pudimos leer los miembros ahora mismo.</Card>;
  }

  return (
    <div className="space-y-3">
      <Card className="divide-y divide-border">
        {rows.length === 0 ? (
          <p className="p-4 text-[13px] text-muted">Nadie más tiene acceso a este proyecto.</p>
        ) : (
          rows.map((m) => (
            <div key={m.userId} className="flex items-center gap-3 p-3.5 text-[13px]">
              <span className="min-w-0 flex-1 truncate text-foreground">{m.email}</span>
              <span
                className={`rounded-md px-2 py-0.5 text-[11px] ${
                  m.role === "owner" ? "bg-brand/10 text-brand" : "bg-surface text-muted"
                }`}
              >
                {m.role === "owner" ? "dueño" : "miembro"}
              </span>
              {m.email === viewer.email ? <span className="text-[11px] text-faint">tú</span> : null}
              {canManage ? <RemoveMemberButton slug={slug} email={m.email} /> : null}
            </div>
          ))
        )}
      </Card>

      {canManage ? (
        <AddMemberForm slug={slug} />
      ) : (
        <p className="text-[11px] text-faint">
          Solo un dueño del proyecto puede agregar o quitar miembros.
        </p>
      )}
    </div>
  );
}
