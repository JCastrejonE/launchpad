/**
 * What the spec detail page should show for a spec (spec 0124).
 *
 * PURE, like `staging-view.ts`/`gate3-evidence.ts`: a function of state the page has
 * already loaded, so every combination is unit-testable without Temporal.
 *
 * ## The bug this exists to fix
 *
 * The page derived everything from the Temporal workflow view. Temporal only knows
 * about RUNS — so a Track-1 spec, which never has one, read as `canStart: true` and
 * `activeStep: 1`: a **Start** button on hand-authored work and a stepper parked at
 * *Draft* on something long finished. The same blind spot hits a finished Track-2
 * spec whose run has aged out of retention.
 *
 * So: **when the frontmatter status is terminal, or the spec never had a run, the
 * status is the authority.** Temporal answers "what is the run doing", which is a
 * different question from "is this work done".
 */
import type { PipelineViewState } from "./pipeline";

/** Status values that mean the work is over. `completed` = done via Track 1 (no
 * pipeline promote); `promoted` = merged to the production branch (spec 0122). */
const TERMINAL_STATUSES = new Set(["promoted", "completed", "rejected"]);

export function isTerminalSpecStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status.trim());
}

/** The four pipeline gates a Track-2 run passes through. */
export const TRACK2_STEPS = ["Borrador", "Programando", "Revisión · PR", "Promoción"] as const;

/**
 * Track 1 has two meaningful stages and no gates: the spec exists, and it either got
 * merged or it did not. The owner's rule — `Promoted` completes only when the chat actually
 * merged it, which is exactly `status === "promoted"`.
 */
export const TRACK1_STEPS = ["Borrador", "Promovido"] as const;

export interface SpecProgress {
  /** Step labels to render. Two for Track 1, four for Track 2. */
  steps: readonly string[];
  /**
   * 1-based index of the CURRENT step. `steps.length + 1` means every step is
   * complete — the encoding the page's stepper already used (5 for four gates).
   */
  activeStep: number;
  /** Render a Start button? */
  showStart: boolean;
  /** Render the manual Complete button (Track 1's only forward action)? */
  showComplete: boolean;
  /** What the Phase field should say. `undefined` ⇒ keep the page's own wording. */
  phaseLabel?: string;
}

export interface SpecProgressInput {
  /** Frontmatter `track:` — absent is treated as Track 1 (fail closed: an unlabelled
   * spec is hand-authored until proven otherwise, matching `deriveNextStep`). */
  track?: 1 | 2;
  /** Frontmatter `status:`. */
  status: string;
  /** The live workflow view, or null when Temporal could not be reached. */
  view: PipelineViewState | null;
  /** The page's existing view-derived step, passed in so this module does not have to
   * duplicate that mapping — used only for a Track-2 run still in flight. */
  viewActiveStep: number;
}

/**
 * Map a live workflow view to the stepper's 1-based step (5 = all shipped).
 *
 * Spec 0149: lifted verbatim out of `/forge/specs/[filename]/page.tsx` when that
 * page became a redirect to the ONE spec page. Draft is the resting position for
 * idle/failed/rejected too — the run has not advanced past gate 1 in any of them
 * — and a null view (Temporal unreachable) rests there as well.
 */
export function activeStepForView(view: PipelineViewState | null): number {
  if (!view) return 1;
  if (view.state === "completed" || view.state === "promoted_teardown_failed") return 5;
  if (view.state === "running" || view.state === "unknown_legacy_run") return 2;
  if (view.state === "waiting_at_gate") {
    return view.gate === "promote" ? 4 : view.gate === "pr" ? 3 : 1;
  }
  return 1;
}

export function deriveSpecProgress(input: SpecProgressInput): SpecProgress {
  const terminal = isTerminalSpecStatus(input.status);
  const track = input.track ?? 1;

  if (track === 1) {
    // Two steps. Draft is reached by definition — the file exists — so the resting
    // position is step 2 ("Promoted", not yet done). A real merge completes the bar.
    const merged = input.status.trim() === "promoted";
    return {
      steps: TRACK1_STEPS,
      activeStep: merged ? TRACK1_STEPS.length + 1 : 2,
      // Never offer to start a run for hand-authored work, even though Temporal
      // reports `canStart` (it says that precisely BECAUSE no run exists).
      showStart: false,
      showComplete: !terminal,
      ...(terminal ? { phaseLabel: phaseLabelFor(input.status) } : {}),
    };
  }

  // Track 2, already finished: every gate is complete, and there is nothing to start
  // — including when the run has aged out of Temporal and `canStart` says otherwise.
  if (terminal) {
    return {
      steps: TRACK2_STEPS,
      activeStep: TRACK2_STEPS.length + 1,
      showStart: false,
      showComplete: false,
      phaseLabel: phaseLabelFor(input.status),
    };
  }

  // Track 2, live: today's behaviour, unchanged.
  return {
    steps: TRACK2_STEPS,
    activeStep: input.viewActiveStep,
    showStart: input.view?.canStart === true,
    showComplete: false,
  };
}

/** Terminal statuses read as an outcome, not as a run state. */
function phaseLabelFor(status: string): string {
  return status.trim() === "rejected" ? "Rechazado" : "Listo";
}
