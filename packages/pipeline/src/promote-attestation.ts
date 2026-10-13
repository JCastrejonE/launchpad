/**
 * Gate-3 concurrency guard (spec 0118 — spec 0115's "concurrency B", the owner's).
 *
 * ## The scenario, in the owner's words
 *
 * > "Two users can start a new spec over last head in main (prod), then that change
 * > gets its own PR… Then if he decides to promote (merge), we cannot do that until
 * > the last prod deployment is completed."
 *
 * `main` **is** production here — odoo.sh builds it on every push. So "promote" is
 * not a bookkeeping step, it is a deploy, and with three concurrent users the thing
 * you approved and the thing you would deploy can silently stop being the same thing.
 *
 * ## What gate 2 attests
 *
 * Approving a change records **two** SHAs, not one:
 *
 *  - `testedSha` — the PR head you actually looked at on staging.
 *  - `baseSha` — the `main` tip it was tested *against*.
 *
 * Both are needed, because there are two independent ways the attestation goes
 * stale, and each has a different fix:
 *
 *  1. **The PR moved.** A coder pushed another commit after you approved. Promoting
 *     would deploy code no human reviewed. Fix: re-approve.
 *  2. **`main` moved.** Someone else promoted first. Your staging build was a copy of
 *     the *old* production; the merge you are about to make produces a tree nobody
 *     has run. Fix: re-test on the new base.
 *
 * Case 2 is the one that only appears with concurrent users, and it is invisible
 * without recording the base — the PR head is unchanged, CI is still green, and the
 * button looks perfectly safe.
 *
 * ## Posture: block on known-bad, warn on unknown
 *
 * Deliberately the same posture as `decidePromoteGate`, its sibling on the same
 * button: a **contradiction** in the evidence blocks; **absent** evidence warns and
 * lets the human decide. Every run approved before this shipped has no attestation,
 * and a legacy run cannot grow one retroactively — blocking those would have made the
 * guard's rollout an outage. Consistency with the neighbouring decision matters more
 * here than my preference for fail-closed, and the warn text says plainly that the
 * check did not run.
 *
 * PURE — no git, no Temporal, no GitHub. Callers resolve the four inputs and this
 * decides. Every branch is unit-testable, which is the whole point: the interesting
 * cases (two users, interleaved) cannot be staged live on demand.
 */
import type { PipelinePhase } from "./phase.js";
// Spec 0115: what odoo.sh says about production. Pure predicate + type, so this
// decision function stays free of IO.
import { isOdooShBuildInFlight, type OdooShBuild } from "./odoosh-status.js";

/** What gate 2 recorded when a human approved the change. Both fields optional at
 * the wire boundary (see `prApproved`'s payload) — this shape is the resolved,
 * complete form the guard consumes. */
export interface PromoteAttestation {
  approvedBy: string;
  /** PR head SHA at approval time. */
  testedSha: string;
  /** `main` tip the approval was tested against. */
  baseSha: string;
}

/**
 * Phases in which a run is touching production and no second promote may start.
 *
 * `merging` is included: it mutates the shared `main`, which is exactly the
 * collision, and in the odoo.sh model the merge IS the production push. The gates
 * before it (`awaiting_*`) are idle waits and never block anyone.
 */
export const PRODUCTION_BUSY_PHASES: readonly PipelinePhase[] = [
  "merging",
  "deploying",
  "tearing_down",
];

export function isProductionBusyPhase(phase: PipelinePhase | undefined): boolean {
  return phase !== undefined && PRODUCTION_BUSY_PHASES.includes(phase);
}

export interface PromoteAttestationInput {
  /** What gate 2 recorded, or undefined for a run approved before this existed. */
  attestation?: PromoteAttestation | undefined;
  /** The PR's head SHA right now; undefined when it could not be resolved. */
  prHead?: string | undefined;
  /** `main`'s tip right now; undefined when it could not be resolved. */
  mainHead?: string | undefined;
  /**
   * Spec ids of OTHER runs on the same repo currently in a production-busy phase.
   * Empty is the normal case. The caller filters by repo — this function is not
   * given a repo, so it cannot get that filter wrong silently.
   */
  busyRuns?: readonly string[] | undefined;
  /**
   * What odoo.sh says about the commit production is currently serving — `main`'s
   * HEAD (spec 0115, clause 4's credentialed half). `undefined` when we did not
   * look; `{status:"absent"}` when odoo.sh has never reported on that commit.
   *
   * Only an IN-FLIGHT build blocks. Absent deliberately does not, for two reasons
   * worth stating because the opposite looks safer and is not:
   *
   *  - most repos are not odoo.sh-connected at all — our own dogfood repo never
   *    reports this context — so blocking on absent would make promote impossible
   *    everywhere except one customer;
   *  - the case absent could hide (odoo.sh has not yet created the build for a
   *    just-merged commit) is already refused by clause 3: after a merge `main`'s
   *    HEAD moves, so a second promote's attested base no longer matches.
   */
  productionBuild?: OdooShBuild | undefined;
}

export interface PromoteAttestationDecision {
  blocked: boolean;
  /** Present whenever there is something to say — on a block, and on the
   * warn-shaped "could not check" outcomes. */
  message?: string;
  tone?: "danger" | "warn";
}

/** First 7 chars, the length every git UI uses. Guards against a short/empty input
 * rather than throwing inside a decision function. */
function short(sha: string): string {
  return sha.slice(0, 7) || "(unknown)";
}

/**
 * Decide whether a promote may proceed given what gate 2 attested and what is true
 * now. Ordered most-concrete-first: a busy production blocks regardless of how good
 * your attestation is, and a stale attestation blocks regardless of CI.
 */
export function decidePromoteAttestation(
  input: PromoteAttestationInput,
): PromoteAttestationDecision {
  // Clause 4 (the half that needs no credentials): another run on this repo is
  // mid-production. Two promotes landing at once is the collision the owner named.
  const busy = input.busyRuns ?? [];
  if (busy.length > 0) {
    const list = busy.map((s) => `spec ${s}`).join(", ");
    return {
      blocked: true,
      tone: "danger",
      message:
        `Production is busy — ${list} ${busy.length === 1 ? "is" : "are"} mid-deploy. ` +
        `Promote again once it finishes (or has rolled back to the last good build).`,
    };
  }

  // Clause 4's other half (spec 0115): odoo.sh is mid-build on the commit
  // production is serving. Same question as the busyRuns check above — "is
  // production free to receive this?" — but about THEIR deploy rather than ours,
  // so it sits immediately after it.
  //
  // This is the clause the owner asked for, and the reason is a documented unknown:
  // pushing to production while a build is in flight makes odoo.sh queue, cancel
  // or restart, and which of those is not documented anywhere. Not merging during
  // a build makes the question moot, which is better than depending on an answer
  // nobody has.
  if (input.productionBuild && isOdooShBuildInFlight(input.productionBuild)) {
    const detail =
      input.productionBuild.status === "building" && input.productionBuild.description
        ? ` (${input.productionBuild.description})`
        : "";
    return {
      blocked: true,
      tone: "danger",
      message:
        `odoo.sh is still building production${detail}. Merging now would push a second ` +
        `commit into an in-flight build, and whether odoo.sh queues, cancels or restarts ` +
        `is undocumented — promote again once the build finishes.`,
    };
  }

  // No attestation: a run approved before this guard existed. Warn, don't block —
  // see the posture note above.
  if (!input.attestation) {
    return {
      blocked: false,
      tone: "warn",
      message:
        "This change was approved before the promote guard existed, so the tested " +
        "commit was never recorded — promoting on your judgment.",
    };
  }

  const { testedSha, baseSha } = input.attestation;

  // Clause 2: the PR moved under the approval.
  if (input.prHead && input.prHead !== testedSha) {
    return {
      blocked: true,
      tone: "danger",
      message:
        `You approved ${short(testedSha)}, but the PR is now at ${short(input.prHead)} — ` +
        `a commit landed after the review. Re-approve the change to promote it.`,
    };
  }

  // Clause 3: main moved under the approval. Green CI does not help here — the
  // merge result is a tree nobody has run.
  if (input.mainHead && input.mainHead !== baseSha) {
    return {
      blocked: true,
      tone: "danger",
      message:
        `This was tested against main ${short(baseSha)}, but main is now ` +
        `${short(input.mainHead)} — another change was promoted first. Re-test the ` +
        `change on the new base, then approve it again.`,
    };
  }

  // An attestation we cannot compare against is not a pass. Say so rather than
  // implying the check ran.
  if (!input.prHead || !input.mainHead) {
    return {
      blocked: false,
      tone: "warn",
      message:
        "Could not read the current PR head or main tip, so the approved commit " +
        "could not be re-checked — promoting on your judgment.",
    };
  }

  return { blocked: false };
}
