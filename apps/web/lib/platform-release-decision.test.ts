/** Spec 0213 D — the platform's own deploy verdict. Pure, so it is testable. */
import test from "node:test";
import assert from "node:assert/strict";
import { decidePlatformDeploy } from "./platform-release-decision.js";

const base = { version: "1.0.0", onMain: true, liveVersion: null, isStaging: false };

test("staging is blocked, and the reason names the real danger", () => {
  const d = decidePlatformDeploy({ ...base, isStaging: true });
  assert.equal(d.blocked, true);
  // The button on the twin would restart PRODUCTION's units. Saying "no aquí"
  // without saying why invites someone to look for a way around it.
  assert.match(d.message, /producción/i);
});

test("a commit no longer on main is blocked", () => {
  assert.equal(decidePlatformDeploy({ ...base, onMain: false }).blocked, true);
});

test("git being unable to answer WARNS, it does not block", () => {
  // An unanswered question is not a "no": refusing here would block every
  // deploy whenever the checkout is briefly unreadable.
  const d = decidePlatformDeploy({ ...base, onMain: undefined });
  assert.equal(d.blocked, false);
  assert.equal(d.tone, "warn");
});

test("redeploying the live version is allowed, with a warning", () => {
  const d = decidePlatformDeploy({ ...base, liveVersion: "1.0.0" });
  assert.equal(d.blocked, false);
  assert.equal(d.tone, "warn");
});

test("the happy path says the app will be briefly down", () => {
  const d = decidePlatformDeploy(base);
  assert.equal(d.blocked, false);
  assert.equal(d.tone, "ok");
  // Restarting both units is a visible outage. A deploy button that does not
  // mention it is a surprise the first time someone presses it at 3pm.
  assert.match(d.message, /reinicia|cae/i);
});

test("spec 0219 C: deploying older than live is danger, not a silent one-click", () => {
  const d = decidePlatformDeploy({ ...base, version: "1.0.7", liveVersion: "1.0.8" });
  assert.equal(d.tone, "danger");
  assert.equal(d.blocked, false); // the control demands a second confirmation
  assert.match(d.message, /1\.0\.8/);
});

test("spec 0219 C: newer than live stays ok", () => {
  const d = decidePlatformDeploy({ ...base, version: "1.0.9", liveVersion: "1.0.8" });
  assert.equal(d.tone, "ok");
});

test("spec 0219 D: an in-flight coding run is named, with whose it is", () => {
  const d = decidePlatformDeploy({
    ...base,
    interrupts: [{ specId: "spec-0218", phase: "coding", who: "teammate@example.com" }],
  });
  assert.equal(d.blocked, false); // decision 2: warn, never block
  assert.equal(d.tone, "warn");
  assert.match(d.message, /spec-0218/);
  assert.match(d.message, /teammate@example\.com/);
});

test("spec 0219 D: a run parked at a gate loses nothing, so it is not named", () => {
  const d = decidePlatformDeploy({
    ...base,
    interrupts: [{ specId: "spec-0218", phase: "awaiting_pr_approval", who: "teammate@example.com" }],
  });
  assert.equal(d.tone, "ok");
  assert.doesNotMatch(d.message, /spec-0218/);
});

test("spec 0219 D: warning never softens a block", () => {
  const d = decidePlatformDeploy({
    ...base,
    isStaging: true,
    interrupts: [{ specId: "spec-0218", phase: "coding", who: "teammate@example.com" }],
  });
  assert.equal(d.blocked, true);
  assert.equal(d.tone, "danger");
});
