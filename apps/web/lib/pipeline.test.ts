import { test } from "node:test";
import assert from "node:assert/strict";
import {
  workflowIdFor,
  specIdForProjectWorkflowId,
  specIdFromWorkflowId,
  derivePipelineState,
  derivePhaseViewState,
  formatPipelineLabel,
  signalGate,
  suppressDuplicateApprove,
  getPrLiveState,
  getPromoteCiState,
  decidePromoteGate,
  getPipelineViewStateSafe,
  resolvePromoteSignalGuard,
  type PipelineDescription,
  type PipelineViewState,
  type SignalClient,
  type GetPrLiveStateDeps,
  type GetPromoteCiStateDeps,
  type PromoteCiResult,
  resolveGate2Attestation,
  type PromoteConcurrencyDeps,
} from "./pipeline.js";
import {
  pipelinePhase,
  pipelinePr,
  pipelineTarget,
  type PullRequestRef,
  type PipelineTarget,
} from "@launchpad/pipeline";
import type { PrState } from "@launchpad/github";

const SPEC_STATUSES = [
  "draft",
  "approved",
  "in_progress",
  "staged",
  "promoted",
  "rejected",
] as const;

const NOT_STARTED: PipelineDescription = { exists: false };
const running = (): PipelineDescription => ({ exists: true, status: "RUNNING" });
const withStatus = (status: PipelineDescription["status"]): PipelineDescription => ({
  exists: true,
  status,
});

test("no workflow → not_started + Start available, for every spec status", () => {
  for (const specStatus of SPEC_STATUSES) {
    const view = derivePipelineState(specStatus, NOT_STARTED);
    assert.equal(view.state, "not_started", specStatus);
    assert.equal(view.canStart, true, specStatus);
    assert.deepEqual(view.availableActions, [], specStatus);
    assert.equal(view.gate, undefined, specStatus);
  }
});

test("draft + running → waiting at the spec gate", () => {
  const view = derivePipelineState("draft", running());
  assert.equal(view.state, "waiting_at_gate");
  assert.equal(view.gate, "spec");
  assert.deepEqual(view.availableActions, ["specApproved", "specRejected"]);
  assert.equal(view.canStart, false);
});

test("approved + running → waiting at the PR gate", () => {
  const view = derivePipelineState("approved", running());
  assert.equal(view.state, "waiting_at_gate");
  assert.equal(view.gate, "pr");
  assert.deepEqual(view.availableActions, ["prApproved", "specRejected"]);
});

test("in_progress + running → waiting at the PR gate (same bucket as approved)", () => {
  const view = derivePipelineState("in_progress", running());
  assert.equal(view.state, "waiting_at_gate");
  assert.equal(view.gate, "pr");
  assert.deepEqual(view.availableActions, ["prApproved", "specRejected"]);
});

test("staged + running → waiting at the promote gate", () => {
  const view = derivePipelineState("staged", running());
  assert.equal(view.state, "waiting_at_gate");
  assert.equal(view.gate, "promote");
  assert.deepEqual(view.availableActions, ["promote", "specRejected"]);
});

test("promoted + running → terminal spec state, no gate buttons", () => {
  const view = derivePipelineState("promoted", running());
  assert.equal(view.state, "running");
  assert.equal(view.gate, undefined);
  assert.deepEqual(view.availableActions, []);
  assert.equal(view.canStart, false);
});

test("rejected + running → terminal spec state, no gate buttons", () => {
  const view = derivePipelineState("rejected", running());
  assert.equal(view.state, "running");
  assert.deepEqual(view.availableActions, []);
});

test("an unrecognized spec status never throws and offers no actions", () => {
  const view = derivePipelineState("some-future-status", running());
  assert.equal(view.state, "running");
  assert.deepEqual(view.availableActions, []);
  assert.equal(view.canStart, false);
});

test("COMPLETED workflow → completed, regardless of spec status", () => {
  for (const specStatus of SPEC_STATUSES) {
    const view = derivePipelineState(specStatus, withStatus("COMPLETED"));
    assert.equal(view.state, "completed", specStatus);
    assert.deepEqual(view.availableActions, [], specStatus);
  }
});

for (const status of [
  "CANCELLED",
  "TIMED_OUT",
  "CONTINUED_AS_NEW",
  "UNSPECIFIED",
  "PAUSED",
  "UNKNOWN",
] as const) {
  test(`${status} workflow → failed, regardless of spec status`, () => {
    for (const specStatus of SPEC_STATUSES) {
      const view = derivePipelineState(specStatus, withStatus(status));
      assert.equal(view.state, "failed", `${status}/${specStatus}`);
      assert.deepEqual(view.availableActions, [], `${status}/${specStatus}`);
      assert.equal(view.canStart, false, `${status}/${specStatus}`);
    }
  });
}

// spec 0008 item 7: FAILED/TERMINATED are the two statuses that offer a
// restart ("Start new run") — Temporal allows workflow id reuse once the
// prior run is closed.
for (const status of ["FAILED", "TERMINATED"] as const) {
  test(`${status} workflow → failed, but canStart (restart) is offered`, () => {
    for (const specStatus of SPEC_STATUSES) {
      const view = derivePipelineState(specStatus, withStatus(status));
      assert.equal(view.state, "failed", `${status}/${specStatus}`);
      assert.deepEqual(view.availableActions, [], `${status}/${specStatus}`);
      assert.equal(view.canStart, true, `${status}/${specStatus}`);
    }
  });
}

// --- Phase-driven derivation (spec 0007, item 3; demoted fallback in spec
// 0008, item 7) -------------------------------------------------------------
// Gate integrity fix: buttons render ONLY in awaiting_* phases; coding shows
// progress; an undefined phase while the workflow is genuinely RUNNING no
// longer guesses via the frontmatter heuristic (that guess is what showed an
// "Approve PR" button at gate 1 in spec 0007's run 2) — it renders an honest
// unknown/legacy state with no gate buttons instead. An undefined phase while
// the workflow ISN'T running (not started/completed/failed) still uses
// `fallback` as-is, since that's real status, not a guess.
const FALLBACK: PipelineViewState = {
  state: "running",
  availableActions: [],
  canStart: false,
};

test("derivePhaseViewState: awaiting_pr_approval → PR gate buttons", () => {
  const view = derivePhaseViewState("awaiting_pr_approval", true, FALLBACK);
  assert.equal(view.state, "waiting_at_gate");
  assert.equal(view.gate, "pr");
  assert.deepEqual(view.availableActions, ["prApproved", "specRejected"]);
});

test("derivePhaseViewState: coding → NO buttons, plan progress shown", () => {
  const view = derivePhaseViewState("coding", true, FALLBACK, { checked: 2, total: 5 });
  assert.deepEqual(view.availableActions, []);
  assert.equal(view.gate, undefined);
  assert.deepEqual(view.planProgress, { checked: 2, total: 5 });
});

// Regression (found live 2026-07-03): closed workflows whose replayed query
// reports a pre-0009 non-terminal phase (tearing_down) showed as "Running"
// in the inbox; a closed run reporting a gate phase would even render
// clickable buttons. Real (closed) status must dominate non-terminal phases.
test("derivePhaseViewState: CLOSED run + non-terminal phase (tearing_down) → fallback, not running", () => {
  const completedFallback: import("./pipeline.js").PipelineViewState = {
    state: "completed",
    availableActions: [],
    canStart: false,
  };
  const view = derivePhaseViewState("tearing_down", false, completedFallback);
  assert.equal(view.state, "completed");
  assert.deepEqual(view.availableActions, []);
});

test("derivePhaseViewState: CLOSED run + gate phase → NO buttons (fallback wins)", () => {
  const failedFallback: import("./pipeline.js").PipelineViewState = {
    state: "failed",
    availableActions: [],
    canStart: true,
  };
  const view = derivePhaseViewState("awaiting_pr_approval", false, failedFallback);
  assert.equal(view.state, "failed");
  assert.deepEqual(view.availableActions, []);
});

test("derivePhaseViewState: CLOSED run + TERMINAL phase still maps directly", () => {
  const view = derivePhaseViewState("promoted", false, FALLBACK);
  assert.equal(view.state, "completed");
});

test("derivePhaseViewState: non-gate running phase (merging) → no buttons", () => {
  const view = derivePhaseViewState("merging", true, FALLBACK);
  assert.deepEqual(view.availableActions, []);
  assert.equal(view.state, "running");
});

test("derivePhaseViewState: undefined phase + not actually running → uses fallback as-is (no guessing needed)", () => {
  assert.deepEqual(derivePhaseViewState(undefined, false, FALLBACK), FALLBACK);
  const notStarted: PipelineViewState = { state: "not_started", availableActions: [], canStart: true };
  assert.deepEqual(derivePhaseViewState(undefined, false, notStarted), notStarted);
});

test("derivePhaseViewState: undefined phase + genuinely RUNNING → unknown legacy run, no gate buttons (spec 0008 item 7)", () => {
  // Even when the frontmatter heuristic would have guessed a gate (e.g. spec
  // status "draft" → FALLBACK-shaped guess of gate 1), a RUNNING workflow
  // with no phase must never show a gate button.
  const guessedGate1: PipelineViewState = {
    state: "waiting_at_gate",
    gate: "spec",
    availableActions: ["specApproved", "specRejected"],
    canStart: false,
  };
  const view = derivePhaseViewState(undefined, true, guessedGate1);
  assert.equal(view.state, "unknown_legacy_run");
  assert.deepEqual(view.availableActions, []);
  assert.equal(view.gate, undefined);
  assert.equal(view.canStart, false);
});

// spec 0009: terminal phases map directly, regardless of the fallback guess
// or whether Temporal still reports the execution as RUNNING (a closed
// workflow can still answer a query during replay).
test("derivePhaseViewState: promoted → completed, no actions, no restart", () => {
  const view = derivePhaseViewState("promoted", false, FALLBACK);
  assert.equal(view.state, "completed");
  assert.deepEqual(view.availableActions, []);
  assert.equal(view.gate, undefined);
  assert.equal(view.canStart, false);
});

test("derivePhaseViewState: rejected → completed, no actions, no restart", () => {
  const view = derivePhaseViewState("rejected", false, FALLBACK);
  assert.equal(view.state, "completed");
  assert.deepEqual(view.availableActions, []);
  assert.equal(view.canStart, false);
});

test("derivePhaseViewState: failed → failed, restart offered", () => {
  const view = derivePhaseViewState("failed", false, FALLBACK);
  assert.equal(view.state, "failed");
  assert.deepEqual(view.availableActions, []);
  assert.equal(view.canStart, true);
});

// spec 0018: promotion succeeded but teardown failed afterward — distinct
// from plain `failed` (no restart: re-running an already-promoted spec's
// whole pipeline would be wrong) and from `promoted` (there IS a real
// problem — cleanup — an operator needs to know about).
test("derivePhaseViewState: promoted_teardown_failed → its own state, no actions, no restart", () => {
  const view = derivePhaseViewState("promoted_teardown_failed", false, FALLBACK);
  assert.equal(view.state, "promoted_teardown_failed");
  assert.deepEqual(view.availableActions, []);
  assert.equal(view.gate, undefined);
  assert.equal(view.canStart, false);
});

test("derivePhaseViewState: terminal phase wins even if `fallback` guessed a gate", () => {
  // Guards against ever re-introducing a fallback consultation for terminal
  // phases — a stale `fallback` guess (e.g. frontmatter still says "staged")
  // must never override a terminal phase's own mapping.
  const guessedGate3: PipelineViewState = {
    state: "waiting_at_gate",
    gate: "promote",
    availableActions: ["promote", "specRejected"],
    canStart: false,
  };
  const view = derivePhaseViewState("promoted", false, guessedGate3);
  assert.equal(view.state, "completed");
  assert.deepEqual(view.availableActions, []);
  assert.equal(view.gate, undefined);
});

test("formatPipelineLabel: null (describePipeline failed) → Desconocido", () => {
  assert.equal(formatPipelineLabel(null), "Desconocido");
});

test("formatPipelineLabel: no gate → just the state label", () => {
  assert.equal(
    formatPipelineLabel(derivePipelineState("draft", NOT_STARTED)),
    "Sin empezar",
  );
  assert.equal(
    formatPipelineLabel(derivePipelineState("promoted", { exists: true, status: "COMPLETED" })),
    "Completado",
  );
});

test("formatPipelineLabel: waiting at a gate → state label + gate label", () => {
  assert.equal(
    formatPipelineLabel(derivePipelineState("draft", running())),
    "Esperando en compuerta — aprobación de spec (compuerta 1)",
  );
  assert.equal(
    formatPipelineLabel(derivePipelineState("approved", running())),
    "Esperando en compuerta — aprobación de PR (compuerta 2)",
  );
  assert.equal(
    formatPipelineLabel(derivePipelineState("staged", running())),
    "Esperando en compuerta — promoción (compuerta 3)",
  );
});

// --- signalGate: fake-Client seam (spec 0008, item 6) --------------------
// signalGate takes an optional client override so its delivery logic (and
// the "not actually running" guard that's the fix for run 2's "Approve PR
// click never signaled the workflow" incident) is testable without a live
// Temporal server. The fake only implements the `workflow.getHandle(...)`
// surface signalGate actually calls.
interface RecordedSignal {
  workflowId: string;
  signalName: string;
  arg: unknown;
}

function fakeClient(status: string, calls: RecordedSignal[]): SignalClient {
  return {
    workflow: {
      getHandle(workflowId: string) {
        return {
          describe: async () => ({ status: { name: status } }),
          signal: async (def: { name: string }, arg: unknown) => {
            calls.push({ workflowId, signalName: def.name, arg });
          },
        };
      },
    },
  } as unknown as SignalClient;
}

test("signalGate: delivers the signal when the workflow is RUNNING", async () => {
  const calls: RecordedSignal[] = [];
  await signalGate("0099", "prApproved", "owner@example.com", undefined, fakeClient("RUNNING", calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.workflowId, "spec-0099");
  assert.equal(calls[0]?.signalName, "prApproved");
  assert.deepEqual(calls[0]?.arg, { approvedBy: "owner@example.com" });
});

for (const status of ["FAILED", "TERMINATED", "COMPLETED"]) {
  test(`signalGate: throws a clear error instead of signaling a ${status} run`, async () => {
    const calls: RecordedSignal[] = [];
    await assert.rejects(
      () => signalGate("0099", "prApproved", "owner@example.com", undefined, fakeClient(status, calls)),
      (err: unknown) => {
        assert.ok(err instanceof Error, "rejects with an Error");
        assert.match(err.message, /not running/);
        assert.match(err.message, new RegExp(status));
        return true;
      },
    );
    assert.equal(calls.length, 0, "must not attempt to signal a non-running execution");
  });
}

// --- getPipelineViewStateSafe: fake-Client seam (spec 0042 item D) ---------
// The spec-detail page's MAIN render path used to call the unsafe
// getPipelineViewState, which throws (and 500s the route) when Temporal is
// unreachable — describePipeline's catch only swallows the expected
// WorkflowNotFoundError/gRPC NOT_FOUND "no workflow yet" case, not a
// connection failure. getPipelineViewStateSafe now forwards planProgress
// (mirroring getPipelineViewState's own signature) and takes the same
// clientOverride test seam as signalGate, so both properties are provable
// without a live Temporal server.
function fakeDescribeClient(
  describe: () => Promise<{ status: { name: string } }>,
  query: (def: unknown) => Promise<unknown> = async () => undefined,
): SignalClient {
  return {
    workflow: {
      getHandle() {
        return { describe, query };
      },
    },
  } as unknown as SignalClient;
}

test("getPipelineViewStateSafe: non-NOT_FOUND describe() failure → null", async () => {
  const client = fakeDescribeClient(async () => {
    throw new Error("Failed to connect before the deadline");
  });
  const view = await getPipelineViewStateSafe("0099", "approved", undefined, client);
  assert.equal(view, null);
});

test("getPipelineViewStateSafe: success path forwards planProgress", async () => {
  const client = fakeDescribeClient(
    async () => ({ status: { name: "RUNNING" } }),
    async (def: unknown) => (def === pipelinePhase ? "coding" : undefined),
  );
  const view = await getPipelineViewStateSafe(
    "0099",
    "in_progress",
    { checked: 3, total: 7 },
    client,
  );
  assert.ok(view, "success path must not return null");
  assert.equal(view?.state, "running");
  assert.deepEqual(view?.planProgress, { checked: 3, total: 7 });
});

// --- target passthrough (spec 0059 item A) ---------------------------------
// describePipeline adds a 4th query (pipelineTarget, spec 0033's existing
// query handler) alongside phase/pr/gate2Poll, with the SAME
// degrade-to-absent-on-any-failure rule; getPipelineViewState carries it
// through verbatim on PipelineViewState.target — the run-follow card's
// Hangar deep-link needs to tell a tenant run from a self run.

const TENANT_TARGET: PipelineTarget = {
  kind: "tenant",
  tenantId: "acme",
  repo: "/tmp/acme",
  odooVersion: 18,
  vpsId: 903331,
};

test("getPipelineViewStateSafe: tenant target passes through verbatim on view.target", async () => {
  const client = fakeDescribeClient(
    async () => ({ status: { name: "RUNNING" } }),
    async (def: unknown) => {
      if (def === pipelinePhase) return "deploying";
      if (def === pipelineTarget) return TENANT_TARGET;
      return undefined;
    },
  );
  const view = await getPipelineViewStateSafe("0099", "in_progress", undefined, client);
  assert.ok(view, "success path must not return null");
  assert.deepEqual(view?.target, TENANT_TARGET);
});

test("getPipelineViewStateSafe: pipelineTarget query failure → target absent, no error", async () => {
  const client = fakeDescribeClient(
    async () => ({ status: { name: "RUNNING" } }),
    async (def: unknown) => {
      if (def === pipelinePhase) return "coding";
      if (def === pipelineTarget) throw new Error("no such query handler");
      return undefined;
    },
  );
  const view = await getPipelineViewStateSafe("0099", "in_progress", undefined, client);
  assert.ok(view, "a query failure must degrade to absent, not throw/null");
  assert.equal(view?.target, undefined);
});

// --- suppressDuplicateApprove (spec 0015 item 8) ---------------------------
// Gate-2 PR surface: the in-app "Approve PR" button is a duplicate source of
// truth once gate 2 is a real GitHub PR (the GitHub review IS the approval,
// delivered via awaitPrApproval) — suppress it in that case only.

const PR_ACTIONS: ("prApproved" | "specRejected")[] = ["prApproved", "specRejected"];

function ghPr(overrides: Partial<PullRequestRef> = {}): PullRequestRef {
  return {
    repo: "example-org/launchpad",
    branch: "spec/0015",
    workdir: "/tmp/repo",
    number: 42,
    url: "https://github.com/example-org/launchpad/pull/42",
    ...overrides,
  };
}

test("suppressDuplicateApprove: no pr ref (never opened / legacy run) → unchanged", () => {
  assert.deepEqual(suppressDuplicateApprove(PR_ACTIONS, undefined), PR_ACTIONS);
});

test("suppressDuplicateApprove: local-diff pr (number 0) → unchanged", () => {
  assert.deepEqual(suppressDuplicateApprove(PR_ACTIONS, ghPr({ number: 0 })), PR_ACTIONS);
});

test("suppressDuplicateApprove: real GitHub PR (number > 0) → prApproved removed, specRejected kept", () => {
  assert.deepEqual(suppressDuplicateApprove(PR_ACTIONS, ghPr()), ["specRejected"]);
});

test("suppressDuplicateApprove: real GitHub PR with no prApproved present → no-op, not a crash", () => {
  assert.deepEqual(suppressDuplicateApprove(["specRejected"], ghPr()), ["specRejected"]);
});

// --- getPrLiveState (spec 0015 item 8) --------------------------------------
// GITHUB_TOKEN is validated here (validatePrModeEnv), not app-wide; the
// injectable createGithubClient seam (mirrors the pipeline's own
// OpenPullRequestDeps/AwaitPrApprovalDeps/MergePullRequestDeps) keeps this
// offline/network-free.

function fakePrState(overrides: Partial<PrState> = {}): PrState {
  return {
    number: 42,
    state: "open",
    merged: false,
    mergeable: true,
    reviewDecision: null,
    checks: "pending",
    approvedBy: null,
    mergedBy: null,
    mergeCommitSha: null,
    ...overrides,
  };
}

function fakeGithubClientDeps(state: PrState, calls: string[] = []): GetPrLiveStateDeps {
  return {
    createGithubClient: (config) => {
      calls.push(`${config.owner}/${config.repo}`);
      return {
        getPrState: async (number: number) => {
          assert.equal(number, 42);
          return state;
        },
      };
    },
  };
}

test("getPrLiveState: no GITHUB_TOKEN → unavailable, no client constructed", async () => {
  const calls: string[] = [];
  const result = await getPrLiveState(ghPr(), {}, fakeGithubClientDeps(fakePrState(), calls));
  assert.deepEqual(result, { available: false, reason: "no_token" });
  assert.equal(calls.length, 0);
});

test("getPrLiveState: unparseable repo (local-diff workdir, not owner/repo) → unavailable", async () => {
  const result = await getPrLiveState(
    ghPr({ repo: "/tmp/repo" }),
    { GITHUB_TOKEN: "ghp_x" },
    fakeGithubClientDeps(fakePrState()),
  );
  assert.deepEqual(result, { available: false, reason: "unparseable_repo" });
});

test("getPrLiveState: token + parseable repo → live state via the injected client", async () => {
  const calls: string[] = [];
  const state = fakePrState({ reviewDecision: "approved", approvedBy: "owner", checks: "success" });
  const result = await getPrLiveState(
    ghPr(),
    { GITHUB_TOKEN: "ghp_x" },
    fakeGithubClientDeps(state, calls),
  );
  assert.deepEqual(result, { available: true, state });
  assert.deepEqual(calls, ["example-org/launchpad"]);
});

test("getPrLiveState: client throws → unavailable (fetch_failed), never crashes the page", async () => {
  const deps: GetPrLiveStateDeps = {
    createGithubClient: () => ({
      getPrState: async () => {
        throw new Error("network down");
      },
    }),
  };
  const result = await getPrLiveState(ghPr(), { GITHUB_TOKEN: "ghp_x" }, deps);
  assert.deepEqual(result, { available: false, reason: "fetch_failed" });
});

// --- getPromoteCiState / decidePromoteGate (spec 0043, source swapped to the
// local-CI artifact by spec 0058 / ADR-024, made TOKEN-LESS by spec 0063) ----
// Gate-3 promote guard: does the CURRENT `origin/main` tip have a recorded
// local-CI verdict for this spec? Separate helper from getPrLiveState above
// (which reads the PR branch head's checks for gate 2) — same never-throws,
// typed-reason discipline. No GitHub client involved any more: the injected
// `listPromoteCiArtifacts` + `resolveOriginMainSha` seams stand in for the fs
// read + git call, and `selectPromoteCiArtifact` (lib/promote-ci-artifact.ts)
// does the specId + evaluatedSha matching.

const REPO_ENV = { LAUNCHPAD_REPO_ROOT: "/repo" };
const SPEC_ID = "0058";
const CURRENT_SHA = "current-tip-sha";

/** A valid raw artifact JSON string for the given specId/evaluatedSha +
 * conclusion — mirrors the shape `scripts/supervise.mjs`'s `postMerge()`
 * writes (schema in lib/promote-ci-artifact.ts). */
function fakeArtifactRaw(
  specId: string,
  evaluatedSha: string,
  conclusion: "success" | "failure",
): string {
  return JSON.stringify({
    schema: 1,
    specId,
    branch: `spec/${specId}`,
    mergeSha: evaluatedSha,
    evaluatedSha,
    conclusion,
    ranAt: "2026-07-16T00:00:00.000Z",
    steps: [{ name: "build", ok: true, ms: 1 }],
  });
}

function fakePromoteCiDeps(
  raws: string[],
  currentSha: string | null = CURRENT_SHA,
): GetPromoteCiStateDeps {
  return {
    listPromoteCiArtifacts: () => raws,
    resolveOriginMainSha: () => currentSha,
  };
}

test("getPromoteCiState: local-diff ref (number 0) → unavailable, no list/rev-parse", async () => {
  const calls: string[] = [];
  const deps: GetPromoteCiStateDeps = {
    listPromoteCiArtifacts: () => {
      calls.push("list");
      return [];
    },
    resolveOriginMainSha: () => {
      calls.push("rev-parse");
      return CURRENT_SHA;
    },
  };
  const result = await getPromoteCiState(ghPr({ number: 0 }), SPEC_ID, REPO_ENV, deps);
  assert.deepEqual(result, { available: false, reason: "local_diff" });
  assert.equal(calls.length, 0);
});

test("getPromoteCiState: no LAUNCHPAD_REPO_ROOT → unavailable (no_local_ci), no list/rev-parse", async () => {
  const calls: string[] = [];
  const deps: GetPromoteCiStateDeps = {
    listPromoteCiArtifacts: () => {
      calls.push("list");
      return [];
    },
    resolveOriginMainSha: () => {
      calls.push("rev-parse");
      return CURRENT_SHA;
    },
  };
  const result = await getPromoteCiState(ghPr(), SPEC_ID, {}, deps);
  assert.deepEqual(result, { available: false, reason: "no_local_ci" });
  assert.equal(calls.length, 0);
});

test("getPromoteCiState: origin/main tip unresolvable (git failure) → unavailable (no_local_ci)", async () => {
  const result = await getPromoteCiState(ghPr(), SPEC_ID, REPO_ENV, fakePromoteCiDeps([], null));
  assert.deepEqual(result, { available: false, reason: "no_local_ci" });
});

for (const conclusion of ["success", "failure"] as const) {
  test(`getPromoteCiState: current artifact matching specId + evaluatedSha → local "${conclusion}" conclusion`, async () => {
    const raw = fakeArtifactRaw(SPEC_ID, CURRENT_SHA, conclusion);
    const result = await getPromoteCiState(ghPr(), SPEC_ID, REPO_ENV, fakePromoteCiDeps([raw]));
    assert.deepEqual(result, { available: true, conclusion });
  });
}

test("getPromoteCiState: no artifacts present → unavailable (no_local_ci)", async () => {
  const result = await getPromoteCiState(ghPr(), SPEC_ID, REPO_ENV, fakePromoteCiDeps([]));
  assert.deepEqual(result, { available: false, reason: "no_local_ci" });
});

test("getPromoteCiState: malformed artifact JSON → treated as absent (no_local_ci)", async () => {
  const result = await getPromoteCiState(
    ghPr(),
    SPEC_ID,
    REPO_ENV,
    fakePromoteCiDeps(["{not json"]),
  );
  assert.deepEqual(result, { available: false, reason: "no_local_ci" });
});

test("getPromoteCiState: artifact evaluatedSha stale (pre-polish tip) → treated as absent (no_local_ci)", async () => {
  const raw = fakeArtifactRaw(SPEC_ID, "stale-pre-polish-sha", "success");
  const result = await getPromoteCiState(ghPr(), SPEC_ID, REPO_ENV, fakePromoteCiDeps([raw]));
  assert.deepEqual(result, { available: false, reason: "no_local_ci" });
});

test("getPromoteCiState: artifact specId mismatch (another spec's run) → treated as absent (no_local_ci)", async () => {
  const raw = fakeArtifactRaw("0099", CURRENT_SHA, "success");
  const result = await getPromoteCiState(ghPr(), SPEC_ID, REPO_ENV, fakePromoteCiDeps([raw]));
  assert.deepEqual(result, { available: false, reason: "no_local_ci" });
});

test("getPromoteCiState: deps throw → unavailable (fetch_failed), never crashes", async () => {
  const deps: GetPromoteCiStateDeps = {
    listPromoteCiArtifacts: () => {
      throw new Error("fs blew up");
    },
    resolveOriginMainSha: () => CURRENT_SHA,
  };
  const result = await getPromoteCiState(ghPr(), SPEC_ID, REPO_ENV, deps);
  assert.deepEqual(result, { available: false, reason: "fetch_failed" });
});

test("decidePromoteGate: success → enabled, ok tone", () => {
  const decision = decidePromoteGate({ available: true, conclusion: "success" });
  assert.deepEqual(decision, {
    enabled: true,
    tone: "ok",
    message: "CI local verde — listo para promover.",
  });
});

test("decidePromoteGate: failure → disabled, danger tone (genuine block)", () => {
  const decision = decidePromoteGate({ available: true, conclusion: "failure" });
  assert.deepEqual(decision, {
    enabled: false,
    tone: "danger",
    message: "CI local rojo — no se puede promover. Arregla en main y vuelve a correr el watcher.",
  });
});

test("decidePromoteGate: no_local_ci → enabled, warn tone, names the watcher", () => {
  const decision = decidePromoteGate({ available: false, reason: "no_local_ci" });
  assert.deepEqual(decision, {
    enabled: true,
    tone: "warn",
    message:
      "El CI local no ha reportado para este commit de fusión (el watcher post-merge aún no ha corrido) — promueves bajo tu criterio.",
  });
});

const UNAVAILABLE_REASONS: PromoteCiResult[] = [
  { available: false, reason: "no_token" },
  { available: false, reason: "local_diff" },
  { available: false, reason: "unparseable_repo" },
  { available: false, reason: "no_merge_commit" },
  { available: false, reason: "fetch_failed" },
];

for (const result of UNAVAILABLE_REASONS) {
  test(`decidePromoteGate: unavailable (${result.available === false ? result.reason : ""}) → enabled, warn tone allow-with-note`, () => {
    const decision = decidePromoteGate(result);
    assert.equal(decision.enabled, true);
    assert.equal(decision.tone, "warn");
    assert.ok(decision.message.includes(result.available === false ? result.reason : ""));
  });
}

// --- resolvePromoteSignalGuard (spec 0043 item D; red-artifact block proven
// for the local-CI source by spec 0058 item 3 / AC4) -------------------------
// Server-side promote guard: the SAME getPromoteCiState + decidePromoteGate
// as item C's render, reused here so the server never diverges from what the
// client showed. Only ever consults local CI for signal === "promote".

/**
 * Spec 0118: the concurrency clauses' IO seam, stubbed to "nothing to report".
 *
 * Every pre-0118 test below passes this EXPLICITLY. The defaults degrade to the
 * same answer, so omitting it would still pass — but only by reaching a real
 * `getClient()` and listing real workflows, which on a developer machine with
 * Temporal up is a live dependency hiding inside a unit test. It would pass today
 * and change behaviour the day a run happens to be mid-deploy.
 */
const IDLE_CONCURRENCY: PromoteConcurrencyDeps = {
  getGate2Attestation: async () => undefined,
  resolveRefSha: () => null,
  listProductionBusySpecIds: async () => [],
  readOdooShBuild: async () => ({ status: "absent" as const }),
};

function fakeDescribeClientWithPr(pr: PullRequestRef | undefined): SignalClient {
  return fakeDescribeClient(
    async () => ({ status: { name: "RUNNING" } }),
    async (def: unknown) => {
      if (def === pipelinePhase) return "awaiting_promote";
      if (def === pipelinePr) return pr;
      return undefined;
    },
  );
}

for (const signal of ["specApproved", "prApproved", "specRejected"] as const) {
  test(`resolvePromoteSignalGuard: non-promote signal "${signal}" → never blocked, never touches Temporal or CI`, async () => {
    let describeCalled = false;
    const client: SignalClient = {
      workflow: {
        getHandle() {
          return {
            describe: async () => {
              describeCalled = true;
              return { status: { name: "RUNNING" } };
            },
            query: async () => undefined,
          };
        },
      },
    } as unknown as SignalClient;
    // A deps object whose methods throw proves the guard short-circuits
    // before ever reaching getPromoteCiState for a non-promote signal.
    const spyDeps: GetPromoteCiStateDeps = {
      listPromoteCiArtifacts: () => {
        throw new Error("must not be called for a non-promote signal");
      },
      resolveOriginMainSha: () => {
        throw new Error("must not be called for a non-promote signal");
      },
    };
    const guard = await resolvePromoteSignalGuard("0099", signal, client, {}, spyDeps, IDLE_CONCURRENCY);
    assert.deepEqual(guard, { blocked: false });
    assert.equal(describeCalled, false, "must not consult Temporal for a non-promote signal");
  });
}

test("resolvePromoteSignalGuard: promote + red local-CI artifact → blocked, with the decidePromoteGate message (AC4)", async () => {
  const client = fakeDescribeClientWithPr(ghPr());
  const raw = fakeArtifactRaw("0099", CURRENT_SHA, "failure");
  const guard = await resolvePromoteSignalGuard(
    "0099",
    "promote",
    client,
    REPO_ENV,
    fakePromoteCiDeps([raw]),
    IDLE_CONCURRENCY,
  );
  assert.equal(guard.blocked, true);
  assert.equal(
    guard.message,
    decidePromoteGate({ available: true, conclusion: "failure" }).message,
  );
});

test("resolvePromoteSignalGuard: promote + green local-CI artifact → allowed", async () => {
  const client = fakeDescribeClientWithPr(ghPr());
  const raw = fakeArtifactRaw("0099", CURRENT_SHA, "success");
  const guard = await resolvePromoteSignalGuard(
    "0099",
    "promote",
    client,
    REPO_ENV,
    fakePromoteCiDeps([raw]),
    IDLE_CONCURRENCY,
  );
  assert.deepEqual(guard, { blocked: false });
});

test("resolvePromoteSignalGuard: promote + no local-CI artifact yet (allow-with-note) → allowed", async () => {
  // No LAUNCHPAD_REPO_ROOT → getPromoteCiState resolves { available: false,
  // reason: "no_local_ci" } → decidePromoteGate's allow-with-note fallback.
  const client = fakeDescribeClientWithPr(ghPr());
  const guard = await resolvePromoteSignalGuard("0099", "promote", client, {}, undefined, IDLE_CONCURRENCY);
  assert.deepEqual(guard, { blocked: false });
});

test("resolvePromoteSignalGuard: promote + no PR ref at all (view.pr undefined) → allowed, no CI call", async () => {
  const client = fakeDescribeClientWithPr(undefined);
  const spyDeps: GetPromoteCiStateDeps = {
    listPromoteCiArtifacts: () => {
      throw new Error("must not be called when there's no PR ref to check");
    },
    resolveOriginMainSha: () => {
      throw new Error("must not be called when there's no PR ref to check");
    },
  };
  const guard = await resolvePromoteSignalGuard(
    "0099",
    "promote",
    client,
    REPO_ENV,
    spyDeps,
    IDLE_CONCURRENCY,
  );
  assert.deepEqual(guard, { blocked: false });
});

// --- spec 0118: concurrency B — the promote attestation ---------------------
// The pure decision is tested exhaustively in @launchpad/pipeline's
// promote-attestation.test.ts. What is tested HERE is the wiring: that the guard
// resolves the right inputs, filters the busy list correctly, and that a
// half-resolved attestation is reported as none.

const ATTESTED_SHA = "aaaaaaa1111111111111111111111111111111111";
const BASE_SHA = "bbbbbbb2222222222222222222222222222222222";

test("resolveGate2Attestation: reads the PR branch tip and origin/main", () => {
  const seen: string[] = [];
  const got = resolveGate2Attestation(ghPr(), "/repo", (root, ref) => {
    assert.equal(root, "/repo");
    seen.push(ref);
    return ref === "origin/spec/0015" ? ATTESTED_SHA : BASE_SHA;
  });
  assert.deepEqual(got, { testedSha: ATTESTED_SHA, baseSha: BASE_SHA });
  assert.deepEqual(seen, ["origin/spec/0015", "origin/main"]);
});

test("resolveGate2Attestation: HALF an attestation is reported as NONE", () => {
  // A recorded testedSha with no baseSha would let clause 2 run and clause 3
  // silently not — a promote that reads as checked while half the check is
  // missing. Both or neither.
  assert.equal(
    resolveGate2Attestation(ghPr(), "/repo", (_r, ref) => (ref === "origin/main" ? null : ATTESTED_SHA)),
    undefined,
  );
  assert.equal(
    resolveGate2Attestation(ghPr(), "/repo", (_r, ref) => (ref === "origin/main" ? BASE_SHA : null)),
    undefined,
  );
});

test("resolveGate2Attestation: no PR ref or no repo root → none, never a guess", () => {
  assert.equal(resolveGate2Attestation(undefined, "/repo", () => ATTESTED_SHA), undefined);
  assert.equal(resolveGate2Attestation(ghPr(), undefined, () => ATTESTED_SHA), undefined);
});

/** Concurrency deps whose attestation matches whatever the git stub returns. */
function concurrencyDeps(over: Partial<PromoteConcurrencyDeps> = {}): PromoteConcurrencyDeps {
  return {
    getGate2Attestation: async () => ({
      approvedBy: "owner@example.com",
      testedSha: ATTESTED_SHA,
      baseSha: BASE_SHA,
    }),
    resolveRefSha: (_root, ref) => (ref === "origin/main" ? BASE_SHA : ATTESTED_SHA),
    listProductionBusySpecIds: async () => [],
    readOdooShBuild: async () => ({ status: "absent" as const }),
    ...over,
  };
}

test("promote guard: attestation still matches → allowed", async () => {
  const client = fakeDescribeClientWithPr(ghPr());
  const guard = await resolvePromoteSignalGuard(
    "0099",
    "promote",
    client,
    REPO_ENV,
    fakePromoteCiDeps([fakeArtifactRaw("0099", CURRENT_SHA, "success")]),
    concurrencyDeps(),
  );
  assert.deepEqual(guard, { blocked: false });
});

test("promote guard: the PR moved after approval → blocked", async () => {
  const client = fakeDescribeClientWithPr(ghPr());
  const guard = await resolvePromoteSignalGuard(
    "0099",
    "promote",
    client,
    REPO_ENV,
    fakePromoteCiDeps([fakeArtifactRaw("0099", CURRENT_SHA, "success")]),
    concurrencyDeps({
      resolveRefSha: (_r, ref) => (ref === "origin/main" ? BASE_SHA : "ddddddd4444444444444444"),
    }),
  );
  assert.equal(guard.blocked, true);
  assert.match(guard.message ?? "", /Re-approve/);
});

test("promote guard: main moved after approval → blocked, though CI is green", async () => {
  // Green CI is exactly why this needs its own clause: the merge commit's build
  // says nothing about a base that changed underneath the approval.
  const client = fakeDescribeClientWithPr(ghPr());
  const guard = await resolvePromoteSignalGuard(
    "0099",
    "promote",
    client,
    REPO_ENV,
    fakePromoteCiDeps([fakeArtifactRaw("0099", CURRENT_SHA, "success")]),
    concurrencyDeps({
      resolveRefSha: (_r, ref) => (ref === "origin/main" ? "eeeeeee5555555555555555" : ATTESTED_SHA),
    }),
  );
  assert.equal(guard.blocked, true);
  assert.match(guard.message ?? "", /promoted first/);
});

test("promote guard: another run mid-deploy → blocked", async () => {
  const client = fakeDescribeClientWithPr(ghPr());
  const guard = await resolvePromoteSignalGuard(
    "0099",
    "promote",
    client,
    REPO_ENV,
    fakePromoteCiDeps([fakeArtifactRaw("0099", CURRENT_SHA, "success")]),
    concurrencyDeps({ listProductionBusySpecIds: async () => ["0042"] }),
  );
  assert.equal(guard.blocked, true);
  assert.match(guard.message ?? "", /spec 0042/);
});

test("promote guard: a run never blocks ITSELF for being mid-deploy", async () => {
  // The self-exclusion is load-bearing: by the time a promote is re-sent (a
  // double click, a stale page resubmit), THIS run may itself be listed. Without
  // the filter, every promote blocks itself and the gate is unusable.
  const client = fakeDescribeClientWithPr(ghPr());
  const guard = await resolvePromoteSignalGuard(
    "0099",
    "promote",
    client,
    REPO_ENV,
    fakePromoteCiDeps([fakeArtifactRaw("0099", CURRENT_SHA, "success")]),
    concurrencyDeps({ listProductionBusySpecIds: async () => ["0099"] }),
  );
  assert.deepEqual(guard, { blocked: false });
});

test("promote guard: a RED build still wins over the concurrency clauses", async () => {
  // Ordering matters for the message the human reads: "CI is red" is the more
  // fundamental problem, so it must not be masked by a staleness complaint.
  const client = fakeDescribeClientWithPr(ghPr());
  const guard = await resolvePromoteSignalGuard(
    "0099",
    "promote",
    client,
    REPO_ENV,
    fakePromoteCiDeps([fakeArtifactRaw("0099", CURRENT_SHA, "failure")]),
    concurrencyDeps({ listProductionBusySpecIds: async () => ["0042"] }),
  );
  assert.equal(guard.blocked, true);
  assert.match(guard.message ?? "", /CI local rojo/);
});

test("promote guard: every concurrency read failing degrades to allowed, never to a crash", async () => {
  const client = fakeDescribeClientWithPr(ghPr());
  const guard = await resolvePromoteSignalGuard(
    "0099",
    "promote",
    client,
    REPO_ENV,
    fakePromoteCiDeps([fakeArtifactRaw("0099", CURRENT_SHA, "success")]),
    {
      getGate2Attestation: async () => undefined,
      resolveRefSha: () => null,
      listProductionBusySpecIds: async () => [],
      readOdooShBuild: async () => ({ status: "absent" as const }),
    },
  );
  assert.deepEqual(guard, { blocked: false });
});

test("promote guard: a non-promote signal never runs the concurrency reads", async () => {
  const client = fakeDescribeClientWithPr(ghPr());
  const guard = await resolvePromoteSignalGuard("0099", "prApproved", client, REPO_ENV, undefined, {
    getGate2Attestation: async () => {
      throw new Error("must not be called for a non-promote signal");
    },
    resolveRefSha: () => {
      throw new Error("must not be called for a non-promote signal");
    },
    listProductionBusySpecIds: async () => {
      throw new Error("must not be called for a non-promote signal");
    },
    readOdooShBuild: async () => {
      throw new Error("must not be called for a non-promote signal");
    },
  });
  assert.deepEqual(guard, { blocked: false });
});

// --- Spec 0142 C: workflow ids are namespaced per project -------------------

test("workflowIdFor namespaces a project's runs and leaves the platform alone", () => {
  // The collision this fixes: two projects' spec 0001 were ONE workflow id.
  assert.notEqual(
    workflowIdFor("0001", "ab-test-sandbox"),
    workflowIdFor("0001", "otro-proyecto"),
  );
  assert.equal(workflowIdFor("0001", "ab-test-sandbox"), "spec-ab-test-sandbox-0001");
  // The platform keeps the bare form — its ids are already in Temporal history.
  assert.equal(workflowIdFor("0131", "platform"), "spec-0131");
  assert.equal(workflowIdFor("0131"), "spec-0131");
});

test("a namespaced id still yields its spec id when inverted", () => {
  // listRunningPipelineTargets takes the LAST segment; stripping the `spec-`
  // prefix would have produced "ab-test-sandbox-0001" and a dead link.
  const invert = (id: string) => id.split("-").pop();
  assert.equal(invert(workflowIdFor("0001", "ab-test-sandbox")), "0001");
  assert.equal(invert(workflowIdFor("0131", "platform")), "0131");
});

/**
 * Spec 0153 — `specIdForProjectWorkflowId` is the inverse of `workflowIdFor`,
 * and the scoping is the whole point: without it the platform's `spec-0003`
 * would read as a customer's `0003` and hide the Start button on the wrong
 * project's row.
 */
test("specIdForProjectWorkflowId: round-trips workflowIdFor for both shapes", () => {
  assert.equal(specIdForProjectWorkflowId(workflowIdFor("0147", "platform"), "platform"), "0147");
  assert.equal(
    specIdForProjectWorkflowId(workflowIdFor("0003", "ab-test-sandbox"), "ab-test-sandbox"),
    "0003",
  );
});

test("specIdForProjectWorkflowId: never matches ANOTHER project's workflow", () => {
  // The platform must not claim a namespaced run...
  assert.equal(specIdForProjectWorkflowId("spec-ab-test-sandbox-0003", "platform"), null);
  // ...nor a project claim the platform's, nor a different project's.
  assert.equal(specIdForProjectWorkflowId("spec-0003", "ab-test-sandbox"), null);
  assert.equal(specIdForProjectWorkflowId("spec-otro-0003", "ab-test-sandbox"), null);
});

test("specIdForProjectWorkflowId: ignores workflows that are not spec runs", () => {
  assert.equal(
    specIdForProjectWorkflowId("branch-staging-ab-test-sandbox-br-x-a54403", "ab-test-sandbox"),
    null,
  );
  assert.equal(specIdForProjectWorkflowId("spec-not-a-number", "platform"), null);
});

/**
 * Spec 0156 — the mistake this guards has now been made in four files. The
 * platform case passes under BOTH the right rule and the broken one
 * (`replace(/^spec-/, "")`), which is exactly why it survived; the namespaced
 * case is the one that separates them.
 */
test("specIdFromWorkflowId takes the LAST segment, not what follows the prefix", () => {
  assert.equal(specIdFromWorkflowId("spec-0147"), "0147");
  assert.equal(specIdFromWorkflowId("spec-ab-test-sandbox-0003"), "0003");
  assert.equal(specIdFromWorkflowId(workflowIdFor("0003", "ab-test-sandbox")), "0003");
  // Never returns empty: a caller uses this to address a workflow.
  assert.equal(specIdFromWorkflowId("spec-"), "spec-");
  assert.equal(specIdFromWorkflowId("0009"), "0009");
});

/**
 * Spec 0179 — measured on `spec-sushi-0001`: the spec page showed gate 2 with a
 * disabled Complete, a Reject and a link to the PR, and no approve. The run was
 * a branch run with PR #1 open, so the suppression fired; spec 0142 had already
 * written the exception for branch runs, and neither call site could pass the
 * argument because the view did not carry the branch.
 *
 * The deadlock that produced: promote refuses while a run is active, and the run
 * waits at gate 2 for the merge. Two correct refusals, one wall.
 */
test("spec 0179: a branch run keeps its in-app approve even with a PR open", () => {
  assert.deepEqual(
    suppressDuplicateApprove(PR_ACTIONS, ghPr(), "owner/menu-sushi"),
    PR_ACTIONS,
    "a branch run's gate 2 IS the in-app approval — nothing competes with it",
  );
  // And the per-spec case is untouched: GitHub's review is gate 2 there.
  assert.deepEqual(suppressDuplicateApprove(PR_ACTIONS, ghPr()), ["specRejected"]);
  assert.deepEqual(suppressDuplicateApprove(PR_ACTIONS, ghPr(), undefined), ["specRejected"]);
});
