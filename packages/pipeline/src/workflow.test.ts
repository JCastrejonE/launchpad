import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { WorkflowFailedError, type WorkflowHandle } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { Context } from "@temporalio/activity";
import type * as activities from "./activities.js";
import type { EphemeralEnv, PullRequestRef } from "./activities.js";
import {
  specPipeline,
  specApproved,
  specRejected,
  prApproved,
  promote,
  pipelinePhase,
  pipelinePr,
  gate2Poll,
  pipelineTarget,
  pipelineBranch,
  pipelineStaging,
  provisionProject,
  provisioningPhase,
  provisioningFailedPhase,
} from "./workflow.js";
import type { PipelineInput } from "./spec.js";
import type { PipelinePhase } from "./phase.js";
import type { Gate2PollState } from "./pr-query.js";
import { recordHarnessCase, writeHarnessCountOnExit } from "./harness-exec.js";

/**
 * Workflow-level test harness (spec 0009 — THE CORE). Until now pipeline
 * workflow behaviour had NO pre-merge test seam: every workflow change was
 * first exercised by the next spec's live run (the chicken-and-egg that
 * produced the 0007 wedge and the three-run promote). This suite closes that
 * with `@temporalio/testing`'s `TestWorkflowEnvironment` (time-skipping) and
 * ALL activities mocked — no git, no LLM, no filesystem.
 *
 * Gated behind `TEMPORAL_TEST=1`: `createTimeSkipping()` downloads its own
 * test-server binary (Java test server) on first use — no Docker needed, but
 * it does need outbound network access and isn't supported on ARM without
 * Rosetta 2. Verified locally (this session, Apple Silicon + Rosetta) that
 * the download + run works, but per the spec's own acceptance criteria the
 * suite is opt-in rather than a hard requirement of plain `pnpm -r test`, so
 * a CI runner without network egress or Docker-only sandboxing still gets a
 * green `pnpm -r test`. Run explicitly with:
 *
 *   TEMPORAL_TEST=1 pnpm --filter @launchpad/pipeline test
 */
const RUN_TEMPORAL_TESTS = process.env["TEMPORAL_TEST"] === "1";
const skip = RUN_TEMPORAL_TESTS
  ? false
  : "set TEMPORAL_TEST=1 to run (downloads a Temporal time-skipping test-server binary; no Docker required)";

const WORKFLOWS_PATH = new URL("./workflow.js", import.meta.url).pathname;
// The frozen pre-0047 fixture (spec 0047 item B, replay test (s)) — see
// workflow-legacy-tenant-fixture.ts's module doc for why this exists.
const LEGACY_TENANT_WORKFLOWS_PATH = new URL(
  "./workflow-legacy-tenant-fixture.js",
  import.meta.url,
).pathname;

let testEnv: TestWorkflowEnvironment | undefined;

/** Spec 0091: build each workflow entrypoint's bundle ONCE and share it.
 * `Worker.create({workflowsPath})` webpack-bundles ~1.6 MB per call and this
 * suite creates 22 workers, which is what made a full run take the better part
 * of an hour. Prebuilding is Temporal's documented pattern for test suites.
 * (It is a speedup only — the suite's real failures were stale assertions,
 * fixed above; bundling was investigated and cleared in spec 0089.) */
const bundles = new Map<string, WorkflowBundleWithSourceMap>();

async function bundleFor(workflowsPath: string): Promise<WorkflowBundleWithSourceMap> {
  const cached = bundles.get(workflowsPath);
  if (cached) return cached;
  const bundle = await bundleWorkflowCode({ workflowsPath });
  bundles.set(workflowsPath, bundle);
  return bundle;
}

// Skip-proofing (spec 0010 item 2): install the exit-hook writer unconditionally
// — it no-ops unless `runCi` set HARNESS_EXEC_COUNT_FILE, so this is a no-op
// under plain `pnpm -r test` and only does real work under runCi's harness run.
writeHarnessCountOnExit();

before(async () => {
  if (!RUN_TEMPORAL_TESTS) return;
  testEnv = await TestWorkflowEnvironment.createTimeSkipping();
});

after(async () => {
  await testEnv?.teardown();
});

// Referenced so the honest-mock type import isn't elided before item 7 lands.
type Activities = typeof activities;
const _activityKeys: (keyof Activities)[] = [
  "draftSpec",
  "writeTenantDeployManifest",
  "runInitializer",
  "runCoder",
  "runRepair",
  "provisionEphemeralEnv",
  "runCi",
  "countRemaining",
  "readLastHandoff",
  "openPullRequest",
  "awaitPrApproval",
  "mergePullRequest",
  "deployToProduction",
  "deployStaging",
  "destroyStaging",
  "teardownEnv",
  "markSpec",
];

test("activity surface is stable (mock bundle must mirror activities.ts)", () => {
  // Sanity anchor for the harness's honest mocks — the real assertion work is
  // the TestWorkflowEnvironment cases below.
  assert.ok(_activityKeys.length > 0);
});

function baseInput(specId: string, overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    specId,
    target: { kind: "self", repo: "/tmp/launchpad-workflow-test" },
    request: "test request",
    requestedBy: "tester@example.com",
    maxIterations: 3,
    ...overrides,
  };
}

function baseEphemeralEnv(): EphemeralEnv {
  return {
    envId: "test-env",
    branch: "spec/test",
    buildUrl: "local",
    workdir: "/tmp/launchpad-workflow-test",
  };
}

function basePullRequestRef(env: EphemeralEnv): PullRequestRef {
  return {
    repo: env.workdir,
    branch: env.branch,
    workdir: env.workdir,
    number: 0,
    url: `local-diff:${env.branch}`,
  };
}

/**
 * Default mock activity bundle — a fully-converged, zero-coder-iteration
 * happy path (`countRemaining` already reports nothing left, matching the
 * "only human items remain" skip-the-coder path spec 0006 added). Each test
 * overrides only the activities it needs to exercise its scenario. `calls`
 * records activity names (and `markSpec`'s status argument) in invocation
 * order so tests can assert ordering without inspecting Temporal history.
 * Typed as `Partial<typeof activities>` (the honest-mock type imported
 * above) so a renamed/removed activity fails typecheck here too.
 */
function makeMocks(
  calls: string[],
  overrides: Partial<typeof activities> = {},
): Partial<typeof activities> {
  const env = baseEphemeralEnv();
  return {
    // Spec 0088's AgentRun projection. Deliberately NOT pushed to `calls`:
    // several tests below assert the exact ORDER of pipeline activities, and
    // these two are a side-channel projection (they fire on every phase
    // change), not steps of the pipeline. They must still be present — an
    // unmocked activity fails the run.
    resolveProjectId: async () => "00000000-0000-4000-8000-000000000000",
    recordAgentRun: async () => {},
    draftSpec: async () => void calls.push("draftSpec"),
    // spec 0047: the tenant-vanilla path's deterministic manifest write, in
    // place of draftSpec's LLM draft. Every test that isn't specifically
    // exercising this activity gets a harmless default.
    writeTenantDeployManifest: async () => void calls.push("writeTenantDeployManifest"),
    provisionEphemeralEnv: async () => {
      calls.push("provisionEphemeralEnv");
      return env;
    },
    runInitializer: async () => void calls.push("runInitializer"),
    countRemaining: async () => {
      calls.push("countRemaining");
      return { remaining: 0, humanPending: 0 };
    },
    runCi: async () => {
      calls.push("runCi");
      return { green: true };
    },
    runCoder: async () => {
      calls.push("runCoder");
      return { remaining: 0, progressed: true };
    },
    // The default zero-iteration happy path never fails a coder session or
    // sees CI red twice, so repair rounds (spec 0018) should never fire.
    // Throws loudly (same pattern as awaitPrApproval below) if a test's
    // scenario ends up triggering one without overriding this.
    runRepair: async () => {
      calls.push("runRepair");
      throw new Error("runRepair should not be called outside a deliberate repair-round scenario");
    },
    readLastHandoff: async () => {
      calls.push("readLastHandoff");
      return "(none)";
    },
    openPullRequest: async () => {
      calls.push("openPullRequest");
      return basePullRequestRef(env);
    },
    // The default openPullRequest above returns a local-diff ref (number: 0),
    // which the workflow never polls (spec 0015) — so this default should
    // never actually run. Throws loudly rather than hanging forever if a test
    // overrides openPullRequest to a real PR (number > 0) without also
    // overriding this.
    awaitPrApproval: async () => {
      calls.push("awaitPrApproval");
      throw new Error("awaitPrApproval should not be called for a local-diff PR (number 0)");
    },
    mergePullRequest: async () => void calls.push("mergePullRequest"),
    deployToProduction: async () => void calls.push("deployToProduction"),
    // Spec 0119. Both are pushed to `calls` because WHERE they run is the
    // property under test: create before the gate-2 wait, destroy on every exit
    // path including the failing ones. The default returns null (the shape a
    // self/dogfood target produces), so tests that care about a live ref
    // override it.
    deployStaging: async () => {
      calls.push("deployStaging");
      return null;
    },
    destroyStaging: async () => {
      calls.push("destroyStaging");
      return null;
    },
    teardownEnv: async () => void calls.push("teardownEnv"),
    markSpec: async (_specId, status) => {
      calls.push(`markSpec:${status}`);
      return status;
    },
    ...overrides,
  };
}

async function createTestWorker(
  taskQueue: string,
  mocks: Partial<typeof activities>,
  workflowsPath: string = WORKFLOWS_PATH,
): Promise<Worker> {
  if (!testEnv) throw new Error("testEnv not initialized — RUN_TEMPORAL_TESTS must be true");
  return Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue,
    workflowBundle: await bundleFor(workflowsPath),
    activities: mocks,
  });
}

/** Polls `pipelinePhase` until `predicate` is satisfied or `timeoutMs` elapses
 * — the workflow parks at human gates indefinitely (no timers), so tests
 * observe progress via the query rather than waiting on `result()`. */
async function waitForPhase(
  handle: WorkflowHandle<typeof specPipeline>,
  predicate: (phase: PipelinePhase) => boolean,
  timeoutMs = 15_000,
): Promise<PipelinePhase> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const phase = await handle.query(pipelinePhase);
    if (predicate(phase)) return phase;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for pipelinePhase; last observed: ${phase}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Polls `gate2Poll` until `predicate` is satisfied or `timeoutMs` elapses —
 * same rationale as `waitForPhase` (spec 0016). */
async function waitForGate2Poll(
  handle: WorkflowHandle<typeof specPipeline>,
  predicate: (poll: Gate2PollState) => boolean,
  timeoutMs = 15_000,
): Promise<Gate2PollState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const poll = await handle.query(gate2Poll);
    if (predicate(poll)) return poll;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for gate2Poll; last observed: ${JSON.stringify(poll)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test(
  "(a) budget cap with CI GREEN proceeds to gate 2 (spec 0068/§9.4), running exactly maxIterations coder sessions",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0009-cap-breach", { maxIterations: 2 });
    const mocks = makeMocks(calls, {
      countRemaining: async () => {
        calls.push("countRemaining");
        return { remaining: 1, humanPending: 0 };
      },
      runCoder: async () => {
        // Never converges: remaining never reaches 0, so the loop only ends
        // via the maxIterations budget cap — the 0007-run-1 wedge class.
        calls.push("runCoder");
        return { remaining: 1, progressed: true };
      },
    });
    const taskQueue = "wf-test-a";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      // Spec 0068 / SPEC-ALIGNMENT §9.4: exhausting the budget with a GREEN
      // branch is not a failure — the partial-but-working branch goes to a
      // human at gate 2, with the leftover items surfaced in the PR body.
      // (`fail` is reserved for budget-exhausted-with-RED-CI; see (a3).)
      const parked = await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      assert.equal(parked, "awaiting_pr_approval");
      // The cap was actually enforced: exactly maxIterations coder sessions.
      assert.equal(calls.filter((c) => c === "runCoder").length, input.maxIterations);
      // Drive the remaining gates the same way (c) does — each signal must be
      // sent AFTER its gate opens: spec 0007's signal hygiene discards any
      // promote() buffered beforehand, so an early one is dropped and the run
      // parks forever.
      await handle.signal(prApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "promoted");
    });
  },
);

test(
  "(a2) ui_only env caps the effective budget at UI_ONLY_MAX_ITERATIONS (6), " +
    "not DEFAULT_MAX_ITERATIONS (12), even with maxIterations unset",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    // No maxIterations override — resolves to DEFAULT_MAX_ITERATIONS (12)
    // unless env.uiOnly caps it to UI_ONLY_MAX_ITERATIONS (6) first.
    const input = baseInput("0031-ui-only-cap", { maxIterations: undefined });
    const mocks = makeMocks(calls, {
      provisionEphemeralEnv: async () => {
        calls.push("provisionEphemeralEnv");
        return { ...baseEphemeralEnv(), uiOnly: true };
      },
      countRemaining: async () => {
        calls.push("countRemaining");
        return { remaining: 1, humanPending: 0 };
      },
      runCoder: async () => {
        // Never converges: remaining never reaches 0, so the loop only ends
        // via the maxIterations budget cap.
        calls.push("runCoder");
        return { remaining: 1, progressed: true };
      },
    });
    const taskQueue = "wf-test-a2";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      // Same §9.4 disposition as (a): green CI at the cap goes to gate 2. The
      // POINT of this test is the cap VALUE, which the coder-session count
      // proves — 6 (UI_ONLY_MAX_ITERATIONS), not 12 (DEFAULT_MAX_ITERATIONS).
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      assert.equal(calls.filter((c) => c === "runCoder").length, 6);
      await handle.signal(prApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "promoted");
    });
  },
);

test(
  "(a3) budget cap with CI RED fails with CoderLoopFailed + terminal phase `failed` (§9.4's reserved fail branch)",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0009-cap-breach-red", { maxIterations: 2 });
    const mocks = makeMocks(calls, {
      countRemaining: async () => {
        calls.push("countRemaining");
        return { remaining: 1, humanPending: 0 };
      },
      runCoder: async () => {
        calls.push("runCoder");
        return { remaining: 1, progressed: true };
      },
      // RED CI is what distinguishes this from (a): §9.4 keeps `fail` for
      // budget-exhausted-with-red, so a broken branch is never handed to a
      // human at gate 2 as if it were merely incomplete.
      runCi: async () => {
        calls.push("runCi");
        return { green: false };
      },
      // Red CI twice triggers one repair round (spec 0018) on the way to the
      // cap — expected here, so it must not throw like the default mock does.
      runRepair: async () => void calls.push("runRepair"),
    });
    const taskQueue = "wf-test-a3";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await assert.rejects(handle.result(), (err: unknown) => {
        assert.ok(err instanceof WorkflowFailedError);
        assert.ok(err.cause instanceof ApplicationFailure);
        assert.equal(err.cause.type, "CoderLoopFailed");
        assert.match(err.cause.message ?? "", new RegExp(input.specId));
        assert.match(err.cause.message ?? "", /ci\.green=false/);
        return true;
      });
      // Closed executions still answer queries via history replay.
      assert.equal(await handle.query(pipelinePhase), "failed");
    });
  },
);

test(
  "(b) prApproved during coding does NOT satisfy gate 2; a fresh approval does",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0009-signal-hygiene");
    const mocks = makeMocks(calls, {
      countRemaining: async () => {
        calls.push("countRemaining");
        return { remaining: 1, humanPending: 0 };
      },
      runCoder: async () => {
        calls.push("runCoder");
        return { remaining: 0, progressed: true }; // converges after one pass
      },
    });
    const taskQueue = "wf-test-b";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      // Fire prApproved immediately — well before gate 2 can possibly open
      // (provisioning/initializing/coding are all still ahead). Gate 2 resets
      // prApproval unconditionally right after openPullRequest, so this stale
      // signal must NOT be honored (spec 0007 item 10 / this spec's closure).
      await handle.signal(prApproved, { approvedBy: "premature" });
      const parked = await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      assert.equal(parked, "awaiting_pr_approval");
      // Prove it's genuinely parked, not about to proceed on the stale signal.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(await handle.query(pipelinePhase), "awaiting_pr_approval");
      // pipelinePr (spec 0015 item 8) reports the ref openPullRequest
      // returned, once gate 2 has opened — apps/web reads this to render the
      // PR link.
      assert.deepEqual(await handle.query(pipelinePr), basePullRequestRef(baseEphemeralEnv()));
      // A fresh approval, sent now that gate 2 is truly open, IS honored.
      await handle.signal(prApproved, { approvedBy: "tester" });
      // Wait for gate 3 to actually OPEN before promoting. "any phase other
      // than awaiting_pr_approval" is not enough — it matches `merging`, and a
      // promote() sent then is discarded by the same signal hygiene this test
      // is about (spec 0007), leaving the run parked forever.
      assert.equal(await handle.result(), "promoted");
      assert.equal(await handle.query(pipelinePhase), "promoted");
    });
  },
);

test(
  "(c) happy path: draft → gates 1/2 → merge → terminal `promoted` (spec 0170: no gate 3)",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0009-happy-path");
    const mocks = makeMocks(calls);
    const taskQueue = "wf-test-c";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      await handle.signal(prApproved, { approvedBy: "tester" });
      // Spec 0170: the run ends when the change is on main. There is no third
      // gate to signal — shipping is a separate decision about a named version,
      // taken in the Versiones panel.
      assert.equal(await handle.result(), "promoted");
      assert.equal(await handle.query(pipelinePhase), "promoted");
    });
    // teardownEnv races the final `return markSpec(...)` (neither is awaited
    // before the other is issued — see workflow.ts's finally block), so its
    // exact position relative to `markSpec:promoted` isn't deterministic;
    // assert it happened, but check strict order only for the fully
    // sequential chain (each awaited before the next call is issued).
    // destroyStaging (spec 0119) sits in that same finally block and races the
    // same way, so it is filtered out here for the same reason and asserted
    // separately below.
    assert.deepEqual(
      calls.filter((c) => c !== "teardownEnv" && c !== "destroyStaging"),
      [
        "draftSpec",
        "markSpec:approved",
        "provisionEphemeralEnv",
        "runInitializer",
        "countRemaining",
        "runCi",
        "openPullRequest",
        // Spec 0119: between opening the PR and the gate-2 wait — an environment
        // that appeared after approval could not have informed it.
        "deployStaging",
        // Spec 0170: the merge happens the moment gate 2 accepts the change, and
        // the run ends. `markSpec:staged` and `deployToProduction` are gone with
        // gate 3 — deploying is now a decision about a NAMED version, made in the
        // Versiones panel and gated on `actorFor("promote")`.
        "mergePullRequest",
        "markSpec:promoted",
      ],
    );
    assert.ok(calls.includes("teardownEnv"));
    assert.ok(calls.includes("destroyStaging"));
  },
);

test(
  "(d) rejection at each gate → markSpec(rejected) + terminal phase `rejected`",
  { skip },
  async () => {
    recordHarnessCase();
    async function rejectAt(gate: "spec_approval" | "pr_approval" | "promotion"): Promise<void> {
      const calls: string[] = [];
      const input = baseInput(`0009-reject-${gate}`);
      const mocks = makeMocks(calls, {
        countRemaining: async () => {
          calls.push("countRemaining");
          return { remaining: 0, humanPending: 0 };
        },
      });
      const taskQueue = `wf-test-d-${gate}`;
      const worker = await createTestWorker(taskQueue, mocks);
      await worker.runUntil(async () => {
        const handle = await testEnv!.client.workflow.start(specPipeline, {
          args: [input],
          taskQueue,
          workflowId: `${taskQueue}-${randomUUID()}`,
        });
        if (gate === "spec_approval") {
          await waitForPhase(handle, (p) => p === "awaiting_spec_approval");
        } else {
          await handle.signal(specApproved, { approvedBy: "tester" });
          await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
          // Spec 0170: there is no third gate on the PR path — the run ends at
          // the merge — so "promotion" is no longer a gate one can reject at.
        }
        await handle.signal(specRejected, { rejectedBy: "tester", reason: "test rejection" });
        assert.equal(await handle.result(), "rejected");
        assert.equal(await handle.query(pipelinePhase), "rejected");
        assert.ok(calls.includes("markSpec:rejected"));
      });
    }

    await rejectAt("spec_approval");
    await rejectAt("pr_approval");
    await rejectAt("promotion");
  },
);

/** A real-GitHub-PR ref (`number > 0`) — the shape `openPullRequest` returns
 * in PR mode (spec 0015), as opposed to `basePullRequestRef`'s local-diff
 * `number: 0`. Only refs shaped like this make the workflow start the
 * `awaitPrApproval` poll race at all. */
function githubPullRequestRef(env: EphemeralEnv): PullRequestRef {
  return {
    repo: "acme/launchpad",
    branch: env.branch,
    workdir: env.workdir,
    number: 7,
    url: "https://github.com/acme/launchpad/pull/7",
  };
}

test(
  "(e) gate 2 via GitHub: awaitPrApproval resolving approved proceeds without any prApproved signal",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0015-poll-approves");
    const mocks = makeMocks(calls, {
      openPullRequest: async () => {
        calls.push("openPullRequest");
        return githubPullRequestRef(baseEphemeralEnv());
      },
      awaitPrApproval: async () => {
        calls.push("awaitPrApproval");
        return { outcome: "approved", actor: "octocat" };
      },
    });
    const taskQueue = "wf-test-e";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      // No prApproved signal sent at all — the poll alone must satisfy gate 2.
      assert.equal(await handle.result(), "promoted");
    });
    assert.ok(calls.includes("awaitPrApproval"));
    assert.ok(calls.includes("mergePullRequest"));
  },
);

test(
  "(f) gate 2 via GitHub: awaitPrApproval resolving rejected (closed w/o merge) ends the run Rejected",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0015-poll-rejects");
    const mocks = makeMocks(calls, {
      openPullRequest: async () => {
        calls.push("openPullRequest");
        return githubPullRequestRef(baseEphemeralEnv());
      },
      awaitPrApproval: async () => {
        calls.push("awaitPrApproval");
        return { outcome: "rejected", actor: "(closed)" };
      },
    });
    const taskQueue = "wf-test-f";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "rejected");
      assert.equal(await handle.query(pipelinePhase), "rejected");
    });
    assert.ok(calls.includes("markSpec:rejected"));
    assert.ok(!calls.includes("mergePullRequest"));
  },
);

test(
  "(g) gate 2 racing order: a fresh prApproved signal wins over a still-pending awaitPrApproval poll",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0015-signal-wins-race");
    const mocks = makeMocks(calls, {
      openPullRequest: async () => {
        calls.push("openPullRequest");
        return githubPullRequestRef(baseEphemeralEnv());
      },
      // Only settles on cancellation (like a well-behaved real activity
      // honoring `Context.current().cancelled` — see awaitPrApproval's own
      // cancellation-aware `sleep`) — proves the workflow doesn't block on
      // the poll once the in-app signal has already satisfied gate 2 (spec
      // 0015's whichever-arrives-first race; the Temporal-signal escape
      // hatch must keep working even in GitHub-PR mode). A plain
      // never-resolving mock would instead leave this activity task running
      // forever on the worker, hanging `worker.runUntil`'s shutdown.
      awaitPrApproval: async () => {
        calls.push("awaitPrApproval");
        await Context.current().cancelled;
        throw new Error("unreachable: Context.current().cancelled only ever rejects");
      },
    });
    const taskQueue = "wf-test-g";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      await handle.signal(prApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "promoted");
    });
    assert.ok(calls.includes("awaitPrApproval"));
    assert.ok(calls.includes("mergePullRequest"));
  },
);

test(
  "(h) gate 2 via GitHub (ADR-016): a merged-PR poll outcome (actor = mergedBy) proceeds past gate 2 into merge",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0019-merged-pr-approves");
    const mocks = makeMocks(calls, {
      openPullRequest: async () => {
        calls.push("openPullRequest");
        return githubPullRequestRef(baseEphemeralEnv());
      },
      // Shaped exactly like awaitPrApproval's own merged short-circuit
      // (activities.ts: `{ outcome: "approved", actor: state.mergedBy ??
      // "(merged)", via: "merge" }`) — the human merged the PR on GitHub instead
      // of clicking approve, and that alone must satisfy gate 2 (ADR-016).
      // `via` is not decoration: spec 0115 moved the merge to gate 3, and this is
      // the one path where it must still happen at gate 2, because the merge has
      // already occurred server-side and `markSpec` commits locally right after.
      awaitPrApproval: async () => {
        calls.push("awaitPrApproval");
        return { outcome: "approved", actor: "owner-gh", via: "merge" as const };
      },
    });
    const taskQueue = "wf-test-h";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      // No prApproved signal sent at all — the merged-PR poll outcome alone
      // must satisfy gate 2, and (spec 0170) that is the end of the run.
      assert.equal(await handle.result(), "promoted");
    });
    assert.ok(calls.includes("awaitPrApproval"));
    assert.ok(calls.includes("mergePullRequest"));
    // ADR-016 preserved: the merge activity runs BEFORE the local spec commit,
    // because the PR is already merged on GitHub and the activity's remaining job
    // is syncing the checkout that `markSpec` then commits to. Spec 0170 renamed
    // the far side of that ordering — `promoted`, not `staged` — without changing
    // the property.
    assert.ok(
      calls.indexOf("mergePullRequest") < calls.indexOf("markSpec:promoted"),
      `merge should precede the local spec commit: ${calls.join(" | ")}`,
    );
  },
);

test(
  "(i) gate 2 racing order (ADR-016): a fresh prApproved signal wins over a still-pending merged-PR poll",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0019-merged-pr-signal-wins-race");
    const mocks = makeMocks(calls, {
      openPullRequest: async () => {
        calls.push("openPullRequest");
        return githubPullRequestRef(baseEphemeralEnv());
      },
      // Same cancellation-aware shape as (g) — proves the in-app prApproved
      // signal still wins the race and the run doesn't block on the poll,
      // even now that the poll can resolve via the merged-PR short-circuit.
      awaitPrApproval: async () => {
        calls.push("awaitPrApproval");
        await Context.current().cancelled;
        throw new Error("unreachable: Context.current().cancelled only ever rejects");
      },
    });
    const taskQueue = "wf-test-i";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      await handle.signal(prApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "promoted");
    });
    assert.ok(calls.includes("awaitPrApproval"));
    assert.ok(calls.includes("mergePullRequest"));
  },
);

test(
  "(gate2Poll-1) a non-cancellation awaitPrApproval failure flips gate2Poll to failed with error text, without crashing gate 2",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0016-poll-fails");
    const mocks = makeMocks(calls, {
      openPullRequest: async () => {
        calls.push("openPullRequest");
        return githubPullRequestRef(baseEphemeralEnv());
      },
      // A persistently broken poll (e.g. a revoked GitHub token) — rejects
      // outright rather than hanging, so the workflow must fall back to the
      // in-app prApproved signal (same as before this spec) while ALSO
      // recording the failure via gate2Poll (spec 0016).
      awaitPrApproval: async () => {
        calls.push("awaitPrApproval");
        // NON-retryable, matching what the real activity does for exactly this
        // scenario (activity-options.ts: "a non-retryable GithubApiError such
        // as 401/403 ... so Temporal does NOT retry it"). A plain Error is
        // retryable, and its backoff needs virtual time to elapse — which
        // never happens while `waitForGate2Poll` polls queries in REAL time,
        // so the poll stayed "polling" until the helper's timeout.
        throw ApplicationFailure.create({
          message: "gate2poll-boom: GitHub token revoked",
          type: "GithubApiError",
          nonRetryable: true,
        });
      },
    });
    const taskQueue = "wf-test-gate2poll-1";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      const poll = await waitForGate2Poll(handle, (p) => p.status === "failed");
      assert.match(poll.error ?? "", /gate2poll-boom: GitHub token revoked/);
      // The broken poll must not wedge gate 2 — the in-app signal still works.
      await handle.signal(prApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "promoted");
    });
    assert.ok(calls.includes("awaitPrApproval"));
    assert.ok(calls.includes("mergePullRequest"));
  },
);

test(
  "(gate2Poll-2) a signal-wins race (cancelling the still-pending poll) leaves gate2Poll never flipped to failed",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0016-poll-cancelled-not-failed");
    const mocks = makeMocks(calls, {
      openPullRequest: async () => {
        calls.push("openPullRequest");
        return githubPullRequestRef(baseEphemeralEnv());
      },
      // Same cancellation-aware shape as (g)/(i) — only ever settles via
      // cancellation, never a genuine failure.
      awaitPrApproval: async () => {
        calls.push("awaitPrApproval");
        await Context.current().cancelled;
        throw new Error("unreachable: Context.current().cancelled only ever rejects");
      },
    });
    const taskQueue = "wf-test-gate2poll-2";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      await waitForGate2Poll(handle, (p) => p.status === "polling");
      await handle.signal(prApproved, { approvedBy: "tester" });
      // The cancelled poll must never have been recorded as "failed" — a
      // signal winning the race is expected, not a poll breakage.
      assert.notEqual((await handle.query(gate2Poll)).status, "failed");
      assert.equal(await handle.result(), "promoted");
    });
    assert.ok(calls.includes("awaitPrApproval"));
    assert.ok(calls.includes("mergePullRequest"));
  },
);

// Repair rounds (spec 0018 item 4): when `runCoder` fails outright (its own
// AGENT_ACTIVITY_OPTIONS retries — maximumAttempts: 3 — already exhausted) or
// CI is red twice consecutively, the workflow gives a `fixer` session ONE
// repair round for that trouble spot before resuming the coder loop. These
// four cases pin the acceptance criteria's harness list verbatim.

test(
  "(j) coder-failure → one repair round → coder retry succeeds",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0018-repair-then-succeed", { maxIterations: 5 });
    let coderAttempts = 0;
    const mocks = makeMocks(calls, {
      countRemaining: async () => {
        calls.push("countRemaining");
        return { remaining: 1, humanPending: 0 };
      },
      runCoder: async () => {
        coderAttempts++;
        calls.push(`runCoder:${coderAttempts}`);
        // The first trouble spot: all 3 Temporal-retried attempts fail, so
        // the workflow sees ONE activity failure after its own retries.
        if (coderAttempts <= 3) throw new Error("coder blew up");
        return { remaining: 0, progressed: true };
      },
      runRepair: async () => void calls.push("runRepair"),
    });
    const taskQueue = "wf-test-j";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      await handle.signal(prApproved, { approvedBy: "tester" });
      // Spec 0170: the run ends when the change is on main. There is no third
      // gate to signal — shipping is a separate decision about a named version,
      // taken in the Versiones panel.
      assert.equal(await handle.result(), "promoted");
      assert.equal(await handle.query(pipelinePhase), "promoted");
    });
    assert.equal(calls.filter((c) => c === "runRepair").length, 1);
    // 3 failing attempts on the first trouble spot + 1 successful retry after
    // the repair round.
    assert.equal(coderAttempts, 4);
  },
);

test(
  "(k) repeated failure on the same trouble spot after repair fails the workflow with BOTH contexts",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0018-repair-then-fail-again", { maxIterations: 5 });
    let coderAttempts = 0;
    const mocks = makeMocks(calls, {
      countRemaining: async () => {
        calls.push("countRemaining");
        return { remaining: 1, humanPending: 0 };
      },
      runCoder: async () => {
        coderAttempts++;
        calls.push(`runCoder:${coderAttempts}`);
        throw new Error(`coder blew up (attempt ${coderAttempts})`);
      },
      runRepair: async () => void calls.push("runRepair"),
    });
    const taskQueue = "wf-test-k";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await assert.rejects(handle.result(), (err: unknown) => {
        assert.ok(err instanceof WorkflowFailedError);
        assert.ok(err.cause instanceof ApplicationFailure);
        assert.equal(err.cause.type, "RepairExhausted");
        // Both failure contexts (the one that triggered the repair AND the
        // one that recurred after it) travel in `details`.
        const details = err.cause.details as Array<{ error: string; stalled: boolean }>;
        assert.equal(details?.length, 2);
        // Temporal's ActivityFailure carries the LAST retried attempt's
        // error (retry policy: maximumAttempts 3), not the first — attempt 3
        // for the pre-repair trouble spot, attempt 6 for the post-repair one.
        assert.match(details[0]!.error, /coder blew up \(attempt 3\)/);
        assert.match(details[1]!.error, /coder blew up \(attempt 6\)/);
        return true;
      });
      assert.equal(await handle.query(pipelinePhase), "failed");
    });
    assert.equal(calls.filter((c) => c === "runRepair").length, 1);
    // 3 failing attempts before the repair + 3 more failing attempts after it.
    assert.equal(coderAttempts, 6);
  },
);

test(
  "(l) CI red twice consecutively triggers a repair round",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0018-ci-red-twice", { maxIterations: 5 });
    let ciCalls = 0;
    let coderCalls = 0;
    const mocks = makeMocks(calls, {
      countRemaining: async () => {
        calls.push("countRemaining");
        return { remaining: 1, humanPending: 0 };
      },
      runCi: async () => {
        ciCalls++;
        calls.push(`runCi:${ciCalls}`);
        // Red, red, then green — the third call is the one that converges.
        return { green: ciCalls >= 3 };
      },
      runCoder: async () => {
        coderCalls++;
        calls.push(`runCoder:${coderCalls}`);
        return { remaining: coderCalls >= 2 ? 0 : 1, progressed: true };
      },
      runRepair: async () => void calls.push("runRepair"),
    });
    const taskQueue = "wf-test-l";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      await handle.signal(prApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "promoted");
    });
    assert.equal(calls.filter((c) => c === "runRepair").length, 1);
  },
);

test(
  "(m) a repair round counts toward maxIterations — no free extra iteration",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0018-repair-respects-max-iterations", { maxIterations: 1 });
    let coderAttempts = 0;
    const mocks = makeMocks(calls, {
      countRemaining: async () => {
        calls.push("countRemaining");
        return { remaining: 1, humanPending: 0 };
      },
      runCoder: async () => {
        coderAttempts++;
        calls.push(`runCoder:${coderAttempts}`);
        throw new Error(`coder blew up (attempt ${coderAttempts})`);
      },
      runRepair: async () => void calls.push("runRepair"),
    });
    const taskQueue = "wf-test-m";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      // The ORDINARY iteration-budget-exhausted path, NOT RepairExhausted — the
      // repair round already spent the entire 1-iteration budget, so the loop
      // leaves via coderLoopDecision's maxIterations branch instead of ever
      // attempting a second coder session. Since the default CI mock is GREEN,
      // that branch routes to gate 2 (spec 0068 / §9.4) rather than failing;
      // (a3) covers the red-CI fail branch. What this test is actually about —
      // that the repair round CONSUMED the budget rather than getting a free
      // extra iteration — is the two counts below.
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      assert.equal(calls.filter((c) => c === "runRepair").length, 1);
      assert.equal(coderAttempts, 3);
      await handle.signal(prApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "promoted");
    });
  },
);

test(
  "(n) teardownEnv failing AFTER promotion reports phase `promoted_teardown_failed` + typed TeardownFailed",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0018-teardown-after-promote");
    const mocks = makeMocks(calls, {
      teardownEnv: async () => {
        calls.push("teardownEnv");
        throw new Error("teardown boom");
      },
    });
    const taskQueue = "wf-test-n";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      await handle.signal(prApproved, { approvedBy: "tester" });
      await assert.rejects(handle.result(), (err: unknown) => {
        assert.ok(err instanceof WorkflowFailedError);
        assert.ok(err.cause instanceof ApplicationFailure);
        assert.equal(err.cause.type, "TeardownFailed");
        assert.match(err.cause.message ?? "", /promoted successfully/);
        assert.match(err.cause.message ?? "", /teardown boom/);
        // The true outcome (promoted) travels alongside the teardown error
        // so the operator never has to guess which half of the run failed
        // (0020 run d1bc4732 — the bare WorkflowExecutionFailed this fixes).
        const details = err.cause.details as Array<{ outcome: string; teardownError: string }>;
        assert.equal(details?.[0]?.outcome, "promoted");
        assert.match(details?.[0]?.teardownError ?? "", /teardown boom/);
        return true;
      });
      // Temporal answers queries against closed executions via history
      // replay — the reported phase must be the distinct
      // `promoted_teardown_failed`, not plain `failed` or a stale `promoted`.
      assert.equal(await handle.query(pipelinePhase), "promoted_teardown_failed");
    });
    assert.ok(calls.includes("teardownEnv"));
  },
);

test(
  "(o) pre-0047 tenant history replays the OLD full-pipeline path with no NonDeterminismError " +
    "(patched=false) — spec 0047 item B-iv, THE determinism guard for closed pre-0047 tenant runs " +
    "(0034/0045) replay-queried by the spec-detail page",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    // Repurposed (spec 0047 item B) from the pre-0047 "tenant target: draft →
    // gates 1/2/3 → deploy → teardown" case (spec 0026): before spec 0047, a
    // tenant run took the IDENTICAL body as a self run — no branch existed at
    // all. workflow-legacy-tenant-fixture.ts is a frozen snapshot of exactly
    // that shape. We run THAT code (not the current workflow.ts) so the
    // resulting Temporal history has no "tenant-vanilla-deploy-0047"
    // patch-marker event in it — i.e. it is shaped exactly like a closed
    // pre-0047 tenant run's real recorded history (specs 0034/0045).
    const input = baseInput("0047-pre-patch-tenant-history", {
      target: {
        kind: "tenant",
        tenantId: "sandbox",
        repo: "/tmp/launchpad-workflow-test",
        odooVersion: 18,
        vpsId: 100001,
      },
    });
    const mocks = makeMocks(calls);
    const taskQueue = "wf-test-o-record";
    const worker = await createTestWorker(taskQueue, mocks, LEGACY_TENANT_WORKFLOWS_PATH);
    let history: Awaited<ReturnType<WorkflowHandle<typeof specPipeline>["fetchHistory"]>> | undefined;
    let workflowId = "";
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      workflowId = handle.workflowId;
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      await handle.signal(prApproved, { approvedBy: "tester" });
      // Gate 3 is still here, and must be: this run executes the FROZEN legacy
      // fixture, not today's workflow.ts. Spec 0170 removed the gate from the
      // live code — removing the signal here too would hang the recording
      // forever, which is exactly what it did until this line came back.
      await waitForPhase(handle, (p) => p === "awaiting_promotion");
      await handle.signal(promote, { promotedBy: "tester" });
      assert.equal(await handle.result(), "promoted");
      history = await handle.fetchHistory();
    });
    assert.ok(history, "expected a recorded pre-0047-shaped history");
    // THE determinism guard (spec 0047's top hazard). Replay that REAL,
    // no-marker history against the CURRENT workflow.ts — which DOES call
    // `patched("tenant-vanilla-deploy-0047")` at the top of `specPipeline`
    // now. `Worker.runReplayHistory` resolves cleanly (no
    // NonDeterminismError / DeterminismViolationError) only if `patched()`
    // returns `false` for this history and execution falls back to the
    // unchanged full-pipeline body — exactly what the history already
    // contains. That's the proof that a closed pre-0047 tenant run (specs
    // 0034/0045) never breaks when the spec-detail page replay-queries it.
    await Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history, workflowId);
  },
);

test(
  "(p) pipelineTarget query returns input.target for a launchpad run AND a tenant run (spec 0033 scope A)",
  { skip },
  async () => {
    recordHarnessCase();

    async function assertTargetQuery(
      taskQueue: string,
      target: PipelineInput["target"],
      // spec 0047: the new tenant-vanilla path never emits
      // `awaiting_spec_approval` (it goes straight to `awaiting_promotion`),
      // so this waits for whichever gate phase this target's flow actually
      // reaches instead of hard-coding gate 1's phase for both.
      firstGatePhase: PipelinePhase,
    ): Promise<void> {
      const calls: string[] = [];
      const input = baseInput(`0033-pipeline-target-${taskQueue}`, { target });
      const mocks = makeMocks(calls);
      const worker = await createTestWorker(taskQueue, mocks);
      await worker.runUntil(async () => {
        const handle = await testEnv!.client.workflow.start(specPipeline, {
          args: [input],
          taskQueue,
          workflowId: `${taskQueue}-${randomUUID()}`,
        });
        // pipelineTarget answers from the very first tick — it's read-only,
        // returned straight from input.target with no phase dependency — so
        // querying it once the run reaches its first gate is enough to prove
        // the wiring.
        await waitForPhase(handle, (p) => p === firstGatePhase);
        assert.deepEqual(await handle.query(pipelineTarget), target);
        // End the run quickly; the query behaviour is what's under test here.
        await handle.signal(specRejected, { rejectedBy: "tester", reason: "test rejection" });
        assert.equal(await handle.result(), "rejected");
      });
    }

    await assertTargetQuery(
      "wf-test-p-launchpad",
      { kind: "self", repo: "/tmp/launchpad-workflow-test" },
      "awaiting_spec_approval",
    );
    await assertTargetQuery(
      "wf-test-p-tenant",
      {
        kind: "tenant",
        tenantId: "sandbox",
        repo: "/tmp/launchpad-workflow-test",
        odooVersion: 18,
        vpsId: 100001,
      },
      // spec 0047: the new tenant-vanilla path's only gate is
      // `awaiting_promotion` — it never emits `awaiting_spec_approval`.
      "awaiting_promotion",
    );
  },
);

// ===========================================================================
// spec 0047 item B — versioned tenant vanilla-deploy branch.
//
// A FRESH tenant run in this test env has no history yet, so
// `patched("tenant-vanilla-deploy-0047")` returns `true` and it takes the new
// `tenantVanillaDeploy` path below ((q), (r)). (o) above is the reconciled
// pre-0047 REPLAY proof (B-iv: patched=false still runs the OLD path, no
// NonDeterminismError) and (p) now waits on whichever gate phase each
// target's flow actually reaches. The self/code path (test (c), "happy
// path") is the byte-identical REGRESSION baseline (B-iii) and is untouched.
// ===========================================================================

function tenantVanillaInput(specId: string): PipelineInput {
  return baseInput(specId, {
    target: {
      kind: "tenant",
      tenantId: "sandbox",
      repo: "/tmp/launchpad-workflow-test",
      odooVersion: 18,
      vpsId: 100001,
    },
  });
}

test(
  "(q) tenant vanilla deploy: manifest → awaiting_promotion → promote → deploying → promoted; " +
    "skips draft/provision/init/coder/ci/PR/merge/teardown; pipelinePr stays undefined",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = tenantVanillaInput("0047-tenant-vanilla");
    const mocks = makeMocks(calls);
    const taskQueue = "wf-test-q";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await waitForPhase(handle, (p) => p === "awaiting_promotion");
      // pipelinePr never gets set on the tenant-vanilla path — there is no
      // PR at all — so apps/web's PR card never renders for this flow.
      assert.equal(await handle.query(pipelinePr), undefined);
      await handle.signal(promote, { promotedBy: "tester" });
      assert.equal(await handle.result(), "promoted");
      assert.equal(await handle.query(pipelinePhase), "promoted");
      assert.equal(await handle.query(pipelinePr), undefined);
    });
    assert.deepEqual(calls, [
      "writeTenantDeployManifest",
      "markSpec:staged",
      "deployToProduction",
      "markSpec:promoted",
    ]);
    for (const neverCalled of [
      "draftSpec",
      "provisionEphemeralEnv",
      "runInitializer",
      "countRemaining",
      "runCi",
      "openPullRequest",
      "mergePullRequest",
      "teardownEnv",
    ]) {
      assert.ok(!calls.includes(neverCalled), `expected ${neverCalled} to never be called`);
    }
  },
);

test(
  "(r) tenant vanilla deploy: specRejected at the single promote gate → `rejected`, no deploy",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = tenantVanillaInput("0047-tenant-vanilla-reject");
    const mocks = makeMocks(calls);
    const taskQueue = "wf-test-r";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await waitForPhase(handle, (p) => p === "awaiting_promotion");
      await handle.signal(specRejected, { rejectedBy: "tester", reason: "test rejection" });
      assert.equal(await handle.result(), "rejected");
      assert.equal(await handle.query(pipelinePhase), "rejected");
    });
    assert.ok(!calls.includes("deployToProduction"));
    assert.ok(calls.includes("writeTenantDeployManifest"));
    assert.ok(calls.includes("markSpec:staged"));
    assert.ok(calls.includes("markSpec:rejected"));
  },
);

// ---------------------------------------------------------------------------
// (s) Spec 0119 — staging teardown runs on EVERY exit.
//
// This is the only seam that can prove it: the unit tests around
// `destroyStaging` prove what the activity does when called, not that the
// workflow calls it on the paths that matter. A create without a matching
// destroy leaks two named volumes per spec onto one 16 GB box, and the exits
// that leak are the ones nobody drives by hand — reject and failure.
//
// The workflow calls the activity UNCONDITIONALLY (the activity itself returns
// null for a self target), so a self-target run still records the call. That is
// deliberate: the decision lives in one place, next to the fleet guards.
// ---------------------------------------------------------------------------

test(
  "(s1) staging teardown runs on the promoted path, and BEFORE the worktree teardown",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0119-staging-promoted");
    const mocks = makeMocks(calls);
    const taskQueue = "wf-test-s1";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      await handle.signal(prApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "promoted");
    });
    assert.ok(calls.includes("destroyStaging"), "staging must come down after a promotion");
    // Ordering matters: a staging failure must never be able to skip the
    // worktree removal, so the remote teardown is attempted first.
    assert.ok(
      calls.indexOf("destroyStaging") < calls.indexOf("teardownEnv"),
      "destroyStaging must run before teardownEnv",
    );
  },
);

test(
  "(s2) staging teardown runs on a rejection AFTER the stack exists (gate 3)",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0119-staging-rejected");
    const mocks = makeMocks(calls);
    const taskQueue = "wf-test-s2";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      // Past gate 2 — which is where the stack is created — then refuse to
      // promote. This is the realistic leak: a reviewer tests the change on
      // staging, says no, and the environment must not outlive the decision.
      // Spec 0119 put staging up as the run ARRIVES at gate 2, and spec 0170
      // made gate 2 the last place to say no — so this is where someone looks at
      // the staging environment and refuses.
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      await handle.signal(specRejected, { rejectedBy: "tester", reason: "staging looked wrong" });
      assert.equal(await handle.result(), "rejected");
    });
    // Unconditional by design: teardown never asks "did I create one?", because
    // a run that crashed between create and here cannot answer. The activity is
    // idempotent (`existed: false`), so a wasted call is the cheap half of the
    // trade.
    assert.ok(calls.includes("destroyStaging"), "a rejected change must not leave its stack up");
    // A gate-1 rejection deliberately does NOT reach this teardown: it returns
    // before the try/finally is entered, and it is also before gate 2, so no
    // stack can exist yet. Nothing to clean up, nothing to call.
  },
);

test(
  "(s3) staging teardown runs when the run FAILS — the exit that would otherwise leak silently",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0119-staging-failed", { maxIterations: 2 });
    const mocks = makeMocks(calls, {
      countRemaining: async () => {
        calls.push("countRemaining");
        return { remaining: 1, humanPending: 0 };
      },
      runCoder: async () => {
        calls.push("runCoder");
        return { remaining: 1, progressed: true };
      },
      runCi: async () => {
        calls.push("runCi");
        return { green: false };
      },
      runRepair: async () => void calls.push("runRepair"),
    });
    const taskQueue = "wf-test-s3";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await assert.rejects(handle.result(), (err: unknown) => {
        assert.ok(err instanceof WorkflowFailedError);
        return true;
      });
      assert.equal(await handle.query(pipelinePhase), "failed");
    });
    assert.ok(calls.includes("destroyStaging"), "a failed run must still take its staging stack down");
  },
);

test(
  "(s4) a staging teardown failure does NOT rewrite the run's outcome, and the worktree still comes down",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0119-staging-teardown-failed");
    const mocks = makeMocks(calls, {
      // Exhausts its retries and throws. Spec 0018 established that a teardown
      // failure must not become the outcome of a run that genuinely promoted;
      // the same reasoning applies here, with `staging-sweep` as the backstop.
      destroyStaging: async () => {
        calls.push("destroyStaging");
        throw ApplicationFailure.create({
          message: "compose down failed",
          type: "FleetError",
          nonRetryable: true,
        });
      },
    });
    const taskQueue = "wf-test-s4";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      await handle.signal(prApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "promoted", "a promoted run stays promoted");
      assert.equal(await handle.query(pipelinePhase), "promoted");
    });
    assert.ok(calls.includes("teardownEnv"), "the worktree must still be removed");
  },
);

test(
  "(s5) the staging environment exists BEFORE gate 2 parks, and the query reports it",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0119-staging-created");
    const ref = {
      specId: "0119",
      stack: "spec-0119",
      host: "spec-0119.sandbox.sandbox.launchpad.test",
      addons: ["sale_custom"],
      healthy: true,
      odooHttpOk: true,
    };
    const mocks = makeMocks(calls, {
      deployStaging: async () => {
        calls.push("deployStaging");
        return ref;
      },
    });
    const taskQueue = "wf-test-s5";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      // The moment the run parks for review, the environment must already be
      // there — that is the ordering the whole spec turns on.
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      // Position in the activity sequence is pinned exactly by (c)'s ordered
      // list; what this asserts is the consequence a reviewer actually depends
      // on — by the time the run is waiting on them, the environment is up.
      assert.deepEqual(await handle.query(pipelineStaging), { status: "ready", ref });
      await handle.signal(prApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "promoted");
    });
  },
);

test(
  "(s6) a staging create FAILURE leaves the run alive and reviewable, with the reason queryable",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0119-staging-create-failed");
    const mocks = makeMocks(calls, {
      deployStaging: async () => {
        calls.push("deployStaging");
        throw ApplicationFailure.create({
          message: "compose up failed: no space left on device",
          type: "FleetError",
          nonRetryable: true,
        });
      },
    });
    const taskQueue = "wf-test-s6";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      // Gate 2 still opens: the change is reviewable on the PR without an
      // environment, and killing the run would be the worse failure mode.
      const parked = await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      assert.equal(parked, "awaiting_pr_approval");
      const state = await handle.query(pipelineStaging);
      assert.equal(state.status, "failed");
      // The UI must be able to say WHY, not just show an absence.
      assert.match(
        state.status === "failed" ? state.error : "",
        /no space left on device/,
      );
      await handle.signal(prApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "promoted", "a staging failure is not a run failure");
    });
  },
);

test(
  "(s7) a self/dogfood run reports no staging at all — never a fabricated environment",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0119-staging-self");
    // The default mock returns null, which is exactly what the real activity
    // does for a self target.
    const mocks = makeMocks(calls);
    const taskQueue = "wf-test-s7";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      assert.deepEqual(await handle.query(pipelineStaging), { status: "none" });
      await handle.signal(prApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "promoted");
    });
  },
);

// ---------------------------------------------------------------------------
// (p) Spec 0115 — promote IS the merge. REVERSED by spec 0170.
//
// 0115's shape was: gate 2 records the tested SHA and does not merge; gate 3
// merges, and for an odoo.sh customer that merge IS the production deploy. The
// property it bought was that `main` stayed untouched until someone promoted.
//
// 0170 removed gate 3, because in practice nobody used it that way: every run
// advanced by a human merging at gate 2, so the third gate only ever asked about
// a commit that was already on main. Shipping is now a decision about a NAMED
// version (a release), taken in the Versiones panel — so gate 2 accepting the
// change is the merge, and that is what these assert.
// ---------------------------------------------------------------------------

test(
  "(p1) spec 0170: an in-app approval MERGES and ends the run — there is no promote signal",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0115-promote-merges");
    const mocks = makeMocks(calls);
    const taskQueue = "wf-test-p1";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      await handle.signal(prApproved, { approvedBy: "tester" });
      // No third signal: accepting the change at gate 2 IS the merge, and the
      // run's job ends with the change on main.
      assert.equal(await handle.result(), "promoted");
    });
    assert.ok(calls.includes("mergePullRequest"), "gate 2 acceptance must perform the merge");
    // The production deploy left with gate 3: it is now a release decision, made
    // per version in the Versiones panel and gated on `actorFor("promote")`.
    assert.equal(
      calls.includes("deployToProduction"),
      false,
      `the pipeline must not deploy to production any more: ${calls.join(" | ")}`,
    );
    // And `staged` is gone with it — the run goes straight to `promoted`, which
    // is what the status reconciler already infers from a merged branch.
    assert.equal(calls.includes("markSpec:staged"), false);
    assert.ok(calls.includes("markSpec:promoted"));
  },
);

test(
  "(p2) spec 0170: a rejection at GATE 2 never merges — main is left untouched",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0115-reject-at-promote");
    const mocks = makeMocks(calls);
    const taskQueue = "wf-test-p2";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      // Spec 0170: gate 2 is the last place to say no, because accepting there is
      // the merge. Rejecting must therefore still leave main untouched — the
      // property spec 0115 introduced, now guarded one gate earlier.
      await handle.signal(specRejected, { rejectedBy: "tester", reason: "changed my mind" });
      assert.equal(await handle.result(), "rejected");
    });
    assert.equal(
      calls.includes("mergePullRequest"),
      false,
      `a rejected change must never reach main: ${calls.join(" | ")}`,
    );
    assert.equal(
      calls.includes("deployToProduction"),
      false,
      "and it must never deploy either",
    );
  },
);

test(
  "(0133) a BRANCH run ends `staged` after gate 2 — no merge, no gate 3, no prod deploy, PR never polled",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0142-branch", {
      branch: "feature/pos",
      project: { slug: "abtest", kind: "odoo" },
    });
    const env: EphemeralEnv = { ...baseEphemeralEnv(), branch: "feature/pos" };
    const mocks = makeMocks(calls, {
      // The input carries a project, so the 0129 ensure-checkout step runs —
      // makeMocks omits it because per-spec tests carry no project.
      ensureCheckout: async () => "/tmp/launchpad-workflow-test",
      provisionEphemeralEnv: async () => {
        calls.push("provisionEphemeralEnv");
        return env;
      },
      openPullRequest: async () => {
        calls.push("openPullRequest");
        // A REAL PR ref (number > 0): a per-spec run would start the gate-2
        // poll on it — a branch run must not, because this PR belongs to the
        // BRANCH and a mid-run merge of it must not clear a spec's gate.
        // makeMocks's awaitPrApproval default THROWS if called, so reaching
        // the poll would fail this test loudly rather than silently pass.
        return {
          ...basePullRequestRef(env),
          number: 7,
          url: "https://github.com/acme/abtest/pull/7",
        };
      },
    });
    const taskQueue = "wf-test-0133-branch";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      // The serialization scan's read: the run answers its branch.
      assert.equal(await handle.query(pipelineBranch), "feature/pos");
      // Gate 2 for a branch run is the in-app signal only ("validated on
      // staging").
      await handle.signal(prApproved, { approvedBy: "tester@example.com" });
      assert.equal(await handle.result(), "staged");
      // The production act belongs to the branch-level promote (spec 0136):
      assert.equal(calls.includes("mergePullRequest"), false, calls.join(" | "));
      assert.equal(calls.includes("deployToProduction"), false, calls.join(" | "));
      assert.equal(calls.includes("awaitPrApproval"), false, calls.join(" | "));
      // The finally still cleaned up: staging destroy tolerated (null for
      // self — the branch's server outlives the run), worktree removed.
      assert.equal(calls.includes("destroyStaging"), true, calls.join(" | "));
      assert.equal(calls.includes("teardownEnv"), true, calls.join(" | "));
      assert.equal(calls.includes("markSpec:staged"), true, calls.join(" | "));
      assert.equal(calls.includes("markSpec:promoted"), false, calls.join(" | "));
    });
  },
);

test(
  "(0133) a per-spec run answers no branch and takes the unchanged non-branch path",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const input = baseInput("0143-per-spec");
    const mocks = makeMocks(calls);
    const taskQueue = "wf-test-0133-per-spec";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(specPipeline, {
        args: [input],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await handle.signal(specApproved, { approvedBy: "tester" });
      await waitForPhase(handle, (p) => p === "awaiting_pr_approval");
      assert.equal(await handle.query(pipelineBranch), undefined);
      await handle.signal(prApproved, { approvedBy: "tester" });
      assert.equal(await handle.result(), "promoted");
      // Spec 0133's property is that the BRANCH discriminator changes nothing
      // for a per-spec run; the shape it compares against is whatever the
      // non-branch path currently is. Spec 0170 changed that shape — gate 3 and
      // the production deploy are gone, and the run ends at the merge — so the
      // comparison moves with it rather than pinning a path that no longer runs.
      assert.equal(calls.includes("mergePullRequest"), true, calls.join(" | "));
      assert.equal(calls.includes("markSpec:promoted"), true, calls.join(" | "));
      assert.equal(calls.includes("deployToProduction"), false, calls.join(" | "));
    });
  },
);

// ---------------------------------------------------------------------------
// spec 0161 F2 — the odoo-next PROVISIONING workflow.
//
// `provisionProject` (provisioning-workflow.ts) is registered in the SAME
// bundle as specPipeline (workflow.ts re-exports it), so the shared harness
// runs it with no new worker wiring. Only its five activities are invoked, so
// the mocks provide just those. Two properties matter: the happy path reaches
// the terminal `completed` in phase order, and a mid-phase throw records BOTH
// the terminal `failed` and WHICH work phase died — the F3 progress view keys
// off that second query to render "that phase failed" instead of a spinner.
// ---------------------------------------------------------------------------

/** All five provisioning activities as call-recording no-ops; a test overrides
 * only the phase it wants to fail. */
function makeProvisioningMocks(
  calls: string[],
  overrides: Partial<typeof activities> = {},
): Partial<typeof activities> {
  return {
    provisionRepo: async () => void calls.push("provisionRepo"),
    provisionDns: async () => void calls.push("provisionDns"),
    provisionOdoo: async () => void calls.push("provisionOdoo"),
    provisionFront: async () => void calls.push("provisionFront"),
    verifyProvision: async () => void calls.push("verifyProvision"),
    ...overrides,
  };
}

test(
  "(prov-1) provisionProject happy path: repo→dns→odoo→front→verify in order, terminal `completed`, no failed phase",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const mocks = makeProvisioningMocks(calls);
    const taskQueue = "wf-test-prov-1";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(provisionProject, {
        args: [{ slug: "acme" }],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      // The workflow returns the slug; the phase query lands on the terminal
      // `completed`, and there is no failed work phase on a clean run.
      assert.equal(await handle.result(), "acme");
      assert.equal(await handle.query(provisioningPhase), "completed");
      assert.equal(await handle.query(provisioningFailedPhase), undefined);
    });
    assert.deepEqual(calls, [
      "provisionRepo",
      "provisionDns",
      "provisionOdoo",
      "provisionFront",
      "verifyProvision",
    ]);
  },
);

test(
  "(prov-2) a mid-phase activity throw sets provisioningPhase=`failed` AND provisioningFailedPhase to that same work phase",
  { skip },
  async () => {
    recordHarnessCase();
    const calls: string[] = [];
    const mocks = makeProvisioningMocks(calls, {
      // Fail the third (odoo) phase, non-retryably — a plain Error is retryable
      // and its backoff needs virtual time that never elapses while the test
      // queries in real time (the gate2poll-1 lesson above).
      provisionOdoo: async () => {
        calls.push("provisionOdoo");
        throw ApplicationFailure.create({
          message: "odoo deploy boom",
          type: "FleetError",
          nonRetryable: true,
        });
      },
    });
    const taskQueue = "wf-test-prov-2";
    const worker = await createTestWorker(taskQueue, mocks);
    await worker.runUntil(async () => {
      const handle = await testEnv!.client.workflow.start(provisionProject, {
        args: [{ slug: "acme" }],
        taskQueue,
        workflowId: `${taskQueue}-${randomUUID()}`,
      });
      await assert.rejects(handle.result(), (err: unknown) => {
        assert.ok(err instanceof WorkflowFailedError);
        assert.ok(err.cause instanceof ApplicationFailure);
        assert.equal(err.cause.type, "ProvisioningFailed");
        assert.match(err.cause.message ?? "", /odoo phase failed/);
        return true;
      });
      // Both queries answer against the closed failed execution via replay: the
      // terminal phase is `failed`, and the WORK phase that died is `odoo` —
      // the pair F3 needs to mark that phase failed rather than pending.
      assert.equal(await handle.query(provisioningPhase), "failed");
      assert.equal(await handle.query(provisioningFailedPhase), "odoo");
    });
    // front/verify never ran — the workflow stopped at the failed phase.
    assert.deepEqual(calls, ["provisionRepo", "provisionDns", "provisionOdoo"]);
  },
);
