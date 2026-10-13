import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkspaceGateAction, type WorkspaceGateDeps } from "./workspace-gate";
import type { GateSignal } from "./gate-actions";

// Proves the guard-then-signal boundary in workspace-gate.ts's doc comment:
// `resolvePromoteSignalGuard` runs FIRST for every signal and a blocked guard
// never reaches `signalGate` — no live Temporal, every IO seam faked via
// `WorkspaceGateDeps`.

function fakeWorkspaceGateDeps(overrides: Partial<WorkspaceGateDeps> = {}): WorkspaceGateDeps {
  return {
    resolvePromoteSignalGuard: async () => {
      throw new Error("resolvePromoteSignalGuard should not be called in this branch");
    },
    signalGate: async () => {
      throw new Error("signalGate should not be called in this branch");
    },
    ...overrides,
  };
}

test("runWorkspaceGateAction: the async core the workspace signalGateAction wraps", () => {
  assert.equal(typeof runWorkspaceGateAction, "function");
});

test("promote ALWAYS calls resolvePromoteSignalGuard (guard-not-bypassable)", async () => {
  const signals: GateSignal[] = ["specApproved", "prApproved", "promote", "specRejected"];
  for (const signal of signals) {
    let called: [string, GateSignal] | undefined;
    const deps = fakeWorkspaceGateDeps({
      resolvePromoteSignalGuard: async (specId, sig) => {
        called = [specId, sig];
        return { blocked: false };
      },
      signalGate: async () => {},
    });
    await runWorkspaceGateAction("0095", signal, "owner@example.com", deps);
    assert.deepEqual(called, ["0095", signal]);
  }
});

test("a blocked guard refuses (ok:false + its message) and never calls signalGate", async () => {
  const deps = fakeWorkspaceGateDeps({
    resolvePromoteSignalGuard: async () => ({ blocked: true, message: "spec 0095: CI is red" }),
  });
  const result = await runWorkspaceGateAction("0095", "promote", "owner@example.com", deps);
  assert.deepEqual(result, { ok: false, reason: "spec 0095: CI is red" });
});

test("an allowed guard calls signalGate(specId, signal, actor) → { ok: true }", async () => {
  let called: [string, GateSignal, string] | undefined;
  const deps = fakeWorkspaceGateDeps({
    resolvePromoteSignalGuard: async () => ({ blocked: false }),
    signalGate: async (specId, signal, actor) => {
      called = [specId, signal, actor];
    },
  });
  const result = await runWorkspaceGateAction("0095", "specApproved", "owner@example.com", deps);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(called, ["0095", "specApproved", "owner@example.com"]);
});

test("a signalGate error surfaces as ok:false, never a thrown exception", async () => {
  const deps = fakeWorkspaceGateDeps({
    resolvePromoteSignalGuard: async () => ({ blocked: false }),
    signalGate: async () => {
      throw new Error("workflow is not running (status: COMPLETED)");
    },
  });
  const result = await runWorkspaceGateAction("0095", "prApproved", "owner@example.com", deps);
  assert.deepEqual(result, { ok: false, reason: "workflow is not running (status: COMPLETED)" });
});
