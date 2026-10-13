import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkSupervisorAccess,
  composeArchitectBrief,
  deriveSpecDraftCard,
  encodeSupervisorEvent,
  resolveForgeRootSurface,
  resolveSupervisorGateCard,
  runSupervisorConsoleTurn,
  type SupervisorGateDeps,
  type SupervisorOrchestrationDeps,
} from "./supervisor-console";
import { isSupervisorConsoleEnabled, SUPERVISOR_CONSOLE_ENV } from "./env";
import type { PipelineViewState } from "./pipeline";
import type { AgentCredential, SupervisorEvent } from "@launchpad/agents";
import type { SpecSummary } from "./specs";

// --- Env flag (spec 0049 B1) — these run now and lock the default-off boundary.

test("supervisor console flag defaults OFF and only 1/true enable it (spec 0049)", () => {
  assert.equal(isSupervisorConsoleEnabled({}), false);
  assert.equal(isSupervisorConsoleEnabled({ [SUPERVISOR_CONSOLE_ENV]: "" }), false);
  assert.equal(isSupervisorConsoleEnabled({ [SUPERVISOR_CONSOLE_ENV]: "0" }), false);
  assert.equal(isSupervisorConsoleEnabled({ [SUPERVISOR_CONSOLE_ENV]: "no" }), false);
  assert.equal(isSupervisorConsoleEnabled({ [SUPERVISOR_CONSOLE_ENV]: "1" }), true);
  assert.equal(isSupervisorConsoleEnabled({ [SUPERVISOR_CONSOLE_ENV]: "true" }), true);
  assert.equal(isSupervisorConsoleEnabled({ [SUPERVISOR_CONSOLE_ENV]: "TRUE" }), true);
});

// --- Guard behavior (spec 0049 B1/B2; role-based since spec 0074) ----------
//
// The guard's inputs are the flag and the VERIFIED session role (spec 0073).
// No header-derived input exists anymore (audit #2): X-Forwarded-For/Host
// are client-controlled and must never appear in an authorization decision.

test("checkSupervisorAccess rejects when the flag is disabled, even for OWNER", () => {
  const result = checkSupervisorAccess({ enabled: false, role: "OWNER" });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /disabled/);
});

test("checkSupervisorAccess rejects a signed-out request even when enabled", () => {
  const result = checkSupervisorAccess({ enabled: true, role: null });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /signed out/);
});

test("checkSupervisorAccess rejects non-OWNER roles on an UNSCOPED request", () => {
  // The unscoped surface (platform console, adhoc turns) stays OWNER-only —
  // it is a shell on the launchpad's own checkout (spec 0135 keeps 0074 here).
  for (const role of ["MEMBER", "VIEWER"] as const) {
    const result = checkSupervisorAccess({ enabled: true, role });
    assert.equal(result.ok, false, `expected role ${role} to be rejected`);
    assert.match(result.reason ?? "", /OWNER/);
  }
});

test("checkSupervisorAccess allows flag-on + OWNER on the UNSCOPED console", () => {
  assert.equal(checkSupervisorAccess({ enabled: true, role: "OWNER" }).ok, true);
});

/**
 * Spec 0168 reverses what this asserted. It used to read "an OWNER needs no
 * membership — the support path (0128) applies here too", which was fine while
 * OWNER meant one person; v0 makes all five users OWNERs, so it would hand every
 * one of them a Bash-capable agent session on every project's checkout. Of the
 * three role short-circuits 0168 removed, this was the widest.
 */
test("an OWNER who is NOT a member is refused a PROJECT-SCOPED chat", () => {
  const result = checkSupervisorAccess({ enabled: true, role: "OWNER", projectMember: false });
  assert.equal(result.ok, false, "the global role must not open another project's chat");
  assert.match(result.reason ?? "", /not a member/);
});

test("an OWNER who IS a member passes, so the change did not lock owners out", () => {
  assert.equal(
    checkSupervisorAccess({ enabled: true, role: "OWNER", projectMember: true }).ok,
    true,
  );
});

// --- Spec 0135: project members reach their project's chat -----------------

test("a MEMBER who belongs to the request's project passes", () => {
  const result = checkSupervisorAccess({ enabled: true, role: "MEMBER", projectMember: true });
  assert.equal(result.ok, true);
});

test("a MEMBER who does NOT belong to the request's project is refused with its own message", () => {
  const result = checkSupervisorAccess({ enabled: true, role: "MEMBER", projectMember: false });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /not a member/);
});

test("a VIEWER is refused even as a project member — the chat can run commands", () => {
  const result = checkSupervisorAccess({ enabled: true, role: "VIEWER", projectMember: true });
  assert.equal(result.ok, false);
});

test("membership never overrides the flag or a signed-out session", () => {
  assert.equal(
    checkSupervisorAccess({ enabled: false, role: "MEMBER", projectMember: true }).ok,
    false,
  );
  assert.equal(
    checkSupervisorAccess({ enabled: true, role: null, projectMember: true }).ok,
    false,
  );
});

// --- Forge-root render decision (spec 0060 item 1, session-based in 0074) --
//
// resolveForgeRootSurface must be fail-closed: every non-affirmative input
// (flag unset, signed out, non-OWNER role) yields "chat"; only flag-on +
// OWNER yields "console".

test("resolveForgeRootSurface returns 'chat' by default (flag unset)", () => {
  assert.equal(resolveForgeRootSurface("OWNER", {}), "chat");
});

test("resolveForgeRootSurface returns 'console' only for flag-on + OWNER", () => {
  assert.equal(resolveForgeRootSurface("OWNER", { [SUPERVISOR_CONSOLE_ENV]: "1" }), "console");
  assert.equal(resolveForgeRootSurface("OWNER", { [SUPERVISOR_CONSOLE_ENV]: "true" }), "console");
});

test("resolveForgeRootSurface returns 'chat' for non-OWNER roles when the flag is on", () => {
  assert.equal(resolveForgeRootSurface("MEMBER", { [SUPERVISOR_CONSOLE_ENV]: "1" }), "chat");
  assert.equal(resolveForgeRootSurface("VIEWER", { [SUPERVISOR_CONSOLE_ENV]: "1" }), "chat");
});

test("resolveForgeRootSurface returns 'chat' when signed out", () => {
  assert.equal(resolveForgeRootSurface(null, { [SUPERVISOR_CONSOLE_ENV]: "1" }), "chat");
});

// --- SSE framing (spec 0049 B1/B2) -----------------------------------------

test("encodeSupervisorEvent frames a normalized event as one SSE data line", () => {
  const framed = encodeSupervisorEvent({ type: "text", delta: "hello" });
  assert.equal(framed, `data: ${JSON.stringify({ type: "text", delta: "hello" })}\n\n`);
  assert.ok(framed.endsWith("\n\n"), "SSE frames must end with a blank line");
});

test("encodeSupervisorEvent round-trips a gate event carrying ONLY a bare specId", () => {
  const framed = encodeSupervisorEvent({ type: "gate", specId: "0099" });
  const payload = framed.slice("data: ".length, -"\n\n".length);
  const decoded = JSON.parse(payload) as { type: string; specId: string };
  // The wire event can never itself carry a signal/action payload — proving
  // the browser MUST go through resolveSupervisorGateCard + the existing
  // signalGateAction click, never a shortcut embedded in the stream.
  assert.deepEqual(Object.keys(decoded).sort(), ["specId", "type"]);
  assert.equal(decoded.type, "gate");
  assert.equal(decoded.specId, "0099");
});

// --- Gate-card resolution / click wiring (spec 0049 B2) --------------------
//
// Mirrors lib/chat-tools.test.ts's fakeDeps pattern (injectable I/O, a `calls`
// tally per dependency): resolveSupervisorGateCard is handed ONLY read
// functions (resolveSpecFilenameById/readSpecFile/getPipelineViewStateSafe) —
// it has no signalGate/startPipeline dependency to call even if it wanted to.
// The actual signal only ever fires from the human's click on the rendered
// `GateActionButtons`, which calls the EXISTING `signalGateAction` (spec 0016
// gate path) — unchanged by this resolution helper.

const gateSpecMarkdown = "---\nid: 0099\ntitle: Test spec\nstatus: draft\n---\n";

const waitingAtSpecGate: PipelineViewState = {
  state: "waiting_at_gate",
  gate: "spec",
  availableActions: ["specApproved", "specRejected"],
  canStart: false,
};

interface FakeGateDeps {
  deps: SupervisorGateDeps;
  calls: { resolveSpecFilenameById: unknown[][]; readSpecFile: unknown[][]; getPipelineViewStateSafe: unknown[][] };
}

function fakeGateDeps(
  filename: string | null,
  view: PipelineViewState | null,
  markdown: string = gateSpecMarkdown,
): FakeGateDeps {
  const calls: FakeGateDeps["calls"] = { resolveSpecFilenameById: [], readSpecFile: [], getPipelineViewStateSafe: [] };
  const deps: SupervisorGateDeps = {
    resolveSpecFilenameById: (async (...args: unknown[]) => {
      calls.resolveSpecFilenameById.push(args);
      return filename;
    }) as SupervisorGateDeps["resolveSpecFilenameById"],
    readSpecFile: (async (...args: unknown[]) => {
      calls.readSpecFile.push(args);
      return markdown;
    }) as SupervisorGateDeps["readSpecFile"],
    getPipelineViewStateSafe: (async (...args: unknown[]) => {
      calls.getPipelineViewStateSafe.push(args);
      return view;
    }) as SupervisorGateDeps["getPipelineViewStateSafe"],
  };
  return { deps, calls };
}

test("resolveSupervisorGateCard resolves a spec truly parked at a gate", async () => {
  const { deps, calls } = fakeGateDeps("0099-test.md", waitingAtSpecGate);
  const card = await resolveSupervisorGateCard("0099", deps);
  assert.deepEqual(card, {
    filename: "0099-test.md",
    specId: "0099",
    title: "Test spec",
    actions: ["specApproved", "specRejected"],
  });
  assert.equal(calls.resolveSpecFilenameById.length, 1);
  assert.equal(calls.getPipelineViewStateSafe.length, 1);
});

test("resolveSupervisorGateCard returns null for an unknown spec id (never throws)", async () => {
  const { deps } = fakeGateDeps(null, null);
  assert.equal(await resolveSupervisorGateCard("nope", deps), null);
});

test("resolveSupervisorGateCard returns null when the spec isn't actually parked at a gate", async () => {
  const notWaiting: PipelineViewState = { state: "running", availableActions: [], canStart: false };
  const { deps } = fakeGateDeps("0099-test.md", notWaiting);
  assert.equal(await resolveSupervisorGateCard("0099", deps), null);
});

test("resolveSupervisorGateCard is render-only: its deps carry no signalGate/startPipeline capability", () => {
  // Structural proof, not just behavioral: SupervisorGateDeps has exactly the
  // three read-only keys below — there is no signal-capable dependency this
  // helper could call even by accident. Mirrors chat-tools.test.ts's
  // "gate-card render handlers never call startPipeline or signalGate".
  const { deps } = fakeGateDeps("0099-test.md", waitingAtSpecGate);
  assert.deepEqual(Object.keys(deps).sort(), [
    "getPipelineViewStateSafe",
    "readSpecFile",
    "resolveSpecFilenameById",
  ]);
});

// --- Supervisor turn orchestration (spec 0050 item B1) ----------------------
//
// runSupervisorConsoleTurn is the route's actual logic, moved to lib for the
// same testability reason resolveSupervisorGateCard was: a fake
// streamSupervisorSession/runArchitectSpawn/listSpecs (mirroring the
// architect-session.test.ts fake-queryFn pattern) proves the route's spawn
// delegation without spinning up a real SDK session or a Next.js Response.

test("composeArchitectBrief folds the supervisor's briefing text under the user's request", () => {
  const composed = composeArchitectBrief("add a widget", "The widget should live in apps/web.");
  assert.match(composed, /^add a widget/);
  assert.match(composed, /Supervisor brief:\nThe widget should live in apps\/web\.$/);
});

test("composeArchitectBrief falls back to the bare user request when the supervisor left no brief text", () => {
  assert.equal(composeArchitectBrief("add a widget", "   "), "add a widget");
  assert.equal(composeArchitectBrief("add a widget", ""), "add a widget");
});

const fakeCredential: AgentCredential = { mode: "api-key", apiKey: "test-key" };

function fakeSpecSummary(id: string): SpecSummary {
  return { id, title: `Spec ${id}`, status: "draft", filename: `${id}-spec.md`, progress: { checked: 0, total: 0 } };
}

interface FakeOrchestrationDeps {
  deps: SupervisorOrchestrationDeps;
  calls: { runArchitectSpawn: unknown[][]; listSpecs: unknown[][] };
}

/** Builds fake orchestration deps. `supervisorEvents` stand in for one
 * streamSupervisorSession turn; `architectEvents` (only consumed if a
 * `spawn_architect` event is among them) stand in for runArchitectSpawn. */
function fakeOrchestrationDeps(
  supervisorEvents: SupervisorEvent[],
  architectEvents: SupervisorEvent[],
  existingIds: string[] = ["0049"],
): FakeOrchestrationDeps {
  const calls: FakeOrchestrationDeps["calls"] = { runArchitectSpawn: [], listSpecs: [] };
  // Spec 0164: the id now comes from the project's counter, not from the
  // directory. The fake mimics the real allocator's contract — floor + 1, and a
  // DIFFERENT number every call — so a test that allocated twice would see the
  // collision the real one prevents.
  let allocated = 0;
  const deps: SupervisorOrchestrationDeps = {
    allocateSpecId: async (_projectId: string, floor: number) => {
      allocated += 1;
      return String(floor + allocated).padStart(4, "0");
    },
    platformProjectId: async () => "11111111-1111-4111-8111-111111111111",
    streamSupervisorSession: (async function* () {
      for (const event of supervisorEvents) yield event;
    }) as SupervisorOrchestrationDeps["streamSupervisorSession"],
    runArchitectSpawn: ((...args: unknown[]) => {
      calls.runArchitectSpawn.push(args);
      return (async function* () {
        for (const event of architectEvents) yield event;
      })();
    }) as SupervisorOrchestrationDeps["runArchitectSpawn"],
    listSpecs: (async (...args: unknown[]) => {
      calls.listSpecs.push(args);
      return existingIds.map(fakeSpecSummary);
    }) as SupervisorOrchestrationDeps["listSpecs"],
  };
  return { deps, calls };
}

async function collect(gen: AsyncGenerator<SupervisorEvent, void, unknown>): Promise<SupervisorEvent[]> {
  const events: SupervisorEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

test("runSupervisorConsoleTurn forwards the supervisor's own events untouched when no spec is warranted", async () => {
  const supervisorEvents: SupervisorEvent[] = [
    { type: "text", delta: "no spec needed here" },
    { type: "result", ok: true },
  ];
  const { deps, calls } = fakeOrchestrationDeps(supervisorEvents, []);
  const events = await collect(
    runSupervisorConsoleTurn({ credential: fakeCredential, workdir: "/repo", prompt: "hi" }, deps),
  );
  assert.deepEqual(events, supervisorEvents);
  assert.equal(calls.runArchitectSpawn.length, 0, "the architect must never spawn without a spawn_architect event");
  assert.equal(calls.listSpecs.length, 0);
});

test("runSupervisorConsoleTurn spawns the architect sequentially after a spawn_architect event, computing the next free spec id", async () => {
  const supervisorEvents: SupervisorEvent[] = [
    { type: "text", delta: "This warrants a new spec: add a widget." },
    { type: "spawn_architect" },
    { type: "result", ok: true },
  ];
  const architectEvents: SupervisorEvent[] = [
    { type: "architect_progress", delta: "drafting..." },
    { type: "spec_draft", specId: "0050", specPath: "specs/0050-widget.md", title: "Widget", summary: "Adds a widget.", model: "claude-fable-5" },
  ];
  const { deps, calls } = fakeOrchestrationDeps(supervisorEvents, architectEvents, ["0049"]);
  const events = await collect(
    runSupervisorConsoleTurn({ credential: fakeCredential, workdir: "/repo", prompt: "add a widget" }, deps),
  );
  assert.deepEqual(events, [...supervisorEvents, ...architectEvents]);
  assert.equal(calls.listSpecs.length, 1, "the next free id is computed exactly once, after the supervisor turn ends");
  assert.equal(calls.runArchitectSpawn.length, 1);
  const [request] = calls.runArchitectSpawn[0] as [{ specId: string; brief: string; workdir: string; credential: AgentCredential }];
  assert.equal(request.specId, "0050", "0049 already exists, so the next free id is 0050");
  assert.equal(request.workdir, "/repo");
  assert.equal(request.credential, fakeCredential);
  assert.match(request.brief, /^add a widget/);
  assert.match(request.brief, /This warrants a new spec: add a widget\.$/);
});

test("runSupervisorConsoleTurn forwards req.resume to streamSupervisorSession (spec 0067 item 3 continuity)", async () => {
  const calls: unknown[][] = [];
  const deps: SupervisorOrchestrationDeps = {
    // Spec 0164 seams; this test never drafts, so they are never called.
    allocateSpecId: async () => "0001",
    platformProjectId: async () => "11111111-1111-4111-8111-111111111111",
    streamSupervisorSession: ((...args: unknown[]) => {
      calls.push(args);
      return (async function* () {
        yield { type: "result", ok: true } as SupervisorEvent;
      })();
    }) as SupervisorOrchestrationDeps["streamSupervisorSession"],
    runArchitectSpawn: (() => {
      throw new Error("must not spawn the architect");
    }) as SupervisorOrchestrationDeps["runArchitectSpawn"],
    listSpecs: (async () => []) as SupervisorOrchestrationDeps["listSpecs"],
  };
  await collect(
    runSupervisorConsoleTurn({ credential: fakeCredential, workdir: "/repo", prompt: "hi", resume: "sess-123" }, deps),
  );
  const [request] = calls[0] as [{ resume?: string }];
  assert.equal(request.resume, "sess-123");
});

// --- Spec-draft review card (spec 0050 item B2) ----------------------------

test("deriveSpecDraftCard maps a spec_draft event to review-card props with a link to the draft", () => {
  const card = deriveSpecDraftCard({
    specId: "0050",
    specPath: "specs/0050-widget.md",
    title: "Widget",
    summary: "Adds a widget.",
    model: "claude-fable-5",
  });
  assert.deepEqual(card, {
    specId: "0050",
    specPath: "specs/0050-widget.md",
    title: "Widget",
    summary: "Adds a widget.",
    model: "claude-fable-5",
    href: "/forge/specs/0050",
  });
});

test("deriveSpecDraftCard's props carry no commit/run/promote affordance (review-only)", () => {
  // Structural proof, not just behavioral: SpecDraftCard has exactly these six
  // read-only keys — there is no signal/action field the rendered card could
  // wire to a commit/run/promote handler even by accident. Mirrors
  // resolveSupervisorGateCard's render-only-deps assertion above.
  const card = deriveSpecDraftCard({
    specId: "0050",
    specPath: "specs/0050-widget.md",
    title: "Widget",
    summary: "Adds a widget.",
    model: "claude-fable-5",
  });
  assert.deepEqual(Object.keys(card).sort(), ["href", "model", "specId", "specPath", "summary", "title"]);
});
