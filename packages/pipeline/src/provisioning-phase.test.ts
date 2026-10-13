import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVISIONING_PHASES,
  PROVISIONING_TERMINAL_PHASES,
  isProvisioningTerminalPhase,
  PROVISION_PROJECT_WORKFLOW,
  PROVISIONING_PHASE_QUERY,
} from "./provisioning-phase.js";

test("PROVISIONING_PHASES is repo→dns→odoo→front→verify then the terminal outcomes", () => {
  assert.deepEqual(PROVISIONING_PHASES, [
    "repo",
    "dns",
    "odoo",
    "front",
    "verify",
    "completed",
    "failed",
  ]);
});

test("PROVISIONING_TERMINAL_PHASES are exactly completed/failed and a subset of PROVISIONING_PHASES", () => {
  assert.deepEqual(PROVISIONING_TERMINAL_PHASES, ["completed", "failed"]);
  for (const p of PROVISIONING_TERMINAL_PHASES) {
    assert.ok(PROVISIONING_PHASES.includes(p), `${p} missing from PROVISIONING_PHASES`);
  }
});

test("isProvisioningTerminalPhase is true only for the terminal outcomes", () => {
  assert.equal(isProvisioningTerminalPhase("completed"), true);
  assert.equal(isProvisioningTerminalPhase("failed"), true);
  // A mid-run failure must surface as `failed`, not leave a work phase looking terminal.
  assert.equal(isProvisioningTerminalPhase("verify"), false);
  assert.equal(isProvisioningTerminalPhase("repo"), false);
});

test("workflow type and query names are the shared string constants (VERIFICATION #10)", () => {
  assert.equal(PROVISION_PROJECT_WORKFLOW, "provisionProject");
  assert.equal(PROVISIONING_PHASE_QUERY, "provisioningPhase");
});
