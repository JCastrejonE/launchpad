/**
 * What must be true BEFORE a project is connected (spec 0225 F).
 *
 * Every check here converts a failure that today happens deep inside a run into
 * a refusal at the moment Connect is pressed. Pure: the caller does the GitHub
 * and filesystem I/O and hands the facts in, so the decisions are testable
 * without either.
 *
 * Push access is deliberately NOT here — `lib/repo-access.ts`'s
 * `verifyRepoUsable` already asks it (the server token's push right AND the
 * asking person's), and a second, slightly-weaker copy of a permission check is
 * exactly what its own doc comment warns about.
 */

import type { ProjectKind } from "@launchpad/db";

export type PreflightCode =
  | "specs_collision"
  | "no_ci_toolchain"
  | "root_not_writable"
  | "odoo_kind_without_addons";

export interface PreflightFinding {
  code: PreflightCode;
  /** True = do not connect. False = connect, but the user must know. */
  blocking: boolean;
  problem: string;
}

/** What the repo's own top-level layout tells us. */
export interface RepoShape {
  /** The repo TRACKS its own `specs/`. */
  hasOwnSpecsDir: boolean;
  /** What CI could run: a Node toolchain, Odoo addons, or nothing we know. */
  toolchain: "node" | "odoo" | "none";
}

/** @param paths every blob path in the repo (`GithubClient.listTreePaths`). */
export function inspectRepoShape(paths: readonly string[]): RepoShape {
  const hasOwnSpecsDir = paths.some((p) => p.startsWith("specs/"));
  const node = paths.some((p) => p === "package.json");
  const odoo = paths.some((p) => p.endsWith("__manifest__.py"));
  return { hasOwnSpecsDir, toolchain: node ? "node" : odoo ? "odoo" : "none" };
}

export function connectPreflight(input: {
  shape: RepoShape;
  /**
   * The kind the person picked, in the CANONICAL (database) spelling.
   *
   * Was `string`, and matched the UI spelling `"odoo-next"`. When `/connect`
   * started translating through `fromUiKind` the caller began sending
   * `"odoo_next"`, this stopped matching, and `odoo_kind_without_addons` went
   * silently dead — a regression introduced the same day, found only by
   * connecting a real repo and watching the warning NOT appear. The unit test
   * kept passing because it fed the UI spelling the caller no longer sends
   * (docs/VERIFICATION.md #1: a fake proves the call you made, not the contract).
   * Typed now, so the wrong spelling cannot compile.
   */
  kind?: ProjectKind;
  /** Can the service user write where checkouts and specs are created? */
  checkoutsRootWritable: boolean;
  specsRootWritable: boolean;
}): PreflightFinding[] {
  const findings: PreflightFinding[] = [];

  // The subtlest failure in the batch. `linkSpecsIntoWorktree` returns EARLY
  // when the worktree already has `specs/` — deliberate, it stops the platform's
  // own tracked directory being shadowed. For a repo with its own, the symlink
  // is never made, NO error is raised, and the run dies several activities later
  // at "No spec file for id NNNN". Blocking, because connecting anyway produces
  // a project whose every run fails for a reason that names the wrong thing.
  if (input.shape.hasOwnSpecsDir) {
    findings.push({
      code: "specs_collision",
      blocking: true,
      problem:
        "Este repositorio ya tiene su propio directorio `specs/`. Las specs del pipeline se " +
        "enlazan ahí y el enlace no se crearía, así que cada corrida fallaría más tarde con " +
        "«No spec file for id …». Renombra el directorio del repo, o conecta otro repositorio.",
    });
  }

  // Not blocking: spec 0138 makes CI SKIP honestly for a repo with no Node
  // toolchain, and the run still works. But "CI ran and passed" and "CI did not
  // run" look identical from outside, so the person connecting should learn it
  // now rather than infer it from a green run that checked nothing.
  if (input.shape.toolchain === "none") {
    findings.push({
      code: "no_ci_toolchain",
      blocking: false,
      problem:
        "No reconozco cómo verificar este repositorio (sin `package.json` y sin " +
        "`__manifest__.py`), así que CI se va a saltar y quedará registrado. Las corridas " +
        "funcionan; simplemente nada las comprueba.",
    });
  }

  // Spec 0225 C3, and what that item turned out to be. The mockup promised
  // "detecta si necesita crear el repo de addons de Odoo", which describes a
  // two-repo structure this product does not have: `provisionRepo` creates ONE
  // repo named `slug`, and a tenant's repo holds the addons AND the Next front
  // together (measured on `sushi`'s main: one `__manifest__.py` beside `app/`).
  // So there is no addons repo to create.
  //
  // What IS worth saying: an Odoo-kind project whose repo has no addons is
  // either brand new — normal — or a sign the addons live in a repo you did not
  // link. Only meaningful when CONNECTING something that already exists, which
  // is why it is a warning and why `/new` never sees it.
  if ((input.kind === "odoo" || input.kind === "odoo_next") && input.shape.toolchain !== "odoo") {
    findings.push({
      code: "odoo_kind_without_addons",
      blocking: false,
      problem:
        "Este repositorio no tiene addons de Odoo (`__manifest__.py`). Si el proyecto ya tiene " +
        "addons, puede que estén en otro repositorio y hayas vinculado el equivocado. Si todavía " +
        "no tiene, esto es normal: el pipeline los va a crear aquí mismo, junto al front.",
    });
  }

  // Spec 0210's lesson: root-owned paths let a run stage a spec and then fail to
  // commit it. Asked as the identity that will do the writing, not as root.
  if (!input.checkoutsRootWritable || !input.specsRootWritable) {
    const which = [
      ...(input.checkoutsRootWritable ? [] : ["el directorio de checkouts"]),
      ...(input.specsRootWritable ? [] : ["el directorio de specs"]),
    ].join(" y ");
    findings.push({
      code: "root_not_writable",
      blocking: true,
      problem:
        `El servicio no puede escribir en ${which}. Una corrida dejaría la spec preparada y ` +
        `fallaría al hacer commit (spec 0210).`,
    });
  }

  return findings;
}

/** Convenience for the caller: may we connect at all? */
export function preflightBlocks(findings: readonly PreflightFinding[]): boolean {
  return findings.some((f) => f.blocking);
}
