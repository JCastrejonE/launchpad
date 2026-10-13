/**
 * Spec 0117: the role→capability policy is the whole security value of this
 * spec, so it is tested as a TABLE of facts rather than a few happy paths — the
 * question "can a MEMBER promote?" must have an answer that is checked, not
 * inferred.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIGNAL_CAPABILITY,
  capabilityDenial,
  capabilityForSignal,
  roleHasCapability,
  type Capability,
} from "./capabilities";
import { GATE_ACTION_LABEL, type GateSignal } from "./gate-actions";
import type { UserRole } from "./auth-core";

const ROLES: UserRole[] = ["OWNER", "MEMBER", "VIEWER"];

test("the full role × capability matrix", () => {
  const expected: Record<UserRole, Record<Capability, boolean>> = {
    OWNER: { request: true, promote: true },
    MEMBER: { request: true, promote: false },
    VIEWER: { request: false, promote: false },
  };
  for (const role of ROLES) {
    for (const capability of ["request", "promote"] as Capability[]) {
      assert.equal(
        roleHasCapability(role, capability),
        expected[role][capability],
        `${role} × ${capability}`,
      );
    }
  }
});

test("only OWNER may promote — the one fact this spec exists to enforce", () => {
  assert.equal(roleHasCapability("OWNER", "promote"), true);
  assert.equal(roleHasCapability("MEMBER", "promote"), false);
  assert.equal(roleHasCapability("VIEWER", "promote"), false);
});

test("a signed-out session (null/undefined role) holds nothing", () => {
  for (const capability of ["request", "promote"] as Capability[]) {
    assert.equal(roleHasCapability(null, capability), false);
    assert.equal(roleHasCapability(undefined, capability), false);
  }
});

test("every gate signal is classified — no signal defaults into a capability", () => {
  // GATE_ACTION_LABEL is the independent list of signals (it exists for the
  // buttons, not for us), so this catches a signal added there and forgotten
  // here even though `Record<GateSignal, …>` should already have failed tsc.
  const signals = Object.keys(GATE_ACTION_LABEL) as GateSignal[];
  assert.ok(signals.length > 0);
  for (const signal of signals) {
    assert.ok(
      SIGNAL_CAPABILITY[signal] === "request" || SIGNAL_CAPABILITY[signal] === "promote",
      `${signal} has no capability`,
    );
  }
});

test("promote is the only signal needing the promote capability", () => {
  assert.equal(capabilityForSignal("promote"), "promote");
  assert.equal(capabilityForSignal("specApproved"), "request");
  assert.equal(capabilityForSignal("prApproved"), "request");
  // Stopping your own run is the cheapest, most reversible action here — a
  // MEMBER who can start one must be able to stop it.
  assert.equal(capabilityForSignal("specRejected"), "request");
});

test("a MEMBER may send every gate signal except promote", () => {
  const signals = Object.keys(GATE_ACTION_LABEL) as GateSignal[];
  const allowed = signals.filter((s) => roleHasCapability("MEMBER", capabilityForSignal(s)));
  assert.deepEqual(allowed.sort(), ["prApproved", "specApproved", "specRejected"]);
});

test("a VIEWER may send no gate signal at all", () => {
  const signals = Object.keys(GATE_ACTION_LABEL) as GateSignal[];
  const allowed = signals.filter((s) => roleHasCapability("VIEWER", capabilityForSignal(s)));
  assert.deepEqual(allowed, []);
});

test("capabilityDenial returns null exactly when the role is allowed", () => {
  assert.equal(capabilityDenial("OWNER", "promote"), null);
  assert.equal(capabilityDenial("OWNER", "request"), null);
  assert.equal(capabilityDenial("MEMBER", "request"), null);
  assert.notEqual(capabilityDenial("MEMBER", "promote"), null);
  assert.notEqual(capabilityDenial("VIEWER", "request"), null);
  assert.notEqual(capabilityDenial(null, "request"), null);
});

test("a denial names the role held and the role needed", () => {
  const reason = capabilityDenial("MEMBER", "promote");
  assert.ok(reason?.includes("MEMBER"), `should name the held role: ${reason}`);
  assert.ok(reason?.includes("OWNER"), `should name the needed role: ${reason}`);
});

test("a signed-out denial says sign in, not 'your session is null'", () => {
  const reason = capabilityDenial(null, "request");
  assert.ok(reason?.startsWith("Sign in"), reason ?? "");
  assert.ok(!reason?.includes("null"));
});

test("denials never leak a role the user does not have as if they had it", () => {
  // Regression shape: an early draft interpolated the REQUIRED role into the
  // "your session is X" slot, telling a MEMBER "your session is OWNER".
  assert.ok(!capabilityDenial("MEMBER", "promote")?.includes("your session is OWNER"));
  assert.ok(!capabilityDenial("VIEWER", "request")?.includes("your session is MEMBER"));
});

/**
 * Spec 0166. The branch-promote surface gated on membership alone, so a MEMBER
 * saw three enabled "Promote a main" buttons and the server would have merged
 * for them. Merging a branch to main IS the production change.
 *
 * This pins the rule both promote surfaces now share — the spec page had it, the
 * branch panel did not.
 */
test("promote is OWNER-only; MEMBER is refused with a reason (0166)", () => {
  assert.equal(capabilityDenial("OWNER", "promote"), null);
  const member = capabilityDenial("MEMBER", "promote");
  assert.ok(member, "a MEMBER must be refused");
  assert.match(member, /OWNER/, `the refusal must name what is needed, got: ${member}`);
  assert.ok(capabilityDenial("VIEWER", "promote"));
  assert.ok(capabilityDenial(null, "promote"), "signed out is refused too");
  // …and the capability a MEMBER genuinely has stays available, or we would have
  // fixed the leak by breaking the product.
  assert.equal(capabilityDenial("MEMBER", "request"), null);
});
