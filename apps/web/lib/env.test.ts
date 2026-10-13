import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateWebEnv,
  REQUIRED_WEB_ENV,
  validatePrModeEnv,
  PR_MODE_WEB_ENV,
  temporalWorkflowUrl,
  sharedSessionCookie,
  SHARED_SESSION_COOKIE_NAME,
  isStagingControlPlane,
} from "./env.js";

const full = {
  LAUNCHPAD_REPO_ROOT: "/repo",
  TEMPORAL_ADDRESS: "localhost:7233",
  AUTH_SECRET: "test-secret",
};

test("validateWebEnv: all present → ok", () => {
  assert.deepEqual(validateWebEnv(full), { ok: true, missing: [] });
});

test("validateWebEnv: reports missing vars", () => {
  const v = validateWebEnv({ LAUNCHPAD_REPO_ROOT: "/repo" });
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ["TEMPORAL_ADDRESS", "AUTH_SECRET"]);
});

test("validateWebEnv: missing AUTH_SECRET is reported (spec 0073)", () => {
  const { AUTH_SECRET: _dropped, ...withoutSecret } = full;
  const v = validateWebEnv(withoutSecret);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ["AUTH_SECRET"]);
});

test("validateWebEnv: blank value counts as missing", () => {
  const v = validateWebEnv({ ...full, TEMPORAL_ADDRESS: "  " });
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ["TEMPORAL_ADDRESS"]);
});

test("REQUIRED_WEB_ENV lists exactly the three documented vars (GATE_ACTOR_EMAIL retired by spec 0074)", () => {
  assert.deepEqual([...REQUIRED_WEB_ENV], [
    "LAUNCHPAD_REPO_ROOT",
    "TEMPORAL_ADDRESS",
    "AUTH_SECRET",
  ]);
});

// --- PR-mode-only env (spec 0015 item 8) -----------------------------------
// GITHUB_TOKEN is validated separately from validateWebEnv/REQUIRED_WEB_ENV:
// it's only needed once a spec's gate 2 is a real GitHub PR, not app-wide.

test("validatePrModeEnv: GITHUB_TOKEN present → ok", () => {
  assert.deepEqual(validatePrModeEnv({ GITHUB_TOKEN: "ghp_x" }), { ok: true, missing: [] });
});

test("validatePrModeEnv: GITHUB_TOKEN missing → reported", () => {
  assert.deepEqual(validatePrModeEnv({}), { ok: false, missing: ["GITHUB_TOKEN"] });
});

test("validatePrModeEnv: blank GITHUB_TOKEN counts as missing", () => {
  assert.deepEqual(validatePrModeEnv({ GITHUB_TOKEN: "  " }), { ok: false, missing: ["GITHUB_TOKEN"] });
});

test("PR_MODE_WEB_ENV lists exactly GITHUB_TOKEN", () => {
  assert.deepEqual([...PR_MODE_WEB_ENV], ["GITHUB_TOKEN"]);
});

test("validatePrModeEnv is independent of REQUIRED_WEB_ENV — missing base vars don't affect it", () => {
  assert.deepEqual(validatePrModeEnv({ ...full, GITHUB_TOKEN: "ghp_x" }), { ok: true, missing: [] });
});

// --- Spec 0145: the Temporal workflow link ---------------------------------

test("temporalWorkflowUrl builds a namespaced workflow URL when a UI is configured", () => {
  assert.equal(
    temporalWorkflowUrl("spec-ab-test-sandbox-0003", { TEMPORAL_UI_URL: "https://tw.example" }),
    "https://tw.example/namespaces/default/workflows/spec-ab-test-sandbox-0003",
  );
  // Trailing slash on the base must not double up.
  assert.equal(
    temporalWorkflowUrl("spec-0130", { TEMPORAL_UI_URL: "https://tw.example/" }),
    "https://tw.example/namespaces/default/workflows/spec-0130",
  );
  assert.match(
    temporalWorkflowUrl("spec-0130", {
      TEMPORAL_UI_URL: "https://tw.example",
      TEMPORAL_NAMESPACE: "prod",
    }) ?? "",
    /namespaces\/prod\//,
  );
});

test("no configured UI means NO link — never a dead one", () => {
  assert.equal(temporalWorkflowUrl("spec-0130", {}), null);
  assert.equal(temporalWorkflowUrl("spec-0130", { TEMPORAL_UI_URL: "  " }), null);
  assert.equal(temporalWorkflowUrl("", { TEMPORAL_UI_URL: "https://tw.example" }), null);
});

// ---------------------------------------------------------------------------
// Spec 0213 B2 — one sign-in, two hosts.
// ---------------------------------------------------------------------------

test("sharedSessionCookie: unset leaves Auth.js's defaults completely alone", () => {
  // The sign-in path is the single door to the console. Every deployment that
  // does not opt in must behave EXACTLY as before, so undefined is the contract.
  assert.equal(sharedSessionCookie({}), undefined);
  assert.equal(sharedSessionCookie({ AUTH_COOKIE_DOMAIN: "" }), undefined);
  assert.equal(sharedSessionCookie({ AUTH_COOKIE_DOMAIN: "   " }), undefined);
});

test("sharedSessionCookie: a domain produces a parent-scoped, secure cookie", () => {
  const c = sharedSessionCookie({ AUTH_COOKIE_DOMAIN: "example.com" });
  assert.equal(c?.sessionToken.options.domain, "example.com");
  assert.equal(c?.sessionToken.options.secure, true);
  assert.equal(c?.sessionToken.options.httpOnly, true);
  assert.equal(c?.sessionToken.options.path, "/");
});

test("sharedSessionCookie: a leading dot is normalised away", () => {
  // `.example.com` and `example.com` are the same scope to a browser, but only one
  // of them compares equal to the other in a log line or an assertion.
  assert.equal(
    sharedSessionCookie({ AUTH_COOKIE_DOMAIN: ".example.com" })?.sessionToken.options.domain,
    "example.com",
  );
});

test("sharedSessionCookie: the name is NOT Auth.js's, and never __Host-", () => {
  const name = sharedSessionCookie({ AUTH_COOKIE_DOMAIN: "example.com" })!.sessionToken.name;
  // Reusing authjs's own name would leave two same-named cookies at different
  // scopes — the browser sends both and the server picks one arbitrarily.
  assert.notEqual(name, "__Secure-authjs.session-token");
  assert.equal(name, SHARED_SESSION_COOKIE_NAME);
  // __Host- forbids a Domain attribute outright, which is the one thing this needs.
  assert.ok(!name.startsWith("__Host-"));
  assert.ok(name.startsWith("__Secure-"));
});

test("isStagingControlPlane: absent means production, so the existing box is untouched", () => {
  assert.equal(isStagingControlPlane({}), false);
  assert.equal(isStagingControlPlane({ LAUNCHPAD_ENVIRONMENT: "production" }), false);
});

test("isStagingControlPlane: the twin identifies itself", () => {
  // Without this the deploy button on staging restarts PRODUCTION's units,
  // because deploy-here.sh names them literally.
  assert.equal(isStagingControlPlane({ LAUNCHPAD_ENVIRONMENT: "staging" }), true);
  assert.equal(isStagingControlPlane({ LAUNCHPAD_ENVIRONMENT: " Staging " }), true);
});
