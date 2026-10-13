/**
 * "May this project use this repository?" — one answer, two callers (spec 0151).
 *
 * Lifted verbatim out of `app/new/actions.ts`, where it was inline. It moves
 * because linking a repo to an EXISTING project has to ask exactly the same
 * question, and a second, slightly-weaker copy of a permission check is how a
 * project ends up linked to a repo nobody can push to — a failure that does not
 * surface until gate 2, an hour into a run, as a 404 on something that looked fine.
 *
 * Two distinct checks, both required (spec 0128 C):
 *   1. the SERVER's token can push — otherwise the pipeline cannot open a PR;
 *   2. the PERSON asking has write access — otherwise they are linking someone
 *      else's repo to a project they control. Asked with the server token against
 *      their GitHub login, so their own token stays narrow.
 *
 * Fails CLOSED, deliberately: refusing costs a retry, while linking a repo the
 * pipeline cannot use costs a run.
 */
import { GithubClient } from "@launchpad/github";

export interface RepoUsable {
  ok: boolean;
  /** Human-readable and safe to render; absent when `ok`. */
  problem?: string;
}

export async function verifyRepoUsable(
  owner: string,
  name: string,
  /** The asking viewer's GitHub login, or null/undefined if they have not linked
   * a GitHub account — which is itself a refusal, since check 2 is impossible. */
  githubLogin: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<RepoUsable> {
  const token = env["GITHUB_TOKEN"];
  if (!token) {
    return {
      ok: false,
      problem: "No hay GITHUB_TOKEN en este servidor, así que no puedo verificar el repositorio.",
    };
  }
  if (!githubLogin) {
    return {
      ok: false,
      problem:
        "Vincula tu cuenta de GitHub (inicia sesión con GitHub) antes de vincular un repositorio: necesitamos verificar TU acceso, no el del servidor.",
    };
  }
  try {
    const client = new GithubClient({ token, owner, repo: name });
    const access = await client.getRepoAccess(owner, name);
    if (!access.exists || !access.pushable) {
      return { ok: false, problem: access.problem ?? "No puedo usar ese repositorio." };
    }
    const mine = await client.getCollaboratorPermission(owner, name, githubLogin);
    if (!mine.canWrite) {
      return { ok: false, problem: mine.problem ?? "No tienes escritura en ese repositorio." };
    }
  } catch (err) {
    // A rate limit or a network failure is NOT "that repo does not exist", and must
    // not be reported as one — the user would go and fix the wrong thing.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, problem: `No pude consultar GitHub: ${message}` };
  }
  return { ok: true };
}
