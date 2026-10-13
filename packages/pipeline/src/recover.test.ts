import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDirt, planWatcherRecovery } from "./recover.js";

// ---------------------------------------------------------------------------
// Spec 0051 increment A. The pure recovery-decision core has two classifiers
// (classifyDirt, planWatcherRecovery).
// ---------------------------------------------------------------------------

// classifyDirt — stray-only / drafting-expected / mixed / empty (spec 0051 §A).
test("classifyDirt: every dirty path is stray when none is a drafting spec file", () => {
  const result = classifyDirt({
    porcelainLines: [" M scripts/supervise.mjs", "?? scratch.txt"],
    draftingSpecFiles: [],
  });
  assert.deepEqual(result, { expected: [], stray: ["scripts/supervise.mjs", "scratch.txt"] });
});

test("classifyDirt: an open drafting workflow's spec file goes to expected, not stray", () => {
  const result = classifyDirt({
    porcelainLines: [" M specs/0051-supervise-recover-mode.md"],
    draftingSpecFiles: ["specs/0051-supervise-recover-mode.md"],
  });
  assert.deepEqual(result, { expected: ["specs/0051-supervise-recover-mode.md"], stray: [] });
});

test("classifyDirt: mixed input splits drafting spec files into expected, the rest into stray", () => {
  const result = classifyDirt({
    porcelainLines: [
      " M specs/0051-supervise-recover-mode.md",
      "?? scratch.txt",
      " M packages/pipeline/src/recover.ts",
    ],
    draftingSpecFiles: ["specs/0051-supervise-recover-mode.md"],
  });
  assert.deepEqual(result, {
    expected: ["specs/0051-supervise-recover-mode.md"],
    stray: ["scratch.txt", "packages/pipeline/src/recover.ts"],
  });
});

test("classifyDirt: empty porcelain input yields empty expected and stray (no warning)", () => {
  const result = classifyDirt({ porcelainLines: [], draftingSpecFiles: ["specs/0051-x.md"] });
  assert.deepEqual(result, { expected: [], stray: [] });
});

// planWatcherRecovery — self-exclusion / specId scoping / reattach = open set /
// empty open set (spec 0051 §A).
test("planWatcherRecovery: excludes selfPid from the kill set", () => {
  const result = planWatcherRecovery({
    processes: [
      { specId: "0050", pid: 111 },
      { specId: "0051", pid: 222 },
    ],
    openWorkflowIds: ["0050", "0051"],
    selfPid: 222,
  });
  assert.deepEqual(result.kill, [111]);
  assert.deepEqual(result.reattach.sort(), ["0050", "0051"]);
});

test("planWatcherRecovery: scopeSpecId kills only that specId's watchers and reattaches only that id", () => {
  const result = planWatcherRecovery({
    processes: [
      { specId: "0050", pid: 111 },
      { specId: "0051", pid: 222 },
    ],
    openWorkflowIds: ["0050", "0051"],
    selfPid: 999,
    scopeSpecId: "0050",
  });
  assert.deepEqual(result, { kill: [111], reattach: ["0050"] });
});

test("planWatcherRecovery: unscoped reattach equals the full open-workflow set", () => {
  const result = planWatcherRecovery({
    processes: [],
    openWorkflowIds: ["0050", "0051", "0052"],
    selfPid: 1,
  });
  assert.deepEqual(result.reattach, ["0050", "0051", "0052"]);
});

test("planWatcherRecovery: empty open set yields no reattach", () => {
  const result = planWatcherRecovery({
    processes: [{ specId: "0050", pid: 111 }],
    openWorkflowIds: [],
    selfPid: 999,
  });
  assert.deepEqual(result.reattach, []);
  assert.deepEqual(result.kill, [111]);
});

test("recover module exports its two pure classifiers", () => {
  assert.equal(typeof classifyDirt, "function");
  assert.equal(typeof planWatcherRecovery, "function");
});
