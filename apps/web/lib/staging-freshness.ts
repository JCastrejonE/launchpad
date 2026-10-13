/**
 * What the branch's staging server actually holds, said out loud at gate 2
 * (spec 0187 A) — the sibling of `decideBranchPromote`'s stale-attestation
 * rung, so the notice and the later refusal can never disagree about what
 * "staged" means.
 *
 * The defect this exists for: `autopartes` reached gate 2 with **Approve PR**
 * offered and no staging behind it. The refresh had failed on a capacity guard,
 * spec 0119's posture (a staging failure must not fail a run) let the run
 * continue, and nothing on the page mentioned it. The facts were all in the
 * branch row — `staging_sha` against the branch head — and nobody was told.
 *
 * Deliberately NOT a block. 0119's posture stands, and a reviewer who knows the
 * change is documentation-only may approve anyway. This is about knowing.
 */

export interface StagingFreshnessFacts {
  /** `project_branches.staging_sha` — what staging last actually ran. */
  stagingSha?: string | null | undefined;
  /** The head this gate is approving. */
  branchHead?: string | null | undefined;
  /** `project_branches.staging_status`. */
  stagingStatus?: string | null | undefined;
  /** Spec 0195 B: `project_branches.staging_note` — why the last op failed. */
  stagingNote?: string | null | undefined;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * One sentence when staging does not hold the head under review, or null when
 * it does (and when there is nothing trustworthy to say — an unknown head is
 * not evidence of staleness).
 */
export function stagingFreshnessNotice(facts: StagingFreshnessFacts): string | null {
  const status = facts.stagingStatus ?? "none";
  if (status === "none" || !facts.stagingSha) {
    return (
      "Esta rama no tiene servidor de staging con el cambio: nadie lo ha ejecutado. " +
      "Aprobar aquí es aprobar sobre la revisión del código y la CI, no sobre un entorno."
    );
  }
  if (status === "failed") {
    const why = (facts.stagingNote ?? "").trim();
    return (
      "El último despliegue del staging de esta rama falló, así que el servidor no tiene " +
      "este cambio. Redesplégalo en Ramas & builds antes de validar." +
      // Spec 0195 B: the reason belongs where the decision is made, not only in
      // a worker log. Absent for a failure recorded before the column existed.
      (why ? ` Motivo: ${why}` : "")
    );
  }
  if (facts.branchHead && facts.stagingSha !== facts.branchHead) {
    return (
      `El staging corrió ${short(facts.stagingSha)} y la rama va en ${short(facts.branchHead)} — ` +
      `lo que está desplegado NO es este cambio. Redesplégalo en Ramas & builds.`
    );
  }
  return null;
}
