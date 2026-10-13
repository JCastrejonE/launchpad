/**
 * `GateSignal` + its button label map, split out of lib/pipeline.ts (spec
 * 0016 item 6b) so client components can import the label map WITHOUT
 * pulling in pipeline.ts's `@temporalio/client` (which drags in @grpc/grpc-js
 * — a Node-only module needing `fs`/`net`/`tls` — and breaks the `next
 * build` browser bundle for any "use client" file that imports it, even
 * indirectly for a single unrelated named export: Webpack can't tree-shake
 * past pipeline.ts's top-level `@temporalio/client` import). Framework-free,
 * no I/O — safe from both server and client code.
 *
 * `suppressDuplicateApprove` moved here too (spec 0052 item E) for the same
 * reason: `apps/web/lib/run-follow-card.ts` (the run-follow console's pure
 * card-model derivation) is imported DIRECTLY (as a value, not just a type)
 * by the "use client" `RunFollowCard.tsx` — unlike `chat-cards.ts`'s
 * derivations, which only ever cross into a client component as an
 * already-computed props object via a "use server" action. So anything
 * `run-follow-card.ts` needs from `pipeline.ts` must live in a
 * `@temporalio/client`-free module instead, exactly like `GateSignal`/
 * `GATE_ACTION_LABEL` above.
 *
 * lib/pipeline.ts re-exports all three symbols so its existing server-side
 * callers (app/specs/[filename]/page.tsx, lib/chat-cards.ts, etc.) are
 * unaffected.
 */
import type { PullRequestRef } from "@launchpad/pipeline";

/** Signal names accepted by signalGate() — identical to the workflow's own
 * signal identifiers, so a button's action can be sent straight through. */
export type GateSignal = "specApproved" | "prApproved" | "promote" | "specRejected";

/** Human-readable label for each gate button — shared by the spec detail
 * page and the chat's generative gate cards so the two surfaces never drift
 * on what a button is called. */
export const GATE_ACTION_LABEL: Record<GateSignal, string> = {
  specApproved: "Aprobar spec",
  prApproved: "Aprobar PR",
  promote: "Promover",
  specRejected: "Rechazar",
};

/**
 * Suppresses the in-app "Aprobar PR" action when gate 2 is a real GitHub PR
 * (spec 0015 item 8): in that mode the GitHub review IS gate 2's approval
 * (delivered via the `awaitPrApproval` activity), so also showing an in-app
 * Approve button would be a second, conflicting source of truth for who
 * approved. Local-diff refs (`pr` absent, or `pr.number <= 0`) are
 * unaffected. `specRejected` is left alone in both modes — it's still a
 * valid in-app escape hatch even when GitHub is the approval path.
 */
export function suppressDuplicateApprove(
  actions: GateSignal[],
  pr: PullRequestRef | undefined,
  /**
   * Spec 0142: the run's branch, when it is a BRANCH run (spec 0133).
   *
   * A branch run does NOT poll GitHub for the PR review — its gate 2 means
   * "validated on the branch's staging server", and the only way to deliver it
   * is the in-app signal. Suppressing the button there leaves gate 2 with a
   * Reject and nothing else, and since no poll is running the run waits
   * forever: the first branch run through the pipeline sat at
   * `awaiting_pr_approval` with a green staging environment and no way to
   * approve it.
   *
   * The suppression's own reason does not apply either — it exists so GitHub's
   * review is not competing with an in-app approval, and for a branch run
   * GitHub's review is not gate 2 at all. The branch PR accumulates many
   * specs; merging it is PROMOTE (spec 0136), a different act.
   */
  branch?: string,
): GateSignal[] {
  if (!mergeIsTheGate(pr, branch)) return actions;
  return actions.filter((a) => a !== "prApproved");
}

/**
 * Is gate 2 satisfied by MERGING this PR? (Spec 0225 D.)
 *
 * Exactly the condition under which `suppressDuplicateApprove` removes the
 * in-app approve — deliberately the same predicate, because the two must never
 * disagree: hiding the approve without offering the merge is what left every
 * platform run parked at `awaiting_pr_approval` until someone opened GitHub.
 * Ten consecutive PRs show `approved_by=—`; not one was ever approved, they were
 * all merged by hand.
 *
 * `awaitPrApproval` returns `{outcome:"approved", via:"merge"}` on
 * `state.merged` — ADR-016's "the merge IS the approval". So this names an act
 * the pipeline already accepts, not a new gate.
 */
export function mergeIsTheGate(pr: PullRequestRef | undefined, branch?: string): boolean {
  // A branch run's gate 2 means "validated on staging" and its PR is promote's
  // business, not gate 2's (spec 0142).
  if (branch) return false;
  return !!pr && pr.number > 0;
}
