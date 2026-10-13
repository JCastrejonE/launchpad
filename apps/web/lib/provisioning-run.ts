/**
 * Pure view-model for the odoo-next provisioning progress view (spec 0161 F3)
 * — the `run-follow-card.ts` discipline (framework-free lib, tests off the DOM,
 * VALUE-imported by a "use client" component) applied to the FIVE provisioning
 * work phases instead of the spec pipeline's lifecycle.
 *
 * It generalises the spec-pipeline stepper off its `PipelinePhase` keying
 * (`deriveStepperNodes` / `deriveRunSteps`): the same `{ phase, status, label }`
 * shape and the same `mc-step`/`mc-node`/`mc-bar` CSS, but keyed on
 * {@link ProvisioningPhase} — and with one status the pipeline stepper never
 * had: `failed`. A mid-phase failure must read as THAT phase failed, not as a
 * pulsing `current` node (which reads as a spinner — the F3 acceptance).
 *
 * `import type` only from `@launchpad/pipeline` — TypeScript erases it, so no
 * `@temporalio` value ever reaches this client bundle (the run-follow-card.ts
 * rule).
 */
import type { ProvisioningPhase } from "@launchpad/pipeline";

/** The five WORK phases the progress view renders, in order — the terminal
 * `completed`/`failed` are outcomes, not nodes. Local ordered copy of the work
 * subset of `PROVISIONING_PHASES`; keeping the label map and this list in one
 * file (not two modules) is the "add no second list" discipline for the view. */
export type ProvisioningWorkPhase = "repo" | "dns" | "odoo" | "front" | "verify";

export const PROVISIONING_WORK_PHASES: readonly ProvisioningWorkPhase[] = [
  "repo",
  "dns",
  "odoo",
  "front",
  "verify",
] as const;

/** Human-readable label per work phase — the provisioning stepper's own map,
 * the twin of `PIPELINE_PHASE_LABEL`. */
export const PROVISIONING_PHASE_LABEL: Record<ProvisioningWorkPhase, string> = {
  repo: "Repositorio",
  dns: "DNS",
  odoo: "Odoo",
  front: "Front",
  verify: "Verificación",
};

/** One provisioning step. `failed` is the status the pipeline stepper lacks —
 * rendered distinctly (red, static) so a failed phase never reads as a spinner. */
export interface ProvisioningStep {
  phase: ProvisioningWorkPhase;
  status: "done" | "current" | "upcoming" | "failed";
}

export interface ProvisioningStepperNode extends ProvisioningStep {
  label: string;
}

/**
 * Derive the five steps from a provisioning run's live state. PURE.
 *
 *  - `completed`         → every work phase `done`;
 *  - `failed` + failedAt → phases before `failedAt` `done`, `failedAt` `failed`,
 *                          the rest `upcoming` (that phase failed, mid-flow);
 *  - a work phase        → phases before it `done`, it `current`, rest `upcoming`;
 *  - `undefined`         → all `upcoming` (not started / not yet queryable).
 *
 * `failed` with no `failedAt` (a legacy or partial run) degrades to marking the
 * FIRST phase failed rather than throwing — a failure with an unknown location
 * still reads as a failure, never as a spinner.
 */
export function deriveProvisioningSteps(
  phase: ProvisioningPhase | undefined,
  failedAt?: ProvisioningPhase,
): ProvisioningStep[] {
  const failedIdx =
    phase === "failed"
      ? Math.max(
          0,
          PROVISIONING_WORK_PHASES.indexOf(failedAt as ProvisioningWorkPhase),
        )
      : -1;
  const currentIdx =
    phase && phase !== "completed" && phase !== "failed"
      ? PROVISIONING_WORK_PHASES.indexOf(phase as ProvisioningWorkPhase)
      : -1;

  return PROVISIONING_WORK_PHASES.map((phaseName, i) => {
    let status: ProvisioningStep["status"];
    if (phase === "completed") {
      status = "done";
    } else if (failedIdx >= 0) {
      status = i < failedIdx ? "done" : i === failedIdx ? "failed" : "upcoming";
    } else if (currentIdx >= 0) {
      status = i < currentIdx ? "done" : i === currentIdx ? "current" : "upcoming";
    } else {
      status = "upcoming";
    }
    return { phase: phaseName, status };
  });
}

/** Attach the label so the component never re-derives it — the
 * `deriveStepperNodes` shape, for the provisioning phases. */
export function deriveProvisioningStepperNodes(steps: readonly ProvisioningStep[]): ProvisioningStepperNode[] {
  return steps.map((s) => ({ ...s, label: PROVISIONING_PHASE_LABEL[s.phase] }));
}
