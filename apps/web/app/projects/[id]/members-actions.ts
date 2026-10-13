"use server";

/**
 * Ajustes → Agregar Miembro (spec 0128 E).
 *
 * Adds and removes people on a project. Two rules that are easy to get wrong and
 * expensive if you do:
 *
 *  - **Only a project owner may change membership** — and a control-plane OWNER,
 *    who can already see every project, for support. A plain member cannot grant
 *    access, otherwise "shared with one person" becomes "shared with everyone they
 *    know" and nobody can tell where it started.
 *  - **Existing users only.** An email with no account is refused rather than
 *    creating a row: inventing a user would be a silent invitation to an address
 *    nobody verified, and it would put that address on the sign-in allowlist.
 *
 * `removeProjectMember` refuses to remove the last owner (`@launchpad/db`), so
 * this cannot produce a project whose membership nobody may ever change again.
 */
import { revalidatePath } from "next/cache";
import {
  listProjectMembers,
  membershipFor,
  projectBySlug,
  putProjectMember,
  removeProjectMember,
  userIdsByEmail,
  type ProjectMemberRole,
} from "@launchpad/db";
import { currentViewer } from "../../viewer";
import { recordAudit } from "../../../lib/audit";
import { getDb } from "../../../lib/db";

export interface MemberActionResult {
  ok: boolean;
  problem?: string;
}

/** Resolve the project and confirm the caller may manage its members. */
async function requireProjectOwner(slug: string) {
  const viewer = await currentViewer();
  if (!viewer) return { ok: false as const, problem: "Sesión no válida." };
  const db = getDb();
  const project = await projectBySlug(db, slug);
  if (!project) return { ok: false as const, problem: `No existe el proyecto "${slug}".` };
  const membership = await membershipFor(db, project.id, viewer.userId);
  if (!viewer.isPlatformOwner && membership !== "owner") {
    return {
      ok: false as const,
      problem: "Solo un dueño del proyecto puede cambiar sus miembros.",
    };
  }
  return { ok: true as const, viewer, project, db };
}

export async function addProjectMemberAction(
  slug: string,
  email: string,
  role: ProjectMemberRole = "member",
): Promise<MemberActionResult> {
  const ctx = await requireProjectOwner(slug);
  if (!ctx.ok) return ctx;

  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized) return { ok: false, problem: "Escribe un correo." };
  if (role !== "owner" && role !== "member") return { ok: false, problem: "Rol no reconocido." };

  const ids = await userIdsByEmail(ctx.db, [normalized]);
  const userId = ids.get(normalized);
  if (!userId) {
    // Existing users only (see the module comment): this address is not on the
    // sign-in allowlist, and adding it here would put it there implicitly.
    return {
      ok: false,
      problem: `${normalized} no tiene cuenta todavía. Un administrador debe autorizarla antes de agregarla a un proyecto.`,
    };
  }

  await putProjectMember(ctx.db, { projectId: ctx.project.id, userId, role, addedBy: ctx.viewer.email });
  await recordAudit({
    actor: ctx.viewer.email,
    action: "project.member_added",
    target: slug,
    metadata: { member: normalized, role },
  });
  revalidatePath(`/projects/${slug}`);
  return { ok: true };
}

export async function removeProjectMemberAction(slug: string, email: string): Promise<MemberActionResult> {
  const ctx = await requireProjectOwner(slug);
  if (!ctx.ok) return ctx;

  const normalized = (email ?? "").trim().toLowerCase();
  const ids = await userIdsByEmail(ctx.db, [normalized]);
  const userId = ids.get(normalized);
  if (!userId) return { ok: false, problem: `${normalized} no es miembro de este proyecto.` };

  const result = await removeProjectMember(ctx.db, ctx.project.id, userId);
  if (!result.removed) {
    // The last-owner refusal lands here: a project with no owner could never have
    // its membership changed again.
    return {
      ok: false,
      problem:
        result.reason === "cannot remove the last owner of a project"
          ? "No puedes quitar al último dueño del proyecto."
          : `No se pudo quitar a ${normalized}.`,
    };
  }
  await recordAudit({
    actor: ctx.viewer.email,
    action: "project.member_removed",
    target: slug,
    metadata: { member: normalized },
  });
  revalidatePath(`/projects/${slug}`);
  return { ok: true };
}

/** The project's members, for the Ajustes list. Any member may see who else is on
 * their own project — hiding that from the people inside it protects nobody. */
export async function listProjectMembersAction(slug: string) {
  const viewer = await currentViewer();
  if (!viewer) return [];
  const db = getDb();
  const project = await projectBySlug(db, slug);
  if (!project) return [];
  const membership = await membershipFor(db, project.id, viewer.userId);
  if (!viewer.isPlatformOwner && !membership) return [];
  return listProjectMembers(db, project.id);
}
