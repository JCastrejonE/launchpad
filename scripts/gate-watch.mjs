#!/usr/bin/env node
/**
 * gate-watch.mjs — SUPERVISOR TOOLING (not pipeline/product code; improvable).
 *
 * Watches one specPipeline run end-to-end so the supervisor reacts to the owner's
 * gate clicks (which show up as Temporal phase transitions) instead of the owner
 * prompting after every gate. Run it in the background; it EXITS (→ the
 * supervisor is notified) at every actionable moment:
 *   - a gate-parked phase (awaiting_spec_approval / _pr_approval / _promotion)
 *   - a terminal state (COMPLETED / promoted / FAILED / TERMINATED / rejected)
 *   - ANY error (new TMPRL1100, new gate-2 poll failure, worker restart/death,
 *     primary checkout leaving main or going dirty, a coder activity attempt
 *     that FAILED, or web /api/health down)
 * The supervisor reads the trail, acts (verify / review / cue the owner / fix), and
 * relaunches to watch the next segment. On an error exit we solve manually and
 * improve THIS script.
 *
 * Usage:  node scripts/gate-watch.mjs <spec> [--from <phase>]
 *   <spec>       platform: 0020            (→ spec-0020)
 *                project:  cafeteria-0005  (→ spec-cafeteria-0005)
 *                or the full workflow id, passed through unchanged.
 *                USE THIS instead of a hand-rolled psql poll — it exits at the
 *                gate-parked phases, so it can tell "working" from "blocked".
 *   --from       phase to treat as the starting baseline (default: current)
 *
 * Design notes:
 *   - Error signals use BASELINE-DELTA, not date-string matching: we count
 *     TMPRL1100 / heartbeat-timeout / poll-failure lines in worker.log at
 *     startup and only alarm when the count INCREASES. (The date-string
 *     approach gave stale false-positives; this is the improvement.)
 *   - Web /api/health non-200 is a SOFT alarm by default (known .next
 *     papercut, largely mitigated by 0017 worktrees) — it logs loudly and
 *     exits so the supervisor can decide, but see WEB_HARD to make it fatal.
 *   - gate2Poll (spec 0016): the status line also prints the workflow's
 *     `gate2Poll` query answer (idle/polling/settled/failed, +truncated error
 *     when failed). This is a log-independent SECOND SOURCE for the same
 *     signal the worker.log `pollFail` counter already tracks — it does not
 *     add a new stop condition (the pollFail baseline-delta above stays the
 *     primary tripwire). On a pre-0016 workflow snapshot the query isn't
 *     registered yet, so this prints "q?" (bootstrap note, spec 0016).
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";

const require = createRequire("/home/dev/launchpad/apps/web/index.js");
const { Connection, Client } = require("@temporalio/client");

const REPO = "/home/dev/launchpad";
const WL = `${REPO}/.preflight/worker.log`;
const HEALTH_URL = "http://localhost:3001/api/health";
const POLL_MS = 12_000;
const WEB_HARD = false; // set true to treat a web 500 as a fatal interrupt

// A run's workflow id is `spec-<id>` for the platform and `spec-<slug>-<id>` for
// every other project. This used to strip every non-digit, so `cafeteria-0005`
// became `spec-0005` — a workflow that does not exist — and every A/B run got a
// hand-rolled poll instead (spec 0201; docs/VERIFICATION.md #11). Prepend
// `spec-` when absent; never strip a prefix, so #11 cannot recur here.
const arg = (process.argv[2] || "").trim();
if (!arg || !/^[a-z0-9-]+$/i.test(arg)) {
  console.error("usage: node scripts/gate-watch.mjs <spec>   e.g. 0020 | cafeteria-0005 | spec-cafeteria-0005");
  process.exit(2);
}
const WF = arg.startsWith("spec-") ? arg : `spec-${arg}`;
const OUT = `${REPO}/.preflight/gate-watch-${WF}.out`;
const GATES = ["awaiting_spec_approval", "awaiting_pr_approval", "awaiting_promotion"];
const TERMINAL = ["failed", "rejected", "promoted"]; // pipelinePhase terminals

const sh = (cmd) => { try { return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
const countLines = (pat) => { const n = sh(`grep -c ${JSON.stringify(pat)} ${JSON.stringify(WL)} 2>/dev/null`); return Number(n || "0"); };
const log = (s) => { const line = `${new Date().toLocaleTimeString()} ${s}`; fs.appendFileSync(OUT, line + "\n"); console.log(line); };

fs.writeFileSync(OUT, `gate-watch ${WF} start\n`);

// baselines
const base = {
  tmprl: countLines("TMPRL1100"),
  hbTimeout: countLines("Heartbeat timeout"),
  pollFail: countLines("gate-2 approval poll failed"),
  workerPid: sh(`ps aux | grep "dist/worker.js" | grep -v grep | awk '{print $2}' | head -1`),
  buildId: (sh(`grep "spec-pipeline up" ${JSON.stringify(WL)} | tail -1`).match(/buildId: ([a-f0-9]+)/) || [])[1] || "?",
};
log(`baseline: tmprl=${base.tmprl} hbTimeout=${base.hbTimeout} pollFail=${base.pollFail} workerPid=${base.workerPid} buildId=${base.buildId}`);

const c = await Connection.connect({ address: "localhost:7233" });
const client = new Client({ connection: c });
const h = client.workflow.getHandle(WF);

function stop(reason, code) {
  log(`STOP [${reason}]`);
  try { c.close(); } catch { /* read-only watcher; abrupt exit is fine */ }
  process.exit(code); // synchronous — first stop wins, no further checks run
}

// Default: break on ANY gate, INCLUDING the one we launch in (so launching
// while already parked at an un-handled gate alerts immediately — the fix for
// the power-loss/fast-resume case where the run reached gate 2 before the
// watcher started). Pass `--from <phase>` to skip ONE gate you've already
// handled (e.g. relaunch `--from awaiting_spec_approval` after approving spec,
// so it doesn't re-break on gate 1 while waiting for gate 2).
const fromArg = (() => { const i = process.argv.indexOf("--from"); return i !== -1 ? process.argv[i + 1] : null; })();
const startPhase = fromArg; // null = break on every gate

let lastLine = "";
let sawRunning = false; // gate terminal-status stops until we've actually seen this watch's run RUNNING
for (let i = 0; i < 400; i++) {
  let status = "?", phase = "?", pend = "";
  try {
    const d = await h.describe();
    status = d.status?.name;
    pend = (d.raw?.pendingActivities || [])
      .map((p) => `${p.activityType?.name}#${p.attempt}${p.lastFailure ? " FAIL:" + (p.lastFailure.message || "").slice(0, 50) : ""}`)
      .join(",");
  } catch (e) { status = "describe-err"; }
  try { phase = await h.query("pipelinePhase"); } catch { phase = "q?"; }
  let gate2Poll = "?";
  try {
    const g = await h.query("gate2Poll");
    gate2Poll = g ? `${g.status}${g.status === "failed" ? `:${(g.error || "").slice(0, 40)}` : ""}` : "unavailable";
  } catch { gate2Poll = "q?"; } // pre-0016 snapshot: query not registered yet (spec 0016 bootstrap note)

  // environment signals
  const workerPid = sh(`ps aux | grep "dist/worker.js" | grep -v grep | awk '{print $2}' | head -1`);
  const primaryBranch = sh(`git -C ${REPO} rev-parse --abbrev-ref HEAD`);
  const primaryDirty = sh(`git -C ${REPO} status --porcelain`) ? "DIRTY" : "clean";
  const tmprl = countLines("TMPRL1100");
  const hbTimeout = countLines("Heartbeat timeout");
  const pollFail = countLines("gate-2 approval poll failed");
  const health = sh(`curl -s -o /dev/null -w "%{http_code}" ${HEALTH_URL}`) || "?";

  const line = `${status} phase=${phase} pend=[${pend}] primary=${primaryBranch}/${primaryDirty} worker=${workerPid} tmprl=${tmprl} hbTO=${hbTimeout} pollFail=${pollFail} gate2Poll=${gate2Poll} health=${health}`;
  if (line !== lastLine) { log(line); lastLine = line; }

  // ---- ERROR interrupts (baseline-delta) ----
  if (tmprl > base.tmprl) stop(`NEW TMPRL1100 (nondeterminism)`, 10);
  if (hbTimeout > base.hbTimeout) stop(`NEW heartbeat timeout`, 11);
  if (pollFail > base.pollFail) stop(`NEW gate-2 poll failure (getPrState)`, 12);
  if (base.workerPid && workerPid && workerPid !== base.workerPid) stop(`WORKER PID CHANGED ${base.workerPid}->${workerPid} (mid-run restart)`, 13);
  if (base.workerPid && !workerPid) stop(`WORKER DIED (pid ${base.workerPid} gone)`, 14);
  if (primaryBranch && primaryBranch !== "main") stop(`PRIMARY LEFT MAIN (on ${primaryBranch}) — 0017 isolation violation`, 15);
  // A transient dirty during `drafting` is EXPECTED: draftSpec writes
  // specs/NNNN-*.md to the primary checkout and then harness-commits it (spec
  // 0029 Part A). The 12s poll can catch that sub-second write→commit window.
  // Tolerate it ONLY while phase === "drafting"; if the draft is genuinely
  // left uncommitted (the 0028 regression), the tree stays dirty and the phase
  // advances to awaiting_spec_approval — where this tripwire still fires.
  if (primaryDirty === "DIRTY" && phase !== "drafting") stop(`PRIMARY CHECKOUT DIRTY — 0017 isolation violation`, 16);
  if (primaryDirty === "DIRTY" && phase === "drafting") log(`(primary dirty during drafting — expected draftSpec write→commit window, spec 0029; not interrupting)`);
  if (/#\d+ FAIL:/.test(pend)) stop(`ACTIVITY ATTEMPT FAILED: ${pend}`, 17);
  if (health !== "200") { if (WEB_HARD) stop(`WEB ${health}`, 18); else log(`!!! WEB ${health} (soft — .next papercut; not interrupting)`); }

  // ---- actionable stops ----
  // describe-err / not-started: the run hasn't been Started yet — keep polling
  // (so the watcher can be launched before the owner clicks Start).
  const TERMINAL_STATUS = ["COMPLETED", "FAILED", "TERMINATED", "CANCELED", "TIMED_OUT", "CONTINUED_AS_NEW"];
  if (status === "RUNNING") sawRunning = true;
  // A terminal status stops the watch ONLY after we've seen THIS session's run
  // RUNNING — otherwise a pre-existing terminal at launch (a prior run we just
  // terminated while awaiting a fresh Start, or a re-run) would false-stop with
  // exit 20 before the new run even begins. With the not-started tolerance
  // above, the watcher can be launched before OR after a re-run's Start and
  // still catch the NEW run's transitions.
  if (sawRunning && TERMINAL_STATUS.includes(status)) stop(`workflow ${status}`, status === "COMPLETED" ? 0 : 20);
  // only break on a gate/terminal-phase we TRANSITIONED into (not the launch
  // phase), and only once we've seen THIS session's run RUNNING (so a stale
  // phase from a just-terminated prior run can't false-stop pre-Start)
  if (sawRunning && phase !== startPhase) {
    if (GATES.includes(phase)) stop(`parked at gate: ${phase}`, 0);
    if (TERMINAL.includes(phase)) stop(`terminal phase: ${phase}`, phase === "promoted" ? 0 : 21);
  }

  await new Promise((r) => setTimeout(r, POLL_MS));
}
stop("max iterations reached (still running)", 30);
