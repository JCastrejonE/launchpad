"use server";

/**
 * Server Actions backing the spec detail page's gate buttons (spec 0005).
 * Thin — all real logic (Temporal I/O, signal names) lives in
 * lib/pipeline.ts; these just supply the actor and revalidate the page so
 * the new state shows up without a manual reload. Since spec 0074 the actor
 * is the VERIFIED session email: every mutating action here requires a
 * signed-in OWNER session (audit #3's "authenticated, attributable
 * mutations") and refuses via the page's `?error=` panel otherwise.
 *
 * Failures redirect back to the same page with `?error=`, rather than
 * throwing into Next's generic error page (spec 0007) — a gate click must
 * never be lost silently.
 *
 * spec 0056 item B (re-based by 0074): `startPipelineAction` is gate-aware —
 * it consults the SAME `supervisorAccess` (flag + OWNER session) guard the
 * `/api/supervisor*` routes use. The actual branch dispatch
 * (`spawnStartWatcher` when the gate is on, the pre-existing bare
 * `startPipeline` when it's off) lives in `runStartPipelineAction`
 * (lib/supervisor-run.ts) — this action is just a thin session +
 * redirect/revalidate wrapper around it, so the dispatch itself stays
 * unit-testable (this file can't be, per the doc comment there).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
// Spec 0124: the frontmatter status writer, beside the other spec-file helpers.
import { setStatus } from "@launchpad/pipeline";
import { actorFor, isPlatformMember, supervisorAccess } from "../../../auth";
import { capabilityForSignal } from "../../../../lib/capabilities";
import { gateAuditAction, recordAudit } from "../../../../lib/audit";
import {
  signalGate,
  resolvePromoteSignalGuard,
  type GateSignal,
} from "../../../../lib/pipeline";
import { runStartPipelineAction } from "../../../../lib/supervisor-run";

/** Starts a pipeline run for a spec that's already on disk (status draft,
 * no workflow yet). draftSpec() is idempotent when the spec file already
 * exists, so `request` is a placeholder here — the "start a change" form on
 * the inbox page (a later Plan item) is what makes the request text matter
 * for brand-new specs.
 *
 * Gate ON (flag + OWNER session): starts a WATCHED run — the same guarded
 * `spawnStartWatcher` the console's `{mode:"start"}` POST calls. Gate OFF:
 * falls back to the bare `startPipeline` call this action always made
 * before spec 0056 — byte-identical, no host spawn. */
export async function startPipelineAction(filename: string, specId: string, title: string): Promise<void> {
  // Spec 0144 E: platform membership, not merely a role — see signalGateAction.
  if (!(await isPlatformMember())) {
    redirect(`/forge/specs/${filename}?error=${encodeURIComponent("No eres miembro del proyecto platform.")}`);
    return;
  }
  // Spec 0117: `request` — a run produces a branch and a PR, never a
  // production change. Same capability as the workspace twin, deliberately.
  const check = await actorFor("request");
  if (!check.ok) {
    redirect(`/forge/specs/${filename}?error=${encodeURIComponent(check.reason)}`);
    return;
  }
  const actor = check.actor;
  const access = await supervisorAccess();
  const result = await runStartPipelineAction(specId, title, actor, access);
  if (!result.ok) {
    redirect(`/forge/specs/${filename}?error=${encodeURIComponent(`Could not start pipeline: ${result.reason}`)}`);
    return;
  }
  await recordAudit({ actor, action: "pipeline.start", target: specId, metadata: { filename, watched: access.ok } });
  revalidatePath(`/forge/specs/${filename}`);
}

export async function signalGateAction(
  filename: string,
  specId: string,
  signal: GateSignal,
): Promise<void> {
  // Spec 0144 E: this surface acts on the PLATFORM's specs, so it needs
  // platform membership — not merely a role. Load-bearing while workflow ids
  // are `spec-<id>` (0142 C): a signal here addresses a workflow by spec id,
  // and a customer project's `spec-0001` shares that id.
  if (!(await isPlatformMember())) {
    redirect(`/forge/specs/${filename}?error=${encodeURIComponent("No eres miembro del proyecto platform.")}`);
    return;
  }
  // Spec 0074 (audit #3): gate signals are authenticated, attributable
  // mutations — the actor recorded on the workflow is the verified session
  // email. Spec 0117: approve/reject need `request`, `promote` needs OWNER.
  // Both surfaces consult the SAME `capabilityForSignal` map for the same
  // reason they share `resolvePromoteSignalGuard` — a second surface for one
  // signal must never be the weaker one.
  const check = await actorFor(capabilityForSignal(signal));
  if (!check.ok) {
    if (check.actor) {
      await recordAudit({
        actor: check.actor,
        action: "gate.denied",
        target: specId,
        metadata: { filename, signal },
      });
    }
    redirect(`/forge/specs/${filename}?error=${encodeURIComponent(check.reason)}`);
    return;
  }
  const actor = check.actor;
  // Server-side promote guard (spec 0043 item D): defense-in-depth behind
  // item C's UI disable, since this is still a plain form POST a stale page
  // could resubmit. Purely subtractive — only ever blocks a `promote` signal
  // whose real merge-commit CI is failure/pending; every other signal (and
  // every allow-with-note promote case) reaches signalGate exactly as
  // before. Never sends a signal itself.
  const guard = await resolvePromoteSignalGuard(specId, signal);
  if (guard.blocked) {
    redirect(
      `/forge/specs/${filename}?error=${encodeURIComponent(guard.message ?? "Promote blocked: CI is not green.")}`,
    );
    return;
  }
  try {
    await signalGate(specId, signal, actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    redirect(`/forge/specs/${filename}?error=${encodeURIComponent(`Could not send "${signal}": ${message}`)}`);
  }
  // Reached only on success (the catch redirect throws NEXT_REDIRECT).
  await recordAudit({ actor, action: gateAuditAction(signal), target: specId, metadata: { filename } });
  revalidatePath(`/forge/specs/${filename}`);
}

/**
 * Mark a Track-1 spec complete (spec 0124) — the manual step, since hand-authored
 * work has no pipeline run to finish it.
 *
 * `request`-gated like archiving, not `promote`: it edits a frontmatter field and
 * changes nothing in production (spec 0117's split). Reversible by editing the file,
 * which is why there is no confirmation.
 *
 * The button that calls this is only rendered for a Track-1 spec with a non-terminal
 * status (`deriveSpecProgress`), but the action does not depend on that: it is a
 * status write either way, and a stale page re-submitting it is harmless.
 */
export async function completeSpecAction(filename: string, specId: string): Promise<void> {
  // Spec 0144 E: platform membership, not merely a role — see signalGateAction.
  if (!(await isPlatformMember())) {
    redirect(`/forge/specs/${filename}?error=${encodeURIComponent("No eres miembro del proyecto platform.")}`);
    return;
  }
  const check = await actorFor("request");
  if (!check.ok) {
    redirect(`/forge/specs/${filename}?error=${encodeURIComponent(check.reason)}`);
    return;
  }
  const root = process.env["LAUNCHPAD_REPO_ROOT"];
  if (!root) {
    redirect(
      `/forge/specs/${filename}?error=${encodeURIComponent("LAUNCHPAD_REPO_ROOT is not set on the web server")}`,
    );
    return;
  }
  try {
    await setStatus(root, specId, "completed");
  } catch (err) {
    redirect(
      `/forge/specs/${filename}?error=${encodeURIComponent(
        `Could not complete spec ${specId}: ${(err as Error).message}`,
      )}`,
    );
    return;
  }
  await recordAudit({
    actor: check.actor,
    action: "spec.completed",
    target: specId,
    metadata: { filename, track: 1 },
  });
  revalidatePath(`/forge/specs/${filename}`);
}
