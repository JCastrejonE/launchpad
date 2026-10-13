import { test } from "node:test";
import assert from "node:assert/strict";
import { runCiGateActivity, CI_STATUS_CONTEXT, type CiGateDeps } from "./ci-gate-activity.js";

// Spec 0228 B/C. These test the ORDER and the verdict logic, which is what this
// activity is. They do NOT prove the GitHub contract — that was proven live on
// 2026-08-19 (POST 201, status read back off the commit) — nor that a container
// runs, which needs the box.

function deps(over: Partial<CiGateDeps> = {}) {
  const published: Array<{ state: string; description?: string }> = [];
  const base: CiGateDeps = {
    shipTree: async () => "/tmp/ci-abc",
    runGate: async () => ({ output: "GATE GREEN", code: 0 }),
    readOutcome: (out) =>
      /GATE RED:\s*([^\n]+)/.test(out)
        ? { green: false, failedStep: /GATE RED:\s*([^\n]+)/.exec(out)![1]!.trim() }
        : /GATE GREEN/.test(out)
          ? { green: true, failedStep: null }
          : { green: false, failedStep: "the gate did not run" },
    publish: async (s) => {
      published.push({ state: s.state, ...(s.description ? { description: s.description } : {}) });
    },
    cleanup: async () => undefined,
    ...over,
  };
  return { deps: base, published };
}

const input = { sha: "abc123", owner: "example-org", repo: "launchpad" };

test("publishes pending BEFORE running, then the verdict", async () => {
  // A gate taking minutes must read as running. Absence is indistinguishable
  // from "no CI exists", which is the confusion spec 0227 was built under.
  const order: string[] = [];
  const { deps: d, published } = deps({
    runGate: async () => {
      order.push("ran");
      return { output: "GATE GREEN", code: 0 };
    },
  });
  const wrapped: CiGateDeps = {
    ...d,
    publish: async (s) => {
      order.push("published:" + s.state);
      return d.publish(s);
    },
  };
  await runCiGateActivity(input, wrapped);
  assert.deepEqual(order, ["published:pending", "ran", "published:success"]);
  assert.equal(published.length, 2);
});

test("a red gate publishes failure and names the step", async () => {
  const { deps: d, published } = deps({
    runGate: async () => ({ output: "GATE RED: test", code: 1 }),
  });
  const res = await runCiGateActivity(input, d);
  assert.equal(res.green, false);
  assert.equal(res.failedStep, "test");
  assert.equal(published.at(-1)?.state, "failure");
  assert.equal(published.at(-1)?.description, "test");
});

test("output and exit code disagreeing is NOT green, and says so", async () => {
  // Output arrived over SSH; the code may have travelled through a pipe. Neither
  // is trustworthy alone (VERIFICATION #8), so a disagreement is the finding.
  const { deps: d, published } = deps({
    runGate: async () => ({ output: "GATE GREEN", code: 1 }),
  });
  const res = await runCiGateActivity(input, d);
  assert.equal(res.green, false);
  assert.match(res.failedStep ?? "", /disagree/);
  assert.equal(published.at(-1)?.state, "failure");
});

test("a gate that never ran is failure, never success", async () => {
  const { deps: d, published } = deps({
    runGate: async () => ({ output: "docker: pull access denied", code: 125 }),
  });
  const res = await runCiGateActivity(input, d);
  assert.equal(res.green, false);
  assert.equal(published.at(-1)?.state, "failure");
});

test("a throw resolves the status instead of stranding it at pending", async () => {
  // The defect the first three real deliveries exposed: git archive found no
  // such commit, the activity threw, and three commits sat at `pending` forever.
  // A stranded pending is worse than never posting — promote reads it as
  // "in flight" and waits on something already dead.
  const { deps: d, published } = deps({
    shipTree: async () => {
      throw new Error("could not fetch abc123 from origin");
    },
  });
  await assert.rejects(() => runCiGateActivity(input, d));
  assert.equal(published.length, 2, "pending, then a resolution");
  assert.equal(published.at(-1)?.state, "failure");
  assert.match(published.at(-1)?.description ?? "", /could not run|could not fetch/);
});

test("a failure to publish the failure does not replace the original error", async () => {
  // The original error is the useful one.
  let calls = 0;
  const { deps: d } = deps({
    runGate: async () => {
      throw new Error("ssh died");
    },
    publish: async () => {
      calls++;
      if (calls > 1) throw new Error("github unreachable");
    },
  });
  await assert.rejects(() => runCiGateActivity(input, d), /ssh died/);
});

test("the working directory is cleaned up even when the gate throws", async () => {
  let cleaned: string | null = null;
  const { deps: d } = deps({
    runGate: async () => {
      throw new Error("ssh died");
    },
    cleanup: async (w) => {
      cleaned = w;
    },
  });
  await assert.rejects(() => runCiGateActivity(input, d));
  assert.equal(cleaned, "/tmp/ci-abc");
});

test("the status context is the one promote will look for", () => {
  assert.equal(CI_STATUS_CONTEXT, "ci/launchpad");
});
