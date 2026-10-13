/**
 * Spec 0119. The rule under test is spec 0084's — never present what we cannot
 * observe — so most of these assert what is NOT rendered: no panel for a run
 * without staging, and no link for a host that cannot resolve.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveStagingView } from "./staging-view";
import type { StagingState, StagingRef } from "@launchpad/pipeline";

function ref(overrides: Partial<StagingRef> = {}): StagingRef {
  return {
    specId: "0119",
    stack: "spec-0119",
    host: "spec-0119.sandbox.sandbox.launchpad.test",
    addons: ["sale_custom"],
    healthy: true,
    odooHttpOk: true,
    ...overrides,
  };
}

test("no staging state at all renders nothing — a pre-0119 run must not imply an environment", () => {
  assert.equal(deriveStagingView(undefined), null);
});

test("status none renders nothing — a dogfood run has no environment to show", () => {
  assert.equal(deriveStagingView({ status: "none" }), null);
});

test("a .test host is shown as text with the reason, never as a link", () => {
  // A link that cannot resolve reads as a broken environment rather than as a
  // missing DNS record. The whole point of withholding href.
  const view = deriveStagingView({ status: "ready", ref: ref() });
  assert.ok(view);
  assert.equal(view.href, undefined, "there must be no link while the domain cannot resolve");
  assert.equal(view.host, "spec-0119.sandbox.sandbox.launchpad.test");
  assert.match(view.detail ?? "", /no resuelve/);
});

test("a resolvable host DOES get a link", () => {
  // The positive control: without this, a deriver that never linked anything
  // would satisfy the test above.
  const view = deriveStagingView({
    status: "ready",
    ref: ref({ host: "spec-0119.sandbox.staging.example.com" }),
  });
  assert.ok(view);
  assert.equal(view.href, "https://spec-0119.sandbox.staging.example.com");
  assert.equal(view.detail?.includes("no resuelve"), false);
});

test("odooHttpOk is reported as 'answered on the VPS', never as 'reachable'", () => {
  const ok = deriveStagingView({ status: "ready", ref: ref() });
  assert.match(ok?.detail ?? "", /respondió en el VPS/);
  const notOk = deriveStagingView({ status: "ready", ref: ref({ odooHttpOk: false }) });
  assert.equal(notOk?.tone, "info", "an unanswered Odoo is not presented as healthy");
  assert.match(notOk?.detail ?? "", /aún no respondía/);
});

test("no custom addons says so plainly rather than showing an empty list", () => {
  const view = deriveStagingView({ status: "ready", ref: ref({ addons: [] }) });
  assert.match(view?.detail ?? "", /sólo `base`/);
});

test("a failed create explains itself — an unexplained absence reads as 'not built yet'", () => {
  const state: StagingState = {
    status: "failed",
    error: "staging capacity reached on VPS 100001",
  };
  const view = deriveStagingView(state);
  assert.ok(view);
  assert.equal(view.tone, "warn");
  assert.match(view.detail ?? "", /staging capacity reached/);
  // The review can still proceed, and the panel says so.
  assert.match(view.detail ?? "", /revisable en el PR/);
  assert.equal(view.host, undefined, "a failed create has no host to show");
});

// --- Spec 0226 E: what the environment IS ------------------------------------

test("spec 0226 E: every staging view says it is disposable, unconditionally", () => {
  // odoo.sh states plainly that staging is not backed up. We said nothing, which
  // reads as durability — and gets worse once it holds a copy of production.
  const ready = deriveStagingView({ status: "ready", ref: ref() });
  assert.equal(ready?.disposable, true);
  const failed = deriveStagingView({ status: "failed", error: "box hiccup" });
  assert.equal(failed?.disposable, true);
});

test("spec 0226 E: `neutralized` appears only when the marker was proven", () => {
  const clean = deriveStagingView({ status: "ready", ref: ref() });
  assert.equal(clean?.neutralized, undefined, "absent must not read as 'probably neutralized'");
  const copied = deriveStagingView({ status: "ready", ref: ref({ neutralized: true }) });
  assert.equal(copied?.neutralized, true);
});
