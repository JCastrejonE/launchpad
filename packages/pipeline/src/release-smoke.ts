/**
 * The end-state check for a deployed release (spec 0177).
 *
 * Both of today's production defects — a backend moved to a hostname with no
 * DNS (0175) and an addon copied but never installed (0176) — shipped past
 * green unit tests and a green deploy, and were found by a human looking. This
 * asks the customer's own systems whether the release is actually there.
 *
 * PURE. The script gathers; this decides. That split is what lets the four
 * checks be tested against the exact facts observed live, with no VPS.
 */
import { manifestVersion } from "./release.js";
import type { OdooVersion } from "./spec.js";

/** One module row as the tenant's Odoo reports it. */
export interface InstalledModule {
  name: string;
  state: string;
  version: string;
}

/** Everything the script measured about one project. `null` means "could not
 * measure", which is never silently treated as "fine". */
export interface ReleaseSmokeFacts {
  slug: string;
  /** The hostnames provisioning assigned — what a customer actually types. */
  odooHost: string;
  frontHost: string;
  odooStatus: number | null;
  frontStatus: number | null;
  /** The deployed release, or null when nothing has shipped yet. */
  releaseVersion: string | null;
  /**
   * When the release's CODE came into being (the candidate was cut at promote)
   * — not when the deploy finished. The front is deployed a few seconds BEFORE
   * the row is marked deployed, so anchoring freshness to `deployedAt` reports
   * every healthy deploy as stale. Measured: a 6.4-second "failure" on sushi.
   */
  releaseCreatedAt: Date | null;
  odooSeries: OdooVersion;
  /** Addon directory names in the release's own tree — what SHOULD be installed. */
  expectedModules: string[];
  /** Does this project run a front at all? A plain `odoo` tenant does not, and
   * checking one it never had is a false alarm, not a finding. */
  hasFront: boolean;
  /** `ir_module_module`, read from the tenant's database. */
  modules: InstalledModule[];
  /** When the front container last started. */
  frontStartedAt: Date | null;
  /**
   * What `HostConfig.RestartPolicy.Name` answers for each of the tenant's
   * containers (spec 0215). Docker fixes this AT CREATE time, so the template
   * having the policy proves nothing about a container that already exists —
   * only an inspect of the running one does. `null` = could not measure.
   */
  restartPolicies: { container: string; policy: string | null }[];
}

export interface SmokeProblem {
  /** Stable, greppable identifier — the thing a future alert keys on. */
  code:
    | "odoo-unreachable"
    | "front-unreachable"
    | "module-not-installed"
    | "module-wrong-version"
    | "front-older-than-release"
    | "restart-policy-wrong";
  detail: string;
}

/**
 * The problems with one project's production, in the order a person would want
 * them: the two hostnames first (nothing else matters if the customer cannot
 * reach it), then what is actually installed.
 *
 * A project with nothing deployed yet has no problems — it has no claim to
 * check. Silence there is honest; silence about a green release is the bug this
 * exists to prevent.
 */
export function releaseSmokeProblems(f: ReleaseSmokeFacts): SmokeProblem[] {
  if (!f.releaseVersion) return [];
  const problems: SmokeProblem[] = [];

  // Spec 0175 lived here: the release row said `deployed` while this answered 404.
  if (f.odooStatus !== 200) {
    problems.push({
      code: "odoo-unreachable",
      detail:
        `${f.odooHost} respondió ${f.odooStatus ?? "nada"} — la release ${f.releaseVersion} dice ` +
        `desplegada. Ese es el nombre que usa el cliente.`,
    });
  }
  if (f.hasFront && f.frontStatus !== 200) {
    problems.push({
      code: "front-unreachable",
      detail: `${f.frontHost} respondió ${f.frontStatus ?? "nada"}.`,
    });
  }

  // Spec 0176 lived here: the file was on disk and the database had never heard
  // of it, among hundreds of modules it did know about.
  const expectedVersion = manifestVersion(f.releaseVersion, f.odooSeries);
  for (const name of f.expectedModules) {
    const row = f.modules.find((m) => m.name === name);
    if (!row || row.state !== "installed") {
      problems.push({
        code: "module-not-installed",
        detail:
          `${name} no está instalado en la base del tenant (${row ? `estado ${row.state}` : "no aparece en ir_module_module"}). ` +
          `El archivo puede estar en disco: eso no es estar instalado.`,
      });
      continue;
    }
    if (row.version !== expectedVersion) {
      problems.push({
        code: "module-wrong-version",
        detail:
          `${name} está instalado en ${row.version}; la release ${f.releaseVersion} implica ` +
          `${expectedVersion}. Odoo sólo re-corre las migraciones cuando la versión SUBE.`,
      });
    }
  }

  // The staging refresh has exactly this defect today (finding 1.13). If
  // production ever grows it, the site keeps serving the previous release while
  // every record says otherwise.
  if (
    f.hasFront &&
    f.releaseCreatedAt &&
    f.frontStartedAt &&
    f.frontStartedAt < f.releaseCreatedAt
  ) {
    problems.push({
      code: "front-older-than-release",
      detail:
        `el contenedor del front arrancó ${f.frontStartedAt.toISOString()}, antes de que existiera ` +
        `el código de la release ${f.releaseVersion} (${f.releaseCreatedAt.toISOString()}) — está ` +
        `sirviendo código anterior.`,
    });
  }

  // 2026-08-14: the docker daemon restarted and the six `-prod` stacks did not
  // come back — their containers were created with no restart policy, so they
  // stayed down ~12h. `db` counts as much as `odoo`: `depends_on` only orders
  // the first start, it does not revive Postgres.
  for (const { container, policy } of f.restartPolicies) {
    if (policy !== "unless-stopped") {
      problems.push({
        code: "restart-policy-wrong",
        detail:
          `${container} tiene restart policy ${policy ?? "sin medir (no respondió el inspect)"}; ` +
          `debería ser unless-stopped. Tal cual, no vuelve solo tras un reinicio del demonio de Docker.`,
      });
    }
  }

  return problems;
}
