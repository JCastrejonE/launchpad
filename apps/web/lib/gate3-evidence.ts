/**
 * Gate-3 evidence, derived BEFORE the click (spec 0111).
 *
 * Gate 3 is the gate that carries the product's promise — "new work cannot break
 * your production" — and until this existed you clicked it blind in the workspace.
 * Two gaps it closes:
 *
 *  1. The promote guard already runs inside `runWorkspaceGateAction`, so a blocked
 *     promote IS refused — but its reason only surfaced as a post-click error. The
 *     old `/forge/specs` detail page rendered it; the workspace did not
 *     (spec 0102 #8).
 *  2. Worse: the CI half is derived from a **PR**, and a tenant-vanilla promote has
 *     none — so the tenant path had no evidence on *either* surface. That is the
 *     path where promote actually deploys onto a real VPS (`deployToProduction`
 *     returns immediately for a platform target — "merge IS the deploy",
 *     `activities.ts:1435`), and per the design rethink it is the gate a business
 *     owner meets first.
 *
 * PURE by design, like `decidePromoteGate` and `derivePrimaryAction`: a function of
 * state the caller already loaded, so every branch is unit-testable without a
 * Temporal client, a GitHub token or an SSH connection.
 *
 * It does NOT restate `decidePromoteGate`'s wording — that function owns the
 * allowed/blocked judgement and its message, and this delegates to it. One source
 * for "may I promote", or the two surfaces drift.
 */
import type { PipelineTarget } from "@launchpad/pipeline";

/** What `decidePromoteGate` returns; restated structurally so this module stays
 * pure and does not import the IO-carrying `lib/pipeline.ts`. */
export interface PromoteGateDecision {
  enabled: boolean;
  tone: "ok" | "danger" | "info" | "warn";
  message: string;
}

export interface Gate3EvidenceInput {
  /** `decidePromoteGate(...)` when the run has a PR; `null` for the tenant path,
   * which has no PR and therefore no CI signal at all. */
  promoteGate: PromoteGateDecision | null;
  /** The run's target from the `pipelineTarget` query (`view.target`). */
  target?: PipelineTarget;
  /** Restore-point ids for a tenant target, newest first — spec 0105's
   * `listTenantBackups`. Empty means none exist; `undefined` means we could not
   * look (no SSH, non-sandbox VPS), which is reported differently on purpose. */
  restorePoints?: string[];
}

export interface Gate3Evidence {
  /** False ⇒ render the promote button disabled. */
  canPromote: boolean;
  /** Tone for the allowed/blocked line. `info` when there is no CI signal. */
  tone: PromoteGateDecision["tone"];
  /** Why promote is allowed or blocked. */
  verdict: string;
  /** What promoting will actually execute — concrete, never reassuring. */
  willRun: string;
  /** Whether this can be undone, and with what. */
  reversibility: string;
}

/**
 * The tenant path has no PR, so there is no CI to consult. That is NOT a blocker
 * (the deploy is idempotent and gate 3 is the human's timing decision), but it must
 * read as an absence of signal rather than as approval.
 */
const NO_CI_SIGNAL: PromoteGateDecision = {
  enabled: true,
  tone: "info",
  message: "Esta corrida no tiene PR, así que no hay señal de CI — promueves bajo tu criterio.",
};

function describeWillRun(target: PipelineTarget | undefined): string {
  if (!target) {
    return "Objetivo desconocido — esta corrida no reportó ninguno, así que no se puede afirmar qué ejecuta la promoción.";
  }
  // Narrow on `kind === "tenant"` POSITIVELY rather than on `!isSelfTarget`: that
  // helper deliberately widens self|launchpad for wire-compat (spec 0036), so a
  // union-typed discriminant defeats narrowing on the other branch — the same
  // reason `activities.ts` reaches for a cast there. Narrowing the tenant side
  // needs no cast at all.
  if (target.kind === "tenant") {
    const { tenantId, vpsId, odooVersion } = target;
    return `Despliega el tenant ${tenantId} en el VPS ${vpsId} (Odoo ${odooVersion}) — compose up + chequeo de salud.`;
  }
  // self / launchpad: verified that deployToProduction returns immediately, so
  // claiming a deploy here would be a lie.
  return "No se ejecuta nada más — para este repo la fusión ES el despliegue. Promover registra la compuerta.";
}

function describeReversibility(
  target: PipelineTarget | undefined,
  restorePoints: string[] | undefined,
): string {
  if (!target || target.kind !== "tenant") {
    // Verified while writing spec 0105: no rollback machinery exists for the
    // platform target. Better to say so than to imply a safety net.
    return "No se puede deshacer automáticamente — no hay rollback para los despliegues de este repo.";
  }
  if (restorePoints === undefined) {
    return "No se pudieron leer los puntos de restauración (sin SSH, o un VPS fuera de la lista permitida) — trátalo como no reversible.";
  }
  const [newest] = restorePoints;
  if (newest === undefined) {
    return "No existe ningún punto de restauración para este tenant — esto no se puede deshacer.";
  }
  return `${restorePoints.length} punto${restorePoints.length === 1 ? "" : "s"} de restauración; el más nuevo ${newest}. Restaurar es una acción aparte y deliberada.`;
}

/** Build the gate-3 panel model. See the module doc for why each field exists. */
export function deriveGate3Evidence(input: Gate3EvidenceInput): Gate3Evidence {
  const gate = input.promoteGate ?? NO_CI_SIGNAL;
  return {
    canPromote: gate.enabled,
    tone: gate.tone,
    verdict: gate.message,
    willRun: describeWillRun(input.target),
    reversibility: describeReversibility(input.target, input.restorePoints),
  };
}
