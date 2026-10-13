/**
 * Merging the PR that IS gate 2 (spec 0225 D).
 *
 * Its own module rather than inline in the action, for the reason the rest of
 * this codebase splits things out: the DECISION of whether a run can be merged
 * here is testable, and the action around it is not.
 */
import "server-only";
import { GithubApiError, GithubClient } from "@launchpad/github";
import { getPipelineViewStateSafe } from "./pipeline";
import { mergeIsTheGate } from "./gate-actions";
import { readUserGithubToken } from "./user-github-token";

export type MergeGateResult =
  | { ok: true; prNumber: number; mergedSha: string }
  | { ok: false; problem: string };

/**
 * @param actor the verified session email — used to look up THEIR GitHub token.
 */
export async function mergeGate2Pr(
  specId: string,
  projectSlug: string | undefined,
  actor: string,
): Promise<MergeGateResult> {
  const view = await getPipelineViewStateSafe(specId, projectSlug ?? "");
  if (!view) {
    return { ok: false, problem: `No pude leer el estado de la corrida de ${specId}.` };
  }
  // The same predicate that hides the in-app approve. If this is false the app
  // is offering a button it should not have rendered, and refusing is better
  // than merging something whose gate 2 means a different thing (a branch run's
  // gate 2 is "validated on staging"; merging its PR is PROMOTE).
  if (!mergeIsTheGate(view.pr, view.branch)) {
    return {
      ok: false,
      problem:
        "Esta corrida no se aprueba fusionando su PR: es una rama, y fusionarla es Promover, " +
        "que es otro acto con sus propias comprobaciones.",
    };
  }
  const pr = view.pr!;
  const [repoOwner, repoName] = (pr.repo ?? "").split("/");
  if (!repoOwner || !repoName) {
    return { ok: false, problem: `La corrida no registra un repositorio utilizable (${pr.repo}).` };
  }

  // Spec 0136's rule, kept: the merge is performed by the PERSON, never the bot.
  // A merge attributed to someone must have been done with their credential.
  const userToken = await readUserGithubToken(actor);
  if (!userToken) {
    return {
      ok: false,
      problem:
        "No tengo un token de GitHub tuyo — cierra sesión y vuelve a entrar con GitHub para " +
        "almacenarlo, y asegúrate de tener permiso de merge en el repo.",
    };
  }

  try {
    const merger = new GithubClient({ token: userToken, owner: repoOwner, repo: repoName });
    const mergedSha = await merger.mergePr(pr.number);
    return { ok: true, prNumber: pr.number, mergedSha };
  } catch (err) {
    if (err instanceof GithubApiError && (err.kind === "auth" || err.kind === "not_found")) {
      return {
        ok: false,
        problem:
          `GitHub rechazó el merge con TU credencial (${actor}): pide acceso de escritura a ` +
          `${repoOwner}/${repoName}.`,
      };
    }
    // 405/409 — already merged, or the branch moved. GitHub's own words are the
    // honest message; inventing one would hide which of the two it was.
    return {
      ok: false,
      problem: `GitHub no fusionó el PR #${pr.number}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
