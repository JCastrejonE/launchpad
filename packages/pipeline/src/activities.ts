/**
 * Pipeline activities — all side effects live here (retryable).
 * Phase 2: implemented for isSelfTarget(target.kind) (dogfood: this repo,
 * local git, pnpm CI) — true for both "self" and the legacy "launchpad"
 * wire-compat literal (spec 0036). Tenant targets throw TODO(phase-3/4)
 * until fleet and GitHub App land.
 */
import { readFile, writeFile, mkdir, realpath, stat, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { Context, sleep as activitySleep } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import {
  loadCredential,
  modelForRole,
  modelForCoderItem,
  runAgentSession,
  formatSessionTiming,
  // The shared drafting policy (spec 0099 / G.1). Named `Architect*` for the
  // in-UI runner that first extracted them; they are the ONE drafting role's
  // guards now, imported here so `draftSpec` enforces exactly what the in-UI
  // spawn does instead of running with the default Bash/Edit surface.
  ARCHITECT_ALLOWED_TOOLS,
  createArchitectCanUseTool,
  architectFenceViolations,
  specStructureViolations,
} from "@launchpad/agents";
import type { SessionResult } from "@launchpad/agents";
import path from "node:path";
import { GithubClient, GithubApiError, latestStatusForContext } from "@launchpad/github";
import { CheckoutError, ensureProjectCheckout, projectSpecsDir } from "./checkout.js";
import type { GithubConfig } from "@launchpad/github";
import { PR_APPROVAL_NONRETRYABLE_ERROR_TYPE } from "./activity-options.js";
import {
  deployRelease,
  defaultDeployReleaseDeps,
  type DeployReleaseInput,
  type DeployReleaseResult,
} from "./release-deploy.js";
import {
  HostingerClient,
  ExecSshRunner,
  resolveHostingerToken,
  provisionClientVps,
  deployProductionStack,
  deployStagingStack,
  destroyStagingStack,
  deployBranchStagingStack,
  destroyBranchStack,
  branchStackName,
  frontStackFor,
  deployFrontStack,
  installTenantModules,
  readOrCreateDbPassword,
  readOrCreateOdooReadonlyCredentials,
  toActivityFailure,
  discoverAddons,
  runAddonTestsOnSandbox,
} from "@launchpad/fleet-hostinger";
import type {
  OdooReadonlyCredentials,
  SshTarget,
  SshRunner,
  BootstrapOptions,
  BootstrapResult,
  DeployOptions,
  DeployResult,
  DeployStagingOptions,
  StagingDeployResult,
  DestroyStagingOptions,
  DestroyStagingResult,
} from "@launchpad/fleet-hostinger";
import {
  isSelfTarget,
  type PipelineInput,
  type PipelineTarget,
  type OdooVersion,
  type SpecStatus,
  type CiResult,
  type CoderResult,
} from "./spec.js";
import { git, run } from "./git.js";
import { packCheckoutWithTar } from "./pack-checkout.js";
import { ensureLocalBranchAtOrigin, type BranchSyncResult } from "./branch-sync.js";
import { reconcileSpecBranchWithMain } from "./spec-branch-sync.js";
import { HARNESS_COUNT_ENV, harnessSkipProofError } from "./harness-exec.js";
import { coAuthorTrailer, commitTrailerInstruction, ensureCoAuthorTrailer } from "./commit-trailer.js";
import { buildPullRequestBody } from "./pr-body.js";
import { resolvePrMode } from "./github-config.js";
import { sessionProgressed, commitsMarkPlanRevision } from "./progress.js";
import { withRepoLock } from "./repo-lock.js";
// Spec 0189: the zone we publish staging names in, and whether a name in it can
// hold a certificate.
import { provisionedZone } from "./hosts.js";
import { stagingCertResolver, stagingDnsTarget } from "./staging-dns.js";
import { frontFailureNote, stagingRowUpdate } from "./staging-attestation.js";
import type { StagingRef } from "./staging-query.js";
import {
  ODOO_SH_STATUS_CONTEXT,
  interpretOdooShStatus,
  type OdooShBuild,
} from "./odoosh-status.js";
import {
  setStatus,
  specFileExists,
  findSpecFile,
  countUnchecked,
  countChecked,
  countHumanPending,
  readTitle,
  intentGoal,
  completedProgressItems,
  lastHandoffEntry,
  firstUncheckedPlanItem,
  readUiOnly,
  readProduct,
} from "./store.js";

export interface EphemeralEnv {
  envId: string;
  branch: string; // spec/<id>
  buildUrl: string; // https://spec-<id>.<client>... | "local" for dogfood
  workdir: string; // repo checkout the agents operate in
  /**
   * Primary checkout root (spec 0017): with worktree-per-run, `workdir` is the
   * run's isolated worktree (`.worktrees/spec-NNNN`) while `repoRoot` stays the
   * primary checkout that never leaves main — merge/teardown target it.
   * Optional until the worktree provisioning item lands; defaults to `workdir`
   * (today's single-checkout behavior) when unset.
   */
  repoRoot?: string;
  vpsId?: number; // Hostinger VPS (tenant targets, phase 3)
  /**
   * UI-only fast-path flag (spec 0031 / ADR-018), read from the worktree's spec
   * file by `provisionEphemeralEnv` (via `store.readUiOnly`) and returned on the
   * activity RESULT — never a workflow-side file read, so replay/determinism is
   * preserved (no TMPRL1100). The workflow consumes it to cap the coder budget
   * (`UI_ONLY_MAX_ITERATIONS`); `runInitializer`/`runCoder` consume it for the
   * tighter initializer prompt and the diff-path fence. Absent ⇒ today's
   * behavior, unchanged.
   */
  uiOnly?: boolean;
  /**
   * Product facet (spec 0037 / ADR-019), self targets only — read from the
   * WORKTREE's spec file by `provisionEphemeralEnv` (via `store.readProduct`)
   * and returned on the activity RESULT, EXACTLY the `uiOnly` channel
   * (activity output → `EphemeralEnv`, never a workflow-side file read; no
   * TMPRL1100). INFORMATIONAL this batch: nothing branches on it — it only
   * surfaces as a badge on `/specs`. `undefined` when absent (or no spec file
   * yet), matching the optional field's "no facet declared" contract.
   */
  product?: "hangar" | "forge" | "both";
}

export interface PullRequestRef {
  repo: string;
  branch: string;
  workdir: string;
  /**
   * Primary checkout root (spec 0017): local-diff merge and the post-merge
   * `pull --ff-only` target this — the primary checkout that stays on main —
   * not the run's worktree (`workdir`). Optional until the merge-into-primary
   * item lands; defaults to `workdir` when unset.
   */
  repoRoot?: string;
  number: number; // 0 = local merge (dogfood)
  url: string;
  /** Rendered PR body (spec 0006) — human-pending items + any stall note. */
  body?: string;
}

/** How the coder loop arrived at gate 2 — passed to openPullRequest so the PR
 * body can flag an incomplete (stalled) diff. */
export interface PrContext {
  stalled: boolean;
  /** Spec 0138: the recorded CI-skip reason, surfaced on the PR body. */
  ciNote?: string;
}

/** Counts read from the spec file without running a coder session — lets the
 * workflow check for work (or only-human items) before spending a session. */
export interface RemainingWork {
  /** Unchecked non-human items (store.countUnchecked). */
  remaining: number;
  /** Unchecked `(human)` items (store.countHumanPending). */
  humanPending: number;
}

/** Tuning for the gate-2 approval poll (spec 0015). `pollIntervalMs` is
 * injectable so the harness/tests don't wait on a real interval. */
export interface AwaitPrApprovalOptions {
  pollIntervalMs?: number;
}

/**
 * Outcome of the gate-2 approval wait (spec 0015). `approved` when an approving
 * review + green checks land (actor = the reviewer login); `rejected` when the
 * PR is closed without merging (actor names the closer / "(closed)").
 */
export interface PrApprovalOutcome {
  outcome: "approved" | "rejected";
  actor: string;
  /**
   * HOW an approval was reached (spec 0115) — and the reason this field exists:
   * gate 3 now performs the merge, so the workflow has to know whether there is
   * still a merge left to perform.
   *
   * `"merge"` is ADR-016's path: a human merged the PR on GitHub, which IS the
   * approval, so the merge already happened and the local checkout must be synced
   * at gate 2 (markSpec commits there immediately afterwards). `"review"` means the
   * PR was approved but is still open, so the merge belongs at promote.
   *
   * OPTIONAL for wire compatibility (spec 0036's discipline): an in-flight run
   * approved on older code replays an outcome without this field, and the workflow
   * treats a missing value as "not a merge", which is the pre-0115 behaviour for
   * every path except the already-merged one it can detect another way.
   */
  via?: "merge" | "review";
  /**
   * Spec 0167: the approval was accepted with NO CI, because the repo defines no
   * Actions workflows at all. Recorded rather than inferred — "approved without a
   * machine check" is exactly the fact a reviewer of the run should be able to
   * see, and the absence of evidence must stay visible (the posture spec 0138 set
   * for a skipped `runCi`).
   *
   * Optional for wire compatibility (spec 0036): a run approved on older code
   * replays an outcome without this field, which reads as "CI was present",
   * matching the behaviour that existed then.
   */
  noCi?: boolean;
}

/**
 * Repo checkout root for the working tree the agents operate in. Tenant
 * targets (spec 0026 MVP) resolve to `input.target.repo` too — the CLI's
 * `start-tenant` verb sets it to the launchpad checkout (tenant spec docs
 * live in this repo's `specs/` per docs/SPEC_FORMAT.md's
 * `tenant:`/`odoo_version:` frontmatter). TODO(phase-4): point tenant runs
 * at real per-tenant repos (ADR-009) instead of the launchpad checkout.
 */
// Exported (alongside the other internal-but-testable helpers in this file,
// e.g. parseOwnerRepo) so tenant-branch behavior is unit-testable directly,
// without standing up a real agent session or Temporal activity context.
/**
 * Where the ROLE prompts live (spec 0200): the launchpad's own checkout, which
 * is where `agents/*.md` are. NOT the session's workdir — a customer's checkout
 * has no `agents/` directory, so reading the role file from there produced an
 * EMPTY role prompt on every customer run, silently, for the whole life of the
 * customer-repo pipeline.
 *
 * `LAUNCHPAD_REPO_ROOT` is the same variable the worker resolves itself from and
 * is required env (CLAUDE.md). Undefined leaves `promptRoot` unset, which falls
 * back to the old workdir read rather than throwing — a missing env var must not
 * take a run down, and the (human) check on this spec is what proves it arrived.
 */
function promptRootOrUndefined(): string | undefined {
  return process.env["LAUNCHPAD_REPO_ROOT"] || undefined;
}

export function repoRootOf(input: PipelineInput): string {
  return input.target.repo; // absolute path of the checkout (launchpad, for both target kinds today)
}

// Spec 0161 F2: the odoo-next provisioning activities (repo/dns/odoo/front/
// verify). Re-exported here so the worker's `import * as activities` registers
// them with no worker change — the same namespace the workflow proxies against.
export * from "./provisioning-activities.js";

/**
 * LLM credential account for the agent sessions. Tenant targets
 * (spec 0026 MVP) use the `"owner"` credential until Vault lands —
 * `loadCredential(tenantId)` throws `TODO(phase-5)` today and would kill a
 * tenant run at the very first agent session (`draftSpec`). TODO(phase-5):
 * once Vault-backed per-tenant credentials exist, resolve
 * `input.target.tenantId` here instead.
 */
export async function accountIdOf(input: PipelineInput): Promise<string> {
  return "owner";
}

/**
 * Heartbeats the current Temporal activity — passed as `onHeartbeat` to
 * `runAgentSession` so a force-killed worker is detected within
 * `AGENT_HEARTBEAT_TIMEOUT` instead of stalling for the full
 * `startToCloseTimeout` (spec 0006). Only meaningful inside an activity
 * execution context (draftSpec/runInitializer/runCoder, all proxied with
 * `AGENT_ACTIVITY_OPTIONS`, which declares `heartbeatTimeout`).
 */
function heartbeat(): void {
  Context.current().heartbeat();
}

/**
 * Inactivity-watchdog threshold override (spec 0018): `LAUNCHPAD_SESSION_INACTIVITY_MS`
 * lets an operator tune the silence threshold without a code change (e.g. a
 * shorter one in CI/dev to smoke-test the watchdog). Unset or non-numeric ->
 * `undefined`, which lets `runAgentSession` fall back to
 * `DEFAULT_SESSION_INACTIVITY_MS`.
 */
function sessionInactivityMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.LAUNCHPAD_SESSION_INACTIVITY_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Abort signal tied to the current activity's cancellation (spec 0017,
 * ADR-014). When Temporal cancels the attempt (heartbeat timeout, workflow
 * teardown, worker shutdown), the signal fires and `runAgentSession` aborts
 * the SDK session — terminating the agent subprocess instead of leaving an
 * orphan that keeps editing the working tree (observed on spec 0015 run 2).
 * Cancellation is only delivered while the activity heartbeats, which the
 * session runner's timer now guarantees.
 *
 * `Context.current()` throws outside a real Temporal activity execution
 * (`Activity context not initialized`) — tolerated here so runCoder/
 * runInitializer stay directly callable from a unit test with an injected
 * fake session (spec 0021 item 3 call-site coverage): no activity context
 * means no cancellation hookup, which is exactly the documented "only
 * meaningful inside an activity execution context" contract.
 */
function activityAbortSignal(): AbortSignal {
  const controller = new AbortController();
  try {
    Context.current().cancelled.catch(() => controller.abort());
  } catch {
    // Not running inside a Temporal activity — no-op (see doc comment above).
  }
  return controller.signal;
}

/**
 * Fails loudly, naming the offending files, if `cwd`'s working tree has
 * uncommitted changes before a git-checkout-driving activity runs (spec 0008
 * worker-hygiene fix). Run 2's merge failure surfaced as git's raw "cannot
 * checkout, you have local changes" error from a stale second worker having
 * dirtied the tree; every legitimate path (coder commits, markSpec now
 * commits its own edit) leaves the tree clean, so any dirt here is a bug
 * worth stopping the workflow for, not retrying.
 */
async function assertCleanTree(
  cwd: string,
  action: string,
  dirtyFiles: (cwd: string) => Promise<string[]> = (c) => git.dirtyFiles(c),
): Promise<void> {
  const dirty = await dirtyFiles(cwd);
  if (dirty.length > 0) {
    throw ApplicationFailure.create({
      type: "UnexpectedDirtyTree",
      message: `${action}: working tree unexpectedly dirty: ${dirty.join(", ")}`,
      nonRetryable: true,
    });
  }
}

/**
 * Logs one `[session]` line to the worker log for a just-finished agent
 * session (spec 0007 item 7) — `start` is the `Date.now()` captured right
 * before `runAgentSession`, `res` its result (model/turns/costUsd). `specId`
 * (spec 0018 loud/attributable failures) makes cost/time lines attributable
 * per spec — every real call site passes it.
 */
function logSessionTiming(start: number, res: SessionResult, specId: string): void {
  const seconds = Math.round((Date.now() - start) / 1000);
  console.log(
    formatSessionTiming({
      role: res.role,
      spec: specId,
      model: res.model,
      seconds,
      turns: res.numTurns,
      costUsd: res.costUsd,
    }),
  );
}

/**
 * Log the session AND record it (spec 0194).
 *
 * This is the one place every pipeline session already passes through —
 * `draftSpec`, `runInitializer`, `runCoder` and the fixer all call it — which is
 * what makes "one row per session" a four-line change instead of a refactor.
 *
 * Best-effort, and the reason is not the usual one: telemetry must never be able
 * to fail a run that produced correct code. It logs loudly when it cannot write,
 * because a silently empty table would be worse than none — the whole point is
 * to stop answering questions about ourselves from prose.
 *
 * The workflow id comes from the activity Context rather than from parsing
 * `specId` into a name: an id's parts are not "the prefix and the rest", and
 * four files learned that the hard way (docs/VERIFICATION.md #11).
 */
async function recordSession(
  start: number,
  res: SessionResult,
  input: Pick<PipelineInput, "specId" | "project">,
): Promise<void> {
  logSessionTiming(start, res, input.specId);
  const finishedAt = new Date();
  const startedAt = new Date(start);
  try {
    // `workflowExecution` is optional in the activity Info type; outside a real
    // activity `Context.current()` throws, and both land in the catch below —
    // telemetry never decides whether a run survives.
    const workflowId = Context.current().info.workflowExecution?.workflowId;
    if (!workflowId) throw new Error("no workflow id on the activity context");
    const { createDb, createPool, projectBySlug, recordAgentSession } = await import(
      "@launchpad/db"
    );
    const pool = createPool();
    try {
      const db = createDb(pool);
      // The row keys on the workflow; the project link is a convenience for
      // per-project reads and is simply absent for a platform run.
      const slug = input.project?.slug;
      const project = slug && slug !== "platform" ? await projectBySlug(db, slug) : null;
      await recordAgentSession(db, {
        workflowId,
        specId: input.specId,
        projectId: project?.id ?? null,
        role: res.role,
        ...(res.model ? { model: res.model } : {}),
        startedAt,
        finishedAt,
        seconds: Math.round((finishedAt.getTime() - start) / 1000),
        ...(res.numTurns === undefined ? {} : { turns: res.numTurns }),
        ...(res.costUsd === undefined ? {} : { costUsd: res.costUsd }),
        ...(res.usage
          ? {
              inputTokens: res.usage.inputTokens,
              outputTokens: res.usage.outputTokens,
              cacheReadTokens: res.usage.cacheReadTokens,
            }
          : {}),
        ok: res.ok,
      });
    } finally {
      await pool.end();
    }
  } catch (err) {
    console.warn(`[session] spec ${input.specId}: could not record the ${res.role} session:`, err);
  }
}

/**
 * Verify-and-repair safety net (spec 0009): `commitTrailerInstruction` asks
 * the agent to write the `Co-Authored-By` trailer itself, but 0008's run
 * landed it on only 3/6 commits — prompt hope isn't enforcement. After a
 * session, checks the newest commit made between `before` and `after` (HEAD)
 * and message-only-amends it via `ensureCoAuthorTrailer` when the trailer is
 * missing. A no-op when the session made no new commit (stalled) or the
 * agent already wrote the trailer.
 */
async function verifyAndRepairTrailer(
  cwd: string,
  before: string,
  after: string,
  model: string,
): Promise<void> {
  const messages = await git.commitMessagesBetween(cwd, before, after);
  if (messages.length === 0) return; // no new commit this session
  const latest = messages[0]; // newest first (HEAD)
  if (latest === undefined) return;
  const repaired = ensureCoAuthorTrailer(latest, model);
  if (repaired.changed) {
    await git.amendCommitMessage(cwd, repaired.message);
  }
}

/**
 * Harness-side repair for a handoff-only dirty tree (spec 0021), the enforcement
 * half of the coder-rule change (agents/coder.md now commits the only-`(human)`
 * handoff; this is the "prompt hope isn't enforcement" backstop, mirroring
 * {@link verifyAndRepairTrailer}). Called immediately after
 * `verifyAndRepairTrailer` in both `runCoder` and `runInitializer`.
 *
 * Behavior (spec 0021 scope item 2):
 *   - Clean tree ⇒ no-op.
 *   - Dirty, and EVERY dirty file is `specFile` ⇒ commit it as
 *     `docs(spec-NNNN): coder handoff (auto-committed by harness)` (NNNN parsed
 *     from `specFile`) with the {@link coAuthorTrailer} trailer for `model`.
 *   - Dirty with ANY other file ⇒ log a loud `[hygiene]` warning naming the
 *     files, do NOT commit, do NOT throw. Loop semantics are unchanged and
 *     teardownEnv's dirty-tree guard (assertCleanTree) remains the backstop
 *     (non-goal: this never touches teardownEnv, never force-removes, never
 *     auto-commits non-spec dirt).
 *
 * NOTE: `specFile` is repo-relative (matches `git.dirtyFiles` output), the same
 * form `runCoder` derives via `path.relative(env.workdir, spec)`.
 */
export async function repairHandoffOnlyDirt(
  workdir: string,
  specFile: string,
  model: string,
): Promise<void> {
  const dirty = await git.dirtyFiles(workdir);
  if (dirty.length === 0) return; // clean tree — nothing to repair
  if (dirty.length === 1 && dirty[0] === specFile) {
    const idMatch = path.basename(specFile).match(/^(\d+)/);
    const specId = idMatch ? idMatch[1] : specFile;
    const message =
      `docs(spec-${specId}): coder handoff (auto-committed by harness)\n\n` +
      coAuthorTrailer(model);
    await git.commit(workdir, message, [specFile]);
    return;
  }
  console.warn(
    `[hygiene] repairHandoffOnlyDirt: dirty files beyond ${specFile}, not auto-committing: ` +
      dirty.join(", "),
  );
}

/**
 * Harness-commits a freshly-drafted spec doc to the primary checkout (spec
 * 0029 Part A). Sibling of {@link repairHandoffOnlyDirt} — same "flow hope
 * isn't enforcement" backstop discipline — but with a DELIBERATELY different
 * only-dirt gate. `draftSpec` runs before gate 1 and before any worktree
 * exists, so for a brand-new spec it writes `specs/NNNN-<slug>.md` straight
 * into the PRIMARY checkout (`root` = {@link repoRootOf}). Leaving that file
 * dirty on `main` is the exact spec-0017 isolation violation this fixes (and
 * the file never reaches the run's worktree — `provisionEphemeralEnv` cuts it
 * from `main` — which would break `findSpecFile` after gate-1 approval).
 *
 * Behavior (spec 0029 scope Part A):
 *   - `git.dirtyFiles(root)` does NOT include `specFile` ⇒ no-op (covers the
 *     launchpad pre-committed flow AND a Temporal retry after a successful
 *     commit — no double-commit).
 *   - `specFile` IS dirty ⇒ `git.commit(root, message, [specFile])`,
 *     PATHSPEC-scoped to `specFile`, with subject
 *     `docs(spec-NNNN): draft (auto-committed by harness)` (NNNN parsed from
 *     the filename) + the {@link coAuthorTrailer} trailer for `model`. Any
 *     unrelated pre-existing dirt on the primary checkout is LEFT UNTOUCHED
 *     with a loud `[hygiene]` warning naming those files (the owner chose
 *     warn-don't-block: refusing to commit would strand the new spec as dirt
 *     on `main`, the exact violation being fixed — so this deviates from
 *     repairHandoffOnlyDirt's only-dirt gate on purpose).
 *
 * `specFile` is repo-relative (matches `git.dirtyFiles` output). Wired into
 * `draftSpec` (spec 0029 Part A item 2): called unconditionally at the end of
 * every `draftSpec` run, whether or not the agent session ran this time.
 */
export async function commitDraftIfUncommitted(
  root: string,
  specFile: string,
  model: string,
): Promise<void> {
  // Spec 0115 concurrency A: the dirty-check and the commit must be ONE critical
  // section on the shared primary checkout — two runs interleaving here collide on
  // git's index.lock, and the loser leaves its spec file untracked in the shared tree
  // (see repo-lock.ts for the reproduction).
  const dirty = await withRepoLock(root, async () => {
    const d = await git.dirtyFiles(root);
    if (!d.includes(specFile)) return d;
    const idMatch = path.basename(specFile).match(/^(\d+)/);
    const specId = idMatch ? idMatch[1] : specFile;
    const message =
      `docs(spec-${specId}): draft (auto-committed by harness)\n\n` + coAuthorTrailer(model);
    await git.commit(root, message, [specFile]);
    return d;
  });
  if (!dirty.includes(specFile)) return; // already committed (or pre-committed) — no-op
  const remaining = dirty.filter((f) => f !== specFile);
  if (remaining.length > 0) {
    console.warn(
      `[hygiene] commitDraftIfUncommitted: unrelated pre-existing dirt left untouched: ` +
        remaining.join(", "),
    );
  }
}

/**
 * LLM drafts the spec document from the user's plain-language request, then
 * harness-commits it to the primary checkout (spec 0029 Part A) — the commit
 * step always runs, even when the `specFileExists` early return skips the
 * agent SESSION, so a retry after a session that wrote the file but crashed
 * pre-commit still commits without re-drafting (and a retry after a
 * successful commit is a no-op via {@link commitDraftIfUncommitted}).
 *
 * GUARDS (spec 0099 / G.1): this session runs under the SAME least-privilege
 * policy as the in-UI drafting spawn, not `runAgentSession`'s default surface.
 * A session whose entire job is to create one markdown file gets
 * `ARCHITECT_ALLOWED_TOOLS` (`Read`/`Grep`/`Glob`/`Write` — no `Bash`, no
 * `Edit`), a `canUseTool` gate binding `Write` to `specs/<specId>-*.md`, and a
 * post-session working-tree fence. The fence is the load-bearing one here:
 * unlike the in-UI path, `draftSpec` writes into the PRIMARY checkout on `main`,
 * so anything it dirties beyond its own spec file lands where every later
 * activity (and the human) will trip over it. Snapshotting BEFORE the session
 * (rather than filtering the after-state) means pre-existing dirt on `main`
 * never reads as a violation — only what this session touched counts.
 */
export async function draftSpec(
  input: PipelineInput,
  // Injectable session runner — see runInitializer's matching parameter for
  // why (spec 0021 item 3 call-site coverage; here: fake-session drafting
  // tests, spec 0029 Part A item 2).
  runSession: typeof runAgentSession = runAgentSession,
): Promise<void> {
  const root = repoRootOf(input);
  const cfg = await loadCredential(await accountIdOf(input));
  const model = modelForRole("spec-drafter", cfg.modelOverrides);
  if (!(await specFileExists(root, input.specId))) {
    const start = Date.now();
    const beforeDirty = await git.dirtyFiles(root);
    const res = await runSession({
      role: "spec-drafter",
      promptRoot: promptRootOrUndefined(),
      model,
      credential: cfg.primary,
      workdir: root,
      specPath: `specs/${input.specId}-draft.md`,
      // See the doc comment: same guards as the in-UI drafting spawn.
      allowedTools: ARCHITECT_ALLOWED_TOOLS,
      canUseTool: createArchitectCanUseTool(root, input.specId),
      prompt:
        `Draft spec ${input.specId} per docs/SPEC_FORMAT.md from this request by ` +
        `${input.requestedBy}: "${input.request}". Create exactly one file ` +
        `specs/${input.specId}-<slug>.md with status: draft. Leave Plan/Progress empty. ` +
        `If the request touches ONLY apps/web/ (no packages/, infra/, or docs-only ` +
        `changes elsewhere), set \`ui_only: true\` in the frontmatter (spec 0031 / ` +
        `ADR-018) — otherwise omit it. ` +
        (isSelfTarget(input.target)
          ? `This run targets this repo itself (Hangar/Forge, ADR-019): also propose ` +
            `\`product: hangar\` (fleet/Hangar areas: packages/fleet-hostinger, ` +
            `infra/tenant/, /fleet), \`product: forge\` (pipeline/chat/Forge areas: ` +
            `packages/pipeline, packages/agents, packages/github, specs/), or ` +
            `\`product: both\` (mixed) in the frontmatter — otherwise omit it. `
          : "") +
        `This is a proposal only; the human confirms or edits it at gate 1.`,
      maxTurns: 15,
      onHeartbeat: heartbeat,
      abortSignal: activityAbortSignal(),
      sessionInactivityMs: sessionInactivityMsFromEnv(),
    });
    await recordSession(start, res, input);
    const violations = architectFenceViolations(
      beforeDirty,
      await git.dirtyFiles(root),
      input.specId,
    );
    if (violations.length > 0) {
      throw ApplicationFailure.create({
        type: "SpecDrafterFenceViolation",
        message:
          `draftSpec: the drafting session touched ${violations.join(", ")} outside ` +
          `specs/${input.specId}-*.md (execution-free boundary, spec 0099 / ADR-015). ` +
          `Left in place for inspection — retrying would redraft over the same dirt.`,
        nonRetryable: true,
      });
    }
    if (!(await specFileExists(root, input.specId))) {
      throw new Error(`spec-drafter finished without creating spec: ${res.handoffNote}`);
    }
    // Spec 0217: the structural guard, on the drafting SESSION's output only —
    // it sits inside this `if (!specFileExists)` block on purpose, so the
    // pass-through path (a hand-written Track-1 spec already on disk, plus 216
    // historical specs with `## Acceptance` / `## Out of scope`) is never
    // validated. Before `commitDraftIfUncommitted`: a malformed draft must not
    // reach a commit, and a retry would only redraft it the same way.
    const structure = specStructureViolations(
      await readFile(await findSpecFile(root, input.specId), "utf8"),
    );
    if (structure.length > 0) {
      throw ApplicationFailure.create({
        type: "SpecStructureViolation",
        message:
          `draftSpec: the drafted spec's structure is not the house format (spec 0217): ` +
          `${structure.join("; ")}. Spec prose is Spanish; headings, frontmatter keys and ` +
          `\`(human)\` stay English and byte-identical — \`packages/pipeline/src/store.ts\` ` +
          `parses them with literal regexes. Left in place for inspection.`,
        nonRetryable: true,
      });
    }
  }
  const specFile = path.relative(root, await findSpecFile(root, input.specId));
  await commitDraftIfUncommitted(root, specFile, model);
}

/**
 * Deterministic deploy-manifest activity (spec 0047 item A) — the tenant
 * vanilla-deploy path's replacement for {@link draftSpec}. Writes
 * `specs/<id>-tenant-<tenantId>-deploy.md` to the RUN's primary checkout
 * ({@link repoRootOf}) with house-format frontmatter
 * (`id`, a fixed `title` like `Tenant deploy: <tenantId> — vanilla Odoo
 * <version>`, `tenant: launchpad`, `status: draft`, `requested_by`) and a
 * manifest body stating the target tenant id, VPS id, Odoo version, the
 * "vanilla stock Odoo (no addons, no snapshot restore, no neutralize)"
 * declaration, and the synthesized request text. Commits it to the primary
 * checkout with the SAME git-commit discipline as `draftSpec` (reuse
 * {@link commitDraftIfUncommitted}).
 *
 * HARD contract (see spec 0047 Scope A + Determinism hazards):
 *   - DETERMINISTIC: content is a pure function of `input` — NO `Date.now()`,
 *     NO `randomUUID()`, NO randomness — so replays/retries produce byte-equal
 *     output.
 *   - IDEMPOTENT: if the file already exists (activity retry), reconcile
 *     without failing — mirror `draftSpec`'s "idempotent when the spec file
 *     already exists" contract.
 *   - The slug is `<id>-tenant-<tenantId>-deploy.md` so
 *     `store.findSpecFile` / apps/web `resolveSpecFilenameById` resolve the
 *     bare `<id>` (the deploy form redirects to `/forge/specs/<id>`).
 *
 * Not an agent session (no LLM ran), so the commit does NOT carry a
 * `Co-Authored-By` trailer — same reasoning `markSpec`'s status-bump commit is
 * exempt from trailer coverage (`isTrailerExempt`'s `MARK_SPEC_STATUS_RE`
 * branch): this is a mechanical, deterministic activity write, not agent
 * work. {@link commitManifestIfUncommitted} mirrors
 * {@link commitDraftIfUncommitted}'s idempotent dirty-check-then-commit
 * discipline (only commit when the file is actually dirty; warn, don't
 * sweep, unrelated pre-existing dirt) minus that trailer.
 */
export async function writeTenantDeployManifest(input: PipelineInput): Promise<void> {
  if (isSelfTarget(input.target)) {
    throw new Error(
      "writeTenantDeployManifest: input.target must be a tenant target (self/launchpad runs use draftSpec)",
    );
  }
  // isSelfTarget() isn't a type predicate, so it doesn't narrow the union for
  // TS; the only other PipelineTarget member is "tenant", guaranteed safe by
  // the early return above (same pattern as deployToProduction's cast).
  const { tenantId, vpsId, odooVersion } = input.target as Extract<
    PipelineTarget,
    { kind: "tenant" }
  >;
  const root = repoRootOf(input);
  const specFile = path.join("specs", tenantDeployManifestFilename(input.specId, tenantId));
  if (!(await specFileExists(root, input.specId))) {
    await mkdir(path.join(root, "specs"), { recursive: true });
    await writeFile(
      path.join(root, specFile),
      tenantDeployManifestContent(input, tenantId, vpsId, odooVersion),
    );
  }
  await commitManifestIfUncommitted(root, specFile);
}

/**
 * Deterministic slug for a tenant deploy manifest (spec 0047 item A):
 * `<id>-tenant-<tenantId>-deploy.md`, so `store.findSpecFile` (and apps/web's
 * `resolveSpecFilenameById`) resolve the bare `<id>` — the deploy form
 * redirects to `/forge/specs/<id>`.
 */
function tenantDeployManifestFilename(specId: string, tenantId: string): string {
  return `${specId}-tenant-${tenantId}-deploy.md`;
}

/**
 * Pure, deterministic manifest body — a function of `input` (plus the
 * already-narrowed tenant fields) ONLY: no `Date.now()`, no `randomUUID()`, no
 * randomness, so two replays/retries of `writeTenantDeployManifest` for the
 * same `input` produce byte-equal content. House-format frontmatter (spec
 * 0047 item A / docs/SPEC_FORMAT.md): `tenant: launchpad` with no
 * `odoo_version:` key is the documented "launchpad specs" form — the actual
 * target tenant/VPS/version live in the body instead, since this manifest
 * documents an OPERATIONAL deploy, not a code change to a client tenant.
 */
function tenantDeployManifestContent(
  input: PipelineInput,
  tenantId: string,
  vpsId: number,
  odooVersion: OdooVersion,
): string {
  return `---
id: ${input.specId}
title: Tenant deploy: ${tenantId} — vanilla Odoo ${odooVersion}
tenant: launchpad
status: draft
requested_by: ${input.requestedBy}
---

## Intent
Deterministic tenant vanilla deploy (spec 0047 item A) — no LLM draft, no
code changes. Deploys vanilla stock Odoo (no addons, no snapshot restore, no
neutralize) for tenant \`${tenantId}\` to VPS ${vpsId}.

## Scope
- Target tenant: \`${tenantId}\`
- VPS: ${vpsId}
- Odoo version: ${odooVersion}
- Vanilla stock Odoo (no addons, no snapshot restore, no neutralize).
- Requested by ${input.requestedBy}: "${input.request}"

## Acceptance criteria
- A live, DB-initialized vanilla Odoo ${odooVersion} instance is reachable
  for tenant \`${tenantId}\` on VPS ${vpsId} after the human clicks Deploy at
  the promote gate.

## Plan
- [ ] (human) Review this manifest, then click Deploy at the promote gate.

## Progress
- [ ] (human) Review this manifest, then click Deploy at the promote gate.

## Handoff log
- **writeTenantDeployManifest (harness, deterministic):** generated this
  manifest from the deploy form's input — no LLM session, no code diff.
`;
}

/**
 * Idempotent commit of a freshly-written tenant deploy manifest (spec 0047
 * item A) — sibling of {@link commitDraftIfUncommitted} with the SAME
 * dirty-check discipline (only commit `specFile` when it's actually dirty, so
 * an activity retry after a successful commit is a no-op; unrelated
 * pre-existing dirt is left untouched with a loud `[hygiene]` warning, never
 * swept in). Deliberately does NOT append a `Co-Authored-By` trailer — see
 * {@link writeTenantDeployManifest}'s doc comment for why.
 */
async function commitManifestIfUncommitted(root: string, specFile: string): Promise<void> {
  const dirty = await git.dirtyFiles(root);
  if (!dirty.includes(specFile)) return; // already committed (or a retry after a prior commit)
  const idMatch = path.basename(specFile).match(/^(\d+)/);
  const specId = idMatch ? idMatch[1] : specFile;
  const message = `docs(spec-${specId}): tenant deploy manifest (auto-committed by harness)`;
  await git.commit(root, message, [specFile]);
  const remaining = dirty.filter((f) => f !== specFile);
  if (remaining.length > 0) {
    console.warn(
      `[hygiene] writeTenantDeployManifest: unrelated pre-existing dirt left untouched: ` +
        remaining.join(", "),
    );
  }
}

/**
 * Provisions the run's isolated worktree (spec 0017): `workdir` becomes
 * `.worktrees/spec-<id>` off the PRIMARY checkout (`repoRoot`), which never
 * leaves `main`. `git.worktreeAdd` creates `spec/<id>` from `main` when
 * absent, or reuses it AT ITS TIP when it already exists — never resets it
 * (the 0007-era `checkout -B` footgun this replaces). Idempotent against
 * activity retry: if the worktree is already registered (a prior attempt
 * succeeded before the activity returned), skip re-adding it.
 */
/**
 * Make the run's spec reachable from its worktree (spec 0131 F).
 *
 * A worktree is a checkout of a commit, so it contains exactly what `main`
 * tracks. For the platform that includes `specs/` and everything works. For a
 * customer project spec 0129 EXCLUDES `specs/` from git — deliberately, so our
 * specs leave no trace in their history — which means nothing commits the file
 * and the worktree has no `specs/` at all. `runInitializer`'s
 * `findSpecFile(env.workdir)` then throws and the run dies immediately after
 * gate-1 approval. (`commitDraftedSpec`'s own docstring describes this exact
 * mechanism as the thing its commit prevents.)
 *
 * A symlink, not a copy: the spec is then ONE file per project, so a coder's
 * `## Progress` edits survive the worktree they were made in — which is the
 * right shape for a file whose durable record is a `spec_files` row rather than
 * a commit. Measured before choosing (spec 0131 F): `git worktree remove`
 * unlinks the symlink and does NOT follow it, so the project's specs survive
 * teardown, and `SPEC_EXCLUDE_LINES` carries the no-slash `specs` pattern
 * because git treats a symlink as a file.
 *
 * Conditional on the worktree LACKING `specs/` — which is precisely the
 * situation this repairs — so the platform's tracked directory is never
 * shadowed. No-op (never throws) when the root has no `specs/` either: a
 * dangling link would turn a clear "no spec file" error into a confusing one.
 */
export async function linkSpecsIntoWorktree(
  root: string,
  workdir: string,
  /** Spec 0141: a PROJECT's specs live outside its checkout, so the link
   * points there instead of at `<root>/specs`. Absent for the platform, whose
   * specs ARE this repo's and are committed on purpose. */
  specsDir?: string,
): Promise<void> {
  const target = specsDir ?? path.join(root, "specs");
  const link = path.join(workdir, "specs");
  try {
    // `lstat` for the link, so an EXISTING symlink counts as done even if it
    // dangles — activities retry, and a second `symlink()` would throw EEXIST.
    const hasTarget = await stat(target).then(() => true, () => false);
    const hasLink = await lstat(link).then(() => true, () => false);
    if (!hasTarget || hasLink) return;
    await symlink(target, link, "dir");
  } catch (err) {
    // Best-effort: if the link cannot be made, `findSpecFile` reports the real
    // problem a few steps later. Failing provisioning here would be worse.
    console.warn(`[provision] could not link ${link} -> ${target}:`, err);
  }
}

/** Map a branch-sync refusal to its Temporal failure (spec 0133 decision 3).
 * `fetch_failed` is the one RETRYABLE class — a network hiccup is what
 * activity retries are for; everything else cannot be fixed by trying again. */
function branchSyncFailure(branch: string, result: Exclude<BranchSyncResult, { ok: true }>): Error {
  switch (result.reason) {
    case "missing_on_origin":
      return ApplicationFailure.create({
        message:
          `la rama "${branch}" ya no existe en origin — otra corrida no puede ` +
          `recrearla; créala de nuevo en Ramas & builds. (${result.detail})`,
        type: "BranchMissingOnOrigin",
        nonRetryable: true,
      });
    case "diverged":
      return ApplicationFailure.create({
        message:
          `la rama "${branch}" divergió de origin (${result.ahead} adelante, ` +
          `${result.behind} atrás) — un rebase automático dejaría el worktree a ` +
          `medias; resuélvelo a mano en el checkout y reintenta el run.`,
        type: "BranchDiverged",
        nonRetryable: true,
      });
    case "busy":
      return ApplicationFailure.create({
        message:
          `la rama "${branch}" está en uso por otro run (git la tiene checked out ` +
          `en otro worktree): ${result.detail}`,
        type: "BranchBusy",
        nonRetryable: true,
      });
    case "fetch_failed":
      return new Error(`git fetch for branch "${branch}" failed: ${result.detail}`);
  }
}

/** Map a per-spec branch reconciliation conflict to its Temporal failure (spec
 * 0159 decision 2). Non-retryable: bringing a stale `spec/<id>` branch up to
 * origin/main hit merge conflicts, which a human must resolve — a retry cannot,
 * and a silent auto-resolve is exactly what the `diverged` precedent forbids. */
function specBranchStaleConflict(branch: string, paths: string[]): Error {
  return ApplicationFailure.create({
    message:
      `la rama "${branch}" quedó atrás de origin/main y al traerlo hubo ` +
      `conflictos en: ${paths.join(", ")} — resuélvelos a mano en el checkout ` +
      `y reintenta el run (un rebase automático dejaría el worktree a medias).`,
    type: "SpecBranchStaleConflict",
    nonRetryable: true,
  });
}

export async function provisionEphemeralEnv(input: PipelineInput): Promise<EphemeralEnv> {
  const root = repoRootOf(input);
  // Spec 0133: a branch run checks out ITS branch (shared across the branch's
  // runs); a per-spec run keeps `spec/<id>` cut from main, byte-identically.
  const branch = input.branch ?? `spec/${input.specId}`;
  const workdir = path.join(root, ".worktrees", `spec-${input.specId}`);
  const target = path.resolve(workdir);
  const alreadyProvisioned = (await git.listWorktrees(root)).some(
    (w) => path.resolve(w) === target,
  );
  if (!alreadyProvisioned) {
    // Spec 0115 concurrency A: `worktree add` writes the shared repo's worktree
    // metadata, so two runs provisioning at once contend on it.
    await withRepoLock(root, async () => {
      if (input.branch) {
        // Reconcile the shared branch with origin BEFORE the worktree claims
        // it (spec 0133 decision 3): create-at-tip / fast-forward / tolerate
        // ahead / refuse diverged-or-missing. Inside the repo lock because a
        // fetch moves shared refs.
        const sync = await ensureLocalBranchAtOrigin(root, input.branch);
        if (!sync.ok) throw branchSyncFailure(input.branch, sync);
        if (sync.ahead > 0) {
          console.warn(
            `[provision] branch ${input.branch} carries ${sync.ahead} unpushed ` +
              `commit(s) from an earlier run — they ride along and push at gate 2`,
          );
        }
      }
      try {
        await git.worktreeAdd(root, workdir, branch);
      } catch (err) {
        // Git's one-checkout-per-branch invariant is the ATOMIC per-branch
        // serializer (spec 0133 decision 4) — the web-side refusal in front of
        // it is only friendlier, never load-bearing. The message names the
        // other worktree, which encodes the in-flight spec id.
        const message = err instanceof Error ? err.message : String(err);
        if (input.branch && /already checked out|already used by worktree/i.test(message)) {
          throw ApplicationFailure.create({
            message:
              `la rama "${input.branch}" ya tiene un run en curso — ` +
              `git la reporta en uso: ${message}`,
            type: "BranchBusy",
            nonRetryable: true,
          });
        }
        throw err;
      }
      if (!input.branch) {
        // Spec 0159: a `spec/<id>` branch a run left behind days ago still
        // points at the main it was cut from, and `worktreeAdd` reused it AT
        // ITS TIP — so reconcile it up to origin/main now that the branch is
        // checked out (the merge needs a checkout, so this runs AFTER add,
        // unlike the branch path's pre-add ref sync). The prior run's own
        // commits ride along via merge; a conflict is refused, not auto-resolved.
        const reconcile = await reconcileSpecBranchWithMain(workdir);
        if (!reconcile.ok) {
          await git.worktreeRemove(root, workdir);
          throw specBranchStaleConflict(branch, reconcile.paths);
        }
      }
    });
  }
  // Spec 0141: for a project run the link points at the out-of-repo specs
  // directory; the platform keeps its committed `specs/`.
  await linkSpecsIntoWorktree(
    root,
    workdir,
    input.project && input.project.kind !== "platform"
      ? projectSpecsDir(input.project.slug)
      : undefined,
  );
  // ui_only fast-path (spec 0031 / ADR-018): read the flag from the WORKTREE's
  // spec file (not the primary checkout) — the draft is committed to main
  // before provisioning (spec 0029), and the worktree is cut from main at
  // `branch`'s tip, so the file is present here too. Returned on the activity
  // RESULT, never re-read by the workflow (determinism/replay safety, no
  // TMPRL1100). `undefined` (not `false`) when absent OR when no spec file
  // exists yet (test fixtures that provision a worktree without a `specs/`
  // dir at all) — matching the optional field's "today's behavior, unchanged"
  // contract.
  const uiOnly = (await specFileExists(workdir, input.specId))
    ? readUiOnly(await readFile(await findSpecFile(workdir, input.specId), "utf8")) || undefined
    : undefined;
  // Product facet (spec 0037 / ADR-019): EXACTLY the `uiOnly` channel above —
  // read from the WORKTREE's spec file, returned on the activity RESULT,
  // never re-read by the workflow (determinism/replay safety, no TMPRL1100).
  // `undefined` when absent, unrecognized, or no spec file exists yet.
  // Informational only this batch: nothing branches on it downstream.
  const product = (await specFileExists(workdir, input.specId))
    ? readProduct(await readFile(await findSpecFile(workdir, input.specId), "utf8"))
    : undefined;
  // Tenant targets (spec 0026 MVP) get the same launchpad worktree as
  // launchpad runs (`buildUrl: "local"`, so teardownEnv's worktree-removal
  // path applies unchanged); only `vpsId` threads through, for
  // deployToProduction's gate-3 fleet calls. TODO(phase-4): real ephemeral
  // `spec-<id>` tenant stacks on the VPS (own destroy semantics).
  const vpsId = input.target.kind === "tenant" ? input.target.vpsId : undefined;
  return {
    envId: `local-${input.specId}`,
    branch,
    buildUrl: "local",
    workdir,
    repoRoot: root,
    vpsId,
    uiOnly,
    product,
  };
}

export async function runInitializer(
  input: PipelineInput,
  env: EphemeralEnv,
  // Injectable session runner — call-site coverage (spec 0021 item 3) drives
  // this with a fake session (no real LLM/network) to prove
  // repairHandoffOnlyDirt actually runs right after verifyAndRepairTrailer.
  // Defaults to the real @launchpad/agents runAgentSession in production.
  runSession: typeof runAgentSession = runAgentSession,
): Promise<void> {
  const cfg = await loadCredential(await accountIdOf(input));
  const spec = await findSpecFile(env.workdir, input.specId);
  const before = await git.headSha(env.workdir);
  const start = Date.now();
  const model = modelForRole("initializer", cfg.modelOverrides);
  const res = await runSession({
    role: "initializer",
    promptRoot: promptRootOrUndefined(),
    model,
    credential: cfg.primary,
    workdir: env.workdir,
    specPath: spec,
    prompt:
      `Act per agents/initializer.md for the spec at ${spec}.\n\n` +

      commitTrailerInstruction(model),
    maxTurns: 50,
    onHeartbeat: heartbeat,
    abortSignal: activityAbortSignal(),
    sessionInactivityMs: sessionInactivityMsFromEnv(),
  });
  await recordSession(start, res, input);
  const after = await git.headSha(env.workdir);
  await verifyAndRepairTrailer(env.workdir, before, after, model);
  await repairHandoffOnlyDirt(env.workdir, path.relative(env.workdir, spec), model);
}

/**
 * Runs one coder increment; returns unchecked plan items left and whether
 * the session produced at least one new commit on the spec branch
 * (`progressed`, spec 0006) — the workflow's stall-detection signal.
 *
 * The `ui_only` diff-path fence that used to run here is GONE (spec 0196). It
 * allowed `apps/web/**` — the launchpad's own layout — so on a customer project,
 * whose Next app is at the repo root, every legitimate increment was a
 * violation. It was also never a boundary: a path allowlist is defense-in-depth
 * that an agent routes around through any allowed code-runner, while the real
 * boundaries here are the throwaway worktree, CI, the PR and the human gate.
 * `env.uiOnly` survives as what it honestly is — a smaller iteration budget.
 */
export async function runCoder(
  input: PipelineInput,
  env: EphemeralEnv,
  // Injectable session runner — see runInitializer's matching parameter for
  // why (spec 0021 item 3 call-site coverage).
  runSession: typeof runAgentSession = runAgentSession,
): Promise<CoderResult> {
  const cfg = await loadCredential(await accountIdOf(input));
  const spec = await findSpecFile(env.workdir, input.specId);
  const specMd = await readFile(spec, "utf8");
  const nextItem = firstUncheckedPlanItem(specMd);
  const before = await git.headSha(env.workdir);
  const start = Date.now();
  const model = modelForCoderItem(nextItem?.tag ?? "code", cfg.modelOverrides);
  const res = await runSession({
    role: "coder",
    promptRoot: promptRootOrUndefined(),
    model,
    credential: cfg.primary,
    workdir: env.workdir,
    specPath: spec,
    prompt:
      `Act per agents/coder.md for the spec at ${spec}. One item only.\n\n` +
      commitTrailerInstruction(model),
    maxTurns: 80,
    onHeartbeat: heartbeat,
    abortSignal: activityAbortSignal(),
    sessionInactivityMs: sessionInactivityMsFromEnv(),
  });
  await recordSession(start, res, input);
  const after = await git.headSha(env.workdir);
  await verifyAndRepairTrailer(env.workdir, before, after, model);
  const specFile = path.relative(env.workdir, spec);
  await repairHandoffOnlyDirt(env.workdir, specFile, model);
  const afterMd = await readFile(spec, "utf8");
  const remaining = countUnchecked(afterMd);
  const changedFiles = await git.changedFiles(env.workdir, before, after);
  // Spec 0113: a session that corrected the plan counts as progress. Without this
  // a revision touched only the spec file and read as a stall, which is why the
  // plan was revised zero times in 8 sessions.
  const planRevised = commitsMarkPlanRevision(
    await git.commitSubjects(env.workdir, before, after).catch(() => []),
  );
  const progressed = sessionProgressed({
    changedFiles,
    checkboxDelta: countChecked(afterMd) - countChecked(specMd),
    specFile,
    planRevised,
  });
  return { remaining, progressed };
}

/**
 * Failure context handed to the fixer (spec 0018 repair rounds). Captures why
 * the trouble spot tripped so `agents/fixer.md` can diagnose: the thrown error
 * text and whether the coder session STALLED (inactivity watchdog aborted it —
 * a `SessionStalledError`) vs. plain-failed or CI-red-twice. The workflow
 * builds this when `runCoder` fails or CI is red twice consecutively.
 */
export interface RepairContext {
  /** Thrown coder-activity error text, or a CI-red-twice summary. */
  error: string;
  /** True when the failure was a watchdog `SessionStalledError` abort. */
  stalled: boolean;
}

/**
 * Runs ONE repair round (spec 0018): a `fixer` session diagnoses the trouble
 * spot described by `context` and applies the smallest fix (hotfix commit,
 * plan-item split, or corrective Progress note) so the coder loop can resume.
 * Mirrors `runCoder`'s post-session hygiene — `verifyAndRepairTrailer`,
 * `repairHandoffOnlyDirt` (spec 0021), and a `[session]` timing line — and runs
 * in the run's worktree (spec 0017) like every session. The prompt carries
 * `context.error` plus a STALLED/FAILED classification derived from
 * `context.stalled`; `agents/fixer.md` itself reads the spec's Plan/Progress,
 * the last Handoff log entry, and `git status` with its own tool access — the
 * activity's job is only to get the fixer session running with the right
 * failure context, same division of labor `runCoder` has with `agents/coder.md`.
 * `runSession` is injectable for call-site coverage, matching
 * runInitializer/runCoder (spec 0021 item 3 pattern).
 */
export async function runRepair(
  input: PipelineInput,
  env: EphemeralEnv,
  context: RepairContext,
  runSession: typeof runAgentSession = runAgentSession,
): Promise<void> {
  const cfg = await loadCredential(await accountIdOf(input));
  const spec = await findSpecFile(env.workdir, input.specId);
  const before = await git.headSha(env.workdir);
  const start = Date.now();
  const model = modelForRole("fixer", cfg.modelOverrides);
  const classification = context.stalled
    ? "STALLED (the inactivity watchdog aborted the session)"
    : "FAILED";
  const res = await runSession({
    role: "fixer",
    promptRoot: promptRootOrUndefined(),
    model,
    credential: cfg.primary,
    workdir: env.workdir,
    specPath: spec,
    prompt:
      `Act per agents/fixer.md for the spec at ${spec}. This trouble spot ` +
      `${classification}:\n\n${context.error}\n\n` +
      commitTrailerInstruction(model),
    maxTurns: 40,
    onHeartbeat: heartbeat,
    abortSignal: activityAbortSignal(),
    sessionInactivityMs: sessionInactivityMsFromEnv(),
  });
  await recordSession(start, res, input);
  const after = await git.headSha(env.workdir);
  await verifyAndRepairTrailer(env.workdir, before, after, model);
  await repairHandoffOnlyDirt(env.workdir, path.relative(env.workdir, spec), model);
}

/**
 * Reads unchecked counts from the spec without running a coder — lets the
 * workflow skip a wasted session when only `(human)` items remain.
 * TODO(spec-0006): wired into the workflow loop; countHumanPending is a stub
 * until the human-item plan step lands.
 */
export async function countRemaining(
  input: PipelineInput,
  env: EphemeralEnv,
): Promise<RemainingWork> {
  const spec = await findSpecFile(env.workdir, input.specId);
  const md = await readFile(spec, "utf8");
  return { remaining: countUnchecked(md), humanPending: countHumanPending(md) };
}

/** The spec's most recent Handoff log entry — for stall/budget failure
 * messages and the PR body. TODO(spec-0006): lastHandoffEntry is a stub. */
export async function readLastHandoff(
  input: PipelineInput,
  env: EphemeralEnv,
): Promise<string> {
  const spec = await findSpecFile(env.workdir, input.specId);
  return lastHandoffEntry(await readFile(spec, "utf8"));
}

/**
 * Collaborators `runCi` needs beyond `input`/`env` — injectable so the
 * build-before-typecheck ordering and the build-red → `green: false` outcome
 * are unit-testable without spawning real `pnpm` (spec 0055 AC1), same seam
 * discipline as `OpenPullRequestDeps` / `MergePullRequestDeps`. Defaults to the
 * real `run` exec helper.
 */
export interface RunCiDeps {
  run: (
    cmd: string,
    args: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ) => Promise<{ ok: boolean; out: string; execError?: boolean }>;
  /**
   * Spec 0167: the Odoo-addons CI, run on our own sandbox VPS. Returns null when
   * it does not apply (not an addons repo, or no staging box configured) so the
   * caller falls through to 0138's recorded skip rather than inventing a pass.
   */
  runAddonCi?: (input: PipelineInput, env: EphemeralEnv) => Promise<CiResult | null>;
}

/**
 * Spec 0167: run an Odoo addons repo's own tests on the sandbox VPS.
 *
 * Returns null — falling through to 0138's recorded skip — when this is not an
 * addons repo, or when the staging box is not configured. It never returns a
 * green it did not observe.
 *
 * A FAILURE to run is NOT reported as red: `runAddonTestsOnSandbox` throws for
 * infrastructure trouble, and that propagates as a retryable activity failure,
 * exactly like `assertNoCiInfraFailure` does for the Node path. Telling a coder
 * agent "your tests failed" because an SSH hiccup means it burns repair rounds
 * on code that is fine (SPEC-ALIGNMENT §9.3).
 */
async function defaultRunAddonCi(
  input: PipelineInput,
  env: EphemeralEnv,
): Promise<CiResult | null> {
  const slug = input.project?.slug;
  if (!slug || !process.env[STAGING_VPS_ID_ENV]) return null;
  const addonPaths = discoverAddons(env.workdir);
  if (addonPaths.length === 0) return null;

  const { createDb, createPool, projectBySlug } = await import("@launchpad/db");
  const pool = createPool();
  let odooVersion: OdooVersion = 18;
  try {
    const project = await projectBySlug(createDb(pool), slug);
    odooVersion = odooVersionForProject(project?.version);
  } finally {
    await pool.end();
  }

  const vpsId = stagingVpsIdFromEnv(process.env);
  const ssh = await connectToVpsById(vpsId, defaultStagingFleetDeps);
  heartbeat();
  const result = await runAddonTestsOnSandbox({
    vpsId,
    ssh,
    repoRoot: env.workdir,
    odooVersion,
    runKey: `${slug}-${input.specId}`,
    addonPaths,
  });
  if (!result.ran) return null;
  return {
    green: result.green,
    // The note rides the PR body either way: a green CI whose shape a human
    // cannot see is only marginally better than none.
    note: `${result.summary}\n\n${result.log}`,
  };
}

const defaultRunCiDeps: RunCiDeps = { run, runAddonCi: defaultRunAddonCi };

/**
 * Turn a CI step's INFRASTRUCTURE failure (the process couldn't run — missing
 * tool, killed, output overflow; `run()` flags these as `execError`) into a
 * RETRYABLE `ApplicationFailure` instead of letting it fold into `green:
 * false`. A `green: false` from an infra problem is a lie: the workflow reads
 * it as "tests failed" and spends LLM repair rounds trying to fix code that is
 * fine, ending in `RepairExhausted` (SPEC-ALIGNMENT §9.3). Retryable, so a
 * transient worker/env glitch simply re-runs on another attempt; a persistent
 * one fails the activity loudly with the real cause. A real non-zero exit
 * (tests red) has `execError` falsy and still folds into `green: false`.
 */
function assertNoCiInfraFailure(step: string, result: { execError?: boolean; out: string }): void {
  if (!result.execError) return;
  throw ApplicationFailure.create({
    type: "CiInfrastructureError",
    nonRetryable: false,
    message:
      `CI '${step}' could not run (infrastructure failure — missing tool, killed, or output ` +
      `overflow), not a test/build verdict: ${result.out.trim().slice(0, 500)}`,
  });
}

/** Spec 0171: is this run working in a CUSTOMER's repo rather than the
 * launchpad's own? Mirrors the discriminator `provisionEphemeralEnv` already
 * uses for the specs link. */
function isProjectRepo(input: PipelineInput): boolean {
  return !!input.project && input.project.kind !== "platform";
}

/** The scripts a repo actually defines. An unreadable/absent `package.json`
 * yields none, so a caller runs nothing rather than guessing at `pnpm test`. */
async function packageScripts(workdir: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await readFile(path.join(workdir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return new Set(Object.keys(raw.scripts ?? {}));
  } catch {
    return new Set();
  }
}

/** The three steps we run if the repo defines them, in the order a person
 * would: get it building before asking whether it is correct. */
const PROJECT_CI_STEPS = ["build", "typecheck", "test"] as const;

/**
 * CI for a customer's repo (spec 0171): the scripts THAT repo defines, plus the
 * Odoo addon CI (spec 0167) when it also carries addons — an odoo-next project
 * has both a Next front and its addons in one repo.
 *
 * A script the repo does not define is RECORDED as absent, never counted as a
 * pass: "3/3 green" over a repo that defines no tests is a check that cannot
 * fail (VERIFICATION #2), and the note is how a human sees how thin the
 * evidence was. When nothing ran at all, the result is 0138's honest skip
 * rather than an invented green.
 */
async function runProjectCi(
  input: PipelineInput,
  env: EphemeralEnv,
  deps: RunCiDeps,
): Promise<CiResult> {
  const scripts = await packageScripts(env.workdir);
  const did: string[] = [];
  const absent: string[] = [];
  let green = true;

  // No lockfile is the normal shape of a freshly scaffolded repo, and pnpm
  // turns on --frozen-lockfile by itself when CI=true — which would fail the
  // install for the exact repos this branch exists to serve.
  const install = await deps.run("pnpm", ["install", "--no-frozen-lockfile"], env.workdir);
  assertNoCiInfraFailure("install", install);
  green = green && install.ok;
  did.push(`install ${install.ok ? "ok" : "RED"}`);

  // A failed install makes every later step meaningless — `next build` without
  // node_modules reports a missing module, not a verdict about the change.
  if (install.ok) {
    for (const step of PROJECT_CI_STEPS) {
      if (!scripts.has(step)) {
        absent.push(step);
        continue;
      }
      const r = await deps.run("pnpm", ["run", step], env.workdir);
      assertNoCiInfraFailure(step, r);
      green = green && r.ok;
      did.push(`${step} ${r.ok ? "ok" : "RED"}`);
    }
  }

  // Odoo addons in the same repo get their own CI, on our sandbox box. Null
  // when there are none, so a front-only repo is unaffected.
  const addonCi = await deps.runAddonCi?.(input, env);
  if (addonCi) {
    green = green && addonCi.green;
    did.push(`addons ${addonCi.green ? "ok" : "RED"}`);
  }

  const notes = [
    `CI del repo: ${did.join(", ")}`,
    absent.length > 0 ? `sin script: ${absent.join(", ")} (no ejecutado, no aprobado)` : null,
    addonCi?.note ?? null,
  ].filter(Boolean);
  return { green, note: notes.join(" · ") };
}

export async function runCi(
  input: PipelineInput,
  env: EphemeralEnv,
  deps: RunCiDeps = defaultRunCiDeps,
): Promise<CiResult> {
  // Spec 0138: a repo with NO package.json has no Node toolchain to run — an
  // Odoo addons repo, the A/B project's shape. Skip WITH a recorded note
  // rather than going red on `pnpm` in a Python repo (the coder loop would
  // repair forever against a toolchain that does not exist) and rather than
  // a silent green (a check that cannot fail is not a check). The note rides
  // the PR body so a human reading the run sees the absence of evidence.
  const hasPackageJson = await stat(path.join(env.workdir, "package.json")).then(
    () => true,
    () => false,
  );
  if (!hasPackageJson) {
    // Spec 0167: before calling it "skipped", try the repo's OWN tests on our
    // sandbox box. `runAddonCi` returns null when this is not an Odoo addons
    // repo (or CI is not configured), which falls through to 0138's honest note.
    const addonCi = await deps.runAddonCi?.(input, env);
    if (addonCi) return addonCi;
    return {
      green: true,
      skipped:
        "CI omitido — sin toolchain Node (no hay package.json). La verificación real es el " +
        "install de los addons en el staging de la rama.",
    };
  }
  // Spec 0171: a CUSTOMER's repo runs ITS OWN scripts. Spec 0138 fixed the pure
  // addons repo (no package.json); an odoo-next project has one — spec 0169's
  // front scaffold commits it — so without this branch it falls through to the
  // launchpad's body below and gets `pnpm --filter=./packages/*`, `pnpm -r
  // typecheck` and the Temporal harness proof, none of which exist there. Every
  // coder iteration would go red against a toolchain that was never present.
  //
  // `kind !== "platform"` is the discriminator the worktree link already uses
  // (line 884) — NOT `isSelfTarget`, because a project run's target is
  // `{kind: "self"}` too (apps/web builds it that way), and not the slug, which
  // this package has no constant for.
  if (isProjectRepo(input)) return runProjectCi(input, env, deps);
  // Tenant targets reuse the launchpad CI body unconditionally: in this MVP
  // the working tree IS a launchpad worktree (provisionEphemeralEnv, step 2),
  // so `pnpm -r typecheck && pnpm -r test` is the only CI that exists to run.
  // TODO(phase-4): per-tenant Odoo module install/upgrade + unit tests once
  // tenant runs get real per-tenant repos (ADR-009) instead of the launchpad
  // checkout.
  //
  // Rebuild packages/*/dist BEFORE the typecheck, so the typecheck sees fresh
  // cross-package exports rather than the branch's stale/absent dist (spec
  // 0055 AC1) — the same phantom-failure gap that bit specs 0050/0052. This is
  // an activity, so the build side effect is allowed (workflow.ts untouched).
  // Build packages ONLY — never `apps/web` (`next build`); typecheck/test
  // still run unconditionally below and their `.ok` is ANDed in, so a red
  // build folds straight into `green: false` without a novel error shape.
  const b = await deps.run("pnpm", ["--filter=./packages/*", "-r", "build"], env.workdir);
  assertNoCiInfraFailure("build", b);
  const r = await deps.run("pnpm", ["-r", "typecheck"], env.workdir);
  assertNoCiInfraFailure("typecheck", r);
  // Overlay TEMPORAL_TEST=1 so packages/pipeline's workflow.test.ts harness
  // executes its Temporal time-skipping cases instead of skipping them —
  // this is the merge gate spec 0010 exists to turn on. Callers (the
  // workflow) need no TEMPORAL_TEST knowledge; it's runCi's own concern.
  // HARNESS_EXEC_COUNT_FILE names a scratch file the harness's exit-hook
  // (writeHarnessCountOnExit, harness-exec.ts) writes its executed-case
  // count to; we read it back below and fold `harnessSkipProofError(...)`
  // into `green` so an accidental re-gating (0 harness cases reported while
  // TEMPORAL_TEST=1) fails CI instead of looking green.
  const countFile = path.join(tmpdir(), `launchpad-harness-count-${randomUUID()}.txt`);
  const t = await deps.run("pnpm", ["-r", "test"], env.workdir, {
    TEMPORAL_TEST: "1",
    [HARNESS_COUNT_ENV]: countFile,
  });
  assertNoCiInfraFailure("test", t);
  let executed: number | null = null;
  try {
    const parsed = Number.parseInt(await readFile(countFile, "utf8"), 10);
    executed = Number.isFinite(parsed) ? parsed : null;
  } catch {
    executed = null; // file missing/unreadable — treated as a skip-proof failure below
  }
  const skipProofError = harnessSkipProofError({ temporalTest: true, executed });
  return { green: b.ok && r.ok && t.ok && skipProofError === null };
}

/**
 * Collaborators `openPullRequest` needs beyond `input`/`env`/`context` —
 * injectable so both PR-mode branches (real GitHub vs. local-diff fallback)
 * are unit-testable without real git/network (spec 0015 item 4). Defaults to
 * the real `git` helpers, `process.env.GITHUB_TOKEN`, and a real
 * `GithubClient`.
 */
export interface OpenPullRequestDeps {
  originUrl: (cwd: string) => Promise<string | null>;
  push: (cwd: string, branch: string) => Promise<void>;
  githubToken: () => string | undefined;
  createGithubClient: (
    config: GithubConfig,
  ) => Pick<GithubClient, "openPr" | "findOpenPrByHead" | "commentOnPr">;
}

const defaultOpenPullRequestDeps: OpenPullRequestDeps = {
  originUrl: (cwd) => git.originUrl(cwd),
  push: (cwd, branch) => git.push(cwd, branch),
  githubToken: () => process.env["GITHUB_TOKEN"],
  createGithubClient: (config) => new GithubClient(config),
};

/**
 * Best-effort cache of the branch PR's number on the `project_branches` row
 * (spec 0133 decision 5) — the UI reads it; promote re-derives by head when it
 * is stale or missing, so a failure here costs a lookup, never correctness.
 * Same dynamic-import + swallow shape as `markSpec`'s spec_files projection.
 */
async function cacheBranchPrNumber(input: PipelineInput, prNumber: number): Promise<void> {
  if (!input.branch || !input.project) return;
  try {
    const { createDb, createPool, projectIdBySlug, branchByName, setBranchPr } = await import(
      "@launchpad/db"
    );
    const pool = createPool();
    try {
      const db = createDb(pool);
      const projectId = await projectIdBySlug(db, input.project.slug);
      if (!projectId) return;
      const row = await branchByName(db, projectId, input.branch);
      if (row && row.prNumber !== prNumber) await setBranchPr(db, row.id, prNumber);
    } finally {
      await pool.end();
    }
  } catch (err) {
    console.warn("[openPullRequest] branch PR-number cache skipped:", err);
  }
}

export async function openPullRequest(
  input: PipelineInput,
  env: EphemeralEnv,
  context: PrContext = { stalled: false },
  deps: OpenPullRequestDeps = defaultOpenPullRequestDeps,
): Promise<PullRequestRef> {
  // Tenant targets reuse the launchpad PR-mode logic unconditionally: the
  // working tree IS a launchpad worktree in this MVP (provisionEphemeralEnv,
  // step 2), so gate 2 reviews the same kind of diff/PR either way.
  // TODO(phase-4): per-tenant repos via a GitHub App (ADR-009) instead of
  // opening PRs against the launchpad repo itself.
  const spec = await findSpecFile(env.workdir, input.specId);
  const md = await readFile(spec, "utf8");
  const title = readTitle(md);
  const prTitle = title ? `Spec ${input.specId}: ${title}` : `Spec ${input.specId}`;
  const body = buildPullRequestBody({
    specId: input.specId,
    title,
    goal: intentGoal(md),
    keyChanges: completedProgressItems(md),
    stalled: context.stalled,
    lastHandoff: lastHandoffEntry(md),
    ...(context.ciNote ? { ciNote: context.ciNote } : {}),
  });
  const originUrl = await deps.originUrl(env.workdir);
  const prMode = resolvePrMode({ token: deps.githubToken(), originUrl });
  if (prMode.mode === "github") {
    await deps.push(env.workdir, env.branch);
    const client = deps.createGithubClient(prMode.config);
    // Spec 0133 decision 5: a BRANCH run feeds the branch's ONE accumulating
    // PR — find-or-create, then the run's spec summary lands as a COMMENT on
    // its timeline (rewriting the body each run would erase the story).
    if (input.branch) {
      let ref = await client.findOpenPrByHead(env.branch, "main");
      if (!ref) {
        try {
          ref = await client.openPr({
            head: env.branch,
            base: "main",
            title: `Rama ${input.branch}`,
            body:
              `PR acumulativo de la rama \`${input.branch}\` — cada run del ` +
              `pipeline agrega sus commits y comenta su resumen abajo. Se ` +
              `promueve completa a \`main\` desde Ramas & builds.\n\n` +
              `**Está en borrador a propósito.** Fusionar este PR ES promover a ` +
              `producción: hazlo desde "Promote a main", que verifica que ` +
              `staging probó exactamente este commit y deja el registro. ` +
              `Promote lo saca de borrador y lo fusiona con tu credencial.`,
            // Spec 0142: DRAFT. In the branch model merging this PR IS the
            // promote, so a ready PR is a live merge button in GitHub that
            // bypasses every check promote exists to run — attestation,
            // staging freshness, the spec roll-up, the audit row. It happened
            // on the first live run: the PR was merged from GitHub 44 seconds
            // after the pipeline opened it, while our own gate 2 was still
            // pending. GitHub disables merge on a draft; promote marks it
            // ready and merges.
            draft: true,
          });
        } catch (err) {
          // Two runs racing the create: GitHub 422s "A pull request already
          // exists" — the OTHER creator won, so adopt its PR by re-finding.
          const raced =
            err instanceof GithubApiError &&
            err.status === 422 &&
            /already exists/i.test(err.message);
          if (!raced) throw err;
          ref = await client.findOpenPrByHead(env.branch, "main");
          if (!ref) throw err;
        }
      }
      await client.commentOnPr(ref.number, body);
      await cacheBranchPrNumber(input, ref.number);
      return {
        repo: `${prMode.config.owner}/${prMode.config.repo}`,
        branch: env.branch,
        workdir: env.workdir,
        repoRoot: env.repoRoot,
        number: ref.number,
        url: ref.url,
        body,
      };
    }
    const pr = await client.openPr({
      head: env.branch,
      base: "main",
      title: prTitle,
      body,
    });
    return {
      repo: `${prMode.config.owner}/${prMode.config.repo}`,
      branch: env.branch,
      workdir: env.workdir,
      repoRoot: env.repoRoot,
      number: pr.number,
      url: pr.url,
      body,
    };
  }
  // Dogfood "PR" = reviewable local branch; gate 2 approves the diff itself.
  return {
    repo: env.workdir,
    branch: env.branch,
    workdir: env.workdir,
    repoRoot: env.repoRoot,
    number: 0,
    url: `local-diff:${env.branch}`,
    body,
  };
}

/** Default gap between `getPrState` polls (spec 0015) — overridable via
 * `AwaitPrApprovalOptions.pollIntervalMs` (tests pass a tiny value). */
const DEFAULT_PR_POLL_INTERVAL_MS = 60_000;

/**
 * Collaborators `awaitPrApproval` needs beyond `pr`/`options` — injectable so
 * the poll loop is unit-testable without a real Temporal activity Context (the
 * default `delay`/`heartbeat` both require one) or a real interval/network
 * (spec 0015 item 5). Defaults to `process.env.GITHUB_TOKEN`, a real
 * `GithubClient`, the module's `heartbeat()` helper, and `@temporalio/activity`'s
 * cancellation-aware `sleep` (so `CancellationScope.cancel()` on the workflow
 * side — spec 0015's signal-vs-poll race — promptly unwinds an in-flight
 * delay too, not just the request in front of it).
 */
export interface AwaitPrApprovalDeps {
  githubToken: () => string | undefined;
  createGithubClient: (
    config: GithubConfig,
  ) => Pick<GithubClient, "getPrState" | "hasAnyWorkflows">;
  delay: (ms: number) => Promise<void>;
  heartbeat: () => void;
}

const defaultAwaitPrApprovalDeps: AwaitPrApprovalDeps = {
  githubToken: () => process.env["GITHUB_TOKEN"],
  createGithubClient: (config) => new GithubClient(config),
  delay: (ms) => activitySleep(ms),
  heartbeat,
};

/** Splits a `PullRequestRef.repo` (`"<owner>/<repo>"`, as set by
 * `openPullRequest`'s GitHub-mode branch) back into its parts; `null` for
 * anything else (e.g. a local-diff ref's `workdir` path). Exported (spec
 * 0015 item 8) so apps/web can reuse the exact same parsing when it builds
 * its own `GithubClient` to fetch live check/review state, instead of
 * duplicating this regex-free split logic. */
export function parseOwnerRepo(repo: string): { owner: string; repo: string } | null {
  const parts = repo.split("/");
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) return null;
  return { owner, repo: name };
}

/**
 * Gate 2 via GitHub (spec 0015 / ADR-012, merged-as-approval per ADR-016):
 * heartbeats while polling `GithubClient.getPrState` every `pollIntervalMs`
 * until: the PR is merged (→ `approved`, actor = `mergedBy` login, or
 * `"(merged)"` when GitHub doesn't report one — checked first and wins
 * regardless of the checks conclusion, since the human already exercised
 * judgment and required status checks on main are the machine guard against
 * merging red); an approving review + green checks arrive (→ `approved`,
 * actor = reviewer login); or the PR is closed without merging (→ `rejected`,
 * actor = `"(closed)"` — GitHub's PR resource doesn't surface "who closed it"
 * without a separate timeline-events call, out of scope here). Only
 * meaningful in PR mode (`pr.number > 0`); the workflow races this against
 * the in-app `prApproved` signal so the offline fallback and Temporal-UI
 * escape hatch keep working (whichever resolves first wins). Local-diff PRs
 * (`number === 0`) have no remote to poll — the workflow never invokes this
 * for them.
 */
export async function awaitPrApproval(
  pr: PullRequestRef,
  options: AwaitPrApprovalOptions = {},
  deps: AwaitPrApprovalDeps = defaultAwaitPrApprovalDeps,
): Promise<PrApprovalOutcome> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_PR_POLL_INTERVAL_MS;
  const token = deps.githubToken();
  const ownerRepo = parseOwnerRepo(pr.repo);
  if (!token || !ownerRepo) {
    // Non-retryable: this is a caller/config error (the workflow invoked the
    // poll for a non-PR-mode ref) — retrying can never make it a GitHub PR.
    throw ApplicationFailure.create({
      type: PR_APPROVAL_NONRETRYABLE_ERROR_TYPE,
      nonRetryable: true,
      message:
        `awaitPrApproval: PR ${pr.repo}#${pr.number} isn't a GitHub PR (missing token or ` +
        `owner/repo) — the workflow must only call this in PR mode (pr.number > 0)`,
    });
  }
  const client = deps.createGithubClient({ token, ...ownerRepo });
  for (;;) {
    deps.heartbeat();
    let state;
    try {
      state = await client.getPrState(pr.number);
    } catch (err) {
      // A non-retryable GitHub failure (401/403 auth, 404, other 4xx) will
      // never resolve on a retry — stamp it non-retryable so Temporal stops
      // and the in-app `prApproved` signal stays the escape hatch. Transient
      // failures (429/5xx/network/timeout) propagate unchanged, so the
      // unbounded-retry policy re-issues the stateless poll (SPEC-ALIGNMENT §9.2).
      if (err instanceof GithubApiError && !err.retryable) {
        throw ApplicationFailure.create({
          type: PR_APPROVAL_NONRETRYABLE_ERROR_TYPE,
          nonRetryable: true,
          message: `awaitPrApproval: fatal GitHub error (${err.kind}) polling PR #${pr.number}: ${err.message}`,
        });
      }
      throw err;
    }
    if (state.merged) {
      // ADR-016: the merge IS the approval, and it has already happened — so gate 2
      // must still sync the local checkout, and gate 3 has nothing left to merge.
      return { outcome: "approved", actor: state.mergedBy ?? "(merged)", via: "merge" };
    }
    if (state.state === "closed" && !state.merged) {
      return { outcome: "rejected", actor: "(closed)" };
    }
    if (state.reviewDecision === "approved" && state.checks === "success") {
      // Approved but still OPEN: the merge is gate 3's job now (spec 0115).
      return { outcome: "approved", actor: state.approvedBy ?? "(unknown)", via: "review" };
    }
    // Spec 0167: a repo with NO Actions workflows can never report "success" —
    // `aggregateChecks` reads an empty runs list as "pending" — so the condition
    // above is unsatisfiable there and an approved PR polls forever. Sandbox spec
    // 0002 hit exactly this and only advanced because someone merged it by hand.
    //
    // Asked only once an approval is in hand, and only of the REPO, so "this repo
    // has no CI" is never confused with "CI has not started yet": a repo with
    // workflows reports them regardless of this SHA's runs. A failed lookup falls
    // through to the poll — the cautious direction.
    if (state.reviewDecision === "approved" && state.checks === "pending") {
      let noCi = false;
      try {
        noCi = !(await client.hasAnyWorkflows());
      } catch {
        noCi = false;
      }
      if (noCi) {
        return {
          outcome: "approved",
          actor: state.approvedBy ?? "(unknown)",
          via: "review",
          noCi: true,
        };
      }
    }
    await deps.delay(pollIntervalMs);
  }
}

/**
 * Collaborators `mergePullRequest` needs beyond `pr` — injectable so both
 * merge-mode branches (real GitHub vs. local-diff fallback) are unit-testable
 * without real git/network (spec 0015 item 6), same discipline as
 * `OpenPullRequestDeps`/`AwaitPrApprovalDeps`. Defaults to
 * `process.env.GITHUB_TOKEN`, a real `GithubClient`, and the real `git`
 * helpers.
 */
export interface ReadOdooShBuildDeps {
  githubToken: () => string | undefined;
  createGithubClient: (config: GithubConfig) => Pick<GithubClient, "getCommitStatuses">;
}

const defaultReadOdooShBuildDeps: ReadOdooShBuildDeps = {
  githubToken: () => process.env["GITHUB_TOKEN"],
  createGithubClient: (config) => new GithubClient(config),
};

/**
 * What odoo.sh says about a commit (spec 0115).
 *
 * odoo.sh builds from the connected repo and reports back as a GitHub commit
 * status — there is no odoo.sh API in this path by design — so this activity is the
 * only window into a customer's build. It reads statuses for `sha` and interprets
 * the `ci/odoo.sh` context; `interpretOdooShStatus` owns the meaning, this owns the
 * IO.
 *
 * Two callers are coming: spec 0115's promote-guard clause 4 ("production idle" —
 * never promote while a build is in flight) and the workspace's staging panel.
 *
 * **Returns `{ status: "absent" }` rather than throwing when odoo.sh has said
 * nothing**, including when the repo is not a GitHub repo we can read. That is a
 * fact a caller must be able to act on: a guard should refuse for a stated reason,
 * and a panel should say "nothing reported", neither of which is possible if this
 * throws. A genuinely broken token still throws (via the client), because that is
 * not the same as silence.
 */
export async function readOdooShBuild(
  repo: string,
  sha: string,
  deps: ReadOdooShBuildDeps = defaultReadOdooShBuildDeps,
): Promise<OdooShBuild> {
  const ownerRepo = parseOwnerRepo(repo);
  const token = deps.githubToken();
  // No GitHub coordinates or no token: we cannot look, which is reported as
  // "odoo.sh has not told us anything" rather than invented as a green build.
  if (!ownerRepo || !token) return { status: "absent" };
  const client = deps.createGithubClient({ token, owner: ownerRepo.owner, repo: ownerRepo.repo });
  const statuses = await client.getCommitStatuses(sha);
  return interpretOdooShStatus(latestStatusForContext(statuses, ODOO_SH_STATUS_CONTEXT));
}

export interface MergePullRequestDeps {
  githubToken: () => string | undefined;
  /**
   * The PROMOTING user's own GitHub token (spec 0128 F), or null.
   *
   * A promotion is the merge, and the merge is the production deploy — so it is
   * performed with that person's credential, which makes GitHub the authority:
   * branch protection, required reviews and CODEOWNERS all apply to *them*, and a
   * successful merge proves they were allowed to do it. Our own role check cannot
   * make that claim.
   *
   * Null means "we have no credential for this person". It must NEVER fall back
   * to `githubToken()`: silently merging as the bot would re-create the
   * unattributable production deploy this design removes.
   */
  promoterToken: (actor: string) => Promise<string | null>;
  createGithubClient: (config: GithubConfig) => Pick<GithubClient, "mergePr" | "getPrState">;
  dirtyFiles: (cwd: string) => Promise<string[]>;
  checkout: (cwd: string, ref: string) => Promise<void>;
  pullFfOnly: (cwd: string, branch?: string) => Promise<void>;
  /**
   * Spec 0023 post-merge dependency-sync seams. A merge that changes
   * `pnpm-lock.yaml` on the PRIMARY checkout must trigger a
   * `pnpm install --frozen-lockfile` there (nothing else does — the run's
   * coders install on the worktree, not the primary — see spec 0023 Intent),
   * then nudge the owned `next dev` so it recovers module resolution.
   * Injectable so `ensureDepsFresh`'s whole freshness decision is unit-testable
   * with no real files/pnpm/signals, same discipline as the git seams above.
   */
  /**
   * Spec 0162: does `<root>/pnpm-lock.yaml` exist? An Odoo addon repo — the A/B
   * project's shape — has none, so `ensureDepsFresh` must skip cleanly rather
   * than ENOENT on the read, the same "no Node toolchain" absence `runCi`
   * handles via `package.json` (spec 0138). A SEPARATE existence check, NOT a
   * try/catch around `lockfileHash`: swallowing the read error would also
   * swallow a permissions/truncation failure on a repo that genuinely has Node
   * deps, which is a real problem worth failing on (decision 1).
   */
  lockfileExists: (root: string) => Promise<boolean>;
  /** sha256 (hex) of `<root>/pnpm-lock.yaml`. */
  lockfileHash: (root: string) => Promise<string>;
  /** Contents of the `<root>/.preflight/deps-lock.sha` stamp, or null when absent. */
  readDepsStamp: (root: string) => Promise<string | null>;
  /** Write `hash` to `<root>/.preflight/deps-lock.sha` — only after a successful install. */
  writeDepsStamp: (root: string, hash: string) => Promise<void>;
  /** Run `pnpm install --frozen-lockfile` at `root`; reject (naming the command + output) on failure. */
  installFrozen: (root: string) => Promise<void>;
  /** SIGTERM the pid in `<root>/.preflight/web.pid` so the 0018 supervisor restarts `next dev`; never throws. */
  nudgeWeb: (root: string) => Promise<void>;
}

/**
 * Spec 0163: the argv and env that make `pnpm install` incapable of prompting.
 * Exported so a test can pin them — there is no way to assert "it did not hang"
 * without hanging the suite, so the spawn's shape is the checkable contract.
 *
 * `--config.confirmModulesPurge=false` kills the specific prompt that wedged
 * spec-0162; `CI=true` is the general "never prompt" signal pnpm honours. Both,
 * because a future pnpm may add a prompt only one of them covers and the failure
 * mode is a run that hangs for its whole retry budget.
 */
export const PNPM_INSTALL_ARGV = [
  "--config.confirmModulesPurge=false",
  "install",
  "--frozen-lockfile",
] as const;

export const PNPM_NONINTERACTIVE_ENV = { CI: "true" } as const;

const defaultMergePullRequestDeps: MergePullRequestDeps = {
  githubToken: () => process.env["GITHUB_TOKEN"],
  /**
   * Spec 0128 F: the promoter's own token, read from the encrypted secret store
   * (`user-github-token:<email>`, spec 0076's AES-256-GCM table). Inlined rather
   * than importing apps/web's helper — this package must not depend on the web app
   * — but the secret NAME is shared, and the two must agree.
   */
  promoterToken: async (actor: string) => {
    const email = actor.trim().toLowerCase();
    if (!email) return null;
    try {
      const { createDb, createPool, getSecret, loadSecretMasterKey } = await import("@launchpad/db");
      const db = createDb(createPool());
      return await getSecret(db, loadSecretMasterKey(), `user-github-token:${email}`);
    } catch {
      // Absent, undecryptable, or no DB. The caller turns null into a
      // non-retryable refusal — never a fallback to the server token.
      return null;
    }
  },
  createGithubClient: (config) => new GithubClient(config),
  dirtyFiles: (cwd) => git.dirtyFiles(cwd),
  checkout: (cwd, ref) => git.checkout(cwd, ref),
  pullFfOnly: (cwd, branch) => git.pullFfOnly(cwd, branch),
  async lockfileExists(root) {
    return stat(path.join(root, "pnpm-lock.yaml")).then(
      () => true,
      () => false,
    );
  },
  async lockfileHash(root) {
    const contents = await readFile(path.join(root, "pnpm-lock.yaml"));
    return createHash("sha256").update(contents).digest("hex");
  },
  async readDepsStamp(root) {
    try {
      return (await readFile(path.join(root, ".preflight", "deps-lock.sha"), "utf8")).trim();
    } catch {
      return null; // missing stamp (first run, or never previously synced)
    }
  },
  async writeDepsStamp(root, hash) {
    const dir = path.join(root, ".preflight");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "deps-lock.sha"), hash);
  },
  async installFrozen(root) {
    // Spec 0163: an activity has NO TTY and nothing ever writes to the child's
    // stdin, so any pnpm prompt is an infinite hang — not a slow install. The
    // one that bit us:
    //
    //   ? The modules directories will be removed and reinstalled from scratch.
    //     Proceed? (Y/n)
    //
    // spec-0162's merge sat on that for 18 minutes across two attempts at 0% CPU
    // and then burned its last retry. The same command in a login shell answers
    // the prompt from the terminal and finishes in 1.8s, which is exactly what
    // made it look like a broken environment instead of a missing flag.
    //
    // `CI=true` is the general fix — pnpm (and npm/yarn) treat it as "never
    // prompt, take the default" — and the explicit config is the specific one for
    // the prompt we actually hit. Both, because a future pnpm may add a prompt
    // that only one of them covers, and the failure mode is a wedged run.
    const r = await run("pnpm", [...PNPM_INSTALL_ARGV], root, { ...PNPM_NONINTERACTIVE_ENV });
    if (!r.ok) {
      throw new Error(`pnpm install --frozen-lockfile failed at ${root}: ${r.out}`);
    }
  },
  async nudgeWeb(root) {
    let pidText: string;
    try {
      pidText = await readFile(path.join(root, ".preflight", "web.pid"), "utf8");
    } catch {
      return; // no pidfile — web isn't running under the supervisor; not this activity's concern
    }
    const pid = Number.parseInt(pidText.trim(), 10);
    if (!Number.isFinite(pid)) return; // stale/malformed pidfile — tolerate, never fail the merge
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ESRCH (pid no longer exists) or similar — tolerate, the supervisor
      // owns the process's actual lifecycle, not this nudge.
    }
  },
};

/**
 * Spec 0023: post-merge dependency sync. `mergePullRequest` calls this in BOTH
 * modes AFTER the primary checkout is synced onto the new `main`. Computes the
 * sha256 of `<root>/pnpm-lock.yaml` and compares it against the
 * `<root>/.preflight/deps-lock.sha` stamp; on mismatch or a missing stamp it
 * runs `pnpm install --frozen-lockfile` at `root`, writes the stamp ONLY on a
 * successful install, then nudges the owned web server (item 2). On a match:
 * a no-op.
 *
 * Hash-vs-stamp (NOT `git.changedFiles(before, after)`) is deliberate: this
 * runs inside an at-least-once Temporal activity, so on retry after the pull
 * before==after and a diff-based check would silently skip the install and
 * permanently strand the server. The stamp is retry-idempotent and also
 * self-heals a previously missed sync on the next merge. `--frozen-lockfile`:
 * the lockfile is already committed by the run's coders, so a plain
 * `pnpm install` could rewrite it and dirty the tree every later checkout-
 * driving activity asserts clean (spec 0008/0021). Install failure throws
 * loudly (activity fails, retry re-attempts); the stamp is NOT written and the
 * web is NOT nudged. A missing/stale web pidfile is logged and tolerated —
 * never fail the merge over the web not running (preflight's concern).
 */
export async function ensureDepsFresh(root: string, deps: MergePullRequestDeps): Promise<void> {
  // Spec 0162: no `pnpm-lock.yaml` ⇒ no Node toolchain to keep fresh (an Odoo
  // addon repo, the A/B project's shape). Skip WITH a recorded note, mirroring
  // runCi's 0138 package.json skip — a skip the run's logs can see beats a
  // silent no-op. A SEPARATE existence check (decision 1), NOT a try/catch on
  // lockfileHash: an unreadable-but-present lockfile is a real failure worth
  // going red on.
  if (!(await deps.lockfileExists(root))) {
    console.log(`[ensureDepsFresh] sin toolchain Node (no hay pnpm-lock.yaml) en ${root} — omitido`);
    return;
  }
  const hash = await deps.lockfileHash(root);
  const stamp = await deps.readDepsStamp(root);
  if (stamp === hash) return; // already fresh — no-op
  await deps.installFrozen(root);
  await deps.writeDepsStamp(root, hash); // write ONLY after a successful install
  await deps.nudgeWeb(root);
}

export async function mergePullRequest(
  pr: PullRequestRef,
  deps: MergePullRequestDeps = defaultMergePullRequestDeps,
  /**
   * Who is promoting (spec 0128 F). Their credential performs the merge. Optional
   * so the local-diff path and pre-0128 callers keep working; when absent the
   * server token merges, which is the pre-0128 behaviour and stays correct for a
   * dogfood/local merge that touches no customer repo.
   */
  promotedBy?: string,
): Promise<void> {
  // Spec 0017: both modes merge in the PRIMARY checkout (`repoRoot`), never
  // in the run's worktree (`workdir`) — the primary is the one that stays on
  // `main` throughout the run, so it's the only checkout a merge may target.
  // Falls back to `workdir` when unset (pre-0017 refs / single-checkout
  // callers) so this stays backward compatible.
  const root = pr.repoRoot ?? pr.workdir;
  if (pr.number === 0) {
    // Spec 0115 concurrency A: clean-check → checkout → merge must be atomic. Without
    // the lock another run's in-flight commit makes the tree dirty between the assert
    // and the checkout, and this run fails on a guard it had already satisfied.
    await withRepoLock(root, async () => {
      await assertCleanTree(root, `mergePullRequest(${pr.branch})`, deps.dirtyFiles);
      await deps.checkout(root, "main");
      await git.mergeNoFf(root, pr.branch);
      await ensureDepsFresh(root, deps);
    });
    return;
  }
  // Spec 0128 F: prefer the promoting person's own credential. A `promotedBy` with
  // no stored token is a REFUSAL, not a fallback — merging as the bot instead
  // would silently undo the whole point of attributing a production deploy.
  let token = deps.githubToken();
  if (promotedBy) {
    const mine = await deps.promoterToken(promotedBy);
    if (!mine) {
      throw ApplicationFailure.create({
        type: "PromoterCredentialMissing",
        message:
          `mergePullRequest: no GitHub credential stored for ${promotedBy}, so this promotion cannot ` +
          `be performed as them. Sign in with GitHub again to re-authorise, then promote once more.`,
        // Retrying cannot conjure a credential, and a retry loop would bury the
        // one message that says what to do.
        nonRetryable: true,
      });
    }
    token = mine;
  }
  const ownerRepo = parseOwnerRepo(pr.repo);
  if (!token || !ownerRepo) {
    throw new Error(
      `mergePullRequest: PR ${pr.repo}#${pr.number} isn't a GitHub PR (missing token or ` +
        `owner/repo) — the workflow must only reach this branch in PR mode (pr.number > 0)`,
    );
  }
  const client = deps.createGithubClient({ token, ...ownerRepo });
  // Idempotent merge (ADR-016): a human may have already merged the PR on
  // GitHub (that's how gate 2 clears now — see `awaitPrApproval`'s merged
  // short-circuit) by the time this activity runs, or a prior run of this
  // activity may have merged it before a retry/replay lands here again. Check
  // first and skip the API call when it's already merged — calling `mergePr`
  // on an already-merged PR 405s and would wedge the run (spec 0015 PR #2).
  const state = await client.getPrState(pr.number);
  // Spec 0160: ask BEFORE asserting. This check used to sit below
  // `assertCleanTree`, so the idempotency it advertises never applied in the one
  // case it exists for: the owner merged PR #57 on GitHub, this activity then refused on
  // a tree that two Archivar clicks had left dirty two days earlier, and the run
  // was recorded FAILED for a spec whose code was already on main. A merge that
  // happened server-side is not guarded by the state of a local checkout — there
  // is no local git work left to protect.
  if (!state.merged) {
    await assertCleanTree(root, `mergePullRequest(${pr.branch})`, deps.dirtyFiles);
    try {
      await client.mergePr(pr.number);
    } catch (err) {
      // Spec 0128 F / decision 5b. With a USER credential, a 401/403 means "this
      // person may not merge this" — retrying never succeeds, it only stalls the
      // run and buries the real message. Fail once, loudly, naming whose access is
      // the problem. Other failures keep their retryable classification.
      const kind = err instanceof GithubApiError ? err.kind : null;
      if (promotedBy && (kind === "auth" || kind === "not_found")) {
        throw ApplicationFailure.create({
          type: "PromoterMergeRefused",
          message:
            `mergePullRequest: GitHub refused the merge of ${pr.repo}#${pr.number} using ` +
            `${promotedBy}'s credential (${kind}). Their account may lack write access to that ` +
            `repository, or their GitHub authorisation may not include the scope needed to merge — ` +
            `signing in with GitHub again re-consents it.`,
          nonRetryable: true,
        });
      }
      throw err;
    }
  }
  // Merge happened server-side via the API (or already had, by a human or an
  // earlier attempt); sync the local checkout onto the now-updated main so
  // markSpec's status edit lands there, matching the local-diff branch's
  // post-condition (HEAD = main, tree clean).
  //
  // BEST-EFFORT (spec 0096). The pre-0096 comment here claimed "this repo made
  // no local commits of its own since pushing" and then, in the same sentence,
  // described markSpec making exactly such a commit: markSpec commits spec
  // status to local `main` and NEVER pushes it. So local `main` routinely sits
  // ahead of origin — every promote leaves one — and then `pull --ff-only`
  // cannot fast-forward. Spec 0095's run hit this and FAILED with its PR
  // already merged: an irreversible success reported as a failure, and
  // unretryable, since a retry re-runs the same impossible pull.
  //
  // The merge above is done and cannot be undone; this sync is bookkeeping, so
  // its failure is logged and swallowed. Divergence is resolved by an operator
  // (or preflight), not from inside an activity: `pull --rebase` here could
  // conflict on the very spec file the merged PR touched and would strand the
  // PRIMARY checkout mid-rebase, and push-then-pull cannot work when origin has
  // just advanced.
  try {
    // Spec 0115 concurrency A: checkout+pull on the shared primary checkout. This is
    // the sequence most likely to collide in v0 — every promote runs it, and three
    // users promoting in the same minute is the expected load, not the tail.
    await withRepoLock(root, async () => {
      await deps.checkout(root, "main");
      await deps.pullFfOnly(root, "main");
    });
  } catch (err) {
    console.warn(
      `mergePullRequest: PR #${pr.number} merged, but syncing local main failed — ` +
        `local main likely has unpushed markSpec commits. The merge STANDS; resolve with ` +
        `\`git pull --rebase origin main && git push\`. Cause: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
  // Runs on the already-merged ADR-016 path too, which is exactly the 0016
  // incident's human-merged-on-GitHub flow.
  await ensureDepsFresh(root, deps);
}

/** Sandbox domain used for every tenant deploy (spec 0026 MVP): DNS/Traefik
 * for real domains is a later spec — readiness is proven by the fleet's
 * SSH-side `verifyOdooHttp`, not by this cosmetic template value resolving. */
export const TENANT_DEPLOY_DOMAIN = "sandbox.launchpad.test";

/**
 * Worker env var overriding the tenant deploy domain (spec 0121).
 *
 * The default above is `.test`, which no browser can resolve, so until this is set
 * the only way into a tenant is an `/etc/hosts` entry. Same seam as
 * {@link STAGING_DOMAIN_ENV} — one pattern, not two. Changing it rewrites every
 * Traefik router rule, so each tenant needs one redeploy to pick it up.
 */
export const TENANT_DOMAIN_ENV = "LAUNCHPAD_TENANT_DOMAIN";

/**
 * Worker env var holding Odoo's MASTER password — `/web/database/manager` rights
 * (spec 0121). Required at deploy time: no default is safe on a host we expose on
 * purpose.
 */
export const ODOO_MASTER_PASSWORD_ENV = "LAUNCHPAD_ODOO_MASTER_PASSWORD";

/**
 * Worker env var holding the `admin` LOGIN password (spec 0121) — the one typed at
 * `/web/login`, distinct from the master password above.
 */
export const ODOO_ADMIN_PASSWORD_ENV = "LAUNCHPAD_ODOO_ADMIN_PASSWORD";

/**
 * Reads the two Odoo passwords from the worker env, failing with a message that
 * names the missing variable.
 *
 * Fails BEFORE any fleet call: a deploy that gets halfway and then discovers it
 * cannot set a password leaves a stack running on Odoo's defaults, which is the
 * exact state spec 0121 exists to end.
 */
function odooPasswordsFromEnv(env: NodeJS.ProcessEnv): {
  masterPassword: string;
  adminPassword: string;
} {
  const masterPassword = env[ODOO_MASTER_PASSWORD_ENV];
  const adminPassword = env[ODOO_ADMIN_PASSWORD_ENV];
  if (!masterPassword || !adminPassword) {
    const missing = [
      !masterPassword ? ODOO_MASTER_PASSWORD_ENV : null,
      !adminPassword ? ODOO_ADMIN_PASSWORD_ENV : null,
    ].filter(Boolean);
    throw new Error(
      `tenant deploy: set ${missing.join(" and ")} on the worker (spec 0121). ` +
        `Never hard-code either — they come from .env, which is gitignored.`,
    );
  }
  return { masterPassword, adminPassword };
}

/** Worker env var naming the SSH private key file for tenant fleet ops
 * (spec 0026). Required — no default, since there is no safe one. */
export const FLEET_SSH_IDENTITY_ENV = "LAUNCHPAD_FLEET_SSH_IDENTITY";
/** Worker env var overriding the SSH user for tenant fleet ops (spec 0026).
 * Optional — defaults to {@link DEFAULT_FLEET_SSH_USER}. */
export const FLEET_SSH_USER_ENV = "LAUNCHPAD_FLEET_SSH_USER";
const DEFAULT_FLEET_SSH_USER = "root";

/**
 * Collaborators `deployToProduction`'s tenant path needs beyond `input` —
 * injectable so happy-path call order/argument threading, the sandbox
 * refusal, and dbPassword reuse are unit-tested with NO live SSH/API call
 * (spec 0026 plan steps 4/5; same injectable-deps pattern as
 * `OpenPullRequestDeps`). The default wiring mirrors the exact sequence
 * `scripts/fleet-bootstrap-smoke.mjs` already proved live: resolve the
 * Hostinger token -> `HostingerClient.getVps` for the IPv4 -> `ExecSshRunner`
 * -> `provisionClientVps` -> `readOrCreateDbPassword` -> `deployProductionStack`.
 *
 * SSH identity/user are read from worker env vars — never from spec/CLI
 * input, never hard-coded: {@link FLEET_SSH_IDENTITY_ENV} (private key path,
 * required) and {@link FLEET_SSH_USER_ENV} (optional, defaults to
 * {@link DEFAULT_FLEET_SSH_USER}). A missing identity file throws a config
 * error naming BOTH var names — never a secret — before any fleet call runs.
 */
export interface DeployToProductionDeps {
  env: NodeJS.ProcessEnv;
  resolveHostingerToken: (tenantId: string) => string;
  createHostingerClient: (token: string) => HostingerClient;
  createSshRunner: (target: SshTarget) => SshRunner;
  provisionClientVps: (opts: BootstrapOptions) => Promise<BootstrapResult>;
  readOrCreateDbPassword: (tenantId: string) => Promise<string>;
  /** Spec 0208: the read-only Odoo login this deploy creates in the tenant. */
  readOdooReadonly: (tenantId: string) => Promise<OdooReadonlyCredentials>;
  deployProductionStack: (opts: DeployOptions) => Promise<DeployResult>;
  heartbeat: () => void;
}

const defaultDeployToProductionDeps: DeployToProductionDeps = {
  env: process.env,
  readOdooReadonly: (tenantId) => readOrCreateOdooReadonlyCredentials(tenantId),
  resolveHostingerToken,
  createHostingerClient: (token) => new HostingerClient({ apiToken: token }),
  createSshRunner: (target) => new ExecSshRunner(target),
  provisionClientVps,
  readOrCreateDbPassword,
  deployProductionStack,
  heartbeat,
};

/**
 * Tenant-target deploy (spec 0026 MVP): wires the workflow's gate-3 promote
 * to the EXISTING, proven fleet functions — no new deploy logic. Launchpad
 * targets are unchanged: merge IS the deploy, so this returns immediately.
 *
 * Fleet errors (`HostingerApiError`/`FleetError`, including the sandbox
 * refusal for a non-allowlisted `vpsId` — ADR-013) map via `toActivityFailure`
 * to an `ApplicationFailure` with the correct `nonRetryable` flag; retries are
 * safe because every fleet step is idempotent (bootstrap marker no-op,
 * `tenantDbExists` guard, same-password redeploy). Heartbeats once between
 * the two fleet calls — this activity runs under the default 30-minute
 * `startToCloseTimeout` (`ACTIVITY_OPTIONS`), so a dedicated long-timeout
 * profile isn't needed for the MVP.
 */
export async function deployToProduction(
  input: PipelineInput,
  deps: DeployToProductionDeps = defaultDeployToProductionDeps,
): Promise<void> {
  // NOTE (spec 0036 item 1): rerouted through isSelfTarget() ahead of item 2's
  // scheduled edit, purely to stay typecheck-green — widening PipelineTarget's
  // self variant to `kind: "self" | "launchpad"` means TS can no longer narrow
  // out just the "launchpad" literal via a plain `=== "launchpad"` check (a
  // union-typed discriminant on one member defeats discriminated-union
  // narrowing), so the destructure below would otherwise fail to compile even
  // though no behavior changed. isSelfTarget() is the forever wire-compat
  // shim (spec 0036): a legacy in-flight run whose persisted target still
  // says "launchpad" must keep returning early here instead of falling
  // through to the tenant deploy path below — see the regression test
  // "deployToProduction: legacy launchpad target ..." in activities.test.ts.
  if (isSelfTarget(input.target)) return; // dogfood: merge IS the deploy

  // isSelfTarget() is an ordinary boolean function, not a type predicate, so
  // it doesn't narrow the union for TS on its own; the only other
  // PipelineTarget member is "tenant", so this cast is safe by construction
  // (guaranteed by isSelfTarget's early return above).
  const { tenantId, vpsId, odooVersion } = input.target as Extract<PipelineTarget, { kind: "tenant" }>;
  try {
    const identityFile = deps.env[FLEET_SSH_IDENTITY_ENV];
    if (!identityFile) {
      throw new Error(
        `deployToProduction: set ${FLEET_SSH_IDENTITY_ENV} (SSH private key path) on the ` +
          `worker; ${FLEET_SSH_USER_ENV} optionally overrides the SSH user (default ` +
          `"${DEFAULT_FLEET_SSH_USER}")`,
      );
    }
    const sshUser = deps.env[FLEET_SSH_USER_ENV] ?? DEFAULT_FLEET_SSH_USER;

    const token = deps.resolveHostingerToken(tenantId);
    const client = deps.createHostingerClient(token);
    const vps = await client.getVps(vpsId);
    const ipv4 = vps.ipv4?.[0]?.address;
    if (!ipv4) {
      throw new Error(`deployToProduction: VPS ${vpsId} has no IPv4 address to SSH to`);
    }
    const ssh = deps.createSshRunner({ host: ipv4, user: sshUser, identityFile });

    await deps.provisionClientVps({ tenantId, vpsId, ssh, client });
    deps.heartbeat();

    const dbPassword = await deps.readOrCreateDbPassword(tenantId);
    const readonly = await deps.readOdooReadonly(tenantId);
    const { masterPassword, adminPassword } = odooPasswordsFromEnv(deps.env);
    await deps.deployProductionStack({
      tenantId,
      // Spec 0208: the front's read-only login, created by this deploy.
      odooReadonlyUser: readonly.user,
      odooReadonlyPassword: readonly.password,
      vpsId,
      ssh,
      odooVersion,
      // Spec 0121: env-driven so a tenant host can actually resolve.
      domain: deps.env[TENANT_DOMAIN_ENV] ?? TENANT_DEPLOY_DOMAIN,
      dbPassword,
      masterPassword,
      adminPassword,
    });
  } catch (err) {
    const failure = toActivityFailure(err);
    throw ApplicationFailure.create({
      type: failure.type,
      message: failure.message,
      nonRetryable: !failure.retryable,
    });
  }
}

/**
 * Worker env var overriding the domain a staging host is built from.
 *
 * The default is {@link TENANT_DEPLOY_DOMAIN}, which is `.test` — an RFC 6761
 * reserved TLD that can never resolve publicly. That is spec 0119's open DNS
 * item, not an oversight: every tenant to date is verified by an SSH-side `curl`
 * with a `Host:` header, which is why nothing noticed. Once a wildcard record
 * exists, setting this makes staging links clickable with no code change.
 */
export const STAGING_DOMAIN_ENV = "LAUNCHPAD_STAGING_DOMAIN";

/**
 * The domain staging environments are named under (spec 0189).
 *
 * One expression, three call sites: the branch op, the gate-2 refresh and the
 * per-spec stack all have to agree, and a fourth reader — the DNS record and the
 * certificate decision — now depends on the same answer. Three copies of a
 * fallback chain is how they drift.
 */
export function stagingDomainOf(env: NodeJS.ProcessEnv): string {
  return env[STAGING_DOMAIN_ENV] ?? env[TENANT_DOMAIN_ENV] ?? TENANT_DEPLOY_DOMAIN;
}

/**
 * Fleet wiring the staging activities share — injectable so the refusals and
 * argument threading are unit-tested with no live SSH or API call, the same
 * pattern {@link DeployToProductionDeps} established for the promote path.
 */
export interface StagingFleetDeps {
  env: NodeJS.ProcessEnv;
  resolveHostingerToken: (tenantId: string) => string;
  createHostingerClient: (token: string) => HostingerClient;
  createSshRunner: (target: SshTarget) => SshRunner;
  heartbeat: () => void;
}

export interface DestroyStagingDeps extends StagingFleetDeps {
  destroyStagingStack: (opts: DestroyStagingOptions) => Promise<DestroyStagingResult>;
}

export interface DeployStagingDeps extends StagingFleetDeps {
  readOrCreateDbPassword: (tenantId: string) => Promise<string>;
  /** Spec 0208: the read-only Odoo login this deploy creates in the tenant. */
  readOdooReadonly: (tenantId: string) => Promise<OdooReadonlyCredentials>;
  deployStagingStack: (opts: DeployStagingOptions) => Promise<StagingDeployResult>;
}

const defaultStagingFleetDeps: StagingFleetDeps = {
  env: process.env,
  resolveHostingerToken,
  createHostingerClient: (token) => new HostingerClient({ apiToken: token }),
  createSshRunner: (target) => new ExecSshRunner(target),
  heartbeat,
};

const defaultDestroyStagingDeps: DestroyStagingDeps = {
  ...defaultStagingFleetDeps,
  destroyStagingStack,
};

const defaultDeployStagingDeps: DeployStagingDeps = {
  ...defaultStagingFleetDeps,
  readOrCreateDbPassword,
  readOdooReadonly: (tenantId) => readOrCreateOdooReadonlyCredentials(tenantId),
  deployStagingStack,
};

/**
 * The SSH connection a staging activity needs, from a tenant target.
 *
 * `deployToProduction` above builds the identical thing inline, and is left
 * alone deliberately (CLAUDE.md rule 3): it has been the live promote path since
 * spec 0026, and reshaping it to share this helper would put a working deploy at
 * risk for a new caller's convenience. The duplication is recorded in 0119's
 * handoff rather than resolved by a drive-by refactor.
 */
async function connectToTenantVps(
  target: Extract<PipelineTarget, { kind: "tenant" }>,
  deps: StagingFleetDeps,
): Promise<SshRunner> {
  const identityFile = deps.env[FLEET_SSH_IDENTITY_ENV];
  if (!identityFile) {
    throw new Error(
      `staging: set ${FLEET_SSH_IDENTITY_ENV} (SSH private key path) on the worker; ` +
        `${FLEET_SSH_USER_ENV} optionally overrides the SSH user (default ` +
        `"${DEFAULT_FLEET_SSH_USER}")`,
    );
  }
  const sshUser = deps.env[FLEET_SSH_USER_ENV] ?? DEFAULT_FLEET_SSH_USER;
  const token = deps.resolveHostingerToken(target.tenantId);
  const client = deps.createHostingerClient(token);
  const vps = await client.getVps(target.vpsId);
  const ipv4 = vps.ipv4?.[0]?.address;
  if (!ipv4) {
    throw new Error(`staging: VPS ${target.vpsId} has no IPv4 address to SSH to`);
  }
  return deps.createSshRunner({ host: ipv4, user: sshUser, identityFile });
}

/**
 * Stand the change under review up as its own Odoo stack (spec 0119).
 *
 * Called when the run ARRIVES at gate 2, not when gate 2 resolves: the entire
 * point is to be testable *before* the human decides, so approving after looking
 * at something is possible at all.
 *
 * The addons deployed are whatever `env.workdir` contains — the run's worktree at
 * the reviewed commit — so what a reviewer tests is the code they are approving,
 * not `main`.
 *
 * Deliberately does NOT bootstrap the host (no `provisionClientVps`, unlike
 * `deployToProduction`). Staging is created for a change to a tenant that already
 * lives on that box, so the host-level install is not this call's business; a
 * review-time create that could mutate host infrastructure is a bigger action
 * than the task needs. If a box were genuinely un-bootstrapped, the deploy fails
 * and the run continues without staging (see the workflow's handling).
 *
 * `null` for self/dogfood targets: our own runs change a TypeScript monorepo, so
 * there is no Odoo stack to stand up.
 */
export async function deployStaging(
  input: PipelineInput,
  env: EphemeralEnv,
  deps: DeployStagingDeps = defaultDeployStagingDeps,
  branchDeps: BranchStagingDeps = defaultBranchStagingDeps,
): Promise<StagingRef | null> {
  // Spec 0134 decision 5: a BRANCH run arriving at gate 2 REFRESHES the
  // branch's existing server from the reviewed worktree (and re-records the
  // attestation SHAs); it never CREATES one — creation is the UI's explicit
  // act, with its own capacity refusal. No stack ⇒ null, and the staging
  // query reports "none" rather than a surprise deploy.
  if (input.branch && input.project) {
    return deployStagingForBranchRun(input, env, branchDeps);
  }
  if (isSelfTarget(input.target)) return null;
  const target = input.target as Extract<PipelineTarget, { kind: "tenant" }>;
  try {
    const ssh = await connectToTenantVps(target, deps);
    const dbPassword = await deps.readOrCreateDbPassword(target.tenantId);
    const readonly = await deps.readOdooReadonly(target.tenantId);
    deps.heartbeat();
    const result = await deps.deployStagingStack({
      tenantId: target.tenantId,
      // Spec 0208: created in the spec-staging database too.
      odooUser: readonly.user,
      odooPassword: readonly.password,
      specId: input.specId,
      vpsId: target.vpsId,
      ssh,
      odooVersion: target.odooVersion,
      // Staging keeps its OWN domain var: a throwaway environment and a long-lived
      // tenant can sit on different domains, and the fallback chain says which
      // wins if only one is set (spec 0121).
      domain: stagingDomainOf(deps.env),
      // Spec 0189: a real certificate when the name is one we can validate.
      ...(stagingCertResolver(stagingDomainOf(deps.env))
        ? { certResolver: stagingCertResolver(stagingDomainOf(deps.env))! }
        : {}),
      dbPassword,
      ...odooPasswordsFromEnv(deps.env),
      repoRoot: env.workdir,
    });
    return {
      specId: result.specId,
      stack: result.stack,
      host: result.host,
      addons: result.addons,
      healthy: result.healthy,
      odooHttpOk: result.odooHttpOk,
    };
  } catch (err) {
    const failure = toActivityFailure(err);
    throw ApplicationFailure.create({
      type: failure.type,
      message: failure.message,
      nonRetryable: !failure.retryable,
    });
  }
}

/**
 * Take the run's staging stack down (spec 0119).
 *
 * Everything this needs is derived from `input` — tenant, VPS, spec id — and
 * deliberately NOT from whatever the create returned. That is the whole point: a
 * run whose worker died between creating the stack and reaching teardown holds no
 * reference to it, and that is exactly the case that leaks a Postgres volume
 * forever. Idempotent by construction (`existed: false` when the directory is
 * already gone), so the at-least-once retry this runs under is safe.
 *
 * `null` for self/dogfood targets: our own runs change a TypeScript monorepo and
 * there is no Odoo stack to take down. `destroyStagingStack` additionally refuses
 * any stack that is not `spec-NNNN`, so no argument reachable from here can aim
 * this at production.
 */
export async function destroyStaging(
  input: PipelineInput,
  deps: DestroyStagingDeps = defaultDestroyStagingDeps,
): Promise<DestroyStagingResult | null> {
  if (isSelfTarget(input.target)) return null;
  const target = input.target as Extract<PipelineTarget, { kind: "tenant" }>;
  try {
    const ssh = await connectToTenantVps(target, deps);
    return await deps.destroyStagingStack({
      tenantId: target.tenantId,
      specId: input.specId,
      vpsId: target.vpsId,
      ssh,
    });
  } catch (err) {
    const failure = toActivityFailure(err);
    throw ApplicationFailure.create({
      type: failure.type,
      message: failure.message,
      nonRetryable: !failure.retryable,
    });
  }
}

// ---------------------------------------------------------------------------
// Spec 0134 — a BRANCH's staging server (the odoo.sh model's per-branch
// environment). Deployed/destroyed EXPLICITLY from the UI via the tiny
// `branchStagingOp` workflow (fleet credentials are worker-only), refreshed
// automatically when a branch run arrives at gate 2 (`deployStaging` below).
// ---------------------------------------------------------------------------

/** Names the ONE staging box branch servers deploy to (spec 0134) —
 * 100001 = 203.0.113.20, already the sandbox allowlist's only entry.
 * `assertSandboxVps` inside the fleet layer still hard-refuses anything the
 * allowlist does not carry, so a wrong value here cannot reach a stranger's
 * box. */
export const STAGING_VPS_ID_ENV = "LAUNCHPAD_STAGING_VPS_ID";

export interface BranchStagingDeps extends StagingFleetDeps {
  readOrCreateDbPassword: (tenantId: string) => Promise<string>;
  /** Spec 0208: the tenant's read-only Odoo credentials, for the branch front. */
  readOdooReadonly: (tenantId: string) => Promise<OdooReadonlyCredentials>;
  deployBranchStagingStack: typeof deployBranchStagingStack;
  destroyBranchStack: typeof destroyBranchStack;
  /** Spec 0172: the branch's Next front — packed from the branch worktree and
   * deployed as a second stack, so staging is the whole app. */
  packCheckout: (repoRoot: string) => Promise<string>;
  deployFrontStack: typeof deployFrontStack;
  /** Spec 0187 E: the install pass for a branch DB that already exists — the
   * branch-path twin of the dep 0176 added to the release deploy. */
  installTenantModules: typeof installTenantModules;
}

const defaultBranchStagingDeps: BranchStagingDeps = {
  ...defaultStagingFleetDeps,
  readOrCreateDbPassword,
  readOdooReadonly: (tenantId) => readOrCreateOdooReadonlyCredentials(tenantId),
  deployBranchStagingStack,
  destroyBranchStack,
  packCheckout: packCheckoutWithTar,
  deployFrontStack,
  installTenantModules,
};

/**
 * Point a staging host at the box (spec 0189).
 *
 * `upsertDnsRecord` is the same call provisioning makes, and it is the one that
 * REFUSES to overwrite a record already pointing elsewhere — so a name collision
 * is reported rather than hijacked. A host outside our zone (the sslip.io form,
 * or a customer's own domain) yields no target and is skipped: there is no
 * record of ours to write.
 *
 * Best-effort by design. A staging environment that is up and reachable by IP
 * must not be thrown away because a DNS API call failed; the failure is logged
 * and the URL simply does not resolve yet, which the reviewer sees immediately.
 */
async function publishStagingDns(
  hosts: readonly string[],
  vpsId: number,
  deps: StagingFleetDeps,
): Promise<void> {
  const zone = provisionedZone(deps.env);
  const targets = hosts
    .map((h) => stagingDnsTarget(h, zone))
    .filter((t): t is { domain: string; name: string } => t !== null);
  if (targets.length === 0) return;
  try {
    const token = deps.resolveHostingerToken("branch-staging");
    const client = deps.createHostingerClient(token);
    const vps = await client.getVps(vpsId);
    const ipv4 = vps.ipv4?.[0]?.address;
    if (!ipv4) {
      console.warn(`[staging-dns] VPS ${vpsId} has no IPv4 — staging names not published`);
      return;
    }
    for (const t of targets) {
      const res = await client.upsertDnsRecord({ domain: t.domain, name: t.name, content: ipv4 });
      console.log(`[staging-dns] ${t.name}.${t.domain} → ${ipv4} (${res.outcome})`);
    }
  } catch (err) {
    console.warn(
      `[staging-dns] could not publish ${targets.map((t) => `${t.name}.${t.domain}`).join(", ")}:`,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
  }
}

/** Like {@link connectToTenantVps}, from a bare VPS id — branch runs are
 * kind-self, so there is no tenant target to read the id from. */
async function connectToVpsById(vpsId: number, deps: StagingFleetDeps): Promise<SshRunner> {
  const identityFile = deps.env[FLEET_SSH_IDENTITY_ENV];
  if (!identityFile) {
    throw new Error(
      `branch staging: set ${FLEET_SSH_IDENTITY_ENV} (SSH private key path) on the worker`,
    );
  }
  const sshUser = deps.env[FLEET_SSH_USER_ENV] ?? DEFAULT_FLEET_SSH_USER;
  const token = deps.resolveHostingerToken("branch-staging");
  const client = deps.createHostingerClient(token);
  const vps = await client.getVps(vpsId);
  const ipv4 = vps.ipv4?.[0]?.address;
  if (!ipv4) throw new Error(`branch staging: VPS ${vpsId} has no IPv4 address to SSH to`);
  return deps.createSshRunner({ host: ipv4, user: sshUser, identityFile });
}

/** The staging box's VPS id from the worker env — a refusal names the var. */
function stagingVpsIdFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env[STAGING_VPS_ID_ENV];
  const vpsId = Number(raw);
  if (!raw || !Number.isInteger(vpsId) || vpsId <= 0) {
    throw ApplicationFailure.create({
      message: `branch staging: set ${STAGING_VPS_ID_ENV} to the staging box's VPS id (e.g. 100001)`,
      type: "BranchStagingConfig",
      nonRetryable: true,
    });
  }
  return vpsId;
}

/** The project's Odoo major, from its `version` column — default 18 when
 * absent, a NAMED refusal when unparseable (never a silent different major). */
function odooVersionForProject(version: string | null | undefined): OdooVersion {
  const raw = (version ?? "").trim();
  if (!raw) return 18;
  const major = Number(raw.split(".")[0]);
  if (major === 17 || major === 18 || major === 19) return major;
  throw ApplicationFailure.create({
    message: `branch staging: project version ${JSON.stringify(raw)} is not an Odoo major (17|18|19) — fix the project's "version" field`,
    type: "BranchStagingConfig",
    nonRetryable: true,
  });
}

/**
 * The gate-2 half of spec 0134 decision 5: refresh a branch's EXISTING server
 * from the run's reviewed worktree. Reuses the run's own worktree (already at
 * the reviewed commit) — no detached worktree dance needed here.
 */
async function deployStagingForBranchRun(
  input: PipelineInput,
  env: EphemeralEnv,
  deps: BranchStagingDeps,
): Promise<StagingRef | null> {
  const branch = input.branch;
  const slug = input.project?.slug;
  if (!branch || !slug) return null;
  const { createDb, createPool, projectBySlug, branchByName, setBranchStaging } = await import(
    "@launchpad/db"
  );
  const pool = createPool();
  try {
    const db = createDb(pool);
    const project = await projectBySlug(db, slug);
    const row = project ? await branchByName(db, project.id, branch) : null;
    // Only refresh a server that EXISTS and is healthy enough to refresh.
    if (!project || !row || row.stagingStatus !== "ready") return null;
    const vpsId = stagingVpsIdFromEnv(deps.env);
    const sha = await git.headSha(env.workdir);
    // Spec 0136/0142: FETCH main before taking the merge-base. `origin/main`
    // in this checkout is only as fresh as the last fetch, and main moves
    // whenever anyone promotes — so a stale ref makes `staging_base_sha`
    // name a commit main passed long ago, and promote then refuses with
    // "main moved, redeploy and re-validate" for a branch sitting exactly ON
    // main's tip. Caught on the first real promote test: the box's
    // origin/main was 1 merge behind and the attestation was already wrong
    // the moment it was written.
    await run("git", ["fetch", "origin", "main"], env.workdir);
    const base = await run("git", ["merge-base", "HEAD", "origin/main"], env.workdir);
    const baseSha = base.ok ? base.out.trim() : "";
    const ssh = await connectToVpsById(vpsId, deps);
    const dbPassword = await deps.readOrCreateDbPassword(project.slug);
    // Spec 0208: the branch front reads the BRANCH's Odoo with these.
    const readonly = await deps.readOdooReadonly(project.slug);
    deps.heartbeat();
    const result = await deps.deployBranchStagingStack({
      tenantId: project.slug,
      branch,
      vpsId,
      ssh,
      odooUser: readonly.user,
      odooPassword: readonly.password,
      odooVersion: odooVersionForProject(project.version),
      domain: stagingDomainOf(deps.env),
      // Spec 0189: a real certificate when the name is one we can validate.
      ...(stagingCertResolver(stagingDomainOf(deps.env))
        ? { certResolver: stagingCertResolver(stagingDomainOf(deps.env))! }
        : {}),
      dbPassword,
      ...odooPasswordsFromEnv(deps.env),
      repoRoot: env.workdir,
      // Spec 0180: the front too. Spec 0172 taught the deploy about it and this
      // path — the gate-2 refresh — never passed the deps, so a branch's front
      // stayed on whatever it was built from at creation. Measured on
      // `owner/menu-sushi`: four coder commits including a rewritten front page,
      // and the branch URL still served the 0169 scaffold.
      packCheckout: deps.packCheckout,
      deployFront: deps.deployFrontStack,
      // Spec 0187 E: this path ALWAYS redeploys onto an existing branch
      // database (it only refreshes a server that is already `ready`), so the
      // init-time install never runs and the reviewed addons would land on
      // disk uninstalled — gate 2 reading a server that predates the change.
      // Without a stamp from the workflow the install pass cannot back up, so
      // it is skipped and said out loud rather than silently not happening.
      installModules: deps.installTenantModules,
      ...(input.backupTimestamp ? { backupTimestamp: input.backupTimestamp } : {}),
    });
    if (!input.backupTimestamp) {
      console.warn(
        `[branch-staging] spec ${input.specId}: no backupTimestamp on the input — ` +
          `staging refreshed WITHOUT installing addons into the existing branch DB`,
      );
    }
    // Spec 0192 B: the row records what was DEPLOYED, not what we meant to
    // deploy — one shared rule, because the explicit deploy path below must not
    // be able to disagree with this one.
    await setBranchStaging(db, row.id, stagingRowUpdate(result, sha, baseSha));
    if (result.front?.failed) {
      console.warn(
        `[branch-staging] spec ${input.specId}: front deploy FAILED — staging left at its ` +
          `previous commit, no attestation written: ${result.front.failed}`,
      );
    }
    return {
      specId: input.specId,
      stack: result.stack,
      host: result.host,
      addons: result.addons,
      healthy: result.healthy,
      odooHttpOk: result.odooHttpOk,
      // Spec 0226 E2: carried so the branch card can say `neutralizada` from a
      // PROVEN marker rather than from an inference. The workflow keeps this ref
      // as its own staging state, so no column is needed — the truth travels the
      // same path the host and the addons already do.
      ...(result.neutralized ? { neutralized: true as const } : {}),
      ...(result.front ? { front: result.front } : {}),
    };
  } catch (err) {
    const failure = toActivityFailure(err);
    throw ApplicationFailure.create({
      type: failure.type,
      message: failure.message,
      nonRetryable: !failure.retryable,
    });
  } finally {
    await pool.end();
  }
}

/**
 * Deploy or destroy a BRANCH's staging server (spec 0134) — the one activity
 * `branchStagingOp` wraps.
 *
 * Deploy: reconcile → **detached** worktree of `origin/<branch>` (a detached
 * worktree never claims the branch, so an explicit staging deploy can never
 * collide with a run's checkout) → pack the addons → deploy the stack →
 * record the attestation (`staging_sha` = the deployed HEAD,
 * `staging_base_sha` = the main content inside that tree) on the
 * `project_branches` row — the only moment those facts are true (0133
 * decision 2). The worktree is removed afterward regardless.
 *
 * Destroy: bring the stack down (volumes included) and clear every staging
 * field INCLUDING the attestation — stale SHAs on a stackless branch would
 * read as promote evidence.
 *
 * Row status transitions (`deploying → ready | failed`, `destroying → none`)
 * are best-effort writes: the row is the UI's view, the box is the truth, and
 * the sweep reconciles orphans.
 */
export async function runBranchStagingOp(
  op: "deploy" | "destroy",
  projectSlug: string,
  branch: string,
  /** Spec 0187 E: compact UTC stamp for the redeploy install pass's backup,
   * minted by the WORKFLOW so an activity retry reuses one directory (spec
   * 0105). REQUIRED, not optional: an optional argument is silent at exactly
   * the call site that forgets it (docs/VERIFICATION.md #12). */
  backupTimestamp: string,
  deps: BranchStagingDeps = defaultBranchStagingDeps,
): Promise<{ op: "deploy" | "destroy"; stack: string; host?: string }> {
  const { createDb, createPool, projectBySlug, branchByName, setBranchStaging, clearBranchStaging } =
    await import("@launchpad/db");
  const pool = createPool();
  try {
    const db = createDb(pool);
    const project = await projectBySlug(db, projectSlug);
    if (!project) {
      throw ApplicationFailure.create({
        message: `branch staging: no existe el proyecto "${projectSlug}"`,
        type: "BranchStagingConfig",
        nonRetryable: true,
      });
    }
    const row = await branchByName(db, project.id, branch);
    if (!row) {
      throw ApplicationFailure.create({
        message: `branch staging: la rama "${branch}" no existe en "${projectSlug}"`,
        type: "BranchStagingConfig",
        nonRetryable: true,
      });
    }
    const vpsId = stagingVpsIdFromEnv(deps.env);
    const stack = branchStackName(branch);

    if (op === "destroy") {
      await setBranchStaging(db, row.id, { status: "destroying" });
      const ssh = await connectToVpsById(vpsId, deps);
      deps.heartbeat();
      await deps.destroyBranchStack({ tenantId: project.slug, stack, vpsId, ssh });
      // Spec 0172: and its front. Idempotent by construction — `destroyBranchStack`
      // returns `existed: false` for a stack that was never deployed, which is
      // every branch of an addons-only project.
      await deps.destroyBranchStack({
        tenantId: project.slug,
        stack: frontStackFor(stack),
        vpsId,
        ssh,
      });
      await clearBranchStaging(db, row.id);
      return { op, stack };
    }

    try {
      await setBranchStaging(db, row.id, { status: "deploying", stack });
      // The branch's tip, in the PROJECT's checkout (materialized on demand —
      // the same 0129 machinery every run uses, via the same activity helper).
      const root = await ensureCheckout({
        slug: project.slug,
        repoOwner: project.repoOwner,
        repoName: project.repoName,
        kind: project.kind,
      });
      const fetched = await run("git", ["fetch", "origin", branch], root);
      if (!fetched.ok) {
        throw new Error(`branch staging: git fetch origin ${branch} failed: ${fetched.out}`);
      }
      const worktree = path.join(root, ".worktrees", `br-stg-${stack}`);
      // Serialized with run provisioning: `worktree add` writes shared repo
      // metadata (the 0115 concurrency lesson).
      await withRepoLock(root, async () => {
        const existing = (await git.listWorktrees(root)).map((w) => path.resolve(w));
        if (!existing.includes(path.resolve(worktree))) {
          const added = await run(
            "git",
            ["worktree", "add", "--detach", worktree, `origin/${branch}`],
            root,
          );
          if (!added.ok) throw new Error(`branch staging: worktree add failed: ${added.out}`);
        }
      });
      try {
        const sha = await git.headSha(worktree);
        // Spec 0136/0142: FETCH main before taking the merge-base. `origin/main`
        // in this checkout is only as fresh as the last fetch, and main moves
        // whenever anyone promotes — so a stale ref makes `staging_base_sha`
        // name a commit main passed long ago, and promote then refuses with
        // "main moved, redeploy and re-validate" for a branch sitting exactly ON
        // main's tip. Caught on the first real promote test: the box's
        // origin/main was 1 merge behind and the attestation was already wrong
        // the moment it was written.
        await run("git", ["fetch", "origin", "main"], worktree);
        const base = await run("git", ["merge-base", "HEAD", "origin/main"], worktree);
        const baseSha = base.ok ? base.out.trim() : "";
        const ssh = await connectToVpsById(vpsId, deps);
        const dbPassword = await deps.readOrCreateDbPassword(project.slug);
        // Spec 0208: the branch front reads the BRANCH's Odoo with these.
        const readonly = await deps.readOdooReadonly(project.slug);
        deps.heartbeat();
        const result = await deps.deployBranchStagingStack({
          tenantId: project.slug,
          branch,
          vpsId,
          ssh,
          odooUser: readonly.user,
          odooPassword: readonly.password,
          odooVersion: odooVersionForProject(project.version),
          domain: stagingDomainOf(deps.env),
          // Spec 0189: a real certificate when the name is one we can validate.
          ...(stagingCertResolver(stagingDomainOf(deps.env))
            ? { certResolver: stagingCertResolver(stagingDomainOf(deps.env))! }
            : {}),
          dbPassword,
          ...odooPasswordsFromEnv(deps.env),
          repoRoot: worktree,
          // Spec 0172: the branch's front, when its tree has one.
          packCheckout: deps.packCheckout,
          deployFront: deps.deployFrontStack,
          // Spec 0187 E: on a REDEPLOY the branch database already exists, so
          // `deployProductionStack`'s init-time `-i` never runs and the addons
          // land on disk uninstalled. This is the pass that tells Odoo.
          installModules: deps.installTenantModules,
          backupTimestamp,
        });
        // Spec 0189: publish the names this deploy actually produced — after the
        // deploy, because only now do we know whether this branch has a front. A
        // record for a name with nothing behind it is finding 1.16 in miniature.
        await publishStagingDns(
          [result.host, result.front?.host].filter((h): h is string => Boolean(h)),
          vpsId,
          deps,
        );
        // Spec 0192 B: the same rule as the gate-2 refresh, from the same
        // function — a front that did not build is a stack that does not hold
        // this commit, so it gets no attestation.
        await setBranchStaging(db, row.id, stagingRowUpdate(result, sha, baseSha));
        if (result.front?.failed) {
          console.warn(
            `[branch-staging] ${projectSlug}/${branch}: front deploy FAILED — no attestation ` +
              `written: ${result.front.failed}`,
          );
        }
        return { op, stack: result.stack, host: result.host };
      } finally {
        await withRepoLock(root, () => git.worktreeRemove(root, worktree)).catch((err) => {
          console.warn(`[branch-staging] worktree cleanup failed for ${worktree}:`, err);
        });
      }
    } catch (err) {
      // Spec 0195 B: the whole op failed — the row says so AND says why, in the
      // same place the reviewer sees the badge.
      const failure = toActivityFailure(err);
      await setBranchStaging(db, row.id, {
        status: "failed",
        note: frontFailureNote(failure.message),
      }).catch(() => {});
      throw ApplicationFailure.create({
        type: failure.type,
        message: failure.message,
        nonRetryable: !failure.retryable,
      });
    }
  } finally {
    await pool.end();
  }
}

/**
 * Removes the run's worktree (spec 0017): `git worktree remove` detaches the
 * isolated checkout while retaining `env.branch` for reference (per spec
 * lifecycle) — the checkout-main path this replaces (switching `workdir` back
 * to `main` in place) no longer applies now that `workdir` is a dedicated
 * worktree, not the primary checkout. The dirty-tree guard still runs first,
 * now against the worktree instead of the primary. Idempotent against
 * activity retry: if the worktree is already gone (a prior attempt succeeded
 * before the activity returned), this is a no-op. Compares real (symlink-
 * resolved) paths — `git worktree list` reports macOS's `/private/var/...`
 * form even for a worktree added under the `/var/...` symlink `tmpdir()`
 * returns, so a plain `path.resolve` equality would spuriously read as
 * "already torn down" and skip the removal.
 */
export async function teardownEnv(env: EphemeralEnv): Promise<void> {
  if (env.buildUrl === "local") {
    const root = env.repoRoot ?? env.workdir;
    const target = await realpath(env.workdir).catch(() => path.resolve(env.workdir));
    const stillProvisioned = (await git.listWorktrees(root)).some(
      (w) => path.resolve(w) === target,
    );
    if (stillProvisioned) {
      // Spec 0188 A: RECORD dirt, never fail on it.
      //
      // This used to `assertCleanTree` and throw, which made a teardown the
      // verdict on a run that had already produced correct, reviewed, merged
      // code: `spec-autopartes-0001` ended FAILED over `package.json`,
      // `next-env.d.ts` and `pnpm-lock.yaml` — three files its OWN CI writes
      // (`next build` generates one, `pnpm install --no-frozen-lockfile`
      // rewrites another, pnpm's build approval edits the third). It also
      // contradicted the rule this repo already wrote down for exactly this
      // case: a teardown error must not become the outcome of a run that
      // promoted (spec 0018, quoted in scripts/staging-sweep.mjs).
      //
      // The guard that matters is still strict: `mergePullRequest` refuses to
      // merge over a dirty PRIMARY checkout, which is the tree a bad merge
      // would corrupt. This one is a worktree about to be removed.
      const dirty = await git.dirtyFiles(env.workdir);
      if (dirty.length > 0) {
        console.warn(
          `[teardown] ${env.branch}: worktree dirty at teardown (removed anyway): ${dirty.join(", ")}`,
        );
      }
      // Spec 0115 concurrency A — same shared worktree metadata as the add above.
      // `--force` only when there IS dirt: git refuses otherwise, which would
      // put the same failure back, just in git's words.
      await withRepoLock(root, () => git.worktreeRemove(root, env.workdir, dirty.length > 0));
    }
    return; // keep branch for reference (per spec lifecycle)
  }
  throw new Error("TODO(phase-3): destroy tenant ephemeral stack");
}

/**
 * Sets the spec's `status:` frontmatter and commits that edit itself
 * (spec 0008: markSpec used to leave the rewritten spec file uncommitted,
 * the same dirty-tree class that broke run 2's merge). Stages only the spec
 * file so any other in-flight dirt isn't swept into this commit. Only commits
 * when the write actually changed the file, so a retried attempt (this is an
 * at-least-once activity) that re-applies the same status is a no-op instead
 * of failing on git's "nothing to commit".
 */
/**
 * Materialise the run's checkout before anything uses it (spec 0129 B).
 *
 * The first activity of a run whose project has its own repository. Idempotent —
 * an existing checkout is reused, which matters because re-cloning per run is the
 * expensive mistake. Failures are classified: a missing repo or a rejected
 * credential is NON-retryable, since another attempt cannot create a repository or
 * grant a permission.
 */
export async function ensureCheckout(project: NonNullable<PipelineInput["project"]>): Promise<string> {
  try {
    const outcome = await ensureProjectCheckout(project, {
      isCheckout: async (dir) => {
        try {
          await stat(path.join(dir, ".git"));
          return true;
        } catch {
          return false;
        }
      },
      clone: async (url, dest) => {
        await mkdir(path.dirname(dest), { recursive: true });
        // cwd is the PARENT: git resolves the destination relative to it, and the
        // destination cannot exist yet.
        const r = await run("git", ["clone", url, dest], path.dirname(dest));
        return { ok: r.ok, out: r.out };
      },
      addExcludes: async (root, lines) => {
        const file = path.join(root, ".git", "info", "exclude");
        await mkdir(path.dirname(file), { recursive: true });
        const existing = await readFile(file, "utf8").catch(() => "");
        // Idempotent: a second run must not append the block again.
        if (existing.includes(lines[lines.length - 1] as string)) return;
        await writeFile(file, `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${lines.join("\n")}\n`, "utf8");
      },
      persistRepoRoot: async (slug, root) => {
        const { createDb, createPool, setProjectRepoRoot } = await import("@launchpad/db");
        const pool = createPool();
        try {
          await setProjectRepoRoot(createDb(pool), slug, root);
        } finally {
          await pool.end();
        }
      },
    });
    // Spec 0141/0142: the CHECKOUT gets the same `specs` symlink the worktree
    // does. Every spec activity resolves `<root>/specs` — `draftSpec` runs
    // BEFORE any worktree exists, so without this it CREATES a real `specs/`
    // inside the customer's checkout, which is precisely what 0141 forbids.
    //
    // It also split the truth in two: the run wrote `status: staged` into that
    // in-checkout copy while the canonical file outside the repo stayed
    // `draft`, and the UI read the canonical one. One symlink makes every
    // reader and writer — pipeline, chat, tab — address the same file.
    if (project.kind !== "platform") {
      await linkSpecsIntoWorktree(outcome.root, outcome.root, projectSpecsDir(project.slug));
    }
    return outcome.root;
  } catch (err) {
    if (err instanceof CheckoutError) {
      throw ApplicationFailure.create({
        type: `Checkout_${err.kind}`,
        message: err.message,
        nonRetryable: !err.retryable,
      });
    }
    throw err;
  }
}

export async function markSpec(
  specId: string,
  status: SpecStatus,
  /**
   * The run's repo root (spec 0129 C). Before spec 0126 D every run operated on
   * `LAUNCHPAD_REPO_ROOT`, so reading the env here and `repoRootOf(input)` in every
   * other activity were the same directory. D made them differ for a project with
   * its own checkout, and this activity kept looking in OURS — so it would fail to
   * find a spec that `draftSpec` had just written into the project's repo.
   *
   * Optional, falling back to the env, so a pre-0129 workflow history replays with
   * its original behaviour.
   */
  repoRoot?: string,
  /**
   * The project this spec belongs to (spec 0129 A). When given, the spec is also
   * projected into `spec_files` — the DURABLE record, because a spec inside a
   * customer's checkout is excluded from their history and therefore unversioned.
   *
   * Optional and best-effort: a projection failure must not fail a run. Losing the
   * row is bad; losing the run because a row could not be written is worse, and the
   * file on disk is still there to re-project from.
   */
  projectSlug?: string,
): Promise<string> {
  const root = repoRoot?.trim() || process.env["LAUNCHPAD_REPO_ROOT"];
  if (!root) throw new Error("markSpec: no repo root given and LAUNCHPAD_REPO_ROOT not set on worker");
  await setStatus(root, specId, status);
  const specFile = path.relative(root, await findSpecFile(root, specId));
  // Spec 0115 concurrency A — see commitDraftIfUncommitted.
  //
  // Spec 0129: for a non-platform project the spec is in `.git/info/exclude`, so git
  // never reports it dirty and this commit is skipped. That is correct, and it is
  // exactly why the projection below is not optional bookkeeping — it becomes the
  // only record of the change.
  await withRepoLock(root, async () => {
    if ((await git.dirtyFiles(root)).includes(specFile)) {
      await git.commit(root, `chore(spec-${specId}): status -> ${status}`, [specFile]);
    }
  });

  if (projectSlug?.trim()) {
    try {
      const { createDb, createPool, projectIdBySlug, upsertSpecFile } = await import("@launchpad/db");
      const pool = createPool();
      try {
        const db = createDb(pool);
        const projectId = await projectIdBySlug(db, projectSlug.trim());
        if (projectId) {
          const absolute = path.join(root, specFile);
          await upsertSpecFile(db, {
            projectId,
            name: path.basename(specFile),
            status,
            body: await readFile(absolute, "utf8"),
          });
        }
      } finally {
        await pool.end();
      }
    } catch {
      // Best-effort by design (see the param doc): the file is still on disk.
    }
  }
  return status;
}

// ---------------------------------------------------------------------------
// Spec 0088 (Phase D) — link a run to its SPEC §5 `Project` and project the
// run into `agent_runs` so the workspace can list it.
//
// BOTH ARE FAIL-OPEN, deliberately. This is a *projection*: Temporal owns the
// truth of a workflow (SPEC §8), and the control-plane DB being unreachable
// must never fail a build that is otherwise succeeding — the same discipline
// as apps/web's `recordAudit` (spec 0075). They log and resolve instead of
// throwing, so no Temporal retry storm is triggered by a down database either.
//
// These live in activities (not workflow code) because they do I/O:
// CLAUDE.md's "Temporal workflows are deterministic: side effects only in
// activities".
// ---------------------------------------------------------------------------

/** Resolve a pipeline target to its `Project.id`, creating the row if needed.
 *
 * `PipelineTarget` deliberately keeps its shape (spec 0036's wire-compat
 * contract — an in-flight run still carries `{kind:"launchpad"}` in history),
 * so D.1 RESOLVES a target to a project rather than redefining the target as a
 * project id. `projectForTarget` (spec 0079) is the pure mapping; the upsert is
 * idempotent by slug, so a retried activity is a no-op. */
export async function resolveProjectId(
  target: PipelineTarget,
  /**
   * Spec 0142: the run's OWN project (`input.project`, spec 0129), when it has
   * one. `projectForTarget` maps every `{kind:"self"}` target to the PLATFORM
   * project — correct when the launchpad was the only repo, and wrong since a
   * customer's run also carries `kind:"self"` with a different checkout. The
   * effect was not a crash but a misfiling: `spec-0001` on `ab-test-sandbox`
   * projected onto `platform`, so the project's Agentes tab showed "no
   * workflows" while its run sat at gate 1 and the gate card had nowhere to
   * appear. Same family as 0131 C — a run that resolves to the wrong project
   * looks identical to a deliberate platform run.
   */
  projectSlug?: string,
): Promise<string | null> {
  try {
    const { createDb, createPool, projectBySlug, projectForTarget, upsertProject } =
      await import("@launchpad/db");
    const db = createDb(createPool());
    if (projectSlug) {
      // The row already exists (the run resolved its checkout from it), so this
      // is a lookup, never an upsert: inventing a project here would paper over
      // a slug that no longer matches anything.
      const project = await projectBySlug(db, projectSlug);
      if (project) return project.id;
      console.error(
        `[agent-run] project ${projectSlug} not found; falling back to the target mapping`,
      );
    }
    return await upsertProject(db, projectForTarget(target));
  } catch (err) {
    console.error("[agent-run] resolveProjectId failed (continuing without a project link)", err);
    return null;
  }
}

/** Upsert this run's projection row. Idempotent by `workflowId` (migration
 * 0003's unique index), so calling it at every phase transition advances one
 * row instead of appending one per phase — and a retried activity is safe. */
export async function recordAgentRun(run: {
  projectId: string;
  workflowId: string;
  agent: string;
  task?: string;
  status: string;
  phase?: string;
  step?: number;
  totalSteps?: number;
  /** Spec 0131 C: the checkout the run works in (`input.target.repo`). */
  repoRoot?: string;
  /** Spec 0133: the branch the run lands commits on — the promote roll-up's key. */
  branch?: string;
}): Promise<void> {
  try {
    const { createDb, createPool, upsertAgentRun } = await import("@launchpad/db");
    await upsertAgentRun(createDb(createPool()), run);
  } catch (err) {
    console.error("[agent-run] recordAgentRun failed (projection skipped)", err);
  }
}

/**
 * Spec 0170: deploy a release to production, and record the outcome.
 *
 * The DB write lives here rather than in the web action because the workflow is
 * asynchronous — the action starts it and returns, so the only place that knows
 * whether the deploy actually happened is the worker.
 */
export async function deployReleaseActivity(
  input: DeployReleaseInput,
): Promise<DeployReleaseResult> {
  const { createDb, createPool, markDeployed, markDeployFailed } = await import("@launchpad/db");
  const pool = createPool();
  const db = createDb(pool);
  try {
    const result = await deployRelease(input, defaultDeployReleaseDeps);
    const { projectBySlug } = await import("@launchpad/db");
    const project = await projectBySlug(db, input.projectSlug);
    if (project) {
      await markDeployed(db, {
        projectId: project.id,
        releaseId: input.releaseId,
        deployedBy: input.deployedBy,
        deployRef: result.deployRef,
      });
    }
    return result;
  } catch (err) {
    // A failed deploy still moves the release out of `candidate`: knowing that
    // 1.4.2 failed is worth as much as knowing 1.4.1 is live, and leaving it as
    // a candidate would invite a second click at the same broken thing.
    await markDeployFailed(db, input.releaseId, input.deployedBy).catch(() => {});
    throw err;
  } finally {
    await pool.end();
  }
}

// Spec 0228 B: the CI gate activity. Exported here because the worker registers
// `import * as activities`, so this is what makes `runCiGate` resolvable.
export { runCiGate } from "./ci-gate-run.js";
