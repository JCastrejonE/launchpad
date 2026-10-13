/**
 * Run-follow lib for supervisor-in-UI phase 3 (spec 0052 / ADR-022 §6, item
 * D) — the pure + thin-IO core behind `/api/supervisor/run/[specId]`,
 * mirroring `supervisor-console.ts`'s discipline (pure logic here, injectable
 * deps for tests, framework-free so it compiles under `tsconfig.test.json` and
 * runs under `node --test`).
 *
 * Every watcher spawned from here is a FOLLOW watcher —
 * `scripts/supervise.mjs <id> --no-start --events` — attached to a run this
 * process started itself through `startPipeline` (spec 0131 A; before it, the
 * Start button dropped `--no-start` and let the script start the run, which is
 * how runs ended up on the wrong repository). The spawn is a HUMAN button
 * click, never automatic on an agent's marker. The watcher is DETACHED
 * (`stdio:"ignore"`) so it outlives the browser; following reads Temporal + the
 * events FILE, never a pipe (ADR-023).
 *
 * Purity boundaries this module must hold (proven by supervisor-run.test.ts):
 *  - `buildWatcherSpawnArgs` is pure and yields EXACTLY
 *    `[script, specId, "--no-start", "--events"]` — provably never `start`, a
 *    gate signal, or anything else;
 *  - `parseWatcherProcesses` / `isWatcherRunning` are pure ps-parse helpers
 *    (the same line shape `--recover`'s discovery parses; `--recover` excluded);
 *  - `deriveRunSteps` is a pure stepper derivation from `PIPELINE_PHASES`;
 *  - `getRunFollowState` never throws (degraded/null fields on any failure);
 *  - `spawnWatcher` refuses (typed reason) on a bad id, a not-RUNNING
 *    workflow, or an already-running watcher — never two watchers per run.
 */
import { execSync } from "node:child_process";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isTerminalPhase,
  PIPELINE_PHASES,
  parseWatcherEvents,
  watcherEventsPath,
  type PipelinePhase,
  type WatcherEvent,
} from "@launchpad/pipeline";
import {
  describePipeline as describePipelineIO,
  getPipelineViewStateSafe as getPipelineViewStateSafeIO,
  startPipeline as startPipelineIO,
  type PipelineViewState,
} from "./pipeline";
import type { SupervisorAccessResult } from "./supervisor-console";

/** Repo root of the launchpad checkout the watcher is spawned in / read from —
 * the same env var `startPipeline` reads. */
export const LAUNCHPAD_REPO_ROOT = process.env["LAUNCHPAD_REPO_ROOT"] ?? "";

/** A spec id is exactly four digits (`workflowIdFor` → `spec-NNNN`). */
export const SPEC_ID_RE = /^\d{4}$/;

/** How many trailing events the follow route returns (the tail; the file is
 * append-only). Bounded so a long run's file never floods the response. */
export const EVENTS_TAIL_LIMIT = 50;

/** One step of the run-follow stepper — a pipeline phase and where the run is
 * relative to it. */
export interface RunStep {
  phase: PipelinePhase;
  status: "done" | "current" | "upcoming";
}

/** A discovered supervise.mjs FOLLOW watcher process (from `ps`) — the pid and
 * the spec id it is attached to. Mirrors recover.ts's `WatcherProcess`. */
export interface WatcherProcess {
  pid: number;
  specId: string;
}

/** The full run-follow state the GET route returns as JSON. Everything durable
 * (phase/gate/plan/pr/currentActivities) comes from Temporal via `view`; the
 * watcher's judgment moments come from `events`; `watcher` is ps discovery. */
export interface RunFollowState {
  specId: string;
  /** Pipeline view state (phase, gate, plan progress, PR ref, current
   * activities) — null when Temporal is unreachable (degraded, never throws). */
  view: PipelineViewState | null;
  /** The stepper derived from `view`'s phase (empty when phase is unknown). */
  steps: RunStep[];
  /** Watcher liveness from ps discovery. */
  watcher: { running: boolean; pid?: number };
  /** Tail of the parsed events file (last {@link EVENTS_TAIL_LIMIT}). */
  events: WatcherEvent[];
  /**
   * spec 0057 (phase 4b) §5 — ADDITIVE. True iff a `--recover` process is
   * running for this checkout (ps discovery via {@link hasRecoverProcess} over
   * a new `listRecoverProcesses` dep). Degrades to `false` on any failure,
   * never throws. The card uses it to show a "Recovering…" pill and to
   * suppress both remediation offers mid-recovery. Existing consumers ignore
   * it (additive). FOUNDATION: increment A wires the real ps-derivation; the
   * stub default below is `false`.
   */
  recovering: boolean;
}

/** Typed spawn outcome — ok with the new pid, or a refusal with a
 * human-readable reason (never leaks a secret). */
export type SpawnWatcherResult = { ok: true; pid?: number } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Pure helpers (item D implements the bodies; foundation stubs below compile
// and give supervisor-run.test.ts its exact landing points).
// ---------------------------------------------------------------------------

/**
 * The EXACT argv for the follow-only watcher spawn — pure and unit-tested to
 * yield exactly `["scripts/supervise.mjs", specId, "--no-start", "--events"]`
 * (never `start`, never a gate signal, nothing else). Passed to `spawn` as an
 * argv array (no shell).
 */
export function buildWatcherSpawnArgs(specId: string): string[] {
  return ["scripts/supervise.mjs", specId, "--no-start", "--events"];
}

/**
 * Parse `ps` output into FOLLOW watcher processes — the EXACT line shape
 * `--recover`'s own discovery parses in `supervise.mjs` (`ps aux | grep
 * "scripts/supervise.mjs" | grep -v grep | grep -v -- "--recover"`):
 * whitespace-split columns, pid is column index 1 (`ps aux`'s PID column),
 * and the spec id is the first 2-6 digit argv token after `supervise.mjs`.
 * EXCLUDES `--recover` invocations so a recovery run never double-counts as a
 * FOLLOW watcher (the caller's `listWatcherProcesses` already greps them out,
 * same as `--recover`'s own discovery; this parser tolerates them showing up
 * anyway by requiring the `supervise.mjs <digits>` shape, which `--recover`
 * invocations never match). Pure — malformed/unparseable lines are skipped.
 */
export function parseWatcherProcesses(psOutput: string): WatcherProcess[] {
  const processes: WatcherProcess[] = [];
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    const pid = Number(cols[1]);
    const m = line.match(/supervise\.mjs\s+(\d{2,6})\b/);
    if (!m) continue;
    if (line.includes("--recover")) continue;
    if (!Number.isFinite(pid) || pid <= 0) continue;
    processes.push({ pid, specId: m[1] as string });
  }
  return processes;
}

/** True iff a live watcher for `specId` is present in `processes`. Pure. */
export function isWatcherRunning(processes: WatcherProcess[], specId: string): boolean {
  return processes.some((p) => p.specId === specId);
}

/**
 * Derive the run-follow stepper from a phase. `PIPELINE_PHASES` ends with
 * four mutually-EXCLUSIVE terminal outcomes (`promoted`,
 * `promoted_teardown_failed`, `rejected`, `failed`) — a plain "everything
 * before my index is done" walk over the raw array would wrongly mark
 * whichever terminal outcomes precede the current one (array order, not
 * causal order) as `done`. So the stepper walks the NON-terminal phases only
 * (`drafting` .. `tearing_down`) for done/current/upcoming, and — this is the
 * "terminal phases collapse the remainder" rule — when the current phase IS
 * terminal, every non-terminal phase is `done` and exactly ONE extra step is
 * appended for the actual terminal phase reached, `current`, with nothing
 * `upcoming` after it (the other three alternate outcomes never happened, so
 * they never appear). `phase` undefined (no live phase yet) ⇒ `[]`, the
 * empty stepper. Pure.
 */
export function deriveRunSteps(phase: PipelinePhase | undefined): RunStep[] {
  if (phase === undefined) return [];
  const nonTerminal = PIPELINE_PHASES.filter((p) => !isTerminalPhase(p));
  if (isTerminalPhase(phase)) {
    return [
      ...nonTerminal.map((p): RunStep => ({ phase: p, status: "done" })),
      { phase, status: "current" },
    ];
  }
  const index = nonTerminal.indexOf(phase);
  return nonTerminal.map((p, i): RunStep => ({
    phase: p,
    status: i < index ? "done" : i === index ? "current" : "upcoming",
  }));
}

// ---------------------------------------------------------------------------
// Thin-IO composition (injectable deps; defaults do the real ps / fs / spawn).
// ---------------------------------------------------------------------------

/** Injectable IO seam for {@link getRunFollowState} — real functions by
 * default, fakes in tests (so degraded modes are provable without a live
 * Temporal server / real filesystem). */
export interface GetRunFollowStateDeps {
  getPipelineViewStateSafe: typeof getPipelineViewStateSafeIO;
  /** Raw `ps` output listing supervise.mjs processes (thin IO). */
  listWatcherProcesses: () => string;
  /** Raw text of the events file for a spec (thin IO; "" when absent). */
  readEventsFile: (specId: string) => string;
  /**
   * spec 0057 (phase 4b) §5 — raw `ps` output listing `--recover` processes
   * (thin IO; the opposite grep of {@link listWatcherProcesses}, which
   * excludes them). Feeds the `recovering` field via {@link hasRecoverProcess}.
   */
  listRecoverProcesses: () => string;
}

/** Default `ps` discovery — lists supervise.mjs processes, excluding
 * `--recover` invocations (mirrors the script's own discovery grep). */
function defaultListWatcherProcesses(): string {
  try {
    return execSync(
      'ps aux | grep "scripts/supervise.mjs" | grep -v grep | grep -v -- "--recover"',
      { stdio: ["ignore", "pipe", "ignore"] },
    ).toString();
  } catch {
    return "";
  }
}

/** Default events-file read — tolerant ("" when the file doesn't exist yet). */
function defaultReadEventsFile(specId: string): string {
  try {
    return readFileSync(watcherEventsPath(LAUNCHPAD_REPO_ROOT, specId), "utf8");
  } catch {
    return "";
  }
}

export const defaultGetRunFollowStateDeps: GetRunFollowStateDeps = {
  getPipelineViewStateSafe: getPipelineViewStateSafeIO,
  listWatcherProcesses: defaultListWatcherProcesses,
  readEventsFile: defaultReadEventsFile,
  listRecoverProcesses: defaultListRecoverProcesses,
};

/**
 * Compose the durable pipeline view (Temporal) + ps watcher discovery + the
 * parsed events-file tail into a {@link RunFollowState}. NEVER throws — any
 * failure degrades to null/empty fields: `getPipelineViewStateSafe` already
 * never throws (Temporal down ⇒ `view: null`, so `steps` derives from
 * `undefined` ⇒ `[]`); ps discovery and the events-file read are each wrapped
 * so a fake/broken dep degrades its own field rather than the whole response.
 * `specStatus` is irrelevant here (mirrors `resolvePromoteSignalGuard`'s own
 * `""` — the follow view only reads the workflow's live phase/pr/etc., never
 * the frontmatter-status fallback).
 */
export async function getRunFollowState(
  specId: string,
  /**
   * Which project's spec this is (spec 0224). REQUIRED, not optional: every
   * project numbers its specs from 0001, so an unscoped `0001` resolves to the
   * platform's `0001-launchpad-foundations.md` and follows the wrong workflow.
   * An optional parameter here would be silent at exactly the call site that
   * forgot it — the shape four defects in two days already had
   * (`docs/VERIFICATION.md` #12). `""` means the platform console, which has no
   * project and is the one correct unscoped case.
   */
  projectSlug: string,
  deps: GetRunFollowStateDeps = defaultGetRunFollowStateDeps,
): Promise<RunFollowState> {
  const view = await deps.getPipelineViewStateSafe(specId, projectSlug);
  const steps = deriveRunSteps(view?.phase);

  let watcher: RunFollowState["watcher"] = { running: false };
  try {
    const processes = parseWatcherProcesses(deps.listWatcherProcesses());
    const mine = processes.find((p) => p.specId === specId);
    watcher = mine ? { running: true, pid: mine.pid } : { running: false };
  } catch {
    // Degraded: ps discovery failed — report not-running rather than throw.
  }

  let events: WatcherEvent[] = [];
  try {
    events = parseWatcherEvents(deps.readEventsFile(specId)).slice(-EVENTS_TAIL_LIMIT);
  } catch {
    // Degraded: events file unreadable/unparseable — empty tail rather than throw.
  }

  // spec 0057 (phase 4b) §5 — degraded to `false` on any ps failure, never
  // throws (same discipline as the `watcher`/`events` derivations above).
  let recovering = false;
  try {
    recovering = hasRecoverProcess(deps.listRecoverProcesses());
  } catch {
    // Degraded: ps discovery failed — report not-recovering rather than throw.
  }

  return { specId, view, steps, watcher, events, recovering };
}

/** Injectable IO seam for {@link spawnWatcher}. */
export interface SpawnWatcherDeps {
  describePipeline: typeof describePipelineIO;
  listWatcherProcesses: () => string;
  /** Detached spawn of `node <args>` in `cwd`; returns the child pid. */
  spawnWatcherProcess: (args: string[], cwd: string) => number | undefined;
}

/** Default detached spawn — `spawn("node", args, { detached, stdio:"ignore" })`
 * then `unref()`, exactly like `--recover`'s re-attach, so the watcher outlives
 * the request/browser. */
function defaultSpawnWatcherProcess(args: string[], cwd: string): number | undefined {
  const child = spawn("node", args, { cwd, detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

export const defaultSpawnWatcherDeps: SpawnWatcherDeps = {
  describePipeline: describePipelineIO,
  listWatcherProcesses: defaultListWatcherProcesses,
  spawnWatcherProcess: defaultSpawnWatcherProcess,
};

/**
 * Shared "attach to a RUNNING run" ladder behind both {@link spawnWatcher} and
 * (spec 0057 phase 4b) {@link spawnPolishedWatcher} — they differ ONLY in the
 * argv builder. Refuses (typed reason, never throws) on: a malformed id (not
 * {@link SPEC_ID_RE}), an already-running watcher for the spec (ps discovery —
 * never two watchers per run, the same rule as `planWatcherRecovery`), or a
 * workflow that isn't RUNNING. On success detaches `buildArgs(specId)` with
 * `cwd: LAUNCHPAD_REPO_ROOT`.
 */
async function spawnAttachedWatcher(
  specId: string,
  deps: SpawnWatcherDeps,
  buildArgs: (specId: string) => string[],
): Promise<SpawnWatcherResult> {
  if (!SPEC_ID_RE.test(specId)) {
    return { ok: false, reason: `invalid spec id "${specId}" (must be exactly 4 digits)` };
  }

  const processes = parseWatcherProcesses(deps.listWatcherProcesses());
  if (isWatcherRunning(processes, specId)) {
    return { ok: false, reason: `spec ${specId}: a watcher is already following this run` };
  }

  let description;
  try {
    description = await deps.describePipeline(specId);
  } catch {
    return { ok: false, reason: `spec ${specId}: could not reach Temporal to check workflow status` };
  }
  if (!description.exists) {
    return { ok: false, reason: `spec ${specId}: no workflow has been started for this spec` };
  }
  if (description.status !== "RUNNING") {
    return { ok: false, reason: `spec ${specId}: workflow is not RUNNING (status: ${description.status})` };
  }

  const pid = deps.spawnWatcherProcess(buildArgs(specId), LAUNCHPAD_REPO_ROOT);
  return { ok: true, pid };
}

/**
 * Spawn the follow-only watcher for `specId` — see
 * {@link spawnAttachedWatcher} for the shared refusal ladder. The route
 * inherits the dev-local server env (so a present `GITHUB_TOKEN` feeds the
 * watcher's gate-2 CI check). NEVER throws: a `describePipeline` failure
 * (Temporal unreachable) surfaces as a typed refusal rather than an exception,
 * same never-throws discipline as {@link getRunFollowState}.
 */
export async function spawnWatcher(
  specId: string,
  deps: SpawnWatcherDeps = defaultSpawnWatcherDeps,
): Promise<SpawnWatcherResult> {
  return spawnAttachedWatcher(specId, deps, buildWatcherSpawnArgs);
}

// ===========================================================================
// spec 0056 — phase 4c: the guarded WATCHED-START mechanism.
//
// SPEC 0131 A REPLACED THE MECHANISM. Start mode used to be the same detached
// watcher spawn as follow, differing only in argv: dropping `--no-start` made
// `supervise.mjs` start the run itself, via `cli start` — which hardcodes
// `LAUNCHPAD_REPO_ROOT` as the run's checkout and knows nothing about projects.
// So the UI's Start button reached the workflow through a shell script invoking
// a CLI in another package, and every run worked on the launchpad's own
// repository. The live A/B test failed that way twice (spec 0129 D).
//
// Now the START is this module's own project-aware `startPipeline` call and the
// watcher only ATTACHES (`--no-start`, the follow argv). One resolver, one place
// that decides a run's target, and the watcher is a watcher again.
// ===========================================================================

/**
 * INCREMENT A. Pure parse of the run route's OPTIONAL POST body
 * `{mode?: "follow" | "start"}` (raw request text, so the route stays a thin
 * IO shell around this decision): empty/unparseable JSON, `null`,
 * non-object, or an absent `mode` field all default to `"follow"` (the
 * phase-3 byte-compat default — an old client that never sends a body still
 * gets follow behavior); `"follow"`/`"start"`/`"recover"`/`"resume-polished"`
 * pass through; anything else (an unknown mode value) is `"invalid"` (the
 * route maps this to 400).
 *
 * spec 0057 (phase 4b) increment A: widened the return union to
 * `"follow" | "start" | "recover" | "resume-polished" | "invalid"` — the
 * absent/unparseable default stays `"follow"` (byte-compat; existing tests
 * pass unmodified) and unknown values stay `"invalid"`. Widened together with
 * the route's dispatch (§4) so a new mode never falls through to the wrong
 * spawn.
 */
export function parseWatcherMode(
  rawBody: string,
): "follow" | "start" | "recover" | "resume-polished" | "invalid" {
  if (!rawBody) return "follow";
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return "follow";
  }
  if (body === null || typeof body !== "object") return "follow";
  const mode = (body as { mode?: unknown }).mode;
  if (mode === undefined) return "follow";
  if (mode === "follow" || mode === "start" || mode === "recover" || mode === "resume-polished") return mode;
  return "invalid";
}

/** Injectable IO seam for {@link spawnStartWatcher} — superset of
 * {@link SpawnWatcherDeps} with a `specFileExists` check (start refuses when no
 * `specs/<id>-*.md` exists on disk: 4c starts runs for specs that already
 * exist, it never drafts) and, since spec 0131 A, the `startPipeline` that
 * actually starts the run. */
export interface SpawnStartWatcherDeps extends SpawnWatcherDeps {
  /** True iff a spec file `specs/<specId>-*.md` exists on disk. */
  specFileExists: (specId: string) => boolean;
  /** Spec 0131 A: the project-aware starter — the ONLY way a run begins now. */
  startPipeline: typeof startPipelineIO;
}

/** Default `specFileExists` — real `fs` scan of `specs/` under
 * {@link LAUNCHPAD_REPO_ROOT} for a `<specId>-*.md` entry. Tolerant (false when
 * the dir is unreadable). */
function defaultSpecFileExists(specId: string): boolean {
  try {
    const prefix = `${specId}-`;
    return readdirSync(join(LAUNCHPAD_REPO_ROOT, "specs")).some(
      (name) => name.startsWith(prefix) && name.endsWith(".md"),
    );
  } catch {
    return false;
  }
}

export const defaultSpawnStartWatcherDeps: SpawnStartWatcherDeps = {
  describePipeline: describePipelineIO,
  listWatcherProcesses: defaultListWatcherProcesses,
  spawnWatcherProcess: defaultSpawnWatcherProcess,
  specFileExists: defaultSpecFileExists,
  startPipeline: startPipelineIO,
};

/**
 * Start the run for `specId` and attach a watcher to it, after refusing
 * (typed reason, never throws) on:
 *  - a malformed id (not {@link SPEC_ID_RE});
 *  - no spec file `specs/<id>-*.md` on disk (`specFileExists`);
 *  - a live watcher for the spec (never two watchers per run);
 *  - a RUNNING workflow ("already started — use Follow") or COMPLETED
 *    ("already completed"). NOT_FOUND and closed-unsuccessful statuses
 *    (FAILED/TERMINATED/CANCELED/TIMED_OUT) PROCEED — Temporal allows the
 *    `spec-NNNN` id to be reused once the prior run is closed. Temporal
 *    unreachable ⇒ typed refusal, same as {@link spawnWatcher}.
 *
 * Spec 0131 A: the START happens HERE, through the project-aware
 * `startPipeline` — the run's checkout comes from the spec's project. The
 * watcher is then spawned with the FOLLOW argv
 * ({@link buildWatcherSpawnArgs}: `--no-start`), so it observes a run it did
 * not create. `startPipeline` runs BEFORE the spawn deliberately: a failed
 * start must leave no orphan watcher, while a failed spawn leaves a real run
 * going unwatched — recoverable with the Follow button.
 *
 * `request`/`requestedBy` are the caller's, not a shell script's default:
 * `supervise.mjs` synthesised both, and `cli start` defaults `requestedBy` to a
 * hardcoded address, so nothing a run recorded about who asked for it was true.
 */
export async function spawnStartWatcher(
  specId: string,
  request: string,
  requestedBy: string,
  deps: SpawnStartWatcherDeps = defaultSpawnStartWatcherDeps,
  /** Spec 0133: a branch run — forwarded verbatim to `startPipeline`, whose
   * refusal ladder is the ONE validation point (routes never re-validate). */
  /** Spec 0142: `projectSlug` scopes the spec lookup — ids repeat across
   * projects. */
  opts: { branch?: string; projectSlug?: string } = {},
): Promise<SpawnWatcherResult> {
  // Spec 0117: these two checks moved out to `checkStartPreconditions` so the
  // BARE start path gets them too — they were never watcher-specific, they were
  // just written here because the watched path was the only path an authorized
  // user could take.
  const pre = checkStartPreconditions(specId, deps.specFileExists);
  if (!pre.ok) return pre;

  const processes = parseWatcherProcesses(deps.listWatcherProcesses());
  if (isWatcherRunning(processes, specId)) {
    return { ok: false, reason: `spec ${specId}: a watcher is already following this run` };
  }

  let description;
  try {
    description = await deps.describePipeline(specId);
  } catch {
    return { ok: false, reason: `spec ${specId}: could not reach Temporal to check workflow status` };
  }
  if (description.exists) {
    if (description.status === "RUNNING") {
      return { ok: false, reason: `spec ${specId}: already started — use Follow` };
    }
    if (description.status === "COMPLETED") {
      return { ok: false, reason: `spec ${specId}: already completed` };
    }
    // FAILED/TERMINATED/CANCELED/TIMED_OUT (closed-unsuccessful) proceed — the
    // `spec-NNNN` workflow id is reusable once the prior run is closed.
  }
  // NOT_FOUND (description.exists === false) also proceeds.

  try {
    await deps.startPipeline(specId, request, requestedBy, opts);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const pid = deps.spawnWatcherProcess(buildWatcherSpawnArgs(specId), LAUNCHPAD_REPO_ROOT);
  return { ok: true, pid };
}

/**
 * Preconditions that hold for ANY pipeline start, watched or bare (spec 0117).
 *
 * ## The defect this closes
 *
 * Both checks used to live inside `spawnStartWatcher`, i.e. only on the WATCHED
 * branch. That was invisible for as long as the watched branch was the only one
 * an authorized user could take — `resolveStartMode` picks it exactly when
 * `supervisorAccess()` passes, which was OWNER + flag, and OWNER was also the
 * only role allowed to start anything.
 *
 * Spec 0117 lets a MEMBER start a run, and a MEMBER never passes
 * `supervisorAccess()` (the console stays OWNER-only, deliberately). So every
 * MEMBER start took the bare branch — the unvalidated one. Observed live:
 * the same POST for a nonexistent spec `9999` was refused for an OWNER ("no
 * spec file … found on disk") and **started a real, garbage Temporal workflow**
 * for a MEMBER.
 *
 * The `flag off` case had the same hole for an OWNER all along; it is fixed
 * here too, by moving the checks to where they belong rather than copying them.
 *
 * Deliberately NOT moved: the duplicate-watcher check (genuinely
 * watcher-specific) and the `describePipeline` status check (a Temporal round
 * trip whose RUNNING case Temporal itself already refuses via workflow-id
 * reuse). Only the two cheap, local, universally-true checks move.
 */
export function checkStartPreconditions(
  specId: string,
  specFileExists: (specId: string) => boolean,
): { ok: true } | { ok: false; reason: string } {
  if (!SPEC_ID_RE.test(specId)) {
    return { ok: false, reason: `invalid spec id "${specId}" (must be exactly 4 digits)` };
  }
  if (!specFileExists(specId)) {
    return { ok: false, reason: `spec ${specId}: no spec file (specs/${specId}-*.md) found on disk` };
  }
  return { ok: true };
}

/**
 * INCREMENT B. Which start path a caller takes given the supervisor access
 * guard result — the pure branch-decider shared by the run route's
 * `{mode:"start"}` and the spec-page `startPipelineAction`:
 *  - `access.ok` (gate ON — flag + OWNER session, spec 0074) ⇒ `"watched"`
 *    (→ shared {@link spawnStartWatcher}, the guarded host spawn);
 *  - otherwise (gate OFF — flag unset OR no OWNER session) ⇒ `"bare"` (→ the
 *    pre-existing bare `startPipeline`, NO host spawn — byte-identical to
 *    today). Pure so it lives outside the `"use server"` `actions.ts`.
 */
export type StartMode = "watched" | "bare";
export function resolveStartMode(access: SupervisorAccessResult): StartMode {
  return access.ok ? "watched" : "bare";
}

/** Typed outcome of {@link runStartPipelineAction} — a redirect-worthy reason
 * on failure, never a thrown error (the action needs a message for its
 * `?error=` redirect, not an exception into Next's generic error page). */
export type StartPipelineActionResult = { ok: true } | { ok: false; reason: string };

/** Injectable IO seam for {@link runStartPipelineAction} — kept here (not in
 * `actions.ts`) for the SAME reason {@link resolveStartMode} is: a `"use
 * server"` file may only export async server actions, so the branch dispatch
 * itself — not just the decision — has to live in this lib to be
 * unit-testable (mirrors the lib-holds-the-logic / action-is-a-thin-wrapper
 * split `actions.ts`'s doc comment already describes for `lib/pipeline.ts`). */
export interface StartPipelineActionDeps {
  spawnStartWatcher: typeof spawnStartWatcher;
  startPipeline: typeof startPipelineIO;
  /** Spec 0117: the bare branch needs this too — see `checkStartPreconditions`. */
  specFileExists: (specId: string) => boolean;
}

export const defaultStartPipelineActionDeps: StartPipelineActionDeps = {
  spawnStartWatcher,
  startPipeline: startPipelineIO,
  specFileExists: defaultSpecFileExists,
};

/**
 * INCREMENT B. The gate-aware dispatch behind the spec-page Start button
 * (How-it-works §6): `resolveStartMode(access)` picks the path —
 * `"watched"` calls the SHARED {@link spawnStartWatcher}, `"bare"` calls
 * `startPipeline` directly. `access` is the caller's already-resolved
 * `supervisorAccess()` result (flag + OWNER session, spec 0074) — this
 * function does no session derivation of its own, so the route and the
 * server action share one dispatch.
 *
 * Since spec 0131 A the two branches differ ONLY in whether a watcher is
 * attached: both start the run through the same project-aware `startPipeline`.
 * They used to differ in the starter itself — the watched branch started via a
 * detached shell script, which is how an OWNER's run and a MEMBER's run of the
 * same spec ended up targeting DIFFERENT repositories.
 */
export async function runStartPipelineAction(
  specId: string,
  request: string,
  requestedBy: string,
  access: SupervisorAccessResult,
  deps: StartPipelineActionDeps = defaultStartPipelineActionDeps,
  /** Spec 0142: the project this spec belongs to. Forwarded to
   * `startPipeline`, whose refusal ladder is the one validation point. */
  opts: { projectSlug?: string } = {},
): Promise<StartPipelineActionResult> {
  if (resolveStartMode(access) === "watched") {
    const result = await deps.spawnStartWatcher(specId, request, requestedBy, undefined, opts);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }
  // Spec 0117: the bare branch validates too. `spawnStartWatcher` runs the same
  // check on its own branch — this is not a duplicate of the check, it is the
  // same function called from the second path that needed it all along.
  const pre = checkStartPreconditions(specId, deps.specFileExists);
  if (!pre.ok) return pre;
  try {
    await deps.startPipeline(specId, request, requestedBy, opts);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ===========================================================================
// spec 0057 — phase 4b: console-invoked deterministic remediations.
//
// Increment A: the pure args + spawn functions below (the exact behavior is
// in the spec's "How it works" §1-§5). Both remediations REUSE the phase-3/4c
// mechanism verbatim — a guarded `{mode}` POST on the existing route, a
// sibling of `spawnWatcher`/`spawnStartWatcher` here, and a sole-call-site
// button click — never a new spawn path. They differ ONLY in argv:
//
//  - Recover          -> `["scripts/supervise.mjs", "--recover", specId, "--events"]`
//                        (ADR-023 reconnect; `--recover` PRECEDES the id so a
//                        running recovery never matches the follow-watcher
//                        shape `supervise.mjs <digits>` — see
//                        `parseWatcherProcesses`' exclusion, which holds by
//                        construction).
//  - Resume (polished) -> `["scripts/supervise.mjs", specId, "--polished", "--no-start", "--events"]`
//                        (the documented terminal relaunch + the console's
//                        events channel).
//
// Every prior invariant holds: human-click only (rendering an offer sends
// NOTHING), same fail-closed guard + no new route, no gate-signal capability,
// no `workflow.ts`/`packages/*` change (increment B's additive propagate-only
// `--events` in supervise.mjs is the ONLY script touch).
// ===========================================================================

/**
 * INCREMENT A. The EXACT argv for the Recover spawn — pure, to be unit-tested
 * to yield EXACTLY `["scripts/supervise.mjs", "--recover", specId, "--events"]`
 * and NOTHING else: no gate verb (`approve-spec`/`approve-pr`/`promote`), no
 * `--report-only` (recovery ACTS by default — ADR-023 posture), no `--no-push`,
 * no `--request`, no `--no-start`. `--recover` precedes the id (see §1) so the
 * ps line never matches the follow-watcher shape. Passed to `spawn` as an argv
 * array (no shell). Sibling of {@link buildWatcherSpawnArgs}.
 */
export function buildRecoverSpawnArgs(specId: string): string[] {
  return ["scripts/supervise.mjs", "--recover", specId, "--events"];
}

/**
 * INCREMENT A. The EXACT argv for the Resume (polished) relaunch — pure, to be
 * unit-tested to yield EXACTLY
 * `["scripts/supervise.mjs", specId, "--polished", "--no-start", "--events"]`:
 * the documented terminal relaunch plus the console's events channel. NO gate
 * verb, NO `--recover`, NO `--request`; `--no-start` PRESENT (a relaunch never
 * starts a run). Passed to `spawn` as an argv array (no shell).
 */
export function buildPolishedSpawnArgs(specId: string): string[] {
  return ["scripts/supervise.mjs", specId, "--polished", "--no-start", "--events"];
}

/**
 * INCREMENT A. Pure parse of `ps` output for a live `--recover` process — true
 * iff at least one `scripts/supervise.mjs … --recover …` line is present. Used
 * by {@link spawnRecover} (the never-two-concurrent-recoveries + double-click
 * guard) and by `getRunFollowState`'s `recovering` derivation (§5). Pure;
 * malformed lines are simply not matched.
 */
export function hasRecoverProcess(psOutput: string): boolean {
  return psOutput.split("\n").some((line) => /supervise\.mjs/.test(line) && line.includes("--recover"));
}

/** INCREMENT A. Default `ps` discovery for `--recover` processes — mirrors the
 * script's own discovery grep, but KEEPS `--recover` lines (the opposite of
 * {@link defaultListWatcherProcesses}, which excludes them). Tolerant ("" on
 * failure). */
function defaultListRecoverProcesses(): string {
  try {
    return execSync(
      'ps aux | grep "scripts/supervise.mjs" | grep -v grep | grep -- "--recover"',
      { stdio: ["ignore", "pipe", "ignore"] },
    ).toString();
  } catch {
    return "";
  }
}

/** INCREMENT A. Injectable IO seam for {@link spawnRecover}. Deliberately has
 * NO `describePipeline` (§2: recover exists to FIX an unreachable Temporal, so
 * it must not require Temporal to authorize the spawn). `listRecoverProcesses`
 * is the new dep (the recover-in-progress refusal + double-click guard). */
export interface SpawnRecoverDeps {
  listRecoverProcesses: () => string;
  spawnWatcherProcess: (args: string[], cwd: string) => number | undefined;
}

export const defaultSpawnRecoverDeps: SpawnRecoverDeps = {
  listRecoverProcesses: defaultListRecoverProcesses,
  spawnWatcherProcess: defaultSpawnWatcherProcess,
};

/**
 * INCREMENT A (§2). Spawn the scoped Recover remediation for `specId`, refusing
 * (typed `{ok:false,reason}`, never throws) on: a malformed id (not
 * {@link SPEC_ID_RE}); a `--recover` process already running
 * (`listRecoverProcesses` + {@link hasRecoverProcess} — never two concurrent
 * recoveries; also the double-click guard). It does NOT call `describePipeline`
 * first (Temporal being unreachable is a state `--recover` FIXES) and does NOT
 * refuse on a live follow watcher (converging watchers is the script's own
 * idempotent job; the UI simply never OFFERS Recover while a watcher runs). On
 * success detaches {@link buildRecoverSpawnArgs}(specId) with
 * `cwd: LAUNCHPAD_REPO_ROOT`.
 */
export async function spawnRecover(
  specId: string,
  deps: SpawnRecoverDeps = defaultSpawnRecoverDeps,
): Promise<SpawnWatcherResult> {
  if (!SPEC_ID_RE.test(specId)) {
    return { ok: false, reason: `invalid spec id "${specId}" (must be exactly 4 digits)` };
  }
  if (hasRecoverProcess(deps.listRecoverProcesses())) {
    return { ok: false, reason: `spec ${specId}: a recovery is already in progress` };
  }
  const pid = deps.spawnWatcherProcess(buildRecoverSpawnArgs(specId), LAUNCHPAD_REPO_ROOT);
  return { ok: true, pid };
}

/**
 * INCREMENT A (§3). Spawn the Resume (polished) relaunch for `specId` — the
 * {@link spawnWatcher} ladder with new argv: refuse (typed, never throws) on a
 * malformed id, a live watcher (never two watchers per run), Temporal
 * unreachable, or a workflow that is missing / not RUNNING (a polish-paused run
 * IS still RUNNING, parked at `awaiting_promotion`). On success detaches
 * {@link buildPolishedSpawnArgs}(specId) with `cwd: LAUNCHPAD_REPO_ROOT`.
 * Reuses {@link SpawnWatcherDeps} (same "attach to a RUNNING run" shape as
 * `spawnWatcher`); the implementation MAY share `spawnWatcher`'s body via a
 * private argv parameter, but the public export stays distinct + distinctly
 * tested.
 */
export async function spawnPolishedWatcher(
  specId: string,
  deps: SpawnWatcherDeps = defaultSpawnWatcherDeps,
): Promise<SpawnWatcherResult> {
  return spawnAttachedWatcher(specId, deps, buildPolishedSpawnArgs);
}
