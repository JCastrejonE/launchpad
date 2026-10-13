/**
 * Server-side reader for the odoo-next provisioning progress view (spec 0161
 * F3) — the `describePipeline` posture, narrowed to the two provisioning
 * queries the follow view needs. Node-only (it touches @temporalio/client via
 * `getClient`); the pure derivation the browser renders lives in
 * `lib/provisioning-run.ts`.
 *
 * DEGRADE, never throw (the run-follow posture): if Temporal is unreachable, the
 * run was never started, or a query fails, the reader returns `phase: null` /
 * `status: null` rather than raising — the view then renders all five phases
 * `upcoming`, not an error.
 *
 * The workflow id is `provision-<slug>` — the exact id `startProvisioningAction`
 * starts under (app/new/actions.ts), so the two cannot drift.
 */
import {
  PROVISIONING_PHASE_QUERY,
  PROVISIONING_FAILED_PHASE_QUERY,
  type ProvisioningPhase,
} from "@launchpad/pipeline";
import { getClient } from "./pipeline";

/** Live state of one provisioning run, as the follow view reads it. */
export interface ProvisioningRunState {
  slug: string;
  /** The workflow's reported work/terminal phase, or `null` when Temporal is
   * unreachable or the run has not been started (not yet queryable). */
  phase: ProvisioningPhase | null;
  /** Which work phase a failed run died on; `undefined` while running/completed. */
  failedPhase: ProvisioningPhase | undefined;
  /** Temporal execution status name (RUNNING / COMPLETED / FAILED / …), or
   * `null` when unreachable / not started. */
  status: string | null;
  /**
   * Why a FAILED run failed, in the words the activity used. `undefined` for any
   * other state.
   *
   * The view said "revisa el detalle abajo" and then had no detail to show,
   * because nothing carried one — so a failed provisioning told you a phase name
   * and left you to read the worker log. This is that detail.
   *
   * Membership-gated by the route, like the rest of the run state: an activity's
   * message can quote a remote command's stderr, which is fine for a project
   * member and not for the world.
   */
  failureMessage?: string;
}

/** The slice of `@temporalio/client`'s `Client` this reader uses — the test seam
 * (same rationale as `pipeline.ts`'s `SignalClient`); a real `Client` satisfies
 * it, so callers pass nothing. */
export interface ProvisioningFollowClient {
  workflow: {
    getHandle(workflowId: string): {
      query<T>(queryType: string): Promise<T>;
      describe(): Promise<{ status: { name: string } }>;
      /** Only ever awaited for a CLOSED run — see `failureMessageOf`. */
      result(): Promise<unknown>;
    };
  };
}

/**
 * The deepest message in an error's `cause` chain.
 *
 * Temporal wraps a failure: the outer error says "Workflow execution failed" and
 * the ApplicationFailure underneath carries what actually happened
 * ("front phase failed: … open Dockerfile: no such file or directory"). Taking
 * the outermost message would show the useless half.
 */
export function deepestMessage(err: unknown, cap = 600): string | undefined {
  let best: string | undefined;
  let node: unknown = err;
  const seen = new Set<unknown>();
  while (node && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const message = (node as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) best = message.trim();
    node = (node as { cause?: unknown }).cause;
  }
  return best === undefined ? undefined : best.slice(0, cap);
}

/**
 * Read a provisioning run's live phase, failed-phase and execution status.
 * `clientOverride` is the test seam; real callers omit it to use the lazily
 * connected singleton.
 */
export async function getProvisioningRunState(
  slug: string,
  clientOverride?: ProvisioningFollowClient,
): Promise<ProvisioningRunState> {
  try {
    const client: ProvisioningFollowClient = clientOverride ?? (await getClient());
    const handle = client.workflow.getHandle(`provision-${slug}`);
    // Per-read `.catch` keeps partial results — a describe outage still yields
    // the phase; a not-yet-RUNNING query failure still yields the status.
    const [phase, failedPhase, description] = await Promise.all([
      handle.query<ProvisioningPhase>(PROVISIONING_PHASE_QUERY).catch(() => undefined),
      handle.query<ProvisioningPhase | undefined>(PROVISIONING_FAILED_PHASE_QUERY).catch(() => undefined),
      handle.describe().catch(() => undefined),
    ]);
    const status = description?.status.name ?? null;
    // ONLY for a closed-failed run: `result()` on a running workflow blocks
    // until it finishes, which would hang the poll this view calls every few
    // seconds. On a failed one it rejects immediately with the stored failure.
    // Wrapped, not just `.catch`-ed: if `result` is missing or throws
    // synchronously, we must still return the phase and status. Losing the whole
    // run state because the REASON could not be read would be a worse view than
    // the one this replaces.
    let failureMessage: string | undefined;
    if (status === "FAILED") {
      try {
        await handle.result();
      } catch (err) {
        failureMessage = deepestMessage(err);
      }
    }
    return {
      slug,
      phase: phase ?? null,
      failedPhase,
      status,
      ...(failureMessage ? { failureMessage } : {}),
    };
  } catch {
    // Temporal connection / handle creation failed — degrade, don't throw
    // (the run-follow posture the view depends on).
    return { slug, phase: null, failedPhase: undefined, status: null };
  }
}
