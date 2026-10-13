import { test } from "node:test";
import assert from "node:assert/strict";
import type { PullRequestRef } from "@launchpad/pipeline";
import type { PipelineViewState, PrLiveStateResult } from "./pipeline";
import type { SpecSummary } from "./specs";
import {
  CHAT_TOOL_REGISTRY,
  CHAT_TOOL_HANDLERS,
  GUARDED_GATE_SIGNALS,
  toolFiresGuardedGateSignal,
  executeStartPipeline,
  executeSpecStatus,
  executeListSpecs,
  executeRejectSpec,
  executeRenderSpecDraftCard,
  executeRenderPrLinkCard,
  executeRenderPromoteCard,
  type ChatToolName,
  type ChatToolDeps,
} from "./chat-tools";

// The safety invariant (acceptance criterion): the model can never fire a gate
// approval/promotion. These pass against the foundation registry and must keep
// passing once item 5 wires the SDK `tool()` handlers to it.

test("no whitelisted tool fires a guarded gate signal (approve/promote)", () => {
  for (const spec of CHAT_TOOL_REGISTRY) {
    assert.equal(
      toolFiresGuardedGateSignal(spec),
      false,
      `tool "${spec.name}" must not fire a guarded gate signal`,
    );
  }
});

test("every gate card tool is render-only (the human's click fires the signal)", () => {
  const gateCards: ChatToolName[] = ["renderSpecDraftCard", "renderPrLinkCard", "renderPromoteCard"];
  for (const name of gateCards) {
    const spec = CHAT_TOOL_REGISTRY.find((t) => t.name === name);
    assert.ok(spec, `${name} must be in the registry`);
    assert.equal(spec?.renderOnly, true, `${name} must be render-only`);
    assert.deepEqual(spec?.firesSignals, [], `${name} must fire no signal`);
  }
});

test("specRejected stays available as the in-app escape hatch (not guarded)", () => {
  assert.ok(!GUARDED_GATE_SIGNALS.includes("specRejected"));
  const reject = CHAT_TOOL_REGISTRY.find((t) => t.name === "rejectSpec");
  assert.deepEqual(reject?.firesSignals, ["specRejected"]);
});

// ---------------------------------------------------------------------------
// Wired handlers (item 5) — the invariant above proves the DECLARED shape;
// these prove the CALLS made by the actual handlers match it, via the same
// injectable-deps test seam lib/pipeline.ts already uses (SignalClient,
// GetPrLiveStateDeps).
// ---------------------------------------------------------------------------

test("CHAT_TOOL_HANDLERS has exactly one handler per registry entry, no more no fewer", () => {
  const registryNames = CHAT_TOOL_REGISTRY.map((t) => t.name).sort();
  const handlerNames = (Object.keys(CHAT_TOOL_HANDLERS) as ChatToolName[]).sort();
  assert.deepEqual(handlerNames, registryNames);
});

const draftMarkdown = "---\nid: 0099\ntitle: Test spec\nstatus: draft\n---\n\n## Handoff log\n- entry one\n- entry two\n";

const waitingAtSpecGate: PipelineViewState = {
  state: "waiting_at_gate",
  gate: "spec",
  availableActions: ["specApproved", "specRejected"],
  canStart: false,
};

const githubPr: PullRequestRef = {
  repo: "acme/launchpad",
  branch: "spec/0099",
  workdir: "/tmp/wt",
  number: 7,
  url: "https://github.com/acme/launchpad/pull/7",
};

const waitingAtPrGate: PipelineViewState = {
  state: "waiting_at_gate",
  gate: "pr",
  availableActions: ["prApproved", "specRejected"],
  canStart: false,
  pr: githubPr,
};

interface FakeDeps {
  deps: ChatToolDeps;
  calls: {
    startPipeline: unknown[][];
    signalGate: unknown[][];
    getPipelineViewStateSafe: unknown[][];
    getPrLiveState: unknown[][];
    listSpecs: unknown[][];
    readSpecFile: unknown[][];
  };
}

function fakeDeps(overrides: Partial<ChatToolDeps> = {}, view: PipelineViewState | null = waitingAtSpecGate): FakeDeps {
  const calls: FakeDeps["calls"] = {
    startPipeline: [],
    signalGate: [],
    getPipelineViewStateSafe: [],
    getPrLiveState: [],
    listSpecs: [],
    readSpecFile: [],
  };
  const specSummaries: SpecSummary[] = [
    {
      id: "0099",
      title: "Test spec",
      status: "draft",
      filename: "0099-test.md",
      progress: { checked: 0, total: 0 },
    },
  ];
  const prLive: PrLiveStateResult = { available: false, reason: "no_token" };
  const deps: ChatToolDeps = {
    startPipeline: async (...args: unknown[]) => {
      calls.startPipeline.push(args);
    },
    signalGate: async (...args: unknown[]) => {
      calls.signalGate.push(args);
    },
    getPipelineViewStateSafe: async (...args: unknown[]) => {
      calls.getPipelineViewStateSafe.push(args);
      return view;
    },
    getPrLiveState: async (...args: unknown[]) => {
      calls.getPrLiveState.push(args);
      return prLive;
    },
    listSpecs: async (...args: unknown[]) => {
      calls.listSpecs.push(args);
      return specSummaries;
    },
    readSpecFile: async (...args: unknown[]) => {
      calls.readSpecFile.push(args);
      return draftMarkdown;
    },
    ...overrides,
  } as ChatToolDeps;
  return { deps, calls };
}

test("executeStartPipeline calls startPipeline with the SESSION actor and fires no gate signal", async () => {
  const { deps, calls } = fakeDeps();
  const result = await executeStartPipeline({ specId: "0099", request: "add a widget" }, "owner@example.com", deps);
  assert.equal(result.ok, true);
  assert.equal(calls.startPipeline.length, 1);
  const [, , actor] = calls.startPipeline[0] as [string, string, string];
  assert.equal(actor, "owner@example.com", "the verified session email must be the recorded actor (spec 0074)");
  assert.equal(calls.signalGate.length, 0);
});

test("executeRejectSpec fires ONLY specRejected with the SESSION actor, never a guarded gate signal", async () => {
  const { deps, calls } = fakeDeps();
  const result = await executeRejectSpec({ specId: "0099", reason: "no longer needed" }, "owner@example.com", deps);
  assert.equal(result.ok, true);
  assert.equal(calls.signalGate.length, 1);
  assert.equal(calls.startPipeline.length, 0);
  const [, gate, actor] = calls.signalGate[0] as [string, string, string, ...unknown[]];
  assert.equal(gate, "specRejected");
  assert.equal(actor, "owner@example.com", "the verified session email must be the recorded actor (spec 0074)");
  assert.ok(!GUARDED_GATE_SIGNALS.includes(gate as never));
});

test("executeSpecStatus reads only — never calls startPipeline or signalGate", async () => {
  const { deps, calls } = fakeDeps();
  const result = await executeSpecStatus({ filename: "0099-test.md" }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.specId, "0099");
  assert.deepEqual(result.handoffTail, ["entry two", "entry one"]);
  assert.equal(calls.startPipeline.length, 0);
  assert.equal(calls.signalGate.length, 0);
});

test("executeListSpecs reads only — never calls startPipeline or signalGate", async () => {
  const { deps, calls } = fakeDeps();
  const result = await executeListSpecs(deps);
  assert.equal(result.ok, true);
  assert.equal(result.specs?.length, 1);
  assert.equal(calls.startPipeline.length, 0);
  assert.equal(calls.signalGate.length, 0);
});

test("gate-card render handlers never call startPipeline or signalGate (render-only)", async () => {
  const draftCard = fakeDeps();
  await executeRenderSpecDraftCard({ filename: "0099-test.md" }, draftCard.deps);
  assert.equal(draftCard.calls.startPipeline.length, 0);
  assert.equal(draftCard.calls.signalGate.length, 0);

  const promoteCard = fakeDeps();
  await executeRenderPromoteCard({ filename: "0099-test.md" }, promoteCard.deps);
  assert.equal(promoteCard.calls.startPipeline.length, 0);
  assert.equal(promoteCard.calls.signalGate.length, 0);

  const prCard = fakeDeps({}, waitingAtPrGate);
  const prResult = await executeRenderPrLinkCard({ filename: "0099-test.md" }, prCard.deps);
  assert.equal(prCard.calls.startPipeline.length, 0);
  assert.equal(prCard.calls.signalGate.length, 0);
  assert.equal(prResult.ok, true);
  assert.deepEqual(prResult.pr, githubPr);
});

test("renderPrLinkCard reports unavailable (not an error thrown) when no PR ref exists yet", async () => {
  const { deps } = fakeDeps({}, waitingAtSpecGate);
  const result = await executeRenderPrLinkCard({ filename: "0099-test.md" }, deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no PR ref/);
});
