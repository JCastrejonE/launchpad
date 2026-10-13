/**
 * The odoo-next PROVISIONING run's phase model (spec 0148 phase F) — the pure
 * twin of phase.ts, for the `repo → dns → odoo → front → verify` provisioning
 * workflow. Deliberately a separate, smaller alphabet from the spec pipeline's
 * {@link PipelinePhase}: this run provisions a project, it does not draft/code/
 * gate a spec.
 *
 * Every name here is a STRING CONSTANT, never a function reference
 * (VERIFICATION #10). The workflow type apps/web starts, the phase the running
 * workflow reports via query, and the stepper the progress UI renders all
 * identify a phase BY NAME — and a minifier renames a function passed by
 * reference (the nine-hour incident where `provisionProject` became `"P"`). This
 * module is the single source those three read from, so they cannot drift.
 *
 * Pure (no @temporalio import) so the workflow, the worker registration, and the
 * apps/web progress view share the types, and so it loads under `node --test`.
 */

/**
 * Every position the provisioning workflow can report, in order. The first five
 * are the work phases from spec 0148's scope (A repo, B dns, C odoo, D front,
 * F verify); the last two are TERMINAL — the workflow sets one as its final step
 * (the phase.ts pattern that fixed "tearing_down forever", spec 0009) so a
 * closed provisioning run reports its true outcome, and a mid-phase failure
 * surfaces as `failed` rather than a spinner.
 */
export type ProvisioningPhase =
  | "repo"
  | "dns"
  | "odoo"
  | "front"
  | "verify"
  | "completed"
  | "failed";

/** All provisioning phases, in lifecycle order — the single source the query
 * handler, the workflow, and the progress view all read from. */
export const PROVISIONING_PHASES: readonly ProvisioningPhase[] = [
  "repo",
  "dns",
  "odoo",
  "front",
  "verify",
  "completed",
  "failed",
] as const;

/** The terminal outcomes. The workflow sets one as its final step so the query
 * never answers a work phase on a finished run. */
export const PROVISIONING_TERMINAL_PHASES: readonly ProvisioningPhase[] = [
  "completed",
  "failed",
] as const;

export function isProvisioningTerminalPhase(phase: ProvisioningPhase): boolean {
  return (PROVISIONING_TERMINAL_PHASES as readonly string[]).includes(phase);
}

/**
 * The workflow TYPE name apps/web passes to `client.workflow.start`, and the name
 * the worker registers the workflow export under. A string constant, never
 * `start(provisionProject, …)` — a production minifier would rename the function
 * reference and Temporal would look up a type that no worker serves
 * (VERIFICATION #10).
 */
export const PROVISION_PROJECT_WORKFLOW = "provisionProject";

/** Name of the Temporal query apps/web calls to read the provisioning run's true
 * phase. Shared so the `defineQuery` in the workflow and the `query()` call in
 * apps/web never drift apart (the PIPELINE_PHASE_QUERY pattern). */
export const PROVISIONING_PHASE_QUERY = "provisioningPhase";

/**
 * Name of the Temporal query apps/web calls to read WHICH work phase a failed
 * provisioning run died on (spec 0161 F3) — one of the five work phases, or
 * `undefined` on a running or completed run. Paired with
 * {@link PROVISIONING_PHASE_QUERY} so the progress view can render the phase
 * that failed distinctly ("that phase failed", not a spinner) once the
 * `phase` query has already flipped to the terminal `failed`. Reuses
 * {@link ProvisioningPhase} — it is NOT a second list of phases.
 */
export const PROVISIONING_FAILED_PHASE_QUERY = "provisioningFailedPhase";

/**
 * A branding logo to commit into the project's repo during the `repo` phase
 * (spec 0161 E2b). Bytes are base64 — exactly what `commitFileToRepo` (spec
 * 0148 E1) expects as `content`. The repo created in phase A is the durable
 * home; there is no separate object store.
 */
export interface LogoCommit {
  /** Repo-relative path the logo lands at, e.g. `public/logo.png`. */
  path: string;
  /** File bytes, base64-encoded. */
  contentBase64: string;
}

/**
 * Input to the {@link PROVISION_PROJECT_WORKFLOW} workflow (spec 0161 F2).
 *
 * Deliberately minimal — the project slug and an optional logo. Everything
 * else (the repo coordinates to create, the sandbox VPS, the domain) is
 * resolved WORKER-side inside the activities from the project row and worker
 * env, the same posture `runBranchStagingOp` takes (slug in, DB read there):
 * the fleet SSH identity and Hostinger/GitHub tokens are worker-only and must
 * never cross into apps/web.
 */
export interface ProvisionProjectInput {
  slug: string;
  logo?: LogoCommit;
  /**
   * Spec 0182: the DNS ZONE this project's hostnames live in — `<slug>.<zone>`
   * and `<slug>.odoo.<zone>`. The owner: *"domain means the zone."*
   *
   * Carried on the input rather than read per activity, so every phase of one
   * run agrees by construction. Absent means `example.com`, which is where every
   * project provisioned before this one lives.
   *
   * The constant it replaces was the reason `ab-test-sandbox` ended up recorded
   * as deployed at a hostname in a zone nobody created: provisioning wrote DNS
   * into `example.com` while the project's `domain` said otherwise, and the
   * release deploy believed the project.
   */
  zone?: string;
}
