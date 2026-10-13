import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  SUPERVISOR_ALLOWED_TOOLS,
  supervisorCanUseTool,
  streamSupervisorSession,
  markerHoldIndex,
  type SupervisorEvent,
  makeProjectCanUseTool,
} from "./supervisor-session.js";
import { modelForRole, DEFAULT_MODEL_FOR_ROLE } from "./models.js";
import type { QueryFn } from "./session.js";

// Repo root, computed the same way packages/fleet-hostinger/src/stack.test.ts
// does — the compiled test runs from packages/agents/dist, so three levels up
// reaches the checkout root where CLAUDE.md and agents/supervisor.md live.
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// --- Foundation invariants (spec 0049 A2) — these run now and lock the seams.

test("supervisor tool surface is inspect/steer only — NO Write/Edit (spec 0049)", () => {
  const tools = SUPERVISOR_ALLOWED_TOOLS as readonly string[];
  assert.deepEqual([...tools], ["Bash", "Read", "Grep", "Glob"]);
  assert.ok(!tools.includes("Write"), "supervisor must not have the Write tool in phase 1");
  assert.ok(!tools.includes("Edit"), "supervisor must not have the Edit tool in phase 1");
});

test("canUseTool gate enforces the no-gate-signal / no-write invariant mechanically (spec 0070)", async () => {
  // Replaces the old name-only check (which only asserted the tool NAMES
  // weren't literally "promote") with a real capability test: the gate
  // actually DENIES the invariant-violating Bash commands (ADR-007) and the
  // Write tool, while allowing read-only inspection.
  const opts = {} as never; // supervisorCanUseTool ignores the 3rd (options) arg

  const promote = await supervisorCanUseTool(
    "Bash",
    { command: "node packages/pipeline/dist/cli.js promote 0032 owner@example.com" },
    opts,
  );
  assert.equal(promote?.behavior, "deny", "firing a gate via the CLI must be denied");

  const push = await supervisorCanUseTool("Bash", { command: "git push origin main" }, opts);
  assert.equal(push?.behavior, "deny", "git push must be denied");

  const status = await supervisorCanUseTool("Bash", { command: "git status" }, opts);
  assert.equal(status?.behavior, "allow", "read-only Bash must be allowed");

  const read = await supervisorCanUseTool("Read", { file_path: "specs/0032-foo.md" }, opts);
  assert.equal(read?.behavior, "allow", "the Read tool must be allowed");

  const write = await supervisorCanUseTool("Write", { file_path: "x", content: "y" }, opts);
  assert.equal(write?.behavior, "deny", "the Write tool must be denied — no Write/Edit, ever");
});

test("supervisor role resolves to the premium (Opus) model default (spec 0049)", () => {
  assert.equal(modelForRole("supervisor"), DEFAULT_MODEL_FOR_ROLE.supervisor);
  assert.equal(modelForRole("supervisor"), "claude-opus-5");
});

// --- Behavioral tests (spec 0049 A1) --------------------------------------

const credential = { mode: "api-key", apiKey: "sk-test" } as const;

/** Build a fake `queryFn` yielding a canned sequence of raw SDK messages,
 * mirroring session.test.ts's `fakeQuery` helper. */
function fakeQuery(messages: unknown[]): QueryFn {
  return (() => {
    async function* gen() {
      for (const m of messages) yield m as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as QueryFn;
}

async function collect(gen: AsyncGenerator<SupervisorEvent, void, unknown>): Promise<SupervisorEvent[]> {
  const out: SupervisorEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

test("streamSupervisorSession normalizes SDK messages to the SupervisorEvent stream (text/tool_use/tool_result/result)", async () => {
  const q = fakeQuery([
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "checking status" },
          { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "git status" } },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "nothing to commit", is_error: false }],
      },
    },
    { type: "result", subtype: "success", result: "done", total_cost_usd: 0.02, num_turns: 2 },
  ]);

  const events = await collect(
    streamSupervisorSession(
      { credential, workdir: process.cwd(), prompt: "what's the status of spec 0049?" },
      q,
    ),
  );

  assert.deepEqual(events, [
    { type: "text", delta: "checking status" },
    { type: "tool_use", name: "Bash", input: { command: "git status" } },
    { type: "tool_result", name: "Bash", ok: true, output: "nothing to commit" },
    { type: "result", ok: true, handoffNote: "done", costUsd: 0.02, numTurns: 2 },
  ]);
});

test("streamSupervisorSession yields a session event from the SDK's init message (spec 0067 item 3)", async () => {
  const q = fakeQuery([
    { type: "system", subtype: "init", session_id: "sess-123" },
    { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    { type: "result", subtype: "success", result: "done" },
  ]);
  const events = await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "irrelevant" }, q),
  );
  assert.deepEqual(events[0], { type: "session", sessionId: "sess-123" });
});

test("streamSupervisorSession forwards req.resume to the SDK's Options.resume (spec 0067 item 3)", async () => {
  let capturedResume: string | undefined;
  const capturingQuery: QueryFn = ((args: { options?: { resume?: string } }) => {
    capturedResume = args.options?.resume;
    async function* gen() {
      yield { type: "result", subtype: "success", result: "done" } as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as unknown as QueryFn;

  await collect(
    streamSupervisorSession(
      { credential, workdir: process.cwd(), prompt: "irrelevant", resume: "sess-123" },
      capturingQuery,
    ),
  );
  assert.equal(capturedResume, "sess-123");
});

test("streamSupervisorSession surfaces a tool_result error and an unpaired tool name as 'unknown'", async () => {
  const q = fakeQuery([
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_missing", content: "boom", is_error: true }] },
    },
    { type: "result", subtype: "success", result: "done" },
  ]);
  const events = await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "irrelevant" }, q),
  );
  assert.deepEqual(events[0], { type: "tool_result", name: "unknown", ok: false, output: "boom" });
});

test("streamSupervisorSession reuses the abort + inactivity watchdog from session.ts (trips as a terminal error event)", async () => {
  let captured: AbortController | undefined;
  const foreverSilent: QueryFn = ((args: { options?: { abortController?: AbortController } }) => {
    captured = args.options?.abortController;
    async function* gen() {
      await new Promise((resolve) => {
        captured!.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as unknown as QueryFn;

  const events = await collect(
    streamSupervisorSession(
      { credential, workdir: process.cwd(), prompt: "irrelevant", sessionInactivityMs: 30 },
      foreverSilent,
    ),
  );

  assert.ok(captured, "query never received an AbortController");
  assert.equal(captured!.signal.aborted, true, "watchdog did not abort the SDK controller");
  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(event);
  assert.equal(event.type, "error");
  assert.match((event as { type: "error"; message: string }).message, /supervisor session stalled/);
});

test("streamSupervisorSession forwards the caller's abortSignal into the SDK AbortController", async () => {
  let captured: AbortController | undefined;
  const capturingQuery: QueryFn = ((args: { options?: { abortController?: AbortController } }) => {
    captured = args.options?.abortController;
    async function* gen() {
      await new Promise((r) => setTimeout(r, 50));
      yield { type: "result", subtype: "aborted", result: "session aborted" } as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as unknown as QueryFn;

  const external = new AbortController();
  const pending = collect(
    streamSupervisorSession(
      { credential, workdir: process.cwd(), prompt: "irrelevant", abortSignal: external.signal },
      capturingQuery,
    ),
  );
  setTimeout(() => external.abort(), 10);
  await pending;
  assert.ok(captured, "query never received an AbortController");
  assert.equal(captured!.signal.aborted, true, "SDK controller was not aborted");
});

test("streamSupervisorSession loads the supervisor role prompt (agents/supervisor.md)", async () => {
  let systemPrompt = "";
  const capturingQuery: QueryFn = ((args: { options?: { systemPrompt?: string } }) => {
    systemPrompt = args.options?.systemPrompt ?? "";
    async function* gen() {
      yield { type: "result", subtype: "success", result: "ok" } as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as unknown as QueryFn;

  await collect(
    streamSupervisorSession({ credential, workdir: REPO_ROOT, prompt: "irrelevant" }, capturingQuery),
  );
  assert.match(systemPrompt, /in-UI supervisor/);
  assert.match(systemPrompt, /NEVER send a gate signal/);
  assert.match(systemPrompt, /node packages\/pipeline\/dist\/cli\.js/);
  assert.match(systemPrompt, /NOT `?`?pnpm exec cli/);
  assert.doesNotMatch(systemPrompt, /pnpm --filter @launchpad\/pipeline exec cli/);
  assert.match(systemPrompt, /docs\/SUPERVISOR\.md/);
});

test("the supervisor role prompt teaches the guided-fixes workflow (spec 0054 phase 4a)", async () => {
  let systemPrompt = "";
  const capturingQuery: QueryFn = ((args: { options?: { systemPrompt?: string } }) => {
    systemPrompt = args.options?.systemPrompt ?? "";
    async function* gen() {
      yield { type: "result", subtype: "success", result: "ok" } as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as unknown as QueryFn;

  await collect(
    streamSupervisorSession({ credential, workdir: REPO_ROOT, prompt: "irrelevant" }, capturingQuery),
  );
  assert.match(systemPrompt, /Guided fixes \(phase 4a\)/);
  assert.match(systemPrompt, /Inspect read-only FIRST/);
  assert.match(systemPrompt, /inspection only/);
  assert.match(systemPrompt, /Re-attach/);
  assert.match(systemPrompt, /grants you NO new tool/);
});

// --- Gate-card contract (spec 0049 A2) ------------------------------------

test("a [[SUPERVISOR_GATE:<specId>]] marker in agent text normalizes to a { type: 'gate', specId } event, stripped from the visible text", async () => {
  const q = fakeQuery([
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Spec 0032 is parked at gate 2. [[SUPERVISOR_GATE:0032]]" },
        ],
      },
    },
    { type: "result", subtype: "success", result: "done" },
  ]);

  const events = await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "status of 0032?" }, q),
  );

  assert.deepEqual(events, [
    { type: "text", delta: "Spec 0032 is parked at gate 2. " },
    { type: "gate", specId: "0032" },
    { type: "result", ok: true, handoffNote: "done", costUsd: undefined, numTurns: undefined },
  ]);
});

test("a marker-only text block yields no empty text event, just the gate event", async () => {
  const q = fakeQuery([
    { type: "assistant", message: { content: [{ type: "text", text: "[[SUPERVISOR_GATE:0049]]" }] } },
    { type: "result", subtype: "success", result: "done" },
  ]);
  const events = await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "irrelevant" }, q),
  );
  assert.deepEqual(events, [
    { type: "gate", specId: "0049" },
    { type: "result", ok: true, handoffNote: "done", costUsd: undefined, numTurns: undefined },
  ]);
});

test("multiple markers in one text block each produce their own gate event", async () => {
  const q = fakeQuery([
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Two specs are parked: [[SUPERVISOR_GATE:0011]] and [[SUPERVISOR_GATE:0012]]." },
        ],
      },
    },
    { type: "result", subtype: "success", result: "done" },
  ]);
  const events = await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "irrelevant" }, q),
  );
  assert.deepEqual(events, [
    { type: "text", delta: "Two specs are parked:  and ." },
    { type: "gate", specId: "0011" },
    { type: "gate", specId: "0012" },
    { type: "result", ok: true, handoffNote: "done", costUsd: undefined, numTurns: undefined },
  ]);
});

test("the gate marker contract never grants a gate-signal tool — the supervisor's tool surface is unchanged", () => {
  // The marker is parsed from the agent's OWN text output, not a tool call —
  // reaffirms that the gate-card contract adds no new capability to
  // SUPERVISOR_ALLOWED_TOOLS (asserted exhaustively above).
  const tools = SUPERVISOR_ALLOWED_TOOLS as readonly string[];
  assert.deepEqual([...tools], ["Bash", "Read", "Grep", "Glob"]);
});

// --- Architect-spawn contract (spec 0050 A1) ------------------------------

test("a [[SUPERVISOR_SPAWN_ARCHITECT]] marker normalizes to a { type: 'spawn_architect' } event, stripped from the visible text (the remaining text is the architect brief)", async () => {
  const q = fakeQuery([
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "This warrants a spec: add dark mode. [[SUPERVISOR_SPAWN_ARCHITECT]]",
          },
        ],
      },
    },
    { type: "result", subtype: "success", result: "done" },
  ]);

  const events = await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "add dark mode" }, q),
  );

  assert.deepEqual(events, [
    { type: "text", delta: "This warrants a spec: add dark mode. " },
    { type: "spawn_architect" },
    { type: "result", ok: true, handoffNote: "done", costUsd: undefined, numTurns: undefined },
  ]);
});

test("a spawn-marker-only text block yields no empty text event, just the spawn_architect event", async () => {
  const q = fakeQuery([
    { type: "assistant", message: { content: [{ type: "text", text: "[[SUPERVISOR_SPAWN_ARCHITECT]]" }] } },
    { type: "result", subtype: "success", result: "done" },
  ]);
  const events = await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "irrelevant" }, q),
  );
  assert.deepEqual(events, [
    { type: "spawn_architect" },
    { type: "result", ok: true, handoffNote: "done", costUsd: undefined, numTurns: undefined },
  ]);
});

test("a gate marker and a spawn-architect marker in the same text block each produce their own event", async () => {
  const q = fakeQuery([
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "Spec 0032 is parked at gate 2. [[SUPERVISOR_GATE:0032]] Also, this needs a new spec. [[SUPERVISOR_SPAWN_ARCHITECT]]",
          },
        ],
      },
    },
    { type: "result", subtype: "success", result: "done" },
  ]);
  const events = await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "irrelevant" }, q),
  );
  assert.deepEqual(events, [
    { type: "text", delta: "Spec 0032 is parked at gate 2.  Also, this needs a new spec. " },
    { type: "gate", specId: "0032" },
    { type: "spawn_architect" },
    { type: "result", ok: true, handoffNote: "done", costUsd: undefined, numTurns: undefined },
  ]);
});

test("the spawn-architect marker contract grants the supervisor no new tool — its surface is unchanged", () => {
  const tools = SUPERVISOR_ALLOWED_TOOLS as readonly string[];
  assert.deepEqual([...tools], ["Bash", "Read", "Grep", "Glob"]);
  assert.ok(!tools.includes("Write"), "the supervisor still never gets Write — only the spawned architect does");
});

// --- Watch-run contract (spec 0052 item C) --------------------------------

test("a [[SUPERVISOR_WATCH:<specId>]] marker normalizes to a { type: 'watch_run', specId } event, stripped from the visible text", async () => {
  const q = fakeQuery([
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Spec 0052 is running. [[SUPERVISOR_WATCH:0052]]" },
        ],
      },
    },
    { type: "result", subtype: "success", result: "done" },
  ]);

  const events = await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "follow 0052" }, q),
  );

  assert.deepEqual(events, [
    { type: "text", delta: "Spec 0052 is running. " },
    { type: "watch_run", specId: "0052" },
    { type: "result", ok: true, handoffNote: "done", costUsd: undefined, numTurns: undefined },
  ]);
});

test("a watch-marker-only text block yields no empty text event, just the watch_run event", async () => {
  const q = fakeQuery([
    { type: "assistant", message: { content: [{ type: "text", text: "[[SUPERVISOR_WATCH:0052]]" }] } },
    { type: "result", subtype: "success", result: "done" },
  ]);
  const events = await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "irrelevant" }, q),
  );
  assert.deepEqual(events, [
    { type: "watch_run", specId: "0052" },
    { type: "result", ok: true, handoffNote: "done", costUsd: undefined, numTurns: undefined },
  ]);
});

test("a gate marker, a spawn-architect marker, and a watch marker in one text block each produce their own event", async () => {
  const q = fakeQuery([
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text:
              "Spec 0032 is parked at gate 2. [[SUPERVISOR_GATE:0032]] This needs a new spec. " +
              "[[SUPERVISOR_SPAWN_ARCHITECT]] Spec 0052 is running. [[SUPERVISOR_WATCH:0052]]",
          },
        ],
      },
    },
    { type: "result", subtype: "success", result: "done" },
  ]);
  const events = await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "irrelevant" }, q),
  );
  assert.deepEqual(events, [
    {
      type: "text",
      delta: "Spec 0032 is parked at gate 2.  This needs a new spec.  Spec 0052 is running. ",
    },
    { type: "gate", specId: "0032" },
    { type: "spawn_architect" },
    { type: "watch_run", specId: "0052" },
    { type: "result", ok: true, handoffNote: "done", costUsd: undefined, numTurns: undefined },
  ]);
});

test("the watch marker contract grants the supervisor no new tool — its surface is unchanged (REAFFIRMATION)", () => {
  // Re-proves the phase-1/2 invariant still holds after phase 3's third
  // marker: the agent's tool surface excludes Write/Edit and any gate-signal
  // capability. The marker is parsed from the agent's OWN text output, not a
  // tool call — it only causes a card to render, never spawns/signals.
  const tools = SUPERVISOR_ALLOWED_TOOLS as readonly string[];
  assert.deepEqual([...tools], ["Bash", "Read", "Grep", "Glob"]);
  assert.ok(!tools.includes("Write"), "the supervisor still never gets Write in phase 3");
  assert.ok(!tools.includes("Edit"), "the supervisor still never gets Edit in phase 3");
  const GUARDED = ["specApproved", "prApproved", "promote", "spawnWatcher", "signalGate"];
  for (const tool of tools) {
    assert.ok(!GUARDED.includes(tool), `tool "${tool}" must not be a guarded gate/spawn signal`);
  }
});

// --- Guided-fixes contract (spec 0054 phase 4a) ---------------------------

test("guided fixes (0054 phase 4a) grants the supervisor no new tool — its surface is unchanged (REAFFIRMATION)", () => {
  // Guided fixes v1 is diagnose-and-propose: the role prompt teaches a
  // read-only-inspect + propose-fix-steps workflow (see the test above), but
  // adds no new marker, no new SupervisorEvent, and no new tool. The
  // Diagnose-in-console button (apps/web) sends its composed prompt through
  // this EXACT same streamSupervisorSession bridge as a normal user turn —
  // nothing here changes to accommodate it. Re-proves the invariant.
  const tools = SUPERVISOR_ALLOWED_TOOLS as readonly string[];
  assert.deepEqual([...tools], ["Bash", "Read", "Grep", "Glob"]);
  assert.ok(!tools.includes("Write"), "the supervisor still never gets Write in phase 4a");
  assert.ok(!tools.includes("Edit"), "the supervisor still never gets Edit in phase 4a");
  const GUARDED = ["specApproved", "prApproved", "promote", "spawnWatcher", "signalGate", "diagnose"];
  for (const tool of tools) {
    assert.ok(!GUARDED.includes(tool), `tool "${tool}" must not be a guarded gate/spawn/diagnose signal`);
  }
});

// --- Watched-start contract (spec 0056 phase 4c) --------------------------

test("the supervisor role prompt teaches phase 4c (starting a drafted spec's run from the console)", async () => {
  let systemPrompt = "";
  const capturingQuery: QueryFn = ((args: { options?: { systemPrompt?: string } }) => {
    systemPrompt = args.options?.systemPrompt ?? "";
    async function* gen() {
      yield { type: "result", subtype: "success", result: "ok" } as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as unknown as QueryFn;

  await collect(
    streamSupervisorSession({ credential, workdir: REPO_ROOT, prompt: "irrelevant" }, capturingQuery),
  );
  // The marker is now also valid for an on-disk, not-yet-started spec.
  assert.match(systemPrompt, /EXISTS ON DISK/);
  assert.match(systemPrompt, /Start run/);
  // The never-start/never-commit/never-signal boundary is stated explicitly.
  assert.match(systemPrompt, /never spawn the watcher, never start a run, never commit the spec\s+draft, and never signal anything/);
});

test("the watched-start marker contract grants the supervisor no new tool — its surface is unchanged (REAFFIRMATION, spec 0056 phase 4c)", () => {
  // Phase 4c lets the EXISTING [[SUPERVISOR_WATCH:<specId>]] marker also fire
  // for an on-disk, not-yet-started spec (the card then offers Start instead
  // of Follow) — no new marker, no new SupervisorEvent, no new tool. The
  // human's click on the card's Start button is the sole thing that commits
  // the draft and starts the run; re-proves the invariant one more time.
  const tools = SUPERVISOR_ALLOWED_TOOLS as readonly string[];
  assert.deepEqual([...tools], ["Bash", "Read", "Grep", "Glob"]);
  assert.ok(!tools.includes("Write"), "the supervisor still never gets Write in phase 4c");
  assert.ok(!tools.includes("Edit"), "the supervisor still never gets Edit in phase 4c");
  const GUARDED = [
    "specApproved",
    "prApproved",
    "promote",
    "spawnWatcher",
    "signalGate",
    "diagnose",
    "spawnStartWatcher",
    "startPipeline",
  ];
  for (const tool of tools) {
    assert.ok(!GUARDED.includes(tool), `tool "${tool}" must not be a guarded gate/spawn/start signal`);
  }
});

// --- Console remediation-cards contract (spec 0057 phase 4b) --------------

test("the supervisor role prompt teaches phase 4b (point at Recover / Resume (polished) instead of dictating the terminal command)", async () => {
  let systemPrompt = "";
  const capturingQuery: QueryFn = ((args: { options?: { systemPrompt?: string } }) => {
    systemPrompt = args.options?.systemPrompt ?? "";
    async function* gen() {
      yield { type: "result", subtype: "success", result: "ok" } as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as unknown as QueryFn;

  await collect(
    streamSupervisorSession({ credential, workdir: REPO_ROOT, prompt: "irrelevant" }, capturingQuery),
  );
  // Both buttons are named, and the boundary is stated explicitly: the agent
  // itself never spawns/recovers/relaunches/signals — only the human's click
  // on the rendered card does.
  assert.match(systemPrompt, /\*\*Recover\*\*/);
  assert.match(systemPrompt, /Resume \(polished\)/);
  assert.match(
    systemPrompt,
    /never spawn, recover, relaunch, commit,\s+or signal anything yourself/,
  );
});

test("the phase-4b remediation-card contract grants the supervisor no new tool — its surface is unchanged (REAFFIRMATION, spec 0057 phase 4b)", () => {
  // Phase 4b lets the role prompt point at two NEW follow-card buttons
  // (Recover / Resume (polished)) that detach-spawn `supervise.mjs --recover`
  // / `--polished --no-start` — but the agent never clicks them, never spawns
  // either process itself, and gains no new tool, marker, or SupervisorEvent.
  const tools = SUPERVISOR_ALLOWED_TOOLS as readonly string[];
  assert.deepEqual([...tools], ["Bash", "Read", "Grep", "Glob"]);
  assert.ok(!tools.includes("Write"), "the supervisor still never gets Write in phase 4b");
  assert.ok(!tools.includes("Edit"), "the supervisor still never gets Edit in phase 4b");
  const GUARDED = [
    "specApproved",
    "prApproved",
    "promote",
    "spawnWatcher",
    "signalGate",
    "diagnose",
    "spawnStartWatcher",
    "startPipeline",
    "spawnRecover",
    "spawnPolishedWatcher",
  ];
  for (const tool of tools) {
    assert.ok(!GUARDED.includes(tool), `tool "${tool}" must not be a guarded gate/spawn/recover signal`);
  }
});

// Type-level sanity: the SupervisorEvent union stays extensible (room for later
// architect-spawn / watcher-step / phase-progress events per ADR-022).
test("SupervisorEvent union includes the phase-1 event kinds", () => {
  const kinds: SupervisorEvent["type"][] = ["text", "tool_use", "tool_result", "gate", "result", "error"];
  assert.equal(new Set(kinds).size, 6);
  // The stub throws until A1 lands — assert that loudly so it isn't mistaken
  // for a working bridge.
  assert.equal(typeof streamSupervisorSession, "function");
});

// --- Spec 0052 polish-pass regression: markers split across streamed blocks ---
// The SDK chunks a turn's text into multiple assistant blocks; the browser
// concatenates the {type:"text"} deltas. Stripping per-block let a marker
// straddling a chunk boundary LEAK as raw text AND fire no event (found in the
// gate-3 live pass on the RunFollowCard). The buffer + hold-tail fix matches it.

test("markerHoldIndex holds a partial-marker tail but not plain-prose brackets", () => {
  // full marker already extracted upstream ⇒ nothing to hold
  assert.equal(markerHoldIndex("all done."), "all done.".length);
  // initial fragments of the shared prefix are held
  assert.equal(markerHoldIndex("text ["), "text ".length);
  assert.equal(markerHoldIndex("text [[SUPERV"), "text ".length);
  // a marker in progress (no closing ]]) is held from its start
  assert.equal(markerHoldIndex("go [[SUPERVISOR_WATCH:0052"), "go ".length);
  // prose brackets that can't become a marker are NOT held
  assert.equal(markerHoldIndex("see [[note]] here"), "see [[note]] here".length);
  assert.equal(markerHoldIndex("array[[0]]"), "array[[0]]".length);
});

test("streamSupervisorSession matches a watch marker split across two assistant blocks (spec 0052)", async () => {
  // "[[SUPERVISOR_WATCH:0052]]" straddles the block boundary.
  const q = fakeQuery([
    { type: "assistant", message: { content: [{ type: "text", text: "spec 0052 is RUNNING.\n\n[[SUPERVISOR_WA" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "TCH:0052]]\n\nHere's the follow card." }] } },
    { type: "result", subtype: "success", result: "done" },
  ]);
  const events = await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "follow 0052" }, q),
  );
  // exactly one watch_run, for the right spec
  const watch = events.filter((e) => e.type === "watch_run");
  assert.equal(watch.length, 1);
  assert.deepEqual(watch[0], { type: "watch_run", specId: "0052" });
  // the raw marker never leaks into any emitted text delta
  const fullText = events.filter((e): e is Extract<SupervisorEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.delta)
    .join("");
  assert.ok(!fullText.includes("[[SUPERVISOR_WATCH"), "marker must be stripped, not leaked");
  assert.ok(fullText.includes("spec 0052 is RUNNING."), "surrounding text is preserved");
  assert.ok(fullText.includes("Here's the follow card."), "trailing text is preserved");
});

test("streamSupervisorSession flushes a dangling partial-marker tail as text at result (spec 0052)", async () => {
  // A lone "[[" that never becomes a marker must still reach the user as text.
  const q = fakeQuery([
    { type: "assistant", message: { content: [{ type: "text", text: "done. see the array[[" }] } },
    { type: "result", subtype: "success", result: "ok" },
  ]);
  const events = await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "x" }, q),
  );
  const fullText = events.filter((e): e is Extract<SupervisorEvent, { type: "text" }> => e.type === "text")
    .map((e) => e.delta)
    .join("");
  assert.equal(fullText, "done. see the array[[");
  assert.equal(events.filter((e) => e.type === "watch_run").length, 0);
});

// --- Spec 0144 A: the engine hosts Claude Code instead of replacing it -----

function fakeQueryReturning(messagesPerCall: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const fn = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    const batch = messagesPerCall[Math.min(calls.length - 1, messagesPerCall.length - 1)] ?? [];
    async function* gen() {
      for (const m of batch) yield m as never;
    }
    return Object.assign(gen(), { close() {} });
  }) as unknown as QueryFn;
  return { fn, calls };
}

test("spec 0144: a project session uses the claude_code PRESET with the scope block appended", async () => {
  const { fn, calls } = fakeQueryReturning([
    [{ type: "result", subtype: "success", result: "ok" }],
  ]);
  await collect(
    streamSupervisorSession(
      {
        credential,
        workdir: process.cwd(),
        prompt: "hola",
        profile: "project",
        specsDir: "/srv/launchpad/specs/x",
      },
      fn,
    ),
  );
  const sp = calls[0]!.options["systemPrompt"] as Record<string, unknown>;
  assert.equal(typeof sp, "object", "project profile must use the preset object, not a string");
  assert.equal(sp["type"], "preset");
  assert.equal(sp["preset"], "claude_code");
  assert.match(String(sp["append"]), /Gate signals are human-only/);
  assert.match(String(sp["append"]), /\/srv\/launchpad\/specs\/x/);
});

test("spec 0144: the inspect console keeps its pre-0144 string prompt", async () => {
  const { fn, calls } = fakeQueryReturning([
    [{ type: "result", subtype: "success", result: "ok" }],
  ]);
  await collect(
    streamSupervisorSession({ credential, workdir: process.cwd(), prompt: "hola" }, fn),
  );
  assert.equal(typeof calls[0]!.options["systemPrompt"], "string");
  assert.equal(calls[0]!.options["maxTurns"], 30);
});

test("spec 0144: error_max_turns on a project session RESUMES the same session, one visible result", async () => {
  const { fn, calls } = fakeQueryReturning([
    [
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "result", subtype: "error_max_turns", result: "cap" },
    ],
    [
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "result", subtype: "success", result: "done", num_turns: 7 },
    ],
  ]);
  const events = await collect(
    streamSupervisorSession(
      { credential, workdir: process.cwd(), prompt: "long job", profile: "project" },
      fn,
    ),
  );
  assert.equal(calls.length, 2, "the turn cap must chain a second query");
  assert.equal(calls[1]!.options["resume"], "sess-1", "the chain must resume the SAME session");
  const results = events.filter((e) => e.type === "result");
  assert.equal(results.length, 1, "the intermediate cap result must not be yielded");
  assert.equal((results[0] as { ok: boolean }).ok, true);
});

test("spec 0144: the chain is bounded — a session that ALWAYS hits the cap ends after 3 queries", async () => {
  const capBatch = [
    { type: "system", subtype: "init", session_id: "sess-2" },
    { type: "result", subtype: "error_max_turns", result: "cap" },
  ];
  const { fn, calls } = fakeQueryReturning([capBatch, capBatch, capBatch]);
  const events = await collect(
    streamSupervisorSession(
      { credential, workdir: process.cwd(), prompt: "runaway", profile: "project" },
      fn,
    ),
  );
  assert.equal(calls.length, 3, "at most 3 chained queries per user message");
  const results = events.filter((e) => e.type === "result");
  assert.equal(results.length, 1, "the LAST cap result is yielded so the turn terminates honestly");
  assert.equal((results[0] as { ok: boolean }).ok, false);
});

// --- Spec 0144 B: AskUserQuestion blocks on the human, never silently skips --

test("spec 0144: AskUserQuestion resolves with the user's answers via onQuestion", async () => {
  const gate = makeProjectCanUseTool("/srv/checkout", undefined, async (input) => {
    assert.equal(input.questions?.[0]?.question, "¿Formato?");
    return { "¿Formato?": "Resumen" };
  });
  const decision = (await gate(
    "AskUserQuestion",
    { questions: [{ question: "¿Formato?", options: [{ label: "Resumen" }] }] },
    { signal: new AbortController().signal, suggestions: [] } as never,
  )) as unknown as { behavior: string; updatedInput: { answers: unknown } };
  assert.equal(decision.behavior, "allow");
  assert.deepEqual(decision.updatedInput.answers, { "¿Formato?": "Resumen" });
});

test("spec 0144: an unanswered question is a DENY with a reason, never a silent skip", async () => {
  const unanswered = makeProjectCanUseTool("/srv/checkout", undefined, async () => null);
  const d1 = (await unanswered("AskUserQuestion", { questions: [] }, { signal: new AbortController().signal, suggestions: [] } as never)) as unknown as { behavior: string; message: string };
  assert.equal(d1.behavior, "deny");
  assert.match(d1.message, /no respondió/);

  const noHandler = makeProjectCanUseTool("/srv/checkout");
  const d2 = (await noHandler("AskUserQuestion", { questions: [] }, { signal: new AbortController().signal, suggestions: [] } as never)) as unknown as { behavior: string };
  assert.equal(d2.behavior, "deny");
});

// --- specs scoping is WIRED, not merely implemented ------------------------
// The pure rule has its own tests in supervisor-tool-policy.test.ts. This one
// exists because the rule was useless until `canUseTool` actually passed the
// session's specsDir — and every pre-existing test here passed `undefined` for
// it, so a missing argument at the wiring site would have gone unnoticed.
//
// It also covers what a live test could NOT: asked to read another project's
// specs, the real agent declined by its own judgment BEFORE issuing the
// command, so canUseTool was never consulted and the guard was never exercised.
// A guard can only be proven by invoking the gate directly.

test("the project gate denies Bash reaching another project's specs", async () => {
  const gate = makeProjectCanUseTool("/srv/checkout", "/srv/launchpad/specs/taqueria-sol");
  const res = await gate("Bash", { command: "ls -la /srv/launchpad/specs/floreria-bella/" }, {} as never);
  assert.ok(res, "the gate must answer");
  assert.equal(res.behavior, "deny");
  assert.match((res as { message: string }).message, /another project/i);
});

test("the project gate denies listing the specs root, which names every tenant", async () => {
  const gate = makeProjectCanUseTool("/srv/checkout", "/srv/launchpad/specs/taqueria-sol");
  const res = await gate("Bash", { command: "ls -la /srv/launchpad/specs/" }, {} as never);
  assert.ok(res, "the gate must answer");
  assert.equal(res.behavior, "deny");
  assert.match((res as { message: string }).message, /EVERY project/i);
});

test("the project gate allows Bash reading the project's OWN specs", async () => {
  const gate = makeProjectCanUseTool("/srv/checkout", "/srv/launchpad/specs/taqueria-sol");
  const res = await gate("Bash", { command: "cat /srv/launchpad/specs/taqueria-sol/0001-x.md" }, {} as never);
  assert.ok(res, "the gate must answer");
  assert.equal(res.behavior, "allow");
});
