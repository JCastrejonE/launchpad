#!/usr/bin/env node
/**
 * supervise.mjs — SUPERVISOR ORCHESTRATOR (supervisor tooling; NOT pipeline/
 * product code; freely improvable, like gate-watch.mjs).
 *
 * Drives ONE `specPipeline` run end-to-end, automating every DETERMINISTIC
 * between-gate step the supervisor used to run by hand, so a run needs the
 * human only at the three gates (in apps/web) and needs the agent only when
 * something falls outside the script. Encodes the sequence proven across specs
 * 0031/0032/0033 this session (see the memory
 * "supervisor-actions-should-be-scripted").
 *
 * HARD RULE (never violated): this script NEVER clicks or signals a gate.
 * Gate 1 (approve spec), gate 2 (merge PR), gate 3 (promote) are human clicks
 * in apps/web. The script cues them (logs) and waits; it does not advance them.
 *
 * What it automates:
 *   - pre-run: commit an uncommitted spec draft, sync `main` with origin
 *     (fast-forward pull, or push local-ahead status/doc commits), worker-up.
 *   - start the run (`cli start` / `cli start-tenant`) if not already started.
 *     DEVELOPER PATH ONLY as of spec 0131 A: `cli start` targets
 *     `LAUNCHPAD_REPO_ROOT` and resolves no project, so the UI no longer comes
 *     through here to start anything — it starts the run itself (project-aware
 *     `startPipeline`) and spawns this script with `--no-start` to ATTACH. Runs
 *     for a customer project must never be started from this path.
 *   - watch the coder loop, tripping on the SAME exceptions gate-watch does.
 *   - gate 2: a MECHANICAL pre-review (ui_only diff-path fence, determinism
 *     grep on workflow.ts, read-only-inventory scan, changed-file list, coder
 *     increment count, PR number). If a mechanical safety check FAILS it exits
 *     and flags the agent BEFORE the human would merge; if all pass it logs the
 *     summary + a merge cue and keeps waiting.
 *   - post-merge: web-smoke (if apps/web changed) and a worker-restart note
 *     (if packages/ changed).
 *   - close-out: append a factual Handoff entry, commit, push, and restart the
 *     worker when packages/ changed.
 *
 * How it flags (v1): it runs in the background and STAYS ALIVE through gates
 * (the owner clicks them in the UI, which is itself the cue; the script also logs a
 * cue line). It EXITS only on:
 *   - COMPLETED (promoted) after close-out           → exit 0   (agent notified)
 *   - an EXCEPTION that needs the agent              → exit 10+ (agent notified)
 * A FUTURE spec will let it INVOKE the agent to fix an exception in place
 * rather than exiting (the owner's stated end goal).
 *
 * Usage:
 *   node scripts/supervise.mjs <specId> [--request "..."]
 *        [--tenant <id> --vps-id <n> [--odoo-version 17|18|19]]  # tenant run
 *        [--no-push]     # never push; treat a needed push as an exception
 *        [--no-start]    # attach to an already-started run (don't start it)
 *        [--auto-polish]    # spec 0197: retired — pauses at exit 7 like --manual-polish
 *                           # spawn. OFF by default since 0108: it committed to
 *                           # main + auto-pushed with no review, and collided
 *                           # with a human working in the primary checkout.
 *                           # (`--manual-polish` is now a no-op alias.)
 *                         # (exit 7); nothing is auto-spawned any more.
 *        [--events]      # ADDITIVE, opt-in (spec 0052 item B): append NDJSON
 *                         # judgment-event records to
 *                         # .preflight/supervise-<specId>.events.ndjson
 *                         # (start/cue/review/exception/polish/closeout/done).
 *                         # Absent ⇒ byte-identical behavior (no file, same
 *                         # log lines, same exit codes). Under `--recover`
 *                         # this flag is PROPAGATE-ONLY (spec 0057 item B) —
 *                         # see below.
 *
 *   node scripts/supervise.mjs --recover [specId] [--report-only] [--no-push]
 *        [--events]
 *        # ADR-023 steps 1-4, one invocation, act-then-continue (spec 0051).
 *        # specId OPTIONAL: omitted = every open workflow; given = scope
 *        # watcher kill/reattach to that one. By default RESTARTS infra
 *        # (idempotent `bash scripts/preflight.sh` — never `restart`),
 *        # reconciles `main == origin` via the same ensureMainSynced used
 *        # below (ff-pull --autostash when no open run needs the tree kept
 *        # as-is; push ahead-only honoring --no-push; DIVERGED always halts
 *        # for a human), and converges watchers (kill every supervise.mjs
 *        # process, re-attach exactly one tracked --no-start watcher per
 *        # open workflow). Stray uncommitted dirt is LEFT IN THE TREE and
 *        # reported loudly — never stashed. `--report-only` assesses +
 *        # reports the full would-do plan and changes nothing. Report
 *        # written to `.preflight/recover.out` + stdout. `--events` (spec
 *        # 0057 item B) is PROPAGATE-ONLY: the recover process itself still
 *        # NEVER truncates the events file or emits its own records (guarded
 *        # `EVENTS && !RECOVER` below, so today's "`--recover` never passes
 *        # this" behavior holds even when the flag IS given) — it only makes
 *        # each re-attached watcher's argv gain `--events`, so a console-
 *        # clicked recovery doesn't silence the run's own events channel.
 *        # Without `--events`, `--recover` is byte-identical to before this
 *        # flag existed.
 *
 * Exit codes:
 *   0   run completed (promoted) + closed out
 *   2   usage error
 *   10  NEW TMPRL1100 (nondeterminism)
 *   11  NEW heartbeat timeout
 *   12  NEW gate-2 poll failure
 *   13  worker pid changed mid-run
 *   14  worker died
 *   15  primary checkout left main
 *   16  primary checkout dirty (0017 isolation) — outside the drafting window
 *   17  an activity attempt FAILED (incl. mergePullRequest ff-only, spec 0030)
 *   18  web /api/health down
 *   20  workflow reached a terminal NON-success state (failed/rejected/TERMINATED)
 *   30  web-smoke red after merge (spec 0020 gate)
 *   31  gate-2 mechanical review FAILED (fence breach / determinism / mutation)
 *   32  RETIRED (spec 0058) — was "gate-2 GitHub Actions CI conclusion is RED"
 *       (task #86); GitHub Actions produces zero runs for this account now, so
 *       the poll this fired from could never see a truthful red again. Gate-2
 *       CI is now the pipeline's pre-PR `runCi` (build+typecheck+skip-proof
 *       test on the branch's ephemeral worktree, already green before the PR
 *       opens); the gate-2 cue names that fact instead of polling GitHub. Do
 *       not renumber or reuse 32.
 *   33  packages/* rebuild FAILED before post-merge web-smoke (spec 0055) —
 *       `pnpm --filter='./packages/*' -r build` red, so web-smoke would see
 *       stale dist; fail loudly instead of a confusing web-smoke failure.
 *   34  local CI (typecheck / skip-proof test) RED post-merge (spec 0058) —
 *       `pnpm -r typecheck` or the harness-inclusive `pnpm -r test` failed (or
 *       reported 0 executed cases under TEMPORAL_TEST=1, the same skip-proof
 *       check runCi uses). The promote-CI artifact is written `"failure"`
 *       BEFORE this exit, so gate 3 genuinely blocks rather than reading
 *       absent/pending.
 *   40  `main` diverged from origin and can't be reconciled (needs a human)
 *   41  spec file missing / not resolvable
 *   50  a shell step the script relies on failed unexpectedly
 *
 * `--recover` mode uses only 0 (recovered/all-clear) / 14 (infra still down
 * after the preflight attempt) / 40 (main diverged, or an ff-pull/push
 * failed — the exact `ensureMainSynced` code path/meaning above, reused
 * verbatim). Under `--report-only` the same codes describe what WAS FOUND.
 *
 * Non-error actionable pause:
 *   7   VISUAL spec (apps/web) reached gate 3 (merged, web-smoke green). Spec
 *       0064: by default the watcher auto-spawns the `uiux-coder` in-process
 *       right here instead of pausing — exit 7 now fires ONLY when that
 *       auto-polish itself fails (no credential, stalled/failed session, a
 *       dirty tree left behind, red post-polish re-checks, or a blocked push),
 *       i.e. it's a TRIPWIRE, not the routine path. `--manual-polish` restores
 *       today's always-pause-for-a-human behavior verbatim. Either way, the
 *       manual fallback is the same: polish + push by hand, then re-launch
 *       `--polished --no-start` so promote gets cued.
 */
import { createRequire } from "node:module";
import { execFileSync, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo root, derived from THIS FILE's location (spec 0098). It used to be the
 * hardcoded string "/home/dev/launchpad" — a DIFFERENT clone from the one this
 * script lives in. That failed silently rather than loudly, because the old
 * checkout still exists on disk: every `execSync(..., {cwd: REPO})` (git fetch,
 * git diff, `cli start`) and the worker-log read at `${REPO}/.preflight/worker.log`
 * quietly targeted a repo nobody develops in, from the moment this copy became
 * the main repo. A script that hardcodes an absolute path to another clone can
 * only ever be right by accident.
 *
 * `LAUNCHPAD_REPO_ROOT` still overrides, for the deliberate cross-repo case.
 */
const REPO = process.env.LAUNCHPAD_REPO_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Resolve workspace deps (@temporalio/client) from THIS repo's node_modules,
// for the same reason — the base must follow REPO, never a foreign clone.
const require = createRequire(path.join(REPO, "apps/web/index.js"));
const { Connection, Client } = require("@temporalio/client");
const WL = `${REPO}/.preflight/worker.log`;
const WEB_PORT = process.env.WEB_PORT || "3000";
const HEALTH_URL = `http://localhost:${WEB_PORT}/api/health`;
const CLI = `${REPO}/packages/pipeline/dist/cli.js`;
const POLL_MS = 12_000;
const CO_AUTHOR = "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>";

// ---- args ----
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const val = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };

// spec 0051: `--recover` makes specId OPTIONAL (omitted = every open workflow;
// given = scope watcher kill/reattach to that one) — parsed as the first
// purely-numeric argv token rather than argv[0], since argv[0] is `--recover`.
const RECOVER = flag("--recover");
const REPORT_ONLY = flag("--report-only");
const NO_PUSH = flag("--no-push");

const specId = RECOVER
  ? (argv.find((a) => /^\d+$/.test(a)) || "")
  : (argv[0] || "").replace(/[^0-9]/g, "");
if (!RECOVER && !specId) {
  console.error('usage: node scripts/supervise.mjs <specId> [--request "..."] [--tenant <id> --vps-id <n> [--odoo-version 18]] [--no-push] [--no-start] [--polished] [--auto-polish] [--events]');
  console.error('   or: node scripts/supervise.mjs --recover [specId] [--report-only] [--no-push] [--events]');
  process.exit(2);
}
const REQUEST = val("--request") || `Run spec ${specId} through the pipeline (supervise.mjs).`;
const TENANT = val("--tenant");
const VPS_ID = val("--vps-id");
const ODOO_VERSION = val("--odoo-version") || "18";
const NO_START = flag("--no-start");
const POLISHED = flag("--polished"); // set on re-launch AFTER the hands-on impeccable polish pass, so gate 3 cues promote instead of pausing again
const MANUAL_POLISH = flag("--manual-polish"); // spec 0064; now the DEFAULT (kept as a no-op alias so existing invocations still work)
const AUTO_POLISH = flag("--auto-polish");     // spec 0108: opt IN to the unattended uiux-coder spawn (was the default until 0108)
// spec 0052 item B: additive, opt-in structured judgment-event emission for
// apps/web's run-follow route. ABSENT ⇒ zero behavior change (no file, no
// dist require, same log lines/exit codes). `--recover` never passes this.
const EVENTS = flag("--events");

const WF = specId ? `spec-${specId}` : "";
// spec 0051: --recover writes its own report file (`.preflight/recover.out`),
// never the per-spec supervise-<id>.out/.flag files (those belong to a single
// run's watcher/agent-notification contract, which --recover doesn't use).
const OUT = RECOVER ? `${REPO}/.preflight/recover.out` : `${REPO}/.preflight/supervise-${specId}.out`;
const FLAG_FILE = RECOVER ? `${REPO}/.preflight/recover.flag` : `${REPO}/.preflight/supervise-${specId}.flag`;
const REVIEW_FILE = `${REPO}/.preflight/supervise-${specId}.review`;
const GATES = ["awaiting_spec_approval", "awaiting_pr_approval", "awaiting_promotion"];

// ---- shell + logging ----
// NOTE (spec 0098): `sh`/`shC` DO run through /bin/sh. They are left as-is
// because every remaining call site interpolates only fixed strings or values
// this script computed itself (REPO, branch names, docker/git subcommands) —
// never operator input. The one place operator input reached a shell was
// `startRun`'s `--request`, which now uses argv + execFileSync. If a future
// call site needs to pass user input, it must use argv too, not add quoting
// here. (Rewriting the other call sites is the "shrink over time" half of §8
// G.3, which spec 0098 deliberately does not attempt: no defect behind it.)
const sh = (cmd) => { try { return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], cwd: REPO }).toString().trim(); } catch { return ""; } };
// shC: like sh but returns {ok, out} and never throws — for steps whose failure matters.
const shC = (cmd) => { try { return { ok: true, out: execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], cwd: REPO }).toString() }; } catch (e) { return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` }; } };
const countLines = (pat) => Number(sh(`grep -c ${JSON.stringify(pat)} ${JSON.stringify(WL)} 2>/dev/null`) || "0");
const log = (s) => { const line = `${new Date().toLocaleTimeString()} ${s}`; try { fs.appendFileSync(OUT, line + "\n"); } catch {} console.log(line); };

fs.mkdirSync(`${REPO}/.preflight`, { recursive: true });
fs.writeFileSync(OUT, RECOVER
  ? `supervise --recover ${specId || "(all open)"} start (report-only=${REPORT_ONLY} push=${!NO_PUSH})\n`
  : `supervise ${WF} start (push=${!NO_PUSH} start=${!NO_START})\n`);
try { fs.rmSync(FLAG_FILE, { force: true }); } catch {}

// ---- --events (spec 0052 item B): pure-core / thin-IO, same split as
// task-queue.js/recover.js below — require the BUILT dist module lazily
// (only when the flag is set) and do the actual file append here. Truncated
// at watcher start, like OUT. `emit()` is a no-op (and requires nothing) when
// the flag is absent, so byte-identical behavior holds without it.
//
// spec 0057 item B: `--events` is PROPAGATE-ONLY under `--recover` — guarded
// with `EVENTS_ACTIVE = EVENTS && !RECOVER` here and in emit(), so the
// recover process itself NEVER truncates the run's events file or emits a
// bogus `start` from itself (today's "`--recover` never passes this"
// behavior is preserved even when the flag IS given on a --recover
// invocation). The flag still reaches each RE-ATTACHED watcher's own argv
// (step 4 of runRecover, below), where it behaves exactly as it does on a
// normal launch.
const EVENTS_ACTIVE = EVENTS && !RECOVER;
let watcherEventsMod = null;
const requireWatcherEvents = () => watcherEventsMod ||= require(`${REPO}/packages/pipeline/dist/watcher-events.js`);
const EVENTS_FILE = EVENTS_ACTIVE ? requireWatcherEvents().watcherEventsPath(REPO, specId) : null;
function emit(event) {
  if (!EVENTS_ACTIVE) return;
  try {
    const { serializeWatcherEvent } = requireWatcherEvents();
    fs.appendFileSync(EVENTS_FILE, serializeWatcherEvent({ ts: new Date().toISOString(), ...event }) + "\n");
  } catch {}
}
if (EVENTS_ACTIVE) {
  try { fs.writeFileSync(EVENTS_FILE, ""); } catch {}
  emit({ type: "start", pid: process.pid, flags: argv.filter((a) => a.startsWith("--")) });
}

// Parse the repo-relative path out of one `git status --porcelain` line (same
// column shape recover.ts's porcelainPath parses): 2-char XY status + space +
// path; a rename/copy line reads "R  old -> new" — take the destination.
const parsePorcelainPath = (line) => {
  const path = line.slice(3);
  const arrow = path.indexOf(" -> ");
  return arrow === -1 ? path : path.slice(arrow + 4);
};
const dirtyPaths = () => {
  const out = sh(`git -C ${REPO} status --porcelain`);
  return out ? new Set(out.split("\n").filter(Boolean).map(parsePorcelainPath)) : new Set();
};

// ---- baselines for exception deltas (same approach as gate-watch) ----
// spec 0051: none of this (nor the single-workflow `conn`/`client`/`handle`
// below) applies to `--recover` — it isn't a single-run watcher, it manages
// its own Temporal connections per step (probe, enumerate, close) inside
// runRecover(). Left undefined here so fail()/done() still work (their
// `conn.close()` is already try/catch-guarded).
let base;
let conn, client, handle;
if (!RECOVER) {
  base = {
    tmprl: countLines("TMPRL1100"),
    hbTimeout: countLines("Heartbeat timeout"),
    pollFail: countLines("gate-2 approval poll failed"),
    workerPid: sh(`ps aux | grep "dist/worker.js" | grep -v grep | awk '{print $2}' | head -1`),
    // spec 0051: dirty paths present at watcher start are the operator's own
    // scratch files, not a pipeline leak — tolerate them for this watcher's
    // lifetime; code-16 below fires only on a path NOT in this set.
    dirtyPaths: dirtyPaths(),
  };
  log(`baseline: tmprl=${base.tmprl} hbTO=${base.hbTimeout} pollFail=${base.pollFail} workerPid=${base.workerPid} dirtyPaths=${base.dirtyPaths.size}`);

  conn = await Connection.connect({ address: "localhost:7233" });
  client = new Client({ connection: conn });
  handle = client.workflow.getHandle(WF);
}

function done(msg) { log(`DONE [${msg}]`); emit({ type: "done", benign: false, msg }); try { conn.close(); } catch {} process.exit(0); }
function fail(code, msg) {
  log(`FLAG(exception) code=${code} :: ${msg}`);
  emit({ type: "exception", code, msg });
  try { fs.writeFileSync(FLAG_FILE, `EXCEPTION code=${code}\n${msg}\nphase=${lastPhase}\ntime=${new Date().toISOString()}\n`); } catch {}
  try { conn.close(); } catch {}
  process.exit(code);
}
// Not an error (unless spec 0064's auto-polish itself failed, see below): a
// VISUAL spec (apps/web) is parked at gate 3 (merged, web-smoke green) and
// needs an impeccable polish pass BEFORE promote is cued. Exit 7 so the agent
// is notified; it (or a human) polishes + pushes, then re-launches with
// --polished --no-start.
function polishPause(msg) {
  log(`FLAG(polish-needed) :: ${msg}`);
  emit({ type: "polish", msg });
  try { fs.writeFileSync(FLAG_FILE, `POLISH_NEEDED\n${msg}\nphase=${lastPhase}\ntime=${new Date().toISOString()}\n`); } catch {}
  try { conn.close(); } catch {}
  process.exit(7);
}

// ---- state readers ----
let lastPhase = "?";
async function readState() {
  let status = "NOT_FOUND", phase = "none", pend = "";
  try {
    const d = await handle.describe();
    status = d.status?.name;
    pend = (d.raw?.pendingActivities || [])
      .map((p) => `${p.activityType?.name}#${p.attempt}${p.lastFailure ? " FAIL:" + (p.lastFailure.message || "").slice(0, 60) : ""}`)
      .join(",");
  } catch { status = "NOT_FOUND"; }
  if (status !== "NOT_FOUND") { try { phase = await handle.query("pipelinePhase"); } catch { phase = "q?"; } }
  return { status, phase, pend };
}
function envSignals() {
  const porcelain = sh(`git -C ${REPO} status --porcelain`);
  return {
    workerPid: sh(`ps aux | grep "dist/worker.js" | grep -v grep | awk '{print $2}' | head -1`),
    branch: sh(`git -C ${REPO} rev-parse --abbrev-ref HEAD`),
    dirty: porcelain ? "DIRTY" : "clean",
    dirtyPaths: porcelain ? new Set(porcelain.split("\n").filter(Boolean).map(parsePorcelainPath)) : new Set(),
    tmprl: countLines("TMPRL1100"),
    hbTimeout: countLines("Heartbeat timeout"),
    pollFail: countLines("gate-2 approval poll failed"),
    health: sh(`curl -s -o /dev/null -w "%{http_code}" ${HEALTH_URL}`) || "?",
  };
}
// Returns an exception {code,msg} or null. `phase` gates the drafting-dirty tolerance.
function detectException(env, pend, phase) {
  if (env.tmprl > base.tmprl) return { code: 10, msg: "NEW TMPRL1100 (nondeterminism)" };
  if (env.hbTimeout > base.hbTimeout) return { code: 11, msg: "NEW heartbeat timeout" };
  if (env.pollFail > base.pollFail) return { code: 12, msg: "NEW gate-2 poll failure (getPrState)" };
  if (base.workerPid && env.workerPid && env.workerPid !== base.workerPid) return { code: 13, msg: `worker pid changed ${base.workerPid}->${env.workerPid}` };
  if (base.workerPid && !env.workerPid) return { code: 14, msg: `worker died (pid ${base.workerPid} gone)` };
  if (env.branch && env.branch !== "main") return { code: 15, msg: `primary left main (on ${env.branch})` };
  // drafting writes the spec file to main then harness-commits it (spec 0029):
  // a transient dirty during `drafting` is expected, tolerated like gate-watch.
  // spec 0051: baseline-dirt tolerance — a dirty path already present when this
  // watcher started is the operator's own scratch file (recover.ts's
  // classifyDirt handles reporting it, not this watcher); code-16 fires only on
  // a NEW dirty path not in `base.dirtyPaths` (still never during `drafting`).
  if (env.dirty === "DIRTY" && phase !== "drafting") {
    const strayPaths = [...env.dirtyPaths].filter((p) => !base.dirtyPaths.has(p));
    if (strayPaths.length) return { code: 16, msg: `primary checkout DIRTY (0017 isolation): ${strayPaths.join(", ")}` };
  }
  // Activity FAIL: runCoder/runCi failures are EXPECTED-recoverable — the coder
  // loop has fixer + retry + CI-red-streak handling (spec 0018) and a genuinely
  // stuck loop surfaces as workflow FAILED (exit 20) or a gate stall, not here.
  // Hard-flag only OTHER activities' failures (mergePullRequest ff-only [0030],
  // deployToProduction, provisionEphemeralEnv, …) that have no such safety net.
  const hardFail = pend.split(",").filter((p) => /#\d+ FAIL/.test(p) && !/^\s*(runCoder|runCi)#/.test(p));
  if (hardFail.length) return { code: 17, msg: `activity attempt FAILED: ${hardFail.join(", ")}` };
  // web /api/health non-200 is SOFT (known .next papercut; the owner needs it up to
  // click gates, but it doesn't invalidate the run) — logged in the loop, not
  // a hard exit. Mirrors gate-watch's WEB_HARD=false default.
  return null;
}

// ---- git / spec helpers ----
const specFile = () => sh(`ls ${REPO}/specs/${specId}-*.md 2>/dev/null | head -1`);
const relSpec = () => { const f = specFile(); return f ? f.replace(REPO + "/", "") : ""; };
const branch = `spec/${specId}`;

// spec 0051: this is the ONE shared git-reconcile rule — `--recover` calls
// this EXACT function (no mirrored classifier). `autostash` is passed by
// `--recover` only in its no-open-run case (a built-in git flag, not new
// architecture); the watcher's own pre-run/close-out calls never set it,
// unchanged behavior. `dryRun` is `--report-only`'s read-only variant: same
// behind/ahead/diverged determination, but no pull/push is executed — a
// diverged (or --no-push-blocked ahead-only) main still calls `fail(40, …)`
// either way, since divergence ALWAYS halts for a human regardless of
// aggressiveness (never auto-merge/force, report-only or not). `failFn`
// (spec 0064) lets the auto-polish path redirect a push failure into its own
// exit-7 tripwire message instead of a hard exit 40 — every other caller
// keeps the default (unchanged behavior).
function ensureMainSynced({ autostash = false, dryRun = false, failFn = fail } = {}) {
  sh("git -C " + REPO + " fetch origin --quiet");
  const behind = Number(sh(`git -C ${REPO} rev-list --count main..origin/main`) || "0");
  const ahead = Number(sh(`git -C ${REPO} rev-list --count origin/main..main`) || "0");
  if (behind > 0 && ahead === 0) {
    if (dryRun) { log(`git (report-only): main behind origin by ${behind} — would ff-pull${autostash ? " --autostash" : ""}`); return; }
    const r = shC(`git -C ${REPO} pull --ff-only${autostash ? " --autostash" : ""} origin main`);
    if (!r.ok) failFn(40, `main is behind origin and ff-only pull failed:\n${r.out.slice(0, 400)}`);
    log(`synced: fast-forwarded main (+${behind})${autostash ? " (--autostash)" : ""}`);
  } else if (ahead > 0 && behind === 0) {
    if (NO_PUSH) failFn(40, `main is ${ahead} commit(s) ahead of origin and --no-push is set; push to reconcile before the next run.${dryRun ? " (report-only assessment)" : ""}`);
    if (dryRun) { log(`git (report-only): main ahead of origin by ${ahead} — would push`); return; }
    const r = shC("git -C " + REPO + " push origin main");
    if (!r.ok) failFn(40, `push origin main failed:\n${r.out.slice(0, 400)}`);
    log(`synced: pushed ${ahead} local commit(s) to origin`);
  } else if (ahead > 0 && behind > 0) {
    failFn(40, `main DIVERGED from origin (ahead ${ahead}, behind ${behind}) — needs a human to reconcile (do NOT auto-merge).${dryRun ? " (report-only assessment)" : ""}`);
  } else {
    log(`git: main == origin${dryRun ? " (report-only)" : ""}`);
  }
}

// Pre-run spec-frontmatter lint: catch a malformed spec BEFORE starting the
// run, so a bad spec can never crash the workflow mid-flight. The trap that
// motivated this (spec 0042): an empty `status:` field survives drafting AND
// the gate-1 park, then `markSpec`→`setStatus`→`parseStatus` throws "Spec has
// no status field" the instant the human approves gate 1 — FAILING the whole
// workflow at the worst moment. parseStatus (packages/pipeline/src/store.ts)
// requires /^status:\s*(\S+)$/, so we lint the exact same shape here.
function lintSpec() {
  // Tenant vanilla deploys (spec 0047) have NO pre-existing spec — the manifest
  // is written by the workflow's writeTenantDeployManifest activity. So there's
  // nothing to lint before start; skip (detected from the --tenant/--vps-id
  // start flags, which are always present on a tenant `supervise` start).
  if (TENANT || VPS_ID) return;
  const f = specFile();
  if (!f) fail(41, `no spec file matching specs/${specId}-*.md`);
  const md = sh(`cat ${JSON.stringify(f)}`);
  const problems = [];
  if (!/^status:\s*(\S+)\s*$/m.test(md))
    problems.push("`status:` is empty or missing — set `status: draft` for a fresh run (this is the exact field markSpec/parseStatus reads at gate-1 approval)");
  if (!/^id:\s*\d+\s*$/m.test(md)) problems.push("`id:` is missing or non-numeric");
  if (!/^title:\s*\S+/m.test(md)) problems.push("`title:` is empty or missing");
  if (problems.length)
    fail(41, `spec ${specId} frontmatter is invalid — the pipeline would crash mid-run:\n  - ${problems.join("\n  - ")}`);
}

function ensurePreRun() {
  lintSpec();
  // commit an uncommitted spec draft (pathspec-scoped) so the tree is clean.
  const rel = relSpec();
  if (rel && sh(`git -C ${REPO} status --porcelain -- ${JSON.stringify(rel)}`)) {
    log(`pre-run: committing uncommitted spec draft ${rel}`);
    const r = shC(`git -C ${REPO} add ${JSON.stringify(rel)} && git -C ${REPO} commit -q -m "docs(spec-${specId}): draft (auto-committed by supervise.mjs)" -m ${JSON.stringify(CO_AUTHOR)}`);
    if (!r.ok) fail(50, `committing spec draft failed:\n${r.out.slice(0, 300)}`);
  }
  // any OTHER dirt on main is an isolation problem the human must resolve.
  if (sh(`git -C ${REPO} status --porcelain`)) fail(16, `primary checkout dirty with non-spec changes before start:\n${sh("git -C " + REPO + " status --porcelain").slice(0, 400)}`);
  ensureMainSynced();
  if (!base.workerPid) fail(14, "no pipeline worker running — run `bash scripts/preflight.sh` (or `restart`) first.");
}

/**
 * Starts the run via ARGV, not a shell string (spec 0098).
 *
 * It used to build one `cmd` string and hand it to `execSync` (i.e. `/bin/sh -c`).
 * `JSON.stringify(REQUEST)` escapes `"` and `\` but NOT `$`, backticks or
 * `$( )`, all of which the shell still expands inside double quotes — so
 * `--request '$(id > /tmp/pwned)'` executed `id`. `specId`/`--tenant`/`--vps-id`
 * /`--odoo-version` were interpolated unquoted, the same class.
 *
 * With `execFileSync` and an argv array there is no shell, so every value —
 * however punctuated — reaches the CLI verbatim. `LAUNCHPAD_REPO_ROOT` moves
 * from a string prefix to the child's env, which is also where it belonged.
 */
function startRun() {
  let args;
  if (TENANT || VPS_ID) {
    if (!TENANT || !VPS_ID) fail(2, "a tenant run needs both --tenant and --vps-id");
    args = [CLI, "start-tenant", specId, REQUEST,
      "--tenant", TENANT, "--vps-id", String(VPS_ID), "--odoo-version", String(ODOO_VERSION)];
  } else {
    args = [CLI, "start", specId, REQUEST];
  }
  let out;
  try {
    out = execFileSync("node", args, {
      cwd: REPO,
      env: { ...process.env, LAUNCHPAD_REPO_ROOT: REPO },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch (e) {
    fail(50, `cli start failed:\n${`${e.stdout || ""}${e.stderr || ""}`.slice(0, 400)}`);
  }
  log(`started ${WF}: ${out.trim().slice(0, 120)}`);
}

// changed files on the PR branch vs merge-base (three-dot); empty if branch absent.
function changedFiles() {
  sh("git -C " + REPO + " fetch origin --quiet");
  const out = sh(`git -C ${REPO} diff --name-only main...origin/${branch} 2>/dev/null`);
  return out ? out.split("\n").filter(Boolean) : [];
}
const isUiOnly = () => /^ui_only:\s*true\s*$/m.test(sh(`git -C ${REPO} show origin/${branch}:${relSpec()} 2>/dev/null`) || sh(`cat ${specFile()}`));

// The PR branch's changed files, CACHED at gate 2 (pre-merge). Critical: after
// the merge, `main...origin/branch` is empty (the branch is now an ancestor of
// main), so postMerge/closeOut CANNOT recompute it — they must use this cache
// (bug found on the 0036 trial: web-smoke + worker-restart silently skipped).
let branchFiles = null;
// spec 0058 Scope A: the PR branch head, cached at gate 2 for the SAME reason
// as branchFiles — post-merge, `origin/<branch>` is gone (branch deleted), so
// postMerge's merge-SHA resolution (below) cannot recompute it and must use
// this cache.
let branchHeadSha = null;
function batchFiles() {
  if (branchFiles && branchFiles.length) return { files: branchFiles, known: true };
  const f = changedFiles();
  // if the cache is empty AND a live recompute is empty, we're post-merge with
  // no cache (script re-launched after gate 2) — treat as UNKNOWN so callers
  // conservatively run web-smoke + worker-restart rather than skip them.
  return f.length ? { files: f, known: true } : { files: [], known: false };
}

// Mechanical gate-2 review. Returns {fatal, lines[]}. Writes the summary file.
function gate2Review() {
  const files = changedFiles();
  branchFiles = files; // cache while main...branch is still valid (pre-merge)
  branchHeadSha = sh(`git -C ${REPO} rev-parse origin/${branch}`) || null; // spec 0058: cache before the branch is deleted post-merge
  const lines = [];
  let fatal = null;
  const nonSpec = files.filter((f) => !f.startsWith(`specs/${specId}-`));
  lines.push(`PR branch: ${branch}  |  changed files: ${files.length}`);
  const commits = sh(`git -C ${REPO} rev-list --count main..origin/${branch}`) || "?";
  lines.push(`coder increments (commits on branch): ${commits}`);

  // ui_only fence: every change under apps/web/ (+ the spec's own file), plus
  // the root pnpm-lock.yaml EXACT match — parity with the pipeline fence
  // (packages/pipeline/src/scope-fence.ts UI_ONLY_ALLOWED_FILES, spec 0042
  // item B). The monorepo has ONE root lockfile, so a legitimate apps/web
  // dependency change necessarily regenerates it (0040's exit-31) — allow
  // that side effect only. Root/any-nested package.json stays a breach: a
  // ui_only run editing workspace-root config is exactly what the fence must
  // still catch (the owner's decision); dep APPROPRIATENESS is a gate-2 review
  // judgment, not a path-fence one.
  if (isUiOnly()) {
    const fenceAllowed = (f) => f.startsWith("apps/web/") || f === "pnpm-lock.yaml";
    const breach = nonSpec.filter((f) => !fenceAllowed(f));
    if (breach.length) { fatal = { code: 31, msg: `ui_only fence BREACH — changes outside apps/web/: ${breach.join(", ")}` }; lines.push(`FENCE: BREACH → ${breach.join(", ")}`); }
    else lines.push(`FENCE: OK — all ${nonSpec.length} non-spec changes under apps/web/`);
  } else {
    lines.push(`FENCE: n/a (not ui_only)`);
    // determinism: workflow.ts must not gain a file read
    if (files.includes("packages/pipeline/src/workflow.ts")) {
      const wf = sh(`git -C ${REPO} show origin/${branch}:packages/pipeline/src/workflow.ts 2>/dev/null`);
      if (/readFileSync|readFile\(|\bfs\.|from "node:fs"|from "fs"/.test(wf)) { fatal = fatal || { code: 31, msg: "determinism: workflow.ts appears to read the filesystem" }; lines.push(`DETERMINISM: workflow.ts reads fs — REVIEW`); }
      else lines.push(`DETERMINISM: OK — no fs read in workflow.ts`);
    }
    // Fleet mutating-verb scan — ADVISORY, never fatal. The deploy modules
    // (stack.ts / bootstrap.ts) LEGITIMATELY contain `docker compose up`, db
    // init, etc. — that IS the deploy code — so a string match cannot tell a
    // legitimate deploy refactor (e.g. spec 0046 threading `-p` into the
    // existing compose calls) from a rogue live/destructive op. The human
    // reviews the real diff at gate 2 (the GitHub PR); this just surfaces the
    // lines worth a closer look. (Was a fatal exit-31; downgraded after it
    // false-blocked 0046's deploy-mechanics refactor — the string was in the
    // deploy code all along.)
    const fleetFiles = files.filter((f) => f.startsWith("packages/fleet-hostinger/src/") && !f.endsWith(".test.ts"));
    let fleetVerbs = 0;
    for (const f of fleetFiles) {
      const src = sh(`git -C ${REPO} show origin/${branch}:${f} 2>/dev/null`);
      const bad = src.match(/compose\s+(up|down)|docker\s+(rm|stop|kill|start|restart)|prune|DROP |DELETE |TRUNCATE|CREATE (DATABASE|TABLE)|ALTER /i);
      if (bad) { fleetVerbs++; lines.push(`FLEET-VERB (advisory — review the diff, not auto-fatal): ${f} — "${bad[0].trim()}"`); }
    }
    if (fleetFiles.length) lines.push(`FLEET: scanned ${fleetFiles.length} fleet-hostinger file(s); ${fleetVerbs} with mutating verbs (advisory — human reviews the PR diff)`);
  }
  lines.push(nonSpec.map((f) => "  - " + f).join("\n"));
  fs.writeFileSync(REVIEW_FILE, `Gate-2 mechanical review — ${WF}\n${lines.join("\n")}\n`);
  emit({ type: "review", lines });
  return { fatal, lines };
}

// The GitHub client module, required lazily by the merge-SHA resolution below
// (and, before spec 0058 retired it, also by gate2CiConclusion()).
const GH_CLIENT_MOD = `${REPO}/packages/github/dist/index.js`;

// Merge-SHA resolution (spec 0058 Scope A; spec 0063 adds the prior-artifact
// rung). The artifact's key MUST equal what the gate looks up:
// `getPrState(pr.number).mergeCommitSha`. Token-less primary: `branchHeadSha`
// (cached at gate 2, before the branch is deleted) identifies the merge
// commit on `origin/main` whose SECOND parent equals it — the pipeline always
// merges with `merge_method: "merge"` (packages/github/src/client.ts ~438), so
// that second-parent commit IS GitHub's `merge_commit_sha`. When
// `GITHUB_TOKEN` is present in this shell, prefer the authoritative
// `getPrState` lookup instead (also covers a human squash-merge, which has no
// second-parent to match). LAST resort (spec 0063): a `--polished --no-start`
// relaunch runs neither gate 2 (so `branchHeadSha` is null) nor has a token —
// scan `.preflight/promote-ci-*.json` for a parseable artifact matching this
// run's `specId`+`branch` and reuse its `mergeSha` (the filename key is
// unchanged across the relaunch's overwrite); latest `ranAt` wins if several.
// Undeterminable ⇒ return null — the caller writes NO artifact rather than a
// mis-keyed one.
function priorArtifactMergeSha() {
  let names;
  try { names = fs.readdirSync(`${REPO}/.preflight`); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (!/^promote-ci-.+\.json$/.test(name)) continue;
    let a;
    try { a = JSON.parse(fs.readFileSync(`${REPO}/.preflight/${name}`, "utf8")); } catch { continue; }
    if (!a || a.specId !== specId || a.branch !== branch || typeof a.mergeSha !== "string") continue;
    if (!best || String(a.ranAt || "") > String(best.ranAt || "")) best = a;
  }
  return best ? best.mergeSha : null;
}

async function resolveMergeSha() {
  sh(`git -C ${REPO} fetch origin --quiet`);
  let viaGit = null;
  if (branchHeadSha) {
    const merges = sh(`git -C ${REPO} log --merges --format="%H %P" -n 50 origin/main`);
    for (const line of merges.split("\n").filter(Boolean)) {
      const [mergeCommit, , secondParent] = line.split(" ");
      if (secondParent === branchHeadSha) { viaGit = mergeCommit; break; }
    }
  }
  const token = process.env["GITHUB_TOKEN"];
  if (token) {
    try {
      let pr;
      try { pr = await handle.query("pipelinePr"); } catch { pr = null; }
      const m = pr && pr.number > 0 ? /^([^/\s]+)\/([^/\s]+)$/.exec(String(pr.repo || "")) : null;
      if (m) {
        const { GithubClient } = require(GH_CLIENT_MOD);
        const client = new GithubClient({ token, owner: m[1], repo: m[2] });
        const st = await client.getPrState(pr.number);
        if (st.mergeCommitSha) return { sha: st.mergeCommitSha, source: "getPrState" };
      }
    } catch (e) { log(`post-merge: getPrState merge-SHA lookup failed, falling back to git derivation: ${String((e && e.message) || e).slice(0, 150)}`); }
  }
  if (viaGit) return { sha: viaGit, source: "git-second-parent" };
  const prior = priorArtifactMergeSha();
  if (prior) return { sha: prior, source: "prior-artifact" };
  return null;
}

// `failFn` (spec 0064) lets the post-auto-polish re-run redirect a red check
// into its own exit-7 tripwire message instead of the normal hard exit
// (30/33/34) — the FIRST (pre-polish) call keeps the default `fail`, so a
// genuinely broken merge still hard-fails exactly as before.
async function postMerge(failFn = fail) {
  const { files, known } = batchFiles();
  const touchesWeb = !known || files.some((f) => f.startsWith("apps/web/"));
  const touchesPkg = !known || files.some((f) => f.startsWith("packages/"));
  if (!known) log(`post-merge: changed-file list unknown (no gate-2 cache) — conservatively running web-smoke + worker restart`);

  // spec 0058 Scope A: resolve the merge SHA + the `origin/main` tip these
  // steps evaluate BEFORE running anything, so the artifact (written on both
  // outcomes, before any fail()) is ready the instant a step goes red.
  const mergeInfo = await resolveMergeSha();
  const evaluatedSha = sh(`git -C ${REPO} rev-parse origin/main`);
  const steps = [];
  const writeArtifact = (conclusion) => {
    if (!mergeInfo) {
      log(`post-merge: merge SHA undeterminable (no gate-2 branch-head cache / no matching second-parent merge on origin/main, no GITHUB_TOKEN+getPrState fallback, and no matching prior .preflight/promote-ci-*.json artifact) — writing NO artifact (never a mis-keyed file). Gate 3 will allow-with-note.`);
      return;
    }
    const artifact = { schema: 1, specId, branch, mergeSha: mergeInfo.sha, evaluatedSha, conclusion, ranAt: new Date().toISOString(), steps };
    try {
      fs.writeFileSync(`${REPO}/.preflight/promote-ci-${mergeInfo.sha}.json`, JSON.stringify(artifact, null, 2));
      log(`post-merge: wrote .preflight/promote-ci-${mergeInfo.sha}.json conclusion=${conclusion} (SHA source=${mergeInfo.source})`);
    } catch (e) { log(`!! post-merge: FAILED writing promote-ci artifact: ${e.message}`); }
  };
  const timeStep = (name, fn) => { const t0 = Date.now(); const r = fn(); steps.push({ name, ok: r.ok, ms: Date.now() - t0 }); return r; };

  // 1. packages/* rebuild (spec 0055) — so typecheck/test/web-smoke never see
  // stale dist. Never `next build` (would corrupt the shared .next while the
  // dev server is up, spec 0008 item 5).
  const b = timeStep("build", () => shC(`pnpm --filter='./packages/*' -r build`));
  if (!b.ok) { writeArtifact("failure"); failFn(33, `packages/* rebuild FAILED before post-merge CI (spec 0055):\n${b.out.slice(-500)}`); }
  log(`post-merge: packages/* rebuild GREEN`);

  // 2. typecheck — full local CI (spec 0058), for every non-tenant run.
  const tc = timeStep("typecheck", () => shC(`pnpm -r typecheck`));
  if (!tc.ok) { writeArtifact("failure"); failFn(34, `local CI typecheck RED post-merge (spec 0058):\n${tc.out.slice(-500)}`); }
  log(`post-merge: typecheck GREEN`);

  // 3. harness-inclusive, skip-proof test — same mechanics as `runCi`
  // (packages/pipeline/src/activities.ts): TEMPORAL_TEST=1 so the workflow
  // harness executes its time-skipping cases, HARNESS_EXEC_COUNT_FILE names a
  // scratch file the harness's exit hook writes its executed-case count to,
  // and harnessSkipProofError folds a 0/absent count into a red result so an
  // accidental re-gating fails CI instead of looking green.
  const countFile = `${REPO}/.preflight/harness-count-${specId}.txt`;
  try { fs.rmSync(countFile, { force: true }); } catch {}
  const { HARNESS_COUNT_ENV, harnessSkipProofError } = require(`${REPO}/packages/pipeline/dist/harness-exec.js`);
  const t = timeStep("test", () => {
    const r = shC(`${HARNESS_COUNT_ENV}=${JSON.stringify(countFile)} TEMPORAL_TEST=1 pnpm -r test`);
    let executed = null;
    try { const n = Number.parseInt(fs.readFileSync(countFile, "utf8"), 10); executed = Number.isFinite(n) ? n : null; } catch { executed = null; }
    const skipProofError = harnessSkipProofError({ temporalTest: true, executed });
    return { ok: r.ok && skipProofError === null, out: skipProofError ? `${r.out}\nSKIP-PROOF: ${skipProofError}` : r.out };
  });
  if (!t.ok) { writeArtifact("failure"); failFn(34, `local CI test RED (or skip-proof failed) post-merge (spec 0058):\n${t.out.slice(-500)}`); }
  log(`post-merge: skip-proof test GREEN`);

  // 4. web-smoke — unchanged conditional (touchesWeb or unknown batch).
  if (touchesWeb) {
    const r = timeStep("web-smoke", () => shC(`bash ${REPO}/scripts/web-smoke.sh http://localhost:${WEB_PORT}`));
    if (!r.ok) { writeArtifact("failure"); failFn(30, `web-smoke RED after merge (spec 0020 gate):\n${r.out.slice(-500)}`); }
    log(`post-merge: web-smoke GREEN`);
  }

  writeArtifact("success");
  return { touchesPkg, touchesWeb };
}

// Spec 0197: `autoPolish()` (spec 0064) is DELETED with the `uiux-coder` role.
// Nothing could reach it — this script is not a service, not a cron entry and
// not running, all three verified on the box — and it polished `apps/web`, our
// own surface, rather than a customer's project. `--auto-polish` now falls
// through to the same exit-7 pause `--manual-polish` produces, which is where
// every one of its failure paths already landed.

function closeOut(runFacts) {
  const rel = relSpec();
  if (!rel) fail(41, "close-out: spec file not found");
  // idempotency: if this run was already closed out (re-launched script), don't
  // append a duplicate entry — just reconcile main and finish.
  if (/supervise\.mjs \(auto close-out\)/.test(sh(`cat ${JSON.stringify(REPO + "/" + rel)}`))) {
    log("close-out: already present — skipping duplicate append");
    ensureMainSynced();
    return;
  }
  // factual auto close-out entry (a human/agent may enrich later).
  const entry = `\n- **${new Date().toISOString().slice(0, 10)} / supervise.mjs (auto close-out):** ${WF} reached \`promoted\`/COMPLETED via the pipeline under supervise.mjs. ${runFacts}. Gate-2 mechanical review: see \`.preflight/supervise-${specId}.review\`. Gates were human clicks (never scripted). This entry is auto-generated and factual — enrich if needed.\n`;
  try { fs.appendFileSync(`${REPO}/${rel}`, entry); } catch (e) { fail(50, `appending close-out failed: ${e.message}`); }
  const r = shC(`git -C ${REPO} add ${JSON.stringify(rel)} && git -C ${REPO} commit -q -m "docs(spec-${specId}): close-out — promoted + COMPLETED (auto by supervise.mjs)" -m ${JSON.stringify(CO_AUTHOR)}`);
  if (!r.ok) fail(50, `close-out commit failed:\n${r.out.slice(0, 300)}`);
  log(`close-out: handoff entry committed`);
  emit({ type: "closeout", msg: runFacts });
  // restart the worker if packages/ changed (new pipeline/agents code must load).
  // A tenant vanilla deploy (spec 0047) changes NO packages/ — skip the restart
  // (its `known=false` batchFiles would otherwise trigger a spurious one).
  const { files, known } = batchFiles();
  if (!tenantRunFlag && (!known || files.some((f) => f.startsWith("packages/")))) {
    log(`close-out: ${known ? "packages/ changed" : "changed-file list unknown"} — restarting worker to load the new build`);
    const rr = shC(`bash ${REPO}/scripts/preflight.sh restart`);
    if (!rr.ok) log(`!! worker restart reported non-zero (check manually):\n${rr.out.slice(-300)}`);
  }
  ensureMainSynced(); // push the close-out + any status commits so main == origin
}

// gate2CiConclusion() (task #86, GitHub Actions verdict poll feeding exit 32)
// was REMOVED here by spec 0058: GitHub Actions produces zero runs for this
// account now, so the poll could only ever read "pending" forever — dead code
// that could never fire truthfully. Gate-2 CI is now a static advisory (see
// the `awaiting_pr_approval` cue below) naming the pipeline's pre-PR `runCi`
// as the check that already ran, rather than polling GitHub again post-PR.

// Detect a tenant vanilla deploy (spec 0047): its flow has NO PR/merge and
// touches NO apps/web, so the gate-3 postMerge (web-smoke + worker restart),
// the apps/web polish pause, and the close-out worker restart must NOT apply —
// the single gate IS the deploy gate; just cue it. Read from the workflow's own
// `pipelineTarget` query (works on --no-start attach, not just the --tenant
// flag on a start). Cached; falls back to non-tenant on any query error (older
// runs without the handler ⇒ safe default of the normal self/code flow).
let tenantRunFlag = null;
async function isTenantRun() {
  if (tenantRunFlag !== null) return tenantRunFlag;
  if (TENANT || VPS_ID) { tenantRunFlag = true; return true; }
  try { const t = await handle.query("pipelineTarget"); tenantRunFlag = !!t && t.kind === "tenant"; }
  catch { tenantRunFlag = false; }
  return tenantRunFlag;
}

// ---- --recover mode (spec 0051 / ADR-023 steps 1-4) ----
// One command, act-then-continue: infra (idempotent preflight, never
// `restart`) → durable state (report only) → working tree + git (via the
// SAME ensureMainSynced above) → watchers (kill-all, re-attach fresh). Never
// signals a gate, never force-pushes/auto-merges, never stashes/discards
// uncommitted work. Exit codes 0 / 14 / 40 only (see header doc).
async function runRecover() {
  const scopeSpecId = specId || undefined;
  log(`--recover: mode=${REPORT_ONLY ? "report-only" : "act"} scope=${scopeSpecId || "all open workflows"} push=${!NO_PUSH}`);

  // ---- step 1: infra (Temporal, worker, /api/health) ----
  async function probeInfra() {
    let temporalUp = false;
    try {
      const c = await Connection.connect({ address: "localhost:7233" });
      temporalUp = true;
      try { await c.close(); } catch {}
    } catch { temporalUp = false; }
    const workerPid = sh(`ps aux | grep "dist/worker.js" | grep -v grep | awk '{print $2}' | head -1`);
    const health = sh(`curl -s -o /dev/null -w "%{http_code}" ${HEALTH_URL}`) || "?";
    return { temporalUp, workerPid, workerUp: !!workerPid, health, healthUp: health === "200" };
  }
  const infraLine = (i) => `temporal=${i.temporalUp ? "up" : "DOWN"} worker=${i.workerUp ? `up(pid ${i.workerPid})` : "DOWN"} web=${i.healthUp ? "up" : `DOWN(${i.health})`}`;

  let infra = await probeInfra();
  log(`infra: ${infraLine(infra)}`);
  if (!infra.temporalUp || !infra.workerUp || !infra.healthUp) {
    if (REPORT_ONLY) {
      log(`--report-only: would run \`bash scripts/preflight.sh\` (idempotent main flow — never \`restart\`) to bring up the down component(s) above`);
    } else {
      log(`infra component(s) down — running \`bash scripts/preflight.sh\` (idempotent main flow)...`);
      const r = shC(`bash ${REPO}/scripts/preflight.sh`);
      if (!r.ok) { fail(14, `preflight.sh failed:\n${r.out.slice(-800)}`); return; }
      log(`preflight: completed`);
      infra = await probeInfra();
      log(`infra (re-probe): ${infraLine(infra)}`);
    }
  }
  if (!infra.temporalUp || !infra.workerUp) {
    fail(14, `infra still down${REPORT_ONLY ? " (report-only — preflight not run)" : " after the preflight attempt"}: temporal=${infra.temporalUp ? "up" : "DOWN"} worker=${infra.workerUp ? "up" : "DOWN"} — the durable layer needed to make or assess progress is not up.`);
    return;
  }

  // ---- step 2: durable state — enumerate open workflows (read-only, always) ----
  // Same query open-pipeline-workflows.mjs uses (WorkflowType/TaskQueue/Running).
  const { TASK_QUEUE } = require(`${REPO}/packages/pipeline/dist/task-queue.js`);
  const dConn = await Connection.connect({ address: "localhost:7233" });
  const dClient = new Client({ connection: dConn });
  const query = `WorkflowType = 'specPipeline' AND TaskQueue = '${TASK_QUEUE}' AND ExecutionStatus = 'Running'`;
  const openWorkflowIds = [];
  for await (const execution of dClient.workflow.list({ query })) openWorkflowIds.push(execution.workflowId);
  log(`durable state: ${openWorkflowIds.length} open workflow(s)${openWorkflowIds.length ? " — " + openWorkflowIds.join(", ") : ""}`);

  const openInfo = [];
  for (const wfId of openWorkflowIds) {
    const sid = wfId.replace(/^spec-/, "");
    const h = dClient.workflow.getHandle(wfId);
    let status = "?", phase = "?";
    try { status = (await h.describe()).status?.name || "?"; } catch {}
    try { phase = await h.query("pipelinePhase"); } catch { phase = "q?"; }
    const gated = GATES.includes(phase);
    openInfo.push({ wfId, sid, status, phase, gated });
    log(`  ${wfId}: status=${status} phase=${phase}${gated ? ` — PARKED AT GATE. cue: http://localhost:${WEB_PORT}/specs/${sid}` : ""}`);
  }
  try { await dConn.close(); } catch {}

  // ---- step 3: working tree + git ----
  const porcelain = sh(`git -C ${REPO} status --porcelain`);
  const porcelainLines = porcelain ? porcelain.split("\n").filter(Boolean) : [];
  // drafting-phase spec files feed classifyDirt's `draftingSpecFiles` (spec
  // 0029: the harness commits these itself, so they're expected, not stray).
  const draftingSpecFiles = openInfo
    .filter((w) => w.phase === "drafting")
    .map((w) => { const f = sh(`ls ${REPO}/specs/${w.sid}-*.md 2>/dev/null | head -1`); return f ? f.replace(REPO + "/", "") : ""; })
    .filter(Boolean);
  const { classifyDirt, planWatcherRecovery } = require(`${REPO}/packages/pipeline/dist/recover.js`);
  const { expected, stray } = classifyDirt({ porcelainLines, draftingSpecFiles });
  if (stray.length) {
    const pkgStray = stray.filter((p) => p.startsWith("packages/"));
    log(`!! STRAY DIRT left in the tree (never stashed) — ${stray.length} path(s): ${stray.join(", ")}`);
    if (pkgStray.length) log(`   NOTE: ${pkgStray.length} of those under packages/ WILL BE COMPILED INTO the worker by the close-out rebuild (\`preflight.sh restart\`): ${pkgStray.join(", ")}`);
  } else {
    log(`working tree: no stray dirt${expected.length ? ` (${expected.length} drafting-spec path(s) tolerated as expected)` : ""}`);
  }

  // ONE shared rule: the exact ensureMainSynced() the watcher itself uses.
  // autostash only in the no-open-run case (a git flag, not new machinery);
  // dryRun under --report-only assesses without mutating; DIVERGED always
  // halts (fail(40)) either way.
  ensureMainSynced({ autostash: openWorkflowIds.length === 0, dryRun: REPORT_ONLY });

  // ---- step 4: watchers — kill all, re-attach fresh (no classification) ----
  const procOut = sh(`ps aux | grep "scripts/supervise.mjs" | grep -v grep | grep -v -- "--recover"`);
  const processes = [];
  for (const line of procOut.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols[1]);
    const m = line.match(/supervise\.mjs\s+(\d{2,6})\b/);
    if (pid && m) processes.push({ pid, specId: m[1] });
  }
  const plan = planWatcherRecovery({ processes, openWorkflowIds: openInfo.map((w) => w.sid), selfPid: process.pid, scopeSpecId });
  log(`watchers: found ${processes.length} supervise.mjs process(es) — plan kill=[${plan.kill.join(",")}] reattach=[${plan.reattach.join(",")}]`);
  if (REPORT_ONLY) {
    log(`--report-only: would SIGTERM pid(s) [${plan.kill.join(", ")}] and re-attach a fresh tracked --no-start watcher for [${plan.reattach.join(", ")}]`);
  } else {
    for (const pid of plan.kill) {
      try { process.kill(pid, "SIGTERM"); log(`  killed watcher pid ${pid}`); } catch (e) { log(`  !! failed to kill pid ${pid}: ${e.message}`); }
    }
    for (const sid of plan.reattach) {
      // spec 0057 item B: propagate-only — append --events to each
      // re-attached watcher's own argv iff THIS recover invocation received
      // --events. The recover process itself never emits/truncates (guarded
      // above); the re-attached watcher is a normal launch and treats
      // --events exactly as it always has.
      const reattachArgs = [`${REPO}/scripts/supervise.mjs`, sid, "--no-start", ...(EVENTS ? ["--events"] : [])];
      const child = spawn("node", reattachArgs, { cwd: REPO, detached: true, stdio: "ignore" });
      child.unref();
      log(`  re-attached watcher for spec-${sid} (pid ${child.pid})${EVENTS ? " with --events" : ""}`);
    }
  }

  done(`--recover ${REPORT_ONLY ? "report-only assessment" : "recovery"} complete`);
}

if (RECOVER) {
  await runRecover();
  // runRecover always exits the process (done()/fail() above) — nothing
  // below this line ever runs in --recover mode.
}

// ---- orchestration ----
log(`supervising ${WF} — request: ${REQUEST.slice(0, 80)}`);

// One-time pre-work if the run hasn't started yet.
{
  const { status } = await readState();
  // A closed-UNsuccessful run (FAILED/TERMINATED/CANCELED/TIMED_OUT) for this
  // spec id is a spent shell: attaching to it only re-flags exit-20 forever
  // (hit 3× recovering spec 0042 — had to `cli start` by hand). Treat it like
  // NOT_FOUND and start a FRESH run (the spec-NNNN workflow id is reusable
  // under Temporal's AllowDuplicate policy once the prior run is closed). With
  // --no-start we still just wait/flag, never auto-start.
  const closedUnsuccessful = ["FAILED", "TERMINATED", "CANCELED", "TIMED_OUT"].includes(status);
  if (status === "NOT_FOUND" || (closedUnsuccessful && !NO_START)) {
    if (closedUnsuccessful) log(`existing run is ${status} (closed unsuccessfully) — starting a FRESH run (spec-${specId} id reused; prior run is closed).`);
    if (NO_START) { log("run not started and --no-start set; waiting for it to appear…"); }
    else { ensurePreRun(); startRun(); }
  } else {
    log(`attaching to existing run (status=${status})`);
    ensureMainSynced();
  }
}

let cued = {};        // gate phase -> true once cued
let reviewed = false; // gate 2 mechanical review done
let postMerged = false;
let runFacts = "";
let polishDone = POLISHED; // spec 0064: true once the polish point is handled (--polished relaunch or a successful in-process auto-spawn)
let touchesWebFlag = false;
// spec 0058: gate-2 CI is a static advisory, not a poll (see the
// `awaiting_pr_approval` cue below) — no more "last known" state to track.
const gate2CiNote = "CI: pipeline runCi was green pre-PR; local promote CI runs post-merge (spec 0058) — review the diff and merge.";

for (let i = 0; i < 800; i++) {
  const { status, phase, pend } = await readState();
  const env = envSignals();
  lastPhase = phase;

  const line = `${status} phase=${phase} pend=[${pend}] primary=${env.branch}/${env.dirty} worker=${env.workerPid} health=${env.health}`;
  log(line);
  if (env.health !== "200") log(`!! web ${env.health} (soft — you need it up to click gates; not interrupting)`);

  // terminal statuses
  if (["FAILED", "TERMINATED", "CANCELED", "TIMED_OUT"].includes(status)) fail(20, `workflow ${status} (phase=${phase})`);

  // exceptions (baseline-delta + activity fail + isolation)
  if (status === "RUNNING" || status === "COMPLETED") {
    const ex = detectException(env, pend, phase);
    if (ex) fail(ex.code, ex.msg);
  }

  // Is this a tenant vanilla deploy? (cached) — gates the promotion/close-out
  // behavior below so a deploy isn't treated like a code merge.
  const tenant = await isTenantRun();

  // phase-driven automation + gate cues
  if (phase === "awaiting_spec_approval" && !cued[phase]) {
    cued[phase] = true;
    const cueMsg = `verified clean park. CUE: click "Approve spec" at http://localhost:${WEB_PORT}/specs/${specId}`;
    log(`GATE 1 — ${cueMsg}`);
    emit({ type: "cue", gate: 1, msg: cueMsg });
  } else if (phase === "awaiting_pr_approval") {
    if (!reviewed) {
      reviewed = true;
      const { fatal, lines } = gate2Review();
      log(`gate-2 mechanical review:\n${lines.join("\n")}`);
      if (fatal) fail(fatal.code, fatal.msg);
    }
    // spec 0058: GitHub Actions is retired as a CI source (0 runs for this
    // account), so the old task #86 poll-for-verdict + exit-32 red-block is
    // gone — it could never see a truthful result again. `gate2CiNote` is now
    // a static advisory naming the check that DID already run: the pipeline's
    // `runCi` activity (build+typecheck+skip-proof test) on the branch's
    // ephemeral worktree, pre-PR. Local promote CI (spec 0058) runs post-merge
    // and gates promotion at gate 3 instead.
    if (!cued[phase]) {
      cued[phase] = true;
      const cueMsg = `mechanical review OK | ${gate2CiNote} (see .preflight/supervise-${specId}.review). CUE: review + merge PR on GitHub (branch ${branch}).`;
      log(`GATE 2 — ${cueMsg}`);
      emit({ type: "cue", gate: 2, msg: cueMsg });
    }
  } else if (phase === "awaiting_promotion") {
    if (tenant) {
      // Tenant vanilla deploy (spec 0047): no PR, no merge, no apps/web — the
      // single gate IS the deploy gate. Skip postMerge (web-smoke + worker
      // restart) and the apps/web polish pause; just cue the deploy click.
      if (!cued[phase]) {
        cued[phase] = true;
        runFacts = "tenant vanilla deploy";
        const cueMsg = `tenant vanilla deploy at its single gate. CUE: click "Deploy" at http://localhost:${WEB_PORT}/specs/${specId} — this triggers the live VPS provision + deploy.`;
        log(`GATE (deploy) — ${cueMsg}`);
        emit({ type: "cue", gate: "deploy", msg: cueMsg });
      }
    } else {
      if (!postMerged) { postMerged = true; const pm = await postMerge(); touchesWebFlag = pm.touchesWeb; runFacts = `post-merge checks passed${pm.touchesPkg ? " (packages/ changed → worker restart at close-out)" : ""}`; }
      // The polish point (spec 0064): decidePolishAction is the pure
      // touches-web / already-polished / manual decision (unit-tested in
      // polish-decision.test.ts). By default the watcher spawns the
      // uiux-coder itself and continues in this same process; --manual-polish
      // restores today's hands-on pause verbatim.
      const { decidePolishAction } = require(`${REPO}/packages/pipeline/dist/polish-decision.js`);
      const polishAction = decidePolishAction({ touchesWeb: touchesWebFlag, polished: polishDone, autoPolish: AUTO_POLISH });
      if (polishAction === "manual-pause") {
        polishDone = true;
        polishPause(`${WF} parked at gate 3 (merged, web-smoke GREEN) and touched apps/web. Do the hands-on impeccable polish/live pass against the dev server (http://localhost:${WEB_PORT}) — verify both themes + motion, tune, commit + push to main — then re-launch: node scripts/supervise.mjs ${specId} --polished --no-start. Do NOT promote until the polish pass is done.`);
      } else if (polishAction === "auto-spawn") {
        // Spec 0197: the uiux-coder is gone, so "auto-spawn" degrades to the
        // same hands-on pause. Kept as a branch rather than deleted from
        // `decidePolishAction` because that pure function is tested and the
        // watcher is frozen (ADR-022) — this is the smallest honest edit.
        polishDone = true;
        polishPause(`${WF} parked at gate 3 (merged, web-smoke GREEN) and touched apps/web. Auto-polish was retired (spec 0197): do the hands-on pass against the dev server (http://localhost:${WEB_PORT}), then re-launch with --polished --no-start.`);
      }
      if (!cued[phase]) {
        cued[phase] = true;
        const cueMsg = `post-merge checks passed${polishDone ? " + polish pass done" : ""}. CUE: click "Promote" at http://localhost:${WEB_PORT}/specs/${specId}`;
        log(`GATE 3 — ${cueMsg}`);
        emit({ type: "cue", gate: 3, msg: cueMsg });
      }
    }
  } else if (phase === "promoted" || (status === "COMPLETED")) {
    closeOut(runFacts || "run completed");
    done(`${WF} promoted + closed out`);
  } else if (phase === "failed" || phase === "rejected") {
    fail(20, `terminal phase: ${phase}`);
  }

  await new Promise((r) => setTimeout(r, POLL_MS));
}
// Hitting the poll cap while still PARKED AT A GATE is a normal human-gate wait
// (the pipeline can wait days), not a failure — exit 0 benignly and let the
// supervisor re-attach when the human acts. Only a non-gate hang is a real 50.
if (GATES.includes(lastPhase)) {
  const benignMsg = `still parked at gate '${lastPhase}' after ~2.5h — normal human-gate wait, not a failure. Re-launch \`node scripts/supervise.mjs ${specId} --no-start\` to resume watching when the gate is actioned.`;
  log(benignMsg);
  emit({ type: "done", benign: true, msg: benignMsg });
  try { conn.close(); } catch {}
  process.exit(0);
}
fail(50, "max iterations reached (run still not terminal after ~2.5h, NOT at a gate — genuinely hung)");
