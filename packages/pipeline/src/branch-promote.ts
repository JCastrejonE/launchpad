/**
 * The branch-promote guard (spec 0136) — sibling of `promote-attestation.ts`
 * (spec 0118), same posture: BLOCK on contradiction, WARN on absence, and
 * absence of evidence never masquerades as evidence.
 *
 * The odoo.sh model's promotion is a WEB ACTION, not a workflow signal: a
 * branch accumulates over N runs, and by promote time the last run's workflow
 * may be long closed — so the attestation lives on the `project_branches` row
 * (`staging_sha` = what staging actually ran, `staging_base_sha` = the main
 * content inside that tested tree), written at deploy time because that is
 * the only moment those facts are true. This module is the pure judgment over
 * those facts; the action resolves the inputs.
 */
import { isOdooShBuildInFlight, type OdooShBuild } from "./odoosh-status.js";

export interface BranchPromoteInput {
  /** The branch head SHA right now (GitHub API, never a local ref — project
   * checkouts have no guaranteed fetch cadence). Undefined = unresolvable. */
  branchHead?: string | undefined;
  /** `main`'s tip right now; undefined when it could not be resolved. */
  mainHead?: string | undefined;
  /** What staging actually ran (`project_branches.staging_sha`), or null when
   * the branch was never staged / its server was destroyed. */
  stagingSha?: string | null | undefined;
  /** The main content inside the tested tree (`staging_base_sha`). */
  stagingBaseSha?: string | null | undefined;
  /** The branch PR's aggregate checks conclusion, when known. */
  checks?: "success" | "failure" | "pending" | undefined;
  /**
   * Whether the repo defines ANY Actions workflow (spec 0188 C).
   *
   * `aggregateChecks` answers `"pending"` for a head SHA with no workflow runs,
   * which is correct while Actions is still reporting and wrong forever on a
   * repo that has no Actions at all — the shape of every project we scaffold.
   * `autopartes` PR #1 showed `Checks 0 (0)` on GitHub while this guard said
   * they were still running, so *Promover igual* became the ordinary path and
   * the warning stopped being read.
   *
   * `false` = the repo has none, so pending means nothing. `undefined` = not
   * asked (GitHub unreachable, or a caller that cannot know) — treated as
   * "maybe", which keeps the old warn rather than inventing confidence.
   */
  checksConfigured?: boolean | undefined;
  /**
   * Our own CI's verdict on the branch head — the `ci/launchpad` commit status
   * (spec 0228 E).
   *
   * A SEPARATE reading from `checks`, and deliberately so. `checks` is GitHub
   * Actions, which this org does not run: the account's Actions billing is
   * locked, so `checksConfigured` is false and `pending` there means nothing.
   * Our gate reports through the Status API instead, which works under that same
   * lock. Two sources, and the rule below is that ANY red blocks.
   *
   * `undefined` = nobody asked, or nothing has posted yet. Absence says nothing
   * and must never be read as a pass — that is how the promote gate would come
   * to certify a commit no CI ever saw.
   */
  gateStatus?: "success" | "failure" | "error" | "pending" | undefined;
  /** Spec ids of runs on this repo currently in a production-busy phase. */
  busyRuns?: readonly string[] | undefined;
  /** odoo.sh's build state on production's current commit (0115 clause 4);
   * only an IN-FLIGHT build blocks — see promote-attestation.ts for why
   * absent does not. */
  productionBuild?: OdooShBuild | undefined;
}

export interface BranchPromoteDecision {
  blocked: boolean;
  message?: string;
  tone?: "danger" | "warn";
}

function short(sha: string): string {
  return sha.slice(0, 7) || "(unknown)";
}

/**
 * Ordered most-concrete-first, like its 0118 sibling: a busy production
 * blocks regardless of attestation; a stale attestation blocks regardless of
 * CI; and only when nothing contradicts do the warn-shaped unknowns speak.
 */
export function decideBranchPromote(input: BranchPromoteInput): BranchPromoteDecision {
  const busy = input.busyRuns ?? [];
  if (busy.length > 0) {
    const list = busy.map((s) => `spec ${s}`).join(", ");
    return {
      blocked: true,
      tone: "danger",
      message:
        `Producción está ocupada — ${list} ${busy.length === 1 ? "está" : "están"} a medio ` +
        `deploy. Promueve de nuevo cuando termine.`,
    };
  }

  if (input.productionBuild && isOdooShBuildInFlight(input.productionBuild)) {
    return {
      blocked: true,
      tone: "danger",
      message:
        "odoo.sh sigue construyendo producción — promover ahora metería un segundo commit " +
        "a un build en vuelo. Espera a que termine.",
    };
  }

  // The branch moved after staging last ran: whatever was validated, it was
  // not THIS tree.
  if (input.stagingSha && input.branchHead && input.branchHead !== input.stagingSha) {
    return {
      blocked: true,
      tone: "danger",
      message:
        `El staging corrió ${short(input.stagingSha)}, pero la rama ya va en ` +
        `${short(input.branchHead)} — redeploya el staging y revalida antes de promover.`,
    };
  }

  // main moved under the validation: the merge result is a tree nobody ran
  // (0118 clause 3, translated). The escape hatch is GitHub's own Update
  // branch button — no rebase automation.
  if (input.stagingBaseSha && input.mainHead && input.mainHead !== input.stagingBaseSha) {
    return {
      blocked: true,
      tone: "danger",
      message:
        `Se validó contra main ${short(input.stagingBaseSha)}, pero main ya va en ` +
        `${short(input.mainHead)} — otra rama se promovió primero. Usa "Update branch" en el ` +
        `PR, redeploya el staging y revalida.`,
    };
  }

  // Spec 0228 E. Before the Actions clauses, because this is the CI we actually
  // run: a red gate is the most concrete thing we know about the branch.
  if (input.gateStatus === "failure" || input.gateStatus === "error") {
    return {
      blocked: true,
      tone: "danger",
      message:
        "La compuerta (ci/launchpad) está en rojo en la punta de la rama — arregla eso antes de promover.",
    };
  }
  if (input.gateStatus === "pending") {
    return {
      blocked: false,
      tone: "warn",
      message: "La compuerta sigue corriendo sobre este commit — puedes promover bajo tu criterio.",
    };
  }

  if (input.checks === "failure") {
    return {
      blocked: true,
      tone: "danger",
      message: "Los checks del PR están en rojo — corrige la rama antes de promover.",
    };
  }

  // Spec 0188 C: pending only means something when there are checks to be
  // pending. A repo with no Actions reports "pending" forever, and a warning
  // that is always on is a warning nobody reads.
  if (input.checks === "pending" && input.checksConfigured !== false) {
    return {
      blocked: false,
      tone: "warn",
      message: "Los checks del PR siguen corriendo — puedes promover bajo tu criterio.",
    };
  }

  // Never staged, or heads unresolvable: warn, don't block — but never imply
  // the check ran.
  if (!input.stagingSha || !input.stagingBaseSha) {
    return {
      blocked: false,
      tone: "warn",
      message:
        "Esta rama no tiene staging validado (nunca se desplegó o su servidor fue " +
        "destruido) — promover queda bajo tu criterio.",
    };
  }
  if (!input.branchHead || !input.mainHead) {
    return {
      blocked: false,
      tone: "warn",
      message:
        "No pude leer las puntas de la rama o de main en GitHub, así que la validación no " +
        "se pudo comparar — promover queda bajo tu criterio.",
    };
  }

  return { blocked: false };
}
