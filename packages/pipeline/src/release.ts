/**
 * Versioning and the deploy decision (spec 0170) — pure, so every combination is
 * testable without a database, a VPS or GitHub.
 *
 * The sibling of `branch-promote.ts`, and deliberately the same posture:
 * **block on contradiction, warn on absence.** A contradiction means the world
 * disagrees with itself and a deploy would act on a false belief; an absence
 * means we simply do not know, and saying so beats inventing a verdict.
 */

/** A release version: three numeric components, `major.minor.patch`. */
export type BumpLevel = "major" | "minor" | "patch";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parse `"1.4.2"`, or null when it is not one. */
export function parseVersion(version: string): [number, number, number] | null {
  const m = VERSION_RE.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * The next version after `current`, at `level`.
 *
 * A project with no releases starts at `1.0.0` — not `0.1.0`. There is no
 * pre-release phase here: the first thing shipped to a customer's production IS
 * version one.
 *
 * Automation always asks for `patch` (spec 0170 decision 4): it cannot know
 * whether a change is breaking. A human raising it to minor or major does so at
 * deploy time, reading the diff.
 */
export function nextVersion(current: string | null, level: BumpLevel = "patch"): string {
  if (!current) return "1.0.0";
  const parsed = parseVersion(current);
  if (!parsed) {
    throw new Error(`nextVersion: ${JSON.stringify(current)} is not a major.minor.patch version`);
  }
  const [major, minor, patch] = parsed;
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Is `a` strictly newer than `b`? Compares numerically, never as text — `1.10.0`
 * is above `1.9.0`, which string comparison gets backwards. */
export function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! > pb[i]!;
  }
  return false;
}

/**
 * The version string an Odoo `__manifest__.py` must carry for this release.
 *
 * Odoo's convention is `<series>.<major>.<minor>.<patch>` — `18.0.1.4.2` — and
 * the series comes from the PROJECT's Odoo major, never a hard-coded 18 (the
 * `infra/tenant/` rule: version is a parameter).
 *
 * This is not cosmetic. Odoo re-runs a module's migration scripts only when the
 * manifest version INCREASES, so a release that does not move it deploys code
 * and silently skips its migrations.
 */
export function manifestVersion(version: string, odooSeries: number): string {
  if (!parseVersion(version)) {
    throw new Error(`manifestVersion: ${JSON.stringify(version)} is not a major.minor.patch version`);
  }
  return `${odooSeries}.0.${version}`;
}

/** Kinds whose addons carry an Odoo manifest version. */
export function usesOdooManifest(kind: string | null | undefined): boolean {
  return kind === "odoo" || kind === "odoo_next";
}

export interface ReleaseDeployInput {
  /** The version being deployed. */
  version: string;
  /** Is the release's commit still an ancestor of `origin/main`? `undefined`
   * when git could not answer — which is NOT the same as "no". */
  onMain?: boolean;
  /** The version currently deployed, if any. */
  liveVersion?: string | null;
  /** `ci/odoo.sh` build state for this commit, for `odoosh` targets only. */
  odooShBuild?: "success" | "failure" | "pending" | "unknown";
  /** A deploy already running for this project, by version. */
  deployInFlight?: string | null;
  /** Was this commit ever stood up on a staging environment? */
  staged?: boolean;
  /** Where production lives. `none` has nowhere to deploy TO. */
  productionKind?: string | null;
}

export interface ReleaseDeployDecision {
  blocked: boolean;
  tone: "ok" | "warn" | "danger";
  message: string;
}

/**
 * May this release be deployed, and what should the human be told first?
 *
 * Order matters: the contradictions come first, so a message about a missing
 * staging check never hides the fact that main no longer contains this commit.
 */
export function decideReleaseDeploy(input: ReleaseDeployInput): ReleaseDeployDecision {
  if (input.deployInFlight) {
    return {
      blocked: true,
      tone: "danger",
      message: `Ya se está desplegando la versión ${input.deployInFlight}. Espera a que termine.`,
    };
  }

  if (input.productionKind === "none" || !input.productionKind) {
    return {
      blocked: true,
      tone: "danger",
      message:
        "Este proyecto no tiene producción configurada todavía, así que no hay a dónde desplegar. " +
        "Defínela en Ajustes (odoo.sh del cliente o nuestra flota).",
    };
  }

  // A commit that main no longer contains means history was rewritten under us.
  // Deploying it would ship something no longer in the trunk — the deploy would
  // succeed and the record would be a lie.
  if (input.onMain === false) {
    return {
      blocked: true,
      tone: "danger",
      message:
        `El commit de la versión ${input.version} ya no está en main (se reescribió la historia). ` +
        `Corta una versión nueva desde main.`,
    };
  }

  if (input.odooShBuild === "failure") {
    return {
      blocked: true,
      tone: "danger",
      message: `El build de odoo.sh para esta versión está en rojo. Arréglalo antes de desplegar.`,
    };
  }

  // Deliberately NOT called a rollback, here or anywhere (spec 0170 decision 3):
  // Odoo's data migrations are one-way, so this runs OLD CODE against migrated
  // data. It is allowed, loudly, and never described as an undo.
  if (input.liveVersion && isNewer(input.liveVersion, input.version)) {
    return {
      blocked: false,
      tone: "danger",
      message:
        `En producción está la ${input.liveVersion}, más nueva que la ${input.version} que vas a ` +
        `desplegar. Esto NO deshace nada: las migraciones de datos ya corrieron y son de una sola ` +
        `vía, así que quedaría código viejo sobre datos nuevos. Sigue sólo si sabes que este código ` +
        `tolera esos datos.`,
    };
  }

  if (input.liveVersion === input.version) {
    return {
      blocked: false,
      tone: "warn",
      message: `La versión ${input.version} ya está en producción. Volver a desplegarla la reinstala.`,
    };
  }

  if (input.odooShBuild === "pending") {
    return {
      blocked: false,
      tone: "warn",
      message: "El build de odoo.sh sigue corriendo — puedes desplegar bajo tu criterio.",
    };
  }

  // Absences: say what is unknown, never imply a check ran.
  if (input.onMain === undefined) {
    return {
      blocked: false,
      tone: "warn",
      message:
        `No pudimos confirmar con git que el commit de la ${input.version} siga en main. ` +
        `Va bajo tu criterio.`,
    };
  }

  if (input.staged === false) {
    return {
      blocked: false,
      tone: "warn",
      message: `La versión ${input.version} nunca se levantó en un staging. Va bajo tu criterio.`,
    };
  }

  return {
    blocked: false,
    tone: "ok",
    message: `Listo para desplegar la versión ${input.version}${
      input.liveVersion ? ` (en producción: ${input.liveVersion})` : ""
    }.`,
  };
}

/**
 * The release version an Odoo project is ALREADY at, read from its manifests
 * (spec 0170 decision 1, revised).
 *
 * The first cut of this spec had automation allocate the number and bump the
 * manifests to match. Building it surfaced why that is backwards: Odoo migration
 * scripts live in `migrations/<manifest-version>/`, so the manifest version is
 * the DEVELOPER's statement, tied to a folder they created by hand. Automation
 * choosing `1.4.3` when they wrote `migrations/18.0.1.5.0/` means the migration
 * never runs — the bump would cause the exact failure it was meant to prevent.
 *
 * So for Odoo kinds we stop inventing the number and start recording it.
 *
 * @param versions manifest version strings found at a commit, e.g. `["18.0.1.4.2"]`
 * @param series   the project's Odoo major (17|18|19), never assumed
 */
export type ManifestVersionRead =
  | { ok: true; version: string }
  | { ok: false; problem: string };

export function releaseVersionFromManifests(
  versions: readonly string[],
  series: number,
): ManifestVersionRead {
  if (versions.length === 0) {
    return { ok: false, problem: "no se encontró ningún __manifest__.py con versión" };
  }
  const prefix = `${series}.0.`;
  const distinct = [...new Set(versions)];
  if (distinct.length > 1) {
    // Two addons claiming different versions is ambiguous, and picking one would
    // silently decide which module's migrations run. Say so instead.
    return {
      ok: false,
      problem: `los addons declaran versiones distintas (${distinct.join(", ")}) — únifícalas antes de desplegar`,
    };
  }
  const only = distinct[0]!;
  if (!only.startsWith(prefix)) {
    return {
      ok: false,
      problem: `la versión del manifiesto (${only}) no empieza con la serie del proyecto (${prefix})`,
    };
  }
  const rest = only.slice(prefix.length);
  if (!parseVersion(rest)) {
    return {
      ok: false,
      problem: `la versión del manifiesto (${only}) no tiene la forma <serie>.0.mayor.menor.parche`,
    };
  }
  return { ok: true, version: rest };
}
