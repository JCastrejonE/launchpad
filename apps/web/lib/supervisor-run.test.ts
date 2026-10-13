/**
 * Tests for spec 0052 item D — the run-follow lib (pure helpers + the
 * injectable-deps composition functions). No live Temporal server / real
 * filesystem / real `ps`/`spawn` — every IO seam is faked via the exported
 * `*Deps` interfaces (see supervisor-run.ts's own doc comment).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PIPELINE_PHASES, isTerminalPhase, serializeWatcherEvent } from "@launchpad/pipeline";
import type { PipelinePhase } from "@launchpad/pipeline";
import {
  buildPolishedSpawnArgs,
  buildRecoverSpawnArgs,
  buildWatcherSpawnArgs,
  deriveRunSteps,
  getRunFollowState,
  hasRecoverProcess,
  isWatcherRunning,
  LAUNCHPAD_REPO_ROOT,
  parseWatcherMode,
  parseWatcherProcesses,
  resolveStartMode,
  checkStartPreconditions,
  runStartPipelineAction,
  spawnPolishedWatcher,
  spawnRecover,
  spawnStartWatcher,
  spawnWatcher,
  type GetRunFollowStateDeps,
  type SpawnRecoverDeps,
  type SpawnStartWatcherDeps,
  type SpawnWatcherDeps,
  type StartPipelineActionDeps,
} from "./supervisor-run.js";
import type { PipelineViewState } from "./pipeline.js";
import type { SupervisorAccessResult } from "./supervisor-console.js";

// ---------------------------------------------------------------------------
// buildWatcherSpawnArgs — the never-signal-a-gate re-proof.
// ---------------------------------------------------------------------------

test("buildWatcherSpawnArgs: exact follow-only argv, no `start`, no gate signal", () => {
  const args = buildWatcherSpawnArgs("0052");
  assert.deepEqual(args, ["scripts/supervise.mjs", "0052", "--no-start", "--events"]);
  assert.ok(!args.includes("start"));
  for (const signal of ["specApproved", "prApproved", "promote", "specRejected"]) {
    assert.ok(!args.includes(signal));
  }
});

test("buildWatcherSpawnArgs: argv shape is stable across spec ids", () => {
  assert.deepEqual(buildWatcherSpawnArgs("1234"), [
    "scripts/supervise.mjs",
    "1234",
    "--no-start",
    "--events",
  ]);
});

// ---------------------------------------------------------------------------
// parseWatcherProcesses / isWatcherRunning
// ---------------------------------------------------------------------------

const PS_LINE = (pid: number, specId: string, extra = "") =>
  `owner  ${pid}  0.0  0.1  4321  1234 ??  S  1:00PM  0:00.10 node scripts/supervise.mjs ${specId} --no-start${extra}`;

test("parseWatcherProcesses: parses the ps aux line shape (pid=col 1, specId after supervise.mjs)", () => {
  const out = [PS_LINE(12345, "0052"), PS_LINE(23456, "0007")].join("\n");
  assert.deepEqual(parseWatcherProcesses(out), [
    { pid: 12345, specId: "0052" },
    { pid: 23456, specId: "0007" },
  ]);
});

test("parseWatcherProcesses: excludes --recover invocations", () => {
  const out = [PS_LINE(12345, "0052"), PS_LINE(23456, "0007", " --recover")].join("\n");
  assert.deepEqual(parseWatcherProcesses(out), [{ pid: 12345, specId: "0052" }]);
});

test("parseWatcherProcesses: skips blank lines and lines with no supervise.mjs match", () => {
  const out = ["", "   ", "owner  999  something unrelated line", PS_LINE(555, "0099")].join("\n");
  assert.deepEqual(parseWatcherProcesses(out), [{ pid: 555, specId: "0099" }]);
});

test("parseWatcherProcesses: empty ps output yields no processes", () => {
  assert.deepEqual(parseWatcherProcesses(""), []);
});

test("isWatcherRunning: true only when the specId is among the processes", () => {
  const processes = parseWatcherProcesses(PS_LINE(1, "0052"));
  assert.equal(isWatcherRunning(processes, "0052"), true);
  assert.equal(isWatcherRunning(processes, "0007"), false);
  assert.equal(isWatcherRunning([], "0052"), false);
});

// ---------------------------------------------------------------------------
// deriveRunSteps — across ALL PIPELINE_PHASES, including terminals.
// ---------------------------------------------------------------------------

test("deriveRunSteps: undefined phase yields the empty stepper", () => {
  assert.deepEqual(deriveRunSteps(undefined), []);
});

test("deriveRunSteps: across every non-terminal phase, done/current/upcoming split at the right index", () => {
  const nonTerminal = PIPELINE_PHASES.filter((p) => !isTerminalPhase(p));
  for (let i = 0; i < nonTerminal.length; i++) {
    const phase = nonTerminal[i] as PipelinePhase;
    const steps = deriveRunSteps(phase);
    assert.equal(steps.length, nonTerminal.length, `phase ${phase}: step count`);
    steps.forEach((step, j) => {
      assert.equal(step.phase, nonTerminal[j]);
      const expected = j < i ? "done" : j === i ? "current" : "upcoming";
      assert.equal(step.status, expected, `phase ${phase} step ${step.phase}`);
    });
  }
});

test("deriveRunSteps: every terminal phase collapses the remainder — all non-terminal done, ONE current terminal step, nothing upcoming", () => {
  const nonTerminal = PIPELINE_PHASES.filter((p) => !isTerminalPhase(p));
  const terminals = PIPELINE_PHASES.filter((p) => isTerminalPhase(p));
  assert.ok(terminals.length > 1, "sanity: more than one terminal phase exists");
  for (const phase of terminals) {
    const steps = deriveRunSteps(phase);
    assert.equal(steps.length, nonTerminal.length + 1);
    steps.slice(0, -1).forEach((step, j) => {
      assert.equal(step.phase, nonTerminal[j]);
      assert.equal(step.status, "done");
    });
    const last = steps[steps.length - 1];
    assert.equal(last?.phase, phase);
    assert.equal(last?.status, "current");
    // No OTHER terminal phase ever appears — the alternates never happened.
    for (const other of terminals) {
      if (other === phase) continue;
      assert.ok(!steps.some((s) => s.phase === other), `${phase}: ${other} must not appear`);
    }
  }
});

// ---------------------------------------------------------------------------
// getRunFollowState — degraded modes, never throws.
// ---------------------------------------------------------------------------

function fakeGetRunFollowStateDeps(overrides: Partial<GetRunFollowStateDeps> = {}): GetRunFollowStateDeps {
  return {
    getPipelineViewStateSafe: async () => null,
    listWatcherProcesses: () => "",
    readEventsFile: () => "",
    listRecoverProcesses: () => "",
    ...overrides,
  };
}

test("getRunFollowState: Temporal down -> view null, steps empty, never throws", async () => {
  const state = await getRunFollowState("0052", "", fakeGetRunFollowStateDeps());
  assert.equal(state.specId, "0052");
  assert.equal(state.view, null);
  assert.deepEqual(state.steps, []);
  assert.equal(state.watcher.running, false);
  assert.deepEqual(state.events, []);
});

test("getRunFollowState: live view with a phase derives the stepper and passes through", async () => {
  const view: PipelineViewState = {
    state: "running",
    availableActions: [],
    canStart: false,
    phase: "coding",
  };
  const state = await getRunFollowState("0052", "",
    fakeGetRunFollowStateDeps({ getPipelineViewStateSafe: async () => view }),
  );
  assert.equal(state.view, view);
  assert.ok(state.steps.some((s) => s.phase === "coding" && s.status === "current"));
});

test("getRunFollowState: no events file -> events []", async () => {
  const state = await getRunFollowState("0052", "", fakeGetRunFollowStateDeps({ readEventsFile: () => "" }));
  assert.deepEqual(state.events, []);
});

test("getRunFollowState: events file present -> parsed tail returned", async () => {
  const line = serializeWatcherEvent({ type: "cue", gate: 1, msg: "gate 1 cue", ts: "2026-01-01T00:00:00.000Z" });
  const state = await getRunFollowState("0052", "",
    fakeGetRunFollowStateDeps({ readEventsFile: () => line + "\n" }),
  );
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0]?.type, "cue");
});

test("getRunFollowState: watcher dead (not in ps output) -> running false", async () => {
  const state = await getRunFollowState("0052", "",
    fakeGetRunFollowStateDeps({ listWatcherProcesses: () => PS_LINE(1, "0007") }),
  );
  assert.deepEqual(state.watcher, { running: false });
});

test("getRunFollowState: watcher alive for this spec -> running true with pid", async () => {
  const state = await getRunFollowState("0052", "",
    fakeGetRunFollowStateDeps({ listWatcherProcesses: () => PS_LINE(4242, "0052") }),
  );
  assert.deepEqual(state.watcher, { running: true, pid: 4242 });
});

test("getRunFollowState: a throwing ps/events dep degrades that field instead of throwing", async () => {
  const state = await getRunFollowState("0052", "",
    fakeGetRunFollowStateDeps({
      listWatcherProcesses: () => {
        throw new Error("ps unavailable");
      },
      readEventsFile: () => {
        throw new Error("fs unavailable");
      },
    }),
  );
  assert.deepEqual(state.watcher, { running: false });
  assert.deepEqual(state.events, []);
});

// ---------------------------------------------------------------------------
// getRunFollowState: `recovering` (spec 0057 phase 4b §5) — additive,
// degraded-safe ps derivation.
// ---------------------------------------------------------------------------

test("getRunFollowState: no --recover process -> recovering false", async () => {
  const state = await getRunFollowState("0052", "", fakeGetRunFollowStateDeps());
  assert.equal(state.recovering, false);
});

test("getRunFollowState: a live --recover process -> recovering true", async () => {
  const state = await getRunFollowState("0052", "",
    fakeGetRunFollowStateDeps({
      listRecoverProcesses: () =>
        "owner  1  0.0  0.1  4321  1234 ??  S  1:00PM  0:00.10 node scripts/supervise.mjs --recover 0052 --events",
    }),
  );
  assert.equal(state.recovering, true);
});

test("getRunFollowState: a throwing listRecoverProcesses dep degrades recovering to false, never throws", async () => {
  const state = await getRunFollowState("0052", "",
    fakeGetRunFollowStateDeps({
      listRecoverProcesses: () => {
        throw new Error("ps unavailable");
      },
    }),
  );
  assert.equal(state.recovering, false);
});

// ---------------------------------------------------------------------------
// spawnWatcher — refusals + happy path.
// ---------------------------------------------------------------------------

function fakeSpawnWatcherDeps(overrides: Partial<SpawnWatcherDeps> = {}): SpawnWatcherDeps {
  return {
    describePipeline: async () => ({ exists: true, status: "RUNNING" }),
    listWatcherProcesses: () => "",
    spawnWatcherProcess: () => 9999,
    ...overrides,
  };
}

test("spawnWatcher: refuses a malformed spec id", async () => {
  const result = await spawnWatcher("52", fakeSpawnWatcherDeps());
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /invalid spec id/);
});

test("spawnWatcher: refuses when a watcher is already following this run", async () => {
  const deps = fakeSpawnWatcherDeps({ listWatcherProcesses: () => PS_LINE(1, "0052") });
  const result = await spawnWatcher("0052", deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /already following/);
});

test("spawnWatcher: refuses when the workflow does not exist", async () => {
  const deps = fakeSpawnWatcherDeps({ describePipeline: async () => ({ exists: false }) });
  const result = await spawnWatcher("0052", deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no workflow has been started/);
});

test("spawnWatcher: refuses when the workflow is not RUNNING", async () => {
  const deps = fakeSpawnWatcherDeps({ describePipeline: async () => ({ exists: true, status: "COMPLETED" }) });
  const result = await spawnWatcher("0052", deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not RUNNING/);
});

test("spawnWatcher: refuses (never throws) when describePipeline itself throws", async () => {
  const deps = fakeSpawnWatcherDeps({
    describePipeline: async () => {
      throw new Error("temporal unreachable");
    },
  });
  const result = await spawnWatcher("0052", deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /could not reach Temporal/);
});

test("spawnWatcher: happy path spawns with buildWatcherSpawnArgs and returns the pid", async () => {
  let calledArgs: string[] | undefined;
  const deps = fakeSpawnWatcherDeps({
    spawnWatcherProcess: (args) => {
      calledArgs = args;
      return 5555;
    },
  });
  const result = await spawnWatcher("0052", deps);
  assert.deepEqual(result, { ok: true, pid: 5555 });
  assert.deepEqual(calledArgs, buildWatcherSpawnArgs("0052"));
});

// ---------------------------------------------------------------------------
// parseWatcherMode — the route's optional-body dispatch, pure so it's
// testable without a live Request/Response.
// ---------------------------------------------------------------------------

test("parseWatcherMode: empty body defaults to follow (phase-3 byte-compat)", () => {
  assert.equal(parseWatcherMode(""), "follow");
});

test("parseWatcherMode: unparseable JSON defaults to follow", () => {
  assert.equal(parseWatcherMode("not json"), "follow");
});

test("parseWatcherMode: null / non-object body defaults to follow", () => {
  assert.equal(parseWatcherMode("null"), "follow");
  assert.equal(parseWatcherMode("42"), "follow");
  assert.equal(parseWatcherMode('"start"'), "follow");
});

test("parseWatcherMode: absent mode field defaults to follow", () => {
  assert.equal(parseWatcherMode("{}"), "follow");
});

test("parseWatcherMode: explicit follow/start/recover/resume-polished pass through", () => {
  assert.equal(parseWatcherMode('{"mode":"follow"}'), "follow");
  assert.equal(parseWatcherMode('{"mode":"start"}'), "start");
  assert.equal(parseWatcherMode('{"mode":"recover"}'), "recover");
  assert.equal(parseWatcherMode('{"mode":"resume-polished"}'), "resume-polished");
});

test("parseWatcherMode: unknown mode value is invalid", () => {
  assert.equal(parseWatcherMode('{"mode":"reboot"}'), "invalid");
  assert.equal(parseWatcherMode('{"mode":123}'), "invalid");
});

// ---------------------------------------------------------------------------
// spawnStartWatcher — refusal ladder + proceed paths (spec 0056 phase 4c).
// ---------------------------------------------------------------------------

/** The request + actor a start carries since spec 0131 B — supplied by the
 * caller (route/server action), never synthesised further down. */
const REQ = "make the thing";
const WHO = "owner@example.com";

function fakeSpawnStartWatcherDeps(overrides: Partial<SpawnStartWatcherDeps> = {}): SpawnStartWatcherDeps {
  return {
    describePipeline: async () => ({ exists: false }),
    listWatcherProcesses: () => "",
    spawnWatcherProcess: () => 9999,
    specFileExists: () => true,
    startPipeline: async () => {},
    ...overrides,
  };
}

test("spawnStartWatcher: refuses a malformed spec id", async () => {
  const result = await spawnStartWatcher("52", REQ, WHO, fakeSpawnStartWatcherDeps());
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /invalid spec id/);
});

test("spawnStartWatcher: refuses when no spec file exists on disk", async () => {
  const deps = fakeSpawnStartWatcherDeps({ specFileExists: () => false });
  const result = await spawnStartWatcher("0056", REQ, WHO, deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no spec file/);
});

test("spawnStartWatcher: refuses when a watcher is already following this run", async () => {
  const deps = fakeSpawnStartWatcherDeps({ listWatcherProcesses: () => PS_LINE(1, "0056") });
  const result = await spawnStartWatcher("0056", REQ, WHO, deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /already following/);
});

test("spawnStartWatcher: refuses when the workflow is already RUNNING", async () => {
  const deps = fakeSpawnStartWatcherDeps({ describePipeline: async () => ({ exists: true, status: "RUNNING" }) });
  const result = await spawnStartWatcher("0056", REQ, WHO, deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /already started/);
});

test("spawnStartWatcher: refuses when the workflow already COMPLETED", async () => {
  const deps = fakeSpawnStartWatcherDeps({ describePipeline: async () => ({ exists: true, status: "COMPLETED" }) });
  const result = await spawnStartWatcher("0056", REQ, WHO, deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /already completed/);
});

test("spawnStartWatcher: refuses (never throws) when describePipeline itself throws", async () => {
  const deps = fakeSpawnStartWatcherDeps({
    describePipeline: async () => {
      throw new Error("temporal unreachable");
    },
  });
  const result = await spawnStartWatcher("0056", REQ, WHO, deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /could not reach Temporal/);
});

test("spawnStartWatcher: NOT_FOUND (no workflow yet) proceeds — fresh start", async () => {
  let calledArgs: string[] | undefined;
  const deps = fakeSpawnStartWatcherDeps({
    describePipeline: async () => ({ exists: false }),
    spawnWatcherProcess: (args) => {
      calledArgs = args;
      return 4242;
    },
  });
  const result = await spawnStartWatcher("0056", REQ, WHO, deps);
  assert.deepEqual(result, { ok: true, pid: 4242 });
  assert.deepEqual(calledArgs, buildWatcherSpawnArgs("0056"));
});

// ---------------------------------------------------------------------------
// Spec 0131 A — the START is `startPipeline`, and the watcher only ATTACHES.
//
// The defect these cover: dropping `--no-start` made `supervise.mjs` start the
// run itself via `cli start`, which reads `LAUNCHPAD_REPO_ROOT` and knows
// nothing about projects — so every run from the UI's Start button worked on the
// launchpad's own repository, whatever project the spec belonged to. The old
// behaviour must not be reachable, which is what the argv assertions below are
// for: a watcher spawned WITHOUT `--no-start` would start a second run, on the
// wrong repo.
// ---------------------------------------------------------------------------

test("spawnStartWatcher: starts the workflow through startPipeline with the caller's request + actor", async () => {
  const starts: Array<[string, string, string]> = [];
  const deps = fakeSpawnStartWatcherDeps({
    startPipeline: async (specId, request, requestedBy) => {
      starts.push([specId, request, requestedBy]);
    },
  });
  const result = await spawnStartWatcher("0056", REQ, WHO, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(starts, [["0056", REQ, WHO]]);
});

test("spawnStartWatcher: the watcher it spawns ATTACHES — `--no-start` present, never a starter", async () => {
  let calledArgs: string[] = [];
  const deps = fakeSpawnStartWatcherDeps({
    spawnWatcherProcess: (args) => {
      calledArgs = args;
      return 1;
    },
  });
  await spawnStartWatcher("0056", REQ, WHO, deps);
  assert.ok(calledArgs.includes("--no-start"), `watcher argv would START a run: ${calledArgs.join(" ")}`);
  assert.deepEqual(calledArgs, ["scripts/supervise.mjs", "0056", "--no-start", "--events"]);
});

test("spawnStartWatcher: a failed start refuses and spawns NO watcher", async () => {
  let spawned = 0;
  const deps = fakeSpawnStartWatcherDeps({
    startPipeline: async () => {
      throw new Error("prueba no tiene repositorio vinculado");
    },
    spawnWatcherProcess: () => {
      spawned += 1;
      return 1;
    },
  });
  const result = await spawnStartWatcher("0056", REQ, WHO, deps);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no tiene repositorio vinculado/);
  assert.equal(spawned, 0);
});

for (const [name, overrides] of [
  ["a malformed id", { specFileExists: () => true }],
  ["no spec file", { specFileExists: () => false }],
  ["a live watcher", { listWatcherProcesses: () => PS_LINE(1, "0056") }],
  ["a RUNNING workflow", { describePipeline: async () => ({ exists: true, status: "RUNNING" as const }) }],
] as Array<[string, Partial<SpawnStartWatcherDeps>]>) {
  test(`spawnStartWatcher: refusal on ${name} starts NO workflow`, async () => {
    let started = 0;
    const deps = fakeSpawnStartWatcherDeps({
      ...overrides,
      startPipeline: async () => {
        started += 1;
      },
    });
    // The malformed-id case is the id itself, not a dep — hence the two ids.
    const result = await spawnStartWatcher(name === "a malformed id" ? "56" : "0056", REQ, WHO, deps);
    assert.equal(result.ok, false);
    assert.equal(started, 0);
  });
}

for (const status of ["FAILED", "TERMINATED", "CANCELLED", "TIMED_OUT"] as const) {
  test(`spawnStartWatcher: closed-unsuccessful status ${status} proceeds — supervise.mjs restarts fresh`, async () => {
    const deps = fakeSpawnStartWatcherDeps({ describePipeline: async () => ({ exists: true, status }) });
    const result = await spawnStartWatcher("0056", REQ, WHO, deps);
    assert.deepEqual(result.ok, true);
  });
}

test("spawnStartWatcher: happy path spawns the follow watcher in the launchpad checkout and returns the pid", async () => {
  let calledArgs: string[] | undefined;
  let calledCwd: string | undefined;
  const deps = fakeSpawnStartWatcherDeps({
    spawnWatcherProcess: (args, cwd) => {
      calledArgs = args;
      calledCwd = cwd;
      return 5656;
    },
  });
  const result = await spawnStartWatcher("0056", REQ, WHO, deps);
  assert.deepEqual(result, { ok: true, pid: 5656 });
  assert.deepEqual(calledArgs, ["scripts/supervise.mjs", "0056", "--no-start", "--events"]);
  // The WATCHER still runs in the launchpad checkout (that is where the script,
  // its events file and its preflight artifacts live) — the RUN's checkout is a
  // separate question, answered by `startPipeline` from the spec's project.
  assert.equal(calledCwd, LAUNCHPAD_REPO_ROOT);
});

// ---------------------------------------------------------------------------
// resolveStartMode / runStartPipelineAction — the gate-aware spec-page Start
// dispatch shared with the run route (spec 0056 item B).
// ---------------------------------------------------------------------------

const ACCESS_OK: SupervisorAccessResult = { ok: true };
const ACCESS_DENIED: SupervisorAccessResult = { ok: false, reason: "supervisor console is disabled" };

test("resolveStartMode: gate ON (access.ok) -> watched", () => {
  assert.equal(resolveStartMode(ACCESS_OK), "watched");
});

test("resolveStartMode: gate OFF (access not ok) -> bare", () => {
  assert.equal(resolveStartMode(ACCESS_DENIED), "bare");
});

function fakeStartPipelineActionDeps(
  overrides: Partial<StartPipelineActionDeps> = {},
): StartPipelineActionDeps {
  return {
    spawnStartWatcher: async () => {
      throw new Error("spawnStartWatcher should not be called on this branch");
    },
    startPipeline: async () => {
      throw new Error("startPipeline should not be called on this branch");
    },
    // Spec 0117: the bare branch validates the spec exists too. Default to
    // "it exists" so the pre-existing branch tests below keep testing the
    // branch, not the new guard — the guard has its own tests.
    specFileExists: () => true,
    ...overrides,
  };
}

// --- spec 0117: the bare branch validates too -------------------------------

test("runStartPipelineAction: gate OFF refuses a spec with no file — never reaches startPipeline", async () => {
  // The live defect: a MEMBER (who never passes supervisorAccess, so always
  // takes the bare branch) POSTed a start for nonexistent spec 9999 and Temporal
  // accepted a garbage workflow. An OWNER on the watched branch was refused.
  let started = false;
  const deps = fakeStartPipelineActionDeps({
    specFileExists: () => false,
    startPipeline: async () => {
      started = true;
    },
  });
  const result = await runStartPipelineAction("9999", "t", "member@example.com", ACCESS_DENIED, deps);
  assert.deepEqual(result, {
    ok: false,
    reason: "spec 9999: no spec file (specs/9999-*.md) found on disk",
  });
  assert.equal(started, false, "no workflow may be started for a spec that does not exist");
});

test("runStartPipelineAction: gate OFF refuses a malformed spec id", async () => {
  const deps = fakeStartPipelineActionDeps({ startPipeline: async () => {} });
  const result = await runStartPipelineAction("not-an-id", "t", "member@example.com", ACCESS_DENIED, deps);
  assert.equal(result.ok, false);
});

test("both branches refuse the SAME spec for the SAME reason", async () => {
  // The asymmetry is the bug, so the property under test is the agreement —
  // not either branch's behaviour on its own.
  const bare = await runStartPipelineAction(
    "9999",
    "t",
    "member@example.com",
    ACCESS_DENIED,
    fakeStartPipelineActionDeps({ specFileExists: () => false, startPipeline: async () => {} }),
  );
  const watched = await runStartPipelineAction(
    "9999",
    "t",
    "owner@example.com",
    ACCESS_OK,
    fakeStartPipelineActionDeps({
      spawnStartWatcher: async () =>
        checkStartPreconditions("9999", () => false) as { ok: false; reason: string },
    }),
  );
  assert.deepEqual(bare, watched);
});

test("checkStartPreconditions allows a well-formed id whose file exists", () => {
  assert.deepEqual(checkStartPreconditions("0117", () => true), { ok: true });
});

test("runStartPipelineAction: gate OFF calls the bare startPipeline, never spawnStartWatcher", async () => {
  let called: [string, string, string] | undefined;
  const deps = fakeStartPipelineActionDeps({
    startPipeline: async (specId, request, requestedBy) => {
      called = [specId, request, requestedBy];
    },
  });
  const result = await runStartPipelineAction("0056", "a title", "owner@example.com", ACCESS_DENIED, deps);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(called, ["0056", "a title", "owner@example.com"]);
});

test("runStartPipelineAction: gate OFF surfaces a thrown startPipeline error as a typed refusal", async () => {
  const deps = fakeStartPipelineActionDeps({
    startPipeline: async () => {
      throw new Error("LAUNCHPAD_REPO_ROOT not set");
    },
  });
  const result = await runStartPipelineAction("0056", "a title", "owner@example.com", ACCESS_DENIED, deps);
  assert.deepEqual(result, { ok: false, reason: "LAUNCHPAD_REPO_ROOT not set" });
});

test("runStartPipelineAction: gate ON calls the shared spawnStartWatcher, never bare startPipeline", async () => {
  let called: [string, string, string] | undefined;
  const deps = fakeStartPipelineActionDeps({
    spawnStartWatcher: async (specId, request, requestedBy) => {
      called = [specId, request, requestedBy];
      return { ok: true, pid: 4242 };
    },
  });
  const result = await runStartPipelineAction("0056", "a title", "owner@example.com", ACCESS_OK, deps);
  assert.deepEqual(result, { ok: true });
  // Spec 0131 B: the request and actor reach the watched branch too. They used
  // to stop here — `supervise.mjs` invented both, so a MEMBER's start and an
  // OWNER's start of the same spec recorded different (and false) requesters.
  assert.deepEqual(called, ["0056", "a title", "owner@example.com"]);
});

test("runStartPipelineAction: gate ON surfaces a spawnStartWatcher typed refusal", async () => {
  const deps = fakeStartPipelineActionDeps({
    spawnStartWatcher: async () => ({ ok: false, reason: "spec 0056: already started — use Follow" }),
  });
  const result = await runStartPipelineAction("0056", "a title", "owner@example.com", ACCESS_OK, deps);
  assert.deepEqual(result, { ok: false, reason: "spec 0056: already started — use Follow" });
});

// ---------------------------------------------------------------------------
// buildRecoverSpawnArgs / buildPolishedSpawnArgs — spec 0057 phase 4b: the
// never-signal-a-gate re-proof for both new argv builders.
// ---------------------------------------------------------------------------

test("buildRecoverSpawnArgs: exact argv, --recover precedes the id, no gate verb, no --report-only/--no-push/--request/--no-start", () => {
  const args = buildRecoverSpawnArgs("0057");
  assert.deepEqual(args, ["scripts/supervise.mjs", "--recover", "0057", "--events"]);
  for (const flag of ["--report-only", "--no-push", "--request", "--no-start"]) {
    assert.ok(!args.includes(flag), flag);
  }
  for (const signal of ["approve-spec", "approve-pr", "promote"]) {
    assert.ok(!args.includes(signal), signal);
  }
});

test("buildRecoverSpawnArgs: argv shape is stable across spec ids", () => {
  assert.deepEqual(buildRecoverSpawnArgs("1234"), ["scripts/supervise.mjs", "--recover", "1234", "--events"]);
});

test("buildPolishedSpawnArgs: exact argv, --no-start present, no gate verb, no --recover/--request", () => {
  const args = buildPolishedSpawnArgs("0057");
  assert.deepEqual(args, ["scripts/supervise.mjs", "0057", "--polished", "--no-start", "--events"]);
  assert.ok(args.includes("--no-start"));
  for (const flag of ["--recover", "--request"]) {
    assert.ok(!args.includes(flag), flag);
  }
  for (const signal of ["approve-spec", "approve-pr", "promote"]) {
    assert.ok(!args.includes(signal), signal);
  }
});

test("buildPolishedSpawnArgs: argv shape is stable across spec ids", () => {
  assert.deepEqual(buildPolishedSpawnArgs("1234"), [
    "scripts/supervise.mjs",
    "1234",
    "--polished",
    "--no-start",
    "--events",
  ]);
});

// ---------------------------------------------------------------------------
// hasRecoverProcess — pure ps parse.
// ---------------------------------------------------------------------------

test("hasRecoverProcess: true when a supervise.mjs --recover line is present", () => {
  const out = "owner  123  0.0  0.1  4321  1234 ??  S  1:00PM  0:00.10 node scripts/supervise.mjs --recover 0057 --events";
  assert.equal(hasRecoverProcess(out), true);
});

test("hasRecoverProcess: false on empty output or a plain follow-watcher line", () => {
  assert.equal(hasRecoverProcess(""), false);
  assert.equal(hasRecoverProcess(PS_LINE(1, "0057")), false);
});

// ---------------------------------------------------------------------------
// spawnRecover — refusals + happy path (spec 0057 phase 4b §2).
// ---------------------------------------------------------------------------

function fakeSpawnRecoverDeps(overrides: Partial<SpawnRecoverDeps> = {}): SpawnRecoverDeps {
  return {
    listRecoverProcesses: () => "",
    spawnWatcherProcess: () => 9999,
    ...overrides,
  };
}

test("spawnRecover: refuses a malformed spec id", async () => {
  const result = await spawnRecover("57", fakeSpawnRecoverDeps());
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /invalid spec id/);
});

test("spawnRecover: refuses when a --recover process is already in progress (double-click guard)", async () => {
  const deps = fakeSpawnRecoverDeps({
    listRecoverProcesses: () => "node scripts/supervise.mjs --recover 0057 --events",
  });
  const result = await spawnRecover("0057", deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /already in progress/);
});

test("spawnRecover: proceeds WITHOUT any Temporal pre-check (no describePipeline dep exists to call)", async () => {
  // SpawnRecoverDeps has no describePipeline field at all — this test proves
  // the ladder never needs one, unlike spawnWatcher/spawnStartWatcher/
  // spawnPolishedWatcher.
  let calledArgs: string[] | undefined;
  const deps = fakeSpawnRecoverDeps({
    spawnWatcherProcess: (args) => {
      calledArgs = args;
      return 4242;
    },
  });
  const result = await spawnRecover("0057", deps);
  assert.deepEqual(result, { ok: true, pid: 4242 });
  assert.deepEqual(calledArgs, buildRecoverSpawnArgs("0057"));
});

test("spawnRecover: proceeds even with a live FOLLOW watcher (documented convergence semantics)", async () => {
  // A live follow watcher is not a refusal reason for spawnRecover — the
  // script's own re-attach convergence handles it; the UI simply never
  // OFFERS Recover while a watcher runs.
  const deps = fakeSpawnRecoverDeps({ listRecoverProcesses: () => "" });
  const result = await spawnRecover("0057", deps);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// spawnPolishedWatcher — the spawnWatcher ladder, new argv (spec 0057 phase
// 4b §3).
// ---------------------------------------------------------------------------

test("spawnPolishedWatcher: refuses a malformed spec id", async () => {
  const result = await spawnPolishedWatcher("57", fakeSpawnWatcherDeps());
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /invalid spec id/);
});

test("spawnPolishedWatcher: refuses when a watcher is already following this run", async () => {
  const deps = fakeSpawnWatcherDeps({ listWatcherProcesses: () => PS_LINE(1, "0057") });
  const result = await spawnPolishedWatcher("0057", deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /already following/);
});

test("spawnPolishedWatcher: refuses (never throws) when describePipeline itself throws (Temporal down)", async () => {
  const deps = fakeSpawnWatcherDeps({
    describePipeline: async () => {
      throw new Error("temporal unreachable");
    },
  });
  const result = await spawnPolishedWatcher("0057", deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /could not reach Temporal/);
});

test("spawnPolishedWatcher: refuses when the workflow does not exist", async () => {
  const deps = fakeSpawnWatcherDeps({ describePipeline: async () => ({ exists: false }) });
  const result = await spawnPolishedWatcher("0057", deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no workflow has been started/);
});

test("spawnPolishedWatcher: refuses when the workflow is not RUNNING", async () => {
  const deps = fakeSpawnWatcherDeps({ describePipeline: async () => ({ exists: true, status: "COMPLETED" }) });
  const result = await spawnPolishedWatcher("0057", deps);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not RUNNING/);
});

test("spawnPolishedWatcher: a polish-paused RUNNING workflow proceeds — spawns with buildPolishedSpawnArgs", async () => {
  let calledArgs: string[] | undefined;
  const deps = fakeSpawnWatcherDeps({
    describePipeline: async () => ({ exists: true, status: "RUNNING" }),
    spawnWatcherProcess: (args) => {
      calledArgs = args;
      return 6789;
    },
  });
  const result = await spawnPolishedWatcher("0057", deps);
  assert.deepEqual(result, { ok: true, pid: 6789 });
  assert.deepEqual(calledArgs, buildPolishedSpawnArgs("0057"));
});

// --- Spec 0224: the follow must ask about the RIGHT project's run -----------

test("spec 0224: the project reaches the workflow lookup — an unscoped follow found the platform's spec 0001", async () => {
  const asked: Array<[string, string]> = [];
  await getRunFollowState("0001", "cafeteria", fakeGetRunFollowStateDeps({
    getPipelineViewStateSafe: async (specId: string, projectSlug: string) => {
      asked.push([specId, projectSlug]);
      return null;
    },
  }));
  // Before this, the second argument was hardcoded `""` — so `0001` resolved to
  // `spec-0001`, the PLATFORM's workflow, for every customer project.
  assert.deepEqual(asked, [["0001", "cafeteria"]]);
});

test("spec 0224: the platform console still asks unscoped, which is correct there", async () => {
  const asked: Array<[string, string]> = [];
  await getRunFollowState("0219", "", fakeGetRunFollowStateDeps({
    getPipelineViewStateSafe: async (specId: string, projectSlug: string) => {
      asked.push([specId, projectSlug]);
      return null;
    },
  }));
  assert.deepEqual(asked, [["0219", ""]]);
});
