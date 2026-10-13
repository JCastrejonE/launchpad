/**
 * Project membership reads and writes (spec 0128 A).
 *
 * The scoping rule these implement: a project is visible to its members, and a
 * control-plane OWNER sees all of them. That second half is not a convenience —
 * someone has to be able to answer "why can't this customer's project be
 * reached?" without being added to it first, and a support path that requires
 * granting yourself access is a support path nobody audits.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./client.js";
import { projectMembers, projects, users } from "./schema.js";
import type { ProjectRow } from "./projects.js";

/** Membership role — deliberately NOT `users.role`'s vocabulary (see the table's
 * comment): `owner` may manage members, and says nothing about deploying. */
export type ProjectMemberRole = "owner" | "member";

export interface ProjectMemberRow {
  userId: string;
  email: string;
  name: string;
  role: ProjectMemberRole;
  addedBy: string;
  createdAt: Date;
}

/**
 * Projects this user may see: the ones they are a member of. Full stop, since
 * spec 0168 — there is no longer a control-plane role that sees every project.
 *
 * `opts.isPlatformOwner` is retained and ignored so the two call sites do not
 * have to change shape; delete it when something else touches them.
 */
export async function listProjectsFor(
  db: Db,
  userId: string,
  opts: { isPlatformOwner?: boolean } = {},
): Promise<ProjectRow[]> {
  // Spec 0168: no see-everything escape. This used to return every project when
  // the caller held the global OWNER role, which listed projects they could not
  // open once `isProjectMember` stopped honouring that role — and a list of
  // doors that do not open is worse than a shorter list. `opts` is kept so the
  // call site stays explicit about having considered it.
  void opts;
  const rows = await db
    .select({ project: projects })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, userId))
    .orderBy(projects.slug);
  return rows.map((r) => r.project);
}

/**
 * This user's role on this project, or null when they are not a member.
 *
 * Returns null for a control-plane OWNER who is not a member: "can they see it"
 * and "what is their role here" are different questions, and conflating them
 * would report an OWNER as this project's owner on every project in the install.
 */
export async function membershipFor(
  db: Db,
  projectId: string,
  userId: string,
): Promise<ProjectMemberRole | null> {
  const rows = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  const role = rows[0]?.role;
  return role === "owner" || role === "member" ? role : null;
}

/** Everyone on a project, with the identity a members list needs to render. */
export async function listProjectMembers(db: Db, projectId: string): Promise<ProjectMemberRow[]> {
  const rows = await db
    .select({
      userId: projectMembers.userId,
      email: users.email,
      name: users.name,
      role: projectMembers.role,
      addedBy: projectMembers.addedBy,
      createdAt: projectMembers.createdAt,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(users.email);
  return rows.map((r) => ({
    ...r,
    role: r.role === "owner" ? "owner" : "member",
  }));
}

/**
 * Add or update a membership. Idempotent by `(project, user)` — re-adding
 * someone who is already a member updates their role instead of failing, which
 * is what "Agregar Miembro" on an existing member should mean.
 */
export async function putProjectMember(
  db: Db,
  input: { projectId: string; userId: string; role: ProjectMemberRole; addedBy: string },
): Promise<void> {
  await db
    .insert(projectMembers)
    .values(input)
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: { role: input.role, addedBy: input.addedBy },
    });
}

/**
 * Remove a membership, refusing to remove the LAST owner.
 *
 * A project with no owner cannot have members added to it ever again — nobody
 * would hold the permission — so this returns `false` rather than creating a
 * state with no way out. Removing a plain member, or an owner while another
 * remains, succeeds.
 */
export async function removeProjectMember(
  db: Db,
  projectId: string,
  userId: string,
): Promise<{ removed: boolean; reason?: string }> {
  const current = await membershipFor(db, projectId, userId);
  if (!current) return { removed: false, reason: "not a member" };
  if (current === "owner") {
    const owners = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, "owner")));
    if (owners.length <= 1) {
      return { removed: false, reason: "cannot remove the last owner of a project" };
    }
  }
  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return { removed: true };
}

/** User ids for a set of emails — what "Agregar Miembro" resolves before adding.
 * An email with no account is simply absent: this spec adds existing users only,
 * and inventing a row for an unknown address would be a silent invitation. */
export async function userIdsByEmail(db: Db, emails: string[]): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.email, emails));
  return new Map(rows.map((r) => [r.email, r.id]));
}
