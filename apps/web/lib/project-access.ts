/**
 * May this person do this to this project? (spec 0128 C + D)
 *
 * Two questions, deliberately answered by two different systems:
 *
 *  1. **Membership** — is this project theirs to touch at all? Ours to decide,
 *     from `project_members`.
 *  2. **Repo write access** — may they cause commits in its repository? *GitHub's*
 *     to decide, and we only relay the answer.
 *
 * The second is not a permission we grant. That is the owner's model: a project can be
 * shared with someone before they have repo access, the project still shows on
 * their dashboard, and the refusal arrives when they try to *do* something —
 * telling them to request access from the repo's owners, which is the only place
 * that access can actually come from.
 *
 * Pure: every input is passed in, so each rule is testable without a database, a
 * session, or GitHub.
 */
import type { CollaboratorAccess } from "@launchpad/github";
import type { ProjectMemberRole } from "@launchpad/db";

/**
 * The account added as OWNER to every project, on creation (spec 0190).
 *
 * The owner: *"always add owner@example.com to every project as owner by default, this is
 * hard coded for now."* The symptom that prompted it: `client-b` was created
 * by another user, and spec 0168's membership boundary — correctly — made it
 * invisible to the person who runs the company and pays for the box.
 *
 * A MEMBERSHIP, deliberately, not a role escalation: `capabilities.ts` keeps its
 * two capabilities untouched, and every gate, audit row and refusal keeps working
 * exactly as written — it simply finds the owner listed.
 *
 * **Temporary, and this constant is the thing to delete.** It holds only while
 * v0 is five internal company people who all see everything. The first project
 * the company should NOT see — a customer's own staff, a contractor — makes it wrong.
 */
export const DEFAULT_PROJECT_OWNER = "owner@example.com";

export type AccessDecision =
  | { ok: true }
  | { ok: false; problem: string; needsRepoAccess?: boolean };

/** What a project must expose for these rules. */
export interface ProjectAccessFacts {
  slug: string;
  repoOwner?: string | null;
  repoName?: string | null;
}

/**
 * Membership check: can this person act on this project at all?
 *
 * A control-plane OWNER passes without a membership row — they can already SEE
 * every project (support), and a support path that requires adding yourself to a
 * project first is a support path nobody audits.
 */
export function memberMayAct(input: {
  membership: ProjectMemberRole | null;
  isPlatformOwner: boolean;
  slug: string;
}): AccessDecision {
  if (input.isPlatformOwner || input.membership) return { ok: true };
  return {
    ok: false,
    problem: `No eres miembro del proyecto "${input.slug}". Pide a un miembro que te agregue en Ajustes.`,
  };
}

/**
 * Repo-write check for an operation that will cause commits.
 *
 * `linkedRepo === false` (a project with no repo) passes: there is no repository
 * whose owners could grant anything, so refusing would be a permission nobody can
 * satisfy. `access === null` means we never asked — treated as a refusal, because
 * silently skipping the check is how an unauthorised push happens.
 */
export function repoWriteAllowed(input: {
  project: ProjectAccessFacts;
  githubLogin: string | null | undefined;
  access: CollaboratorAccess | null;
}): AccessDecision {
  const linked = Boolean(input.project.repoOwner && input.project.repoName);
  if (!linked) return { ok: true };

  if (!input.githubLogin?.trim()) {
    return {
      ok: false,
      needsRepoAccess: true,
      problem:
        "Tu cuenta aún no está vinculada a GitHub, así que no podemos verificar tu acceso al repositorio. Inicia sesión con GitHub.",
    };
  }
  if (!input.access) {
    return {
      ok: false,
      needsRepoAccess: true,
      problem: "No verificamos tu acceso al repositorio, así que no podemos continuar.",
    };
  }
  if (!input.access.canWrite) {
    return {
      ok: false,
      needsRepoAccess: true,
      problem: input.access.problem ?? "No tienes permiso de escritura en el repositorio del proyecto.",
    };
  }
  return { ok: true };
}

/**
 * Both checks, in the order that produces the more useful message: membership
 * first, because "you are not on this project" is a different (and more
 * actionable) sentence than "ask GitHub for write access" for someone who was
 * never added.
 */
export function projectOperationAllowed(input: {
  project: ProjectAccessFacts;
  membership: ProjectMemberRole | null;
  isPlatformOwner: boolean;
  githubLogin: string | null | undefined;
  access: CollaboratorAccess | null;
  /** False for read-only operations, which never need repo write. */
  writesToRepo: boolean;
}): AccessDecision {
  const member = memberMayAct({
    membership: input.membership,
    isPlatformOwner: input.isPlatformOwner,
    slug: input.project.slug,
  });
  if (!member.ok) return member;
  if (!input.writesToRepo) return { ok: true };
  return repoWriteAllowed(input);
}
