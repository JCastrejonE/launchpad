/**
 * watcher-playbook.ts — the exception PLAYBOOK for supervisor-in-UI phase 4a
 * (spec 0054 / ADR-022 §6). A pure, typed, TOTAL map from a watcher exit code
 * to deterministic human-fix guidance, sourced verbatim from the taxonomy the
 * watcher already documents: `scripts/supervise.mjs`'s header exit-code table
 * and `docs/SUPERVISOR.md`. Sibling of `watcher-events.ts` — the guidance
 * annotates the `{type:"exception",code,msg}` records that stream already
 * carries, so it belongs beside that vocabulary (one import away from any
 * future consumer, e.g. phase-4b remediation cards reading `recoverHint`).
 *
 * PURE by construction: no I/O, no `@temporalio/*` import — so apps/web can
 * VALUE-import `describeWatcherExitCode` (via the package index) into the
 * "use client" `RunFollowCard` without dragging the Temporal client into the
 * browser bundle (the same client-bundle discipline `run-follow-card.ts`
 * documents; proven by `next build` in increment C).
 *
 * The playbook lives HERE (not in `supervise.mjs`, not in the NDJSON event)
 * on purpose: the exit CODE is the stable key; the presentation copy can
 * evolve freely in this package without touching the script or fattening the
 * `--events` contract. NO `scripts/supervise.mjs` change is needed for 4a.
 *
 * Increment A (spec 0054): real per-code entries + the fallback, plus the
 * behavioral tests (`watcher-playbook.test.ts`).
 */

/**
 * Deterministic human-fix guidance for one watcher exit code. `steps` are
 * ordered, concrete HUMAN actions (exact commands from `docs/SUPERVISOR.md`
 * where one exists) — never a CLI gate verb (`approve-spec`/`approve-pr`/
 * `promote`), which the human clicks in the UI. `recoverHint` is `true` when
 * `node scripts/supervise.mjs --recover` is the canonical first move
 * (the outage-class codes 13/14/17/18).
 */
export interface WatcherExceptionGuidance {
  /** The watcher exit code this guidance describes (or the code that was
   * looked up, for the unknown-code fallback). */
  code: number;
  /** Short human title, e.g. "Worker died". */
  title: string;
  /** One sentence: what this exit code tells you. */
  meaning: string;
  /** Ordered, concrete HUMAN fix actions (exact commands where one exists). */
  steps: string[];
  /** `true` when `supervise.mjs --recover` is the canonical first move. */
  recoverHint: boolean;
}

/**
 * TOTAL: every exit code documented in the `supervise.mjs` header
 * (2, 10–18, 20, 30, 31, 32, 40, 41, 50) maps to real guidance; any unknown
 * code degrades to a generic fallback (read the message + the run's
 * `.preflight/supervise-<id>.out`, ask the supervisor to diagnose) rather than
 * `undefined` or a throw.
 */
const PLAYBOOK: Record<number, Omit<WatcherExceptionGuidance, "code">> = {
  2: {
    title: "Usage error",
    meaning:
      "supervise.mjs was invoked with bad or missing arguments (e.g. a tenant run without --tenant/--vps-id).",
    steps: [
      "Read the usage message in the run's `.preflight/supervise-<specId>.out` log.",
      "Re-launch with the correct flags per `docs/SUPERVISOR.md`'s CLI reference (e.g. `node scripts/supervise.mjs <specId> --tenant <id> --vps-id <n>` for a tenant run).",
    ],
    recoverHint: false,
  },
  10: {
    title: "Nondeterminism (TMPRL1100)",
    meaning:
      "The workflow hit a NEW TMPRL1100 nondeterminism error — workflow.ts code likely changed shape while a run was in flight.",
    steps: [
      "Tail the worker log for the TMPRL1100 stack trace: `grep TMPRL1100 .preflight/worker.log | tail -20`.",
      "Confirm whether `packages/pipeline/src/workflow.ts` changed while this run was open — that's the classic source.",
      "With no run open, rebuild + restart the worker on the current build: `bash scripts/preflight.sh restart`.",
    ],
    recoverHint: false,
  },
  11: {
    title: "Heartbeat timeout",
    meaning:
      "An activity missed its heartbeat — usually a stuck or slow activity, or an overloaded worker.",
    steps: [
      "Check `.preflight/worker.log` for the timed-out activity's name and stack.",
      "Confirm the worker process is alive and responsive: `ps -ef | grep pipeline`.",
      "If it's genuinely stuck, restart the worker with no run open (`bash scripts/preflight.sh restart`) and re-attach.",
    ],
    recoverHint: false,
  },
  12: {
    title: "Gate-2 poll failure",
    meaning:
      "The awaitPrApproval activity failed to poll the PR's approval/CI state from GitHub (getPrState).",
    steps: [
      "Check GitHub reachability/auth: `gh pr view spec/<specId>`.",
      "Check the worker log for the getPrState error detail: `grep getPrState .preflight/worker.log | tail -20`.",
      "Once the poll issue is fixed, re-attach: `node scripts/supervise.mjs <specId> --no-start --events`.",
    ],
    recoverHint: false,
  },
  13: {
    title: "Worker pid changed",
    meaning:
      "The pipeline worker process was restarted or replaced mid-run — a worker swap in flight, which has historically caused nondeterminism.",
    steps: [
      "Recover: `node scripts/supervise.mjs --recover <specId>` (idempotent preflight restart, main resync, watcher re-attach).",
      "To preview first: `node scripts/supervise.mjs --recover <specId> --report-only`.",
    ],
    recoverHint: true,
  },
  14: {
    title: "Worker died",
    meaning:
      "The pipeline worker process is no longer running — the run cannot make progress until it's back up.",
    steps: [
      "Recover: `node scripts/supervise.mjs --recover <specId>` (restarts infra idempotently, resyncs main, re-attaches the watcher).",
      "Or manually: `bash scripts/preflight.sh`, then re-attach: `node scripts/supervise.mjs <specId> --no-start --events`.",
      "Check `.preflight/worker.log`'s tail for why it died before relying on the restart alone.",
    ],
    recoverHint: true,
  },
  15: {
    title: "Primary checkout left main",
    meaning:
      "The primary checkout is no longer on `main` — something switched branches on the box running the run.",
    steps: [
      "Check the current branch: `git status`.",
      "Switch back: `git checkout main`.",
      "Confirm the tree is clean and main == origin, then re-attach: `node scripts/supervise.mjs <specId> --no-start --events`.",
    ],
    recoverHint: false,
  },
  16: {
    title: "Primary checkout dirty",
    meaning:
      "A NEW uncommitted change appeared in the primary checkout outside the drafting window — breaks the 0017 isolation invariant.",
    steps: [
      "Inspect the stray path(s) named in the exception message: `git status --porcelain`.",
      "Commit or stash the stray change — a dirty tree can break `mergePullRequest`.",
      "Re-attach once clean: `node scripts/supervise.mjs <specId> --no-start --events`.",
    ],
    recoverHint: false,
  },
  17: {
    title: "Activity attempt failed",
    meaning:
      "A non-coder/CI activity (e.g. mergePullRequest ff-only, deployToProduction, provisionEphemeralEnv) failed an attempt with no built-in retry safety net.",
    steps: [
      "Read the exact activity name and failure message in the exception (and `.preflight/worker.log`).",
      "If it's `mergePullRequest` ff-only / UnexpectedDirtyTree: reconcile main via `git fetch origin`, `git rebase origin/main`, `git push origin main` (never merge, never force).",
      "Recover: `node scripts/supervise.mjs --recover <specId>` to resync main and re-attach, then let the activity retry.",
    ],
    recoverHint: true,
  },
  18: {
    title: "Web /api/health down",
    meaning:
      "The dev web server's health check is not returning 200 — it needs to be up for gates to be clickable.",
    steps: [
      "Check directly: `curl -s http://localhost:3000/api/health`.",
      "Bring it back up: `bash scripts/preflight.sh` (idempotent — starts only what's missing).",
      "Or recover the whole box: `node scripts/supervise.mjs --recover <specId>`.",
      "Re-attach once healthy: `node scripts/supervise.mjs <specId> --no-start --events`.",
    ],
    recoverHint: true,
  },
  20: {
    title: "Workflow reached a terminal non-success state",
    meaning:
      "The workflow itself went FAILED / TERMINATED / CANCELED / TIMED_OUT — a genuine terminal non-success status, not an infra blip.",
    steps: [
      "Inspect the exact failure via the workflow-inspect one-liner in `docs/SUPERVISOR.md` (history + `failure.message`).",
      "Check the terminal status: `node packages/pipeline/dist/cli.js status <specId>`.",
      "Decide whether to start a fresh run (same spec id, prior run closed) or fix the underlying cause first.",
    ],
    recoverHint: false,
  },
  30: {
    title: "Web-smoke red post-merge",
    meaning:
      "`scripts/web-smoke.sh` failed after the PR merged — the spec-0020 gate for apps/web changes caught a regression.",
    steps: [
      "Reproduce locally: `bash scripts/web-smoke.sh` against the running dev server.",
      "Fix the regression it flags, commit, push.",
      "Re-run web-smoke green, then re-attach: `node scripts/supervise.mjs <specId> --no-start --events`.",
    ],
    recoverHint: false,
  },
  31: {
    title: "Gate-2 mechanical review failed",
    meaning:
      "The mechanical pre-review (ui_only fence, determinism grep, read-only-inventory, mutation checks) failed before a human would have merged.",
    steps: [
      "Read the full report: `.preflight/supervise-<specId>.review`.",
      "Fix the flagged issue (e.g. an out-of-scope diff path, a workflow.ts determinism violation).",
      "Push the fix — the watcher re-reviews automatically on its next poll, no manual re-attach needed.",
    ],
    recoverHint: false,
  },
  32: {
    title: "Gate-2 CI is red",
    meaning:
      "GitHub Actions CI on the PR came back failing — the watcher withholds the merge cue until it's green.",
    steps: [
      "Open the PR's Checks tab on GitHub and read the failing job's log.",
      "Fix and push to the PR branch.",
      "Wait for CI to go green; the watcher's merge cue reappears once it polls a success.",
    ],
    recoverHint: false,
  },
  40: {
    title: "Main diverged from origin",
    meaning:
      "Local `main` and `origin/main` have diverged (both ahead and behind) and can't be reconciled by a simple fast-forward or push — needs a human.",
    steps: [
      "Inspect: `git fetch origin && git rev-list --left-right --count origin/main...main`.",
      "Linearize: `git rebase origin/main` (NOT merge, NOT force).",
      "Push: `git push origin main`.",
      "If it can't be linearized cleanly, stop and resolve by hand — never force-push.",
    ],
    recoverHint: false,
  },
  41: {
    title: "Spec file missing",
    meaning:
      "No `specs/<specId>-*.md` file was found, or its frontmatter is invalid — the pipeline would crash mid-run on it.",
    steps: [
      "Confirm the file exists: `ls specs/<specId>-*.md`.",
      "If missing, restore or commit the spec draft first.",
      "If present, check the frontmatter fields the exception message lists as invalid (e.g. a missing `status`).",
    ],
    recoverHint: false,
  },
  50: {
    title: "Unexpected shell-step failure",
    meaning:
      "A shell command the watcher depends on (git commit, `cli start`, the close-out commit, etc.) failed in a way not covered by a more specific code.",
    steps: [
      "Read the exact command and output in the exception message and `.preflight/supervise-<specId>.out`.",
      "Re-run the failing step by hand to see the live error.",
      "Once fixed, re-attach: `node scripts/supervise.mjs <specId> --no-start --events`.",
    ],
    recoverHint: false,
  },
};

const FALLBACK: Omit<WatcherExceptionGuidance, "code"> = {
  title: "Unknown exit code",
  meaning:
    "This exit code isn't in the documented supervise.mjs taxonomy — treat it as a genuine unknown rather than guessing.",
  steps: [
    "Read the verbatim exception message and check `.preflight/supervise-<specId>.out` for full context.",
    "Check `docs/SUPERVISOR.md`'s exit-code table in case the taxonomy has since been extended.",
    "Ask the supervisor to diagnose from the raw message and artifacts.",
  ],
  recoverHint: false,
};

export function describeWatcherExitCode(code: number): WatcherExceptionGuidance {
  const entry = PLAYBOOK[code] ?? FALLBACK;
  return { code, ...entry };
}
