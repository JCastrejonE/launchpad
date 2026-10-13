/**
 * Testable core behind the workspace Agentes tab's gate buttons (spec 0095).
 *
 * The SAME guard-then-signal boundary the spec page enforces
 * (app/forge/specs/[filename]/actions.ts): `resolvePromoteSignalGuard` runs
 * FIRST — the gate-3 CI guard "that never loosens" (spec 0043 item D) — so a
 * `promote` whose merge-commit CI is red is refused before `signalGate` is ever
 * reached. A second surface for the same signal must not become a way around it.
 *
 * Lives in `lib/` (not in the `"use server"` actions.ts) for the same reason
 * `runStartPipelineAction` does: a server-action file may only export async
 * actions, so the dispatch can't take injectable deps there — and the test
 * build (tsconfig.test.json) compiles `lib/` only. Injectable `deps` let the
 * unit test prove the guard is unbypassable without a live Temporal server.
 * The `"use server"` `signalGateAction` is a thin wrapper: it resolves the
 * OWNER session, calls this, then redirects / audits / revalidates.
 */
import {
  resolvePromoteSignalGuard as resolvePromoteSignalGuardIO,
  signalGate as signalGateIO,
  type GateSignal,
} from "./pipeline";

/** Redirect-worthy outcome — a reason on failure, never a thrown error (the
 * action needs a message for its `?error=` redirect, not an exception into
 * Next's generic error page). Mirrors `StartPipelineActionResult`. */
export type WorkspaceGateResult = { ok: true } | { ok: false; reason: string };

/** Injectable IO seam — real functions by default, fakes in the unit test. */
export interface WorkspaceGateDeps {
  resolvePromoteSignalGuard: typeof resolvePromoteSignalGuardIO;
  signalGate: typeof signalGateIO;
}

export const defaultWorkspaceGateDeps: WorkspaceGateDeps = {
  resolvePromoteSignalGuard: resolvePromoteSignalGuardIO,
  signalGate: signalGateIO,
};

/**
 * Guard-then-signal, behaviourally identical to the spec page's action:
 * consult `resolvePromoteSignalGuard` FIRST (subtractive — only ever blocks a
 * red-CI `promote`), refuse with its message if blocked, otherwise deliver the
 * signal. `actor` is the already-verified OWNER session email (the wrapper
 * resolves it; this core never trusts an unauthenticated caller).
 */
export async function runWorkspaceGateAction(
  specId: string,
  signal: GateSignal,
  actor: string,
  deps: WorkspaceGateDeps = defaultWorkspaceGateDeps,
  /** Spec 0142 C: the project whose spec this is — workflow ids are namespaced
   * by slug, so the workspace (which always knows) says so rather than relying
   * on the recorded-id lookup to disambiguate. */
  projectSlug?: string,
): Promise<WorkspaceGateResult> {
  const guard = await deps.resolvePromoteSignalGuard(specId, signal);
  if (guard.blocked) {
    return { ok: false, reason: guard.message ?? "Promote blocked: CI is not green." };
  }
  try {
    await deps.signalGate(specId, signal, actor, undefined, undefined, projectSlug);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
