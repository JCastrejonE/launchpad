/**
 * Tests for spec 0161 F3 — the provisioning follow reader's mapping + degrade
 * (lib/provisioning-follow.ts). Plain `node --test`; a fake `Client` (the
 * `clientOverride` seam) so the reader never touches a real Temporal server.
 *
 * The load-bearing claims (VERIFICATION #2 — checks that can actually fail):
 *  - a healthy run maps the two query answers + describe status through 1:1;
 *  - a per-query failure degrades that field to null/undefined WITHOUT losing
 *    the others (a describe outage still yields the phase);
 *  - a getHandle/connection throw degrades the WHOLE state to null, never
 *    raising — the run-follow posture the view depends on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getProvisioningRunState,
  type ProvisioningFollowClient,
  deepestMessage,
} from "./provisioning-follow";

/** A fake client whose handle answers each of the three reads from a script. */
function fakeClient(handle: {
  query: (queryType: string) => Promise<unknown>;
  describe: () => Promise<{ status: { name: string } }>;
  /** Spec 0169 follow-up: a FAILED run's reason comes from here. */
  result?: () => Promise<unknown>;
}): ProvisioningFollowClient {
  return { workflow: { getHandle: () => handle as never } };
}

test("healthy run: phase, failedPhase and status map through 1:1", async () => {
  const client = fakeClient({
    query: async (q) =>
      q === "provisioningPhase" ? "odoo" : q === "provisioningFailedPhase" ? undefined : undefined,
    describe: async () => ({ status: { name: "RUNNING" } }),
    result: async () => undefined,
  });
  const state = await getProvisioningRunState("acme", client);
  assert.deepEqual(state, { slug: "acme", phase: "odoo", failedPhase: undefined, status: "RUNNING" });
});

test("failed run: failedPhase carries the work phase that died", async () => {
  const client = fakeClient({
    query: async (q) => (q === "provisioningPhase" ? "failed" : "odoo"),
    describe: async () => ({ status: { name: "FAILED" } }),
    result: async () => undefined,
  });
  const state = await getProvisioningRunState("acme", client);
  assert.equal(state.phase, "failed");
  assert.equal(state.failedPhase, "odoo");
  assert.equal(state.status, "FAILED");
});

test("describe outage degrades only status, keeping the phase", async () => {
  const client = fakeClient({
    query: async (q) => (q === "provisioningPhase" ? "dns" : undefined),
    describe: async () => {
      throw new Error("describe unavailable");
    },
  });
  const state = await getProvisioningRunState("acme", client);
  assert.equal(state.phase, "dns");
  assert.equal(state.status, null);
});

test("not-started run (queries throw) degrades to all-null, no throw", async () => {
  const client = fakeClient({
    query: async () => {
      throw new Error("workflow not found");
    },
    describe: async () => {
      throw new Error("workflow not found");
    },
  });
  const state = await getProvisioningRunState("acme", client);
  assert.deepEqual(state, { slug: "acme", phase: null, failedPhase: undefined, status: null });
});

test("connection throw degrades the whole state to null", async () => {
  const throwingClient: ProvisioningFollowClient = {
    workflow: {
      getHandle: () => {
        throw new Error("temporal unreachable");
      },
    },
  };
  const state = await getProvisioningRunState("acme", throwingClient);
  assert.deepEqual(state, { slug: "acme", phase: null, failedPhase: undefined, status: null });
});

/**
 * The card said "revisa el detalle abajo" and rendered no detail, because
 * nothing carried one. These cover the two ways that could come back: no
 * message at all, and the WRONG message.
 */
test("deepestMessage digs past Temporal's wrapper to the real cause", () => {
  // Temporal wraps: the outer error is useless, the ApplicationFailure under it
  // is what a person needs to read.
  const err = Object.assign(new Error("Workflow execution failed"), {
    cause: Object.assign(new Error("Activity task failed"), {
      cause: new Error("front phase failed: open Dockerfile: no such file or directory"),
    }),
  });
  assert.equal(deepestMessage(err), "front phase failed: open Dockerfile: no such file or directory");
});

test("deepestMessage survives a cause cycle and caps its length", () => {
  const a = new Error("outer") as Error & { cause?: unknown };
  const b = new Error("inner") as Error & { cause?: unknown };
  a.cause = b;
  b.cause = a; // a cycle must not hang the request
  assert.equal(deepestMessage(a), "inner");
  const long = new Error("x".repeat(5000));
  assert.equal(deepestMessage(long, 100)?.length, 100);
  assert.equal(deepestMessage(undefined), undefined);
  assert.equal(deepestMessage({}), undefined);
});

test("a FAILED run carries its reason; a RUNNING one is never awaited", async () => {
  let resultCalls = 0;
  const client = (status: string, rejectWith?: unknown): ProvisioningFollowClient => ({
    workflow: {
      getHandle: () => ({
        query: async () => undefined as never,
        describe: async () => ({ status: { name: status } }),
        result: async () => {
          resultCalls++;
          // A RUNNING workflow's result() never settles — if the reader ever
          // awaits it, this test hangs, which is the failure we want.
          if (rejectWith) throw rejectWith;
          return undefined;
        },
      }),
    },
  });

  const failed = await getProvisioningRunState(
    "acme",
    client("FAILED", Object.assign(new Error("wrapper"), { cause: new Error("odoo phase failed: boom") })),
  );
  assert.equal(failed.failureMessage, "odoo phase failed: boom");
  assert.equal(resultCalls, 1);

  resultCalls = 0;
  const running = await getProvisioningRunState("acme", client("RUNNING"));
  assert.equal(running.failureMessage, undefined);
  assert.equal(resultCalls, 0, "result() must not be awaited for a run still in flight");
});
