/**
 * The branch-run refusal ladder (spec 0133 decision 7), as a pure decision —
 * `startPipeline` resolves the inputs (project row, branch row, Temporal
 * scan) and this answers "may this run start, and if not, why not, in words
 * the person can act on". One choke point: routes and actions forward, they
 * never re-validate (the four-disagreeing-starters lesson, spec 0131).
 */

export interface BranchStartFacts {
  branch: string;
  /** `isValidBranchName(branch)` — resolved by the caller so this stays pure. */
  validName: boolean;
  /** The spec's resolved project, or null when it fell back to the platform checkout. */
  project: { slug: string; kind: string | null } | null;
  /** The `project_branches` row, or null when none exists. */
  row: { mergedAt: Date | null } | null;
  /** Spec id of a RUNNING run on this (repo, branch), or null. */
  inFlightSpecId: string | null;
  /**
   * Spec 0186: true when nobody asked for this branch — it was DERIVED from the
   * spec's drafting chat. It only changes the wording, and the wording is the
   * point: *"créala primero en Ramas & builds"* sent a member to create another
   * project's branch inside theirs, and the chat that read it reported a
   * non-existent setting as the cause. A refusal about a branch you never named
   * has to say where the name came from.
   */
  derived?: boolean;
}

/** The refusal message, or null when the start may proceed. Order matters:
 * each rung assumes the previous ones passed, so the person always gets the
 * FIRST actionable problem, not a cascade. */
export function branchStartRefusal(facts: BranchStartFacts): string | null {
  if (!facts.validName) {
    return `rama inválida: "${facts.branch}" — minúsculas, dígitos y ./-_ (sin main/master ni prefijo spec/)`;
  }
  if (!facts.project) {
    return "un run de rama requiere un proyecto vinculado — este spec no resolvió a ningún proyecto";
  }
  if (facts.project.kind === "platform") {
    return "el proyecto plataforma usa el flujo por spec (PR por spec a main), no ramas";
  }
  if (!facts.row) {
    return facts.derived
      ? `el chat de este spec apunta a la rama "${facts.branch}", que no existe en este proyecto — ` +
          `abre el spec desde un chat de la rama en la que quieres trabajar`
      : `la rama "${facts.branch}" no existe en este proyecto — créala primero en Ramas & builds`;
  }
  if (facts.row.mergedAt) {
    return `la rama "${facts.branch}" ya fue promovida a main — el trabajo nuevo va en una rama nueva`;
  }
  if (facts.inFlightSpecId) {
    return `la rama "${facts.branch}" ya tiene un run en curso (spec ${facts.inFlightSpecId}) — espera a que termine`;
  }
  return null;
}
