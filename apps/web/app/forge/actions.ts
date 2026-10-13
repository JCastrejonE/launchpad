"use server";

/**
 * Server action backing the supervisor console's gate card (spec 0049 item
 * B1). The bridge's `{type:"gate",specId}` `SupervisorEvent` carries only a
 * bare spec id (the agent's marker names nothing else) — this resolves it to
 * the filename/title/available-gate-actions the EXISTING
 * `GateActionButtons`/gate-card components need, the same lookup
 * `lib/chat-tools.ts`'s `loadSpecView` does for the chat surface, just keyed
 * by id instead of filename. Read-only: it never signals a gate itself —
 * only the human's click on the rendered `GateActionButtons` does that, via
 * the existing `signalGateAction`.
 *
 * A thin wrapper (item B2) — the real logic lives in
 * `lib/supervisor-console.ts#resolveSupervisorGateCard` (moved there so it's
 * unit-testable with fake deps under `tsconfig.test.json`'s `lib`-only
 * scope), the same lib-holds-the-logic split
 * `app/forge/specs/[filename]/actions.ts` already uses over `lib/pipeline.ts`.
 *
 * Also wraps `deriveSpecDraftCard` (spec 0050 item B2): it's a PURE function
 * with no I/O, but `lib/supervisor-console.ts` also imports server-only I/O
 * (`@launchpad/agents`, `./specs`, `./pipeline`) that must never reach the
 * client bundle — so the client component (`SupervisorConsole.tsx`) calls it
 * through this "use server" boundary, exactly like the gate-card resolver.
 */
import {
  deriveSpecDraftCard as deriveSpecDraftCardLib,
  resolveSupervisorGateCard as resolveSupervisorGateCardLib,
  type SpecDraftCard,
  type SupervisorGateCard,
} from "../../lib/supervisor-console";

export type { SpecDraftCard, SupervisorGateCard };

/** Resolves a bare spec id to gate-card props, or `null` when the spec can't
 * be found or isn't actually parked at a gate right now (e.g. the agent's
 * marker was stale) — never throws into the client component. */
export async function resolveSupervisorGateCard(specId: string): Promise<SupervisorGateCard | null> {
  return resolveSupervisorGateCardLib(specId);
}

/** Maps a `{type:"spec_draft"}` SupervisorEvent to review-card props (spec
 * 0050 item B2) — review-only, no commit/run/promote affordance. */
export async function deriveSpecDraftCard(event: {
  specId: string;
  specPath: string;
  title: string;
  summary: string;
  model: string;
}): Promise<SpecDraftCard> {
  return deriveSpecDraftCardLib(event);
}
