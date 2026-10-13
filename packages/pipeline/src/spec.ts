/** Spec types — the pipeline's unit of work. Mirrors docs/SPEC_FORMAT.md */

export type SpecStatus =
  | "draft"
  | "approved"
  | "in_progress"
  | "staged"
  | "promoted"
  | "rejected"
  /**
   * Done, but never through the pipeline (spec 0122). `promoted` now means
   * specifically "merged to the production branch" — for an odoo.sh customer that
   * merge IS the deploy (spec 0115) — so hand-authored Track-1 work needs its own
   * terminal value rather than borrowing one that claims a gate it never passed.
   */
  | "completed";

export type OdooVersion = 17 | 18 | 19;

/** Target: the same pipeline builds the launchpad itself or a client tenant. */
export type PipelineTarget =
  | { kind: "self"; repo: string }
  | { kind: "tenant"; tenantId: string; repo: string; odooVersion: OdooVersion; vpsId: number };

/**
 * WIRE-COMPAT contract (spec 0036) — not tech debt, keep indefinitely.
 *
 * A run started before the "launchpad" → "self" target-kind rename has its
 * `target` persisted verbatim in Temporal workflow input/history. After a
 * worker redeploys onto a build where the rename has landed, that in-flight
 * run's target may still literally be `{ kind: "launchpad" }`. Any code that
 * needs to ask "is this the self/dogfood target?" must go through this
 * helper — comparing against `"self"` alone would make an in-flight legacy
 * run fall through to the `"tenant"` branch and crash.
 */
export function isSelfTarget(t: { kind: string }): boolean {
  return t.kind === "self" || t.kind === "launchpad";
}

export interface Spec {
  id: string; // "0002"
  title: string;
  target: PipelineTarget;
  status: SpecStatus;
  requestedBy: string;
  approvedBy?: string;
  intent: string;
  scope: string;
  acceptanceCriteria: string[];
  /** Ordered checklist written by the initializer agent. */
  plan: { item: string; done: boolean }[];
}

export interface PipelineInput {
  specId: string;
  target: PipelineTarget;
  /** Plain-language change request from the user; seed for draftSpec. */
  request: string;
  requestedBy: string;
  /**
   * Budget cap on coder-loop iterations (spec 0006). Exceeding it fails the
   * workflow with a clear error. Defaults to DEFAULT_MAX_ITERATIONS when unset.
   */
  maxIterations?: number;
  /**
   * The project this run belongs to (spec 0129 B). Additive and optional: a run
   * started before this — or for the platform itself — carries none, and behaves
   * exactly as it did.
   *
   * Present, it lets the worker MATERIALISE the checkout `target.repo` names before
   * anything tries to use it. `target.repo` stays the single answer to "where does
   * this run work?" (`repoRootOf`); this is only how that directory comes to exist.
   */
  project?: {
    slug: string;
    repoOwner?: string | null;
    repoName?: string | null;
    /** `platform` keeps its specs committed; other kinds exclude them. */
    kind?: string | null;
    /**
     * The checkout the run already resolved (spec 0150).
     *
     * `ensureProjectCheckout` has always taken a known `repoRoot` and returned it
     * before considering a clone — that early return is the whole reason re-cloning
     * per run does not happen. This field is what feeds it. Without it, a project
     * with a `repo_root` row but no `repo_owner`/`repo_name` — which is exactly the
     * PLATFORM, whose checkout is the deployed one — reached the "nothing to clone"
     * refusal and every UI-started platform run failed on its first activity.
     *
     * Payload widening only (the 0131 C precedent): absent from every earlier
     * history, so no replay can reach a path gated on it and no marker is needed.
     */
    repoRoot?: string | null;
  };
  /**
   * The branch this run lands its commits on (spec 0133 — the odoo.sh model).
   * Absent ⇒ today's per-spec behavior, byte-identical: worktree branch
   * `spec/<id>` cut from main, one PR per spec. Present ⇒ the worktree checks
   * out THIS branch (shared across the branch's runs, reconciled with origin
   * first), the PR is the branch's single accumulating PR, and the run ends at
   * the terminal `staged` phase — the production act is the branch-level
   * promote (spec 0136), not a per-spec gate 3.
   *
   * Absent from every pre-0133 history, which is what makes the whole branch
   * model ship with no new `patched()` marker: no replay can reach a path
   * gated on it (spec 0133 decision 1).
   */
  branch?: string;
  /**
   * Compact UTC stamp (`YYYYMMDDTHHMMSSZ`) for the backup the gate-2 staging
   * refresh takes before installing addons into a branch database that already
   * exists (spec 0187 E).
   *
   * The WORKFLOW mints it from its own start time and adds it at the
   * `deployStaging` call — the same shape `deployReleaseWorkflow` uses — because
   * spec 0105 requires the caller to supply it: an activity that stamps itself
   * orphans one backup directory per retry.
   *
   * Not part of a started run's payload: it is added on the way INTO the
   * activity, so `startPipeline` never sets it and no history carries it.
   */
  backupTimestamp?: string;
}

/** Default coder-loop budget when PipelineInput.maxIterations is unset. */
export const DEFAULT_MAX_ITERATIONS = 12;

/**
 * Coder-loop budget cap for a `ui_only` run (spec 0031 / ADR-018). A UI-only
 * spec runs leaner: the workflow caps the effective budget at
 * `min(input.maxIterations ?? DEFAULT_MAX_ITERATIONS, UI_ONLY_MAX_ITERATIONS)`
 * when `EphemeralEnv.uiOnly` is set, so a UI-only run can never spend more than
 * this many coder iterations even if a larger `maxIterations` was requested.
 *
 * Spec 0196: this budget is now the flag's ONLY meaning. The path fence it used
 * to carry allowed `apps/web/**` — the launchpad's own layout — so on a customer
 * project every legitimate change was a violation, and a path allowlist was
 * never a boundary in the first place (`docs/DECISIONS.md`, 2026-08-13). Setting
 * `ui_only: true` says "this is a small front change, spend fewer rounds on it",
 * and nothing else.
 */
export const UI_ONLY_MAX_ITERATIONS = 6;

export interface CiResult {
  green: boolean;
  reportUrl?: string;
  /**
   * Spec 0138: the recorded reason CI did not RUN (a repo with no Node
   * toolchain — e.g. an Odoo addons repo). `green: true` + this note is the
   * honest shape: the coder loop must not repair forever against a toolchain
   * that does not exist, and the note keeps the absence of evidence VISIBLE
   * (VERIFICATION #2 — a fabricated pass would be a check that cannot fail).
   * The branch's staging install is the verification that does exist (0134).
   */
  skipped?: string;
  /**
   * Spec 0167: what CI actually DID, when it ran. Distinct from `skipped` on
   * purpose — that field means "CI did not run, here is why", and reusing it for
   * a real result would make the run's own record say the opposite of the truth.
   * Both ride the PR body through the workflow's `ciNote`.
   */
  note?: string;
}

/**
 * Result of one coder session (spec 0006): unchecked non-human items left and
 * whether the session produced at least one new commit on the spec branch
 * (used for stall detection).
 */
export interface CoderResult {
  remaining: number;
  progressed: boolean;
}
