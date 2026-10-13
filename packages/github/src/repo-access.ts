/**
 * Can we actually use this repository? (spec 0126 B)
 *
 * Linking a project to `owner/name` by storing two strings proves nothing. The
 * failure it hides is expensive and late: the project looks linked, a run starts,
 * and gate 2 discovers at PR-open time — minutes or an hour in — that the repo
 * does not exist, or that the token can read it but not push to it. So linking
 * asks GitHub and believes the answer (`docs/VERIFICATION.md` #1: assert the
 * world's response, not the argument you passed).
 *
 * Split the way this package already splits `getCommitStatuses` from
 * `latestStatusForContext`: a thin fetcher on the client, and the judgement in a
 * PURE function here, so every verdict is unit-testable against a real API shape
 * with no network.
 */

/** The fields of GitHub's repository payload this decision needs. */
export interface RawRepo {
  full_name?: string;
  private?: boolean;
  archived?: boolean;
  default_branch?: string;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; pull?: boolean };
}

export interface RepoAccess {
  /** The token can see a repo at that path. */
  exists: boolean;
  /** The token may push — required to open a branch and a PR. */
  pushable: boolean;
  /** True when the repo is archived: readable, but GitHub refuses all writes. */
  archived: boolean;
  private: boolean;
  /** `owner/name` as GitHub spells it — the canonical casing to store. */
  fullName: string | null;
  defaultBranch: string | null;
  /** Why linking would fail, ready to show a user. Null when it would succeed. */
  problem: string | null;
}

/** Not found, or found but invisible to this token — indistinguishable by design
 * (GitHub 404s private repos rather than confirming they exist). */
export const REPO_ABSENT: RepoAccess = {
  exists: false,
  pushable: false,
  archived: false,
  private: false,
  fullName: null,
  defaultBranch: null,
  problem: "No existe, o el token no tiene acceso a ese repositorio.",
};

/**
 * Judge a repository payload. Pure.
 *
 * `archived` is checked BEFORE `push`, because GitHub keeps reporting
 * `permissions.push: true` on an archived repo while refusing every write. A
 * permission check alone would call that repo linkable and fail at the first
 * push.
 */
export function interpretRepoAccess(raw: RawRepo): RepoAccess {
  const pushable = raw.permissions?.push === true;
  const archived = raw.archived === true;
  const base = {
    exists: true,
    archived,
    private: raw.private === true,
    fullName: raw.full_name ?? null,
    defaultBranch: raw.default_branch ?? null,
  };
  if (archived) {
    return { ...base, pushable: false, problem: "El repositorio está archivado: GitHub rechaza cualquier escritura." };
  }
  if (!pushable) {
    return {
      ...base,
      pushable: false,
      problem: "El token puede leer el repositorio pero no escribir en él (falta permiso push).",
    };
  }
  return { ...base, pushable: true, problem: null };
}

/** True when this repo can carry a pipeline run — the one question a caller asks. */
export function isRepoUsable(access: RepoAccess): boolean {
  return access.exists && access.pushable && !access.archived;
}
