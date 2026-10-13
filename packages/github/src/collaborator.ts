/**
 * Does THIS PERSON have write access to this repo? (spec 0128 C)
 *
 * The obvious implementation — ask GitHub using the user's own OAuth token —
 * would force that token to carry the `repo` scope, because a narrower token
 * cannot even see a private repository (GitHub 404s it). And `repo` grants write
 * access to *every* private repo the person can reach, far beyond the ones we
 * know about, which makes it the most dangerous thing this app could store.
 *
 * So the question is asked the other way round: the SERVER token, which already
 * has access to the repos we manage, asks GitHub what permission a given
 * username holds. Same answer, and user tokens stay at `read:user user:email`.
 *
 * `GET /repos/{owner}/{repo}/collaborators/{username}/permission`
 *
 * The trade, stated: this can only answer for repos the server token can see.
 * That is not a real limit here — a repo the server cannot see is one the
 * pipeline could not run on either — but it does mean "unknown" and "no access"
 * must stay distinguishable, which is why `reachable` exists below.
 */

/** GitHub's permission ladder for a collaborator on a repo. */
export type CollaboratorPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export interface RawCollaboratorPermission {
  permission?: string;
  /** Newer field; `permission` remains for compatibility. */
  role_name?: string;
}

export interface CollaboratorAccess {
  /** Whether we could ask at all (the server token can see the repo). */
  reachable: boolean;
  permission: CollaboratorPermission;
  /** `admin`, `maintain` and `write` can push; `triage` and `read` cannot. */
  canWrite: boolean;
  /** Ready to show a user, or null when they can write. */
  problem: string | null;
}

/** Permissions that allow pushing. `triage` is deliberately absent: it can manage
 * issues and PRs but not write code, and treating it as write would let someone
 * start a run that cannot possibly land. */
const WRITE_LEVELS: ReadonlySet<string> = new Set(["admin", "maintain", "write"]);

/** When GitHub cannot be asked — the repo is invisible to the server token, or the
 * call failed in a way that is not a clean "no". Never reported as "no access":
 * telling someone they lack permission when we simply could not check would send
 * them to argue with a repo owner about a problem that is ours. */
export const COLLABORATOR_UNKNOWN: CollaboratorAccess = {
  reachable: false,
  permission: "none",
  canWrite: false,
  problem: "No pudimos verificar tu acceso al repositorio (no lo alcanzamos desde el servidor).",
};

/** Judge a collaborator-permission payload. Pure. */
export function interpretCollaboratorPermission(
  raw: RawCollaboratorPermission,
  username: string,
): CollaboratorAccess {
  // `role_name` is the more precise field when present (it distinguishes
  // `maintain`/`triage`, which `permission` flattens into write/read).
  const level = (raw.role_name ?? raw.permission ?? "none").trim().toLowerCase();
  const permission = (
    ["admin", "maintain", "write", "triage", "read", "none"].includes(level) ? level : "none"
  ) as CollaboratorPermission;
  const canWrite = WRITE_LEVELS.has(permission);
  return {
    reachable: true,
    permission,
    canWrite,
    problem: canWrite
      ? null
      : `Tu cuenta de GitHub (${username}) tiene permiso "${permission}" en ese repositorio, ` +
        `y hace falta escritura. Solicita acceso a los dueños del repo.`,
  };
}
