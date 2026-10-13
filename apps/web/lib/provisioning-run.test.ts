/**
 * Tests for spec 0161 F3 — the provisioning progress view's pure derivation
 * (lib/provisioning-run.ts). Plain `node --test` over compiled lib-only TS, no
 * React/DOM (the run-follow-card.test.ts discipline).
 *
 * The load-bearing claim (VERIFICATION #2 — a check that can actually fail): a
 * FAILED phase yields a `failed` status that is DISTINCT from `upcoming`, so the
 * view can render it as a failure rather than a spinner. A test that only
 * checked "not done" would pass on the very bug F3 exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveProvisioningSteps,
  deriveProvisioningStepperNodes,
  PROVISIONING_WORK_PHASES,
} from "./provisioning-run.js";

test("mid-run: phases before are done, current is current, rest upcoming", () => {
  const steps = deriveProvisioningSteps("odoo");
  assert.deepEqual(
    steps.map((s) => s.status),
    ["done", "done", "current", "upcoming", "upcoming"],
  );
});

test("completed: every work phase is done", () => {
  const steps = deriveProvisioningSteps("completed");
  assert.ok(steps.every((s) => s.status === "done"));
  assert.equal(steps.length, PROVISIONING_WORK_PHASES.length);
});

test("failed at odoo: that phase reads failed, distinct from an upcoming one", () => {
  const steps = deriveProvisioningSteps("failed", "odoo");
  assert.deepEqual(
    steps.map((s) => s.status),
    ["done", "done", "failed", "upcoming", "upcoming"],
  );
  const odoo = steps.find((s) => s.phase === "odoo");
  const front = steps.find((s) => s.phase === "front");
  assert.equal(odoo?.status, "failed");
  assert.notEqual(odoo?.status, front?.status); // failed !== upcoming — the F3 point
});

test("undefined phase: nothing started, all upcoming", () => {
  const steps = deriveProvisioningSteps(undefined);
  assert.ok(steps.every((s) => s.status === "upcoming"));
});

test("failed with no failedAt degrades to the first phase, still a failure", () => {
  const steps = deriveProvisioningSteps("failed");
  assert.equal(steps[0]?.status, "failed");
  assert.ok(!steps.some((s) => s.status === "current")); // never a spinner
});

test("stepper nodes carry a label per phase", () => {
  const nodes = deriveProvisioningStepperNodes(deriveProvisioningSteps("repo"));
  assert.equal(nodes.length, PROVISIONING_WORK_PHASES.length);
  assert.ok(nodes.every((n) => typeof n.label === "string" && n.label.length > 0));
});
