import test from "node:test";
import assert from "node:assert/strict";
import { requiresSession, signInUrl } from "./route-access";

// The routes that were LIVE and anonymous on the public IP before this policy
// existed (spec 0125). Each one is why this file is here, so each one is a test.
test("the surfaces that actually leaked now require a session", () => {
  assert.equal(requiresSession("/"), true); // rendered the dashboard + greeting
  assert.equal(requiresSession("/forge/specs"), true); // listed every spec title
  assert.equal(requiresSession("/projects/platform"), true);
  assert.equal(requiresSession("/forge/specs/0125-v0-launch-topology.md"), true);
  assert.equal(requiresSession("/api/specs"), true);
});

test("sign-in and liveness stay reachable without a session", () => {
  // Gating these would be a redirect loop, a broken sign-in, and a dead
  // health check respectively.
  assert.equal(requiresSession("/login"), false);
  assert.equal(requiresSession("/api/auth/csrf"), false);
  assert.equal(requiresSession("/api/auth/callback/credentials"), false);
  assert.equal(requiresSession("/api/health"), false);
});

test("assets are not application routes", () => {
  assert.equal(requiresSession("/_next/static/chunks/main.js"), false);
  assert.equal(requiresSession("/favicon.ico"), false);
});

// The negative control, and the reason this is a function rather than a
// startsWith in the middleware: a public prefix must not open a longer path
// that merely begins with the same characters.
test("a public prefix does not leak its neighbours", () => {
  assert.equal(requiresSession("/loginable"), true);
  assert.equal(requiresSession("/login-as-owner"), true);
  assert.equal(requiresSession("/api/authz/tokens"), true);
  assert.equal(requiresSession("/api/healthz-internal"), true);
  assert.equal(requiresSession("/_nextdoor"), true);
});

test("default is DENY — an unknown new route is private", () => {
  assert.equal(requiresSession("/some/route/added/next/quarter"), true);
});

// Both assertions below are regressions of bugs that reached the live box.
test("the sign-in URL is absolute and uses the PUBLIC host", () => {
  const url = signInUrl({
    pathname: "/projects/platform",
    search: "?tab=specs",
    proto: "https",
    host: "203.0.113.10.sslip.io",
  });
  // Absolute: Next's middleware parses Location as a URL and 500s on a
  // relative one (ERR_INVALID_URL).
  assert.ok(url.startsWith("https://"), url);
  // The public host, never the internal origin the app was reached on.
  assert.ok(url.includes("203.0.113.10.sslip.io"), url);
  assert.ok(!url.includes("localhost"), url);
  assert.equal(new URL(url).pathname, "/login");
  assert.equal(new URL(url).searchParams.get("callbackUrl"), "/projects/platform?tab=specs");
});

test("signInUrl tolerates a proto with a trailing colon and an empty search", () => {
  // nextUrl.protocol yields "https:", headers yield "https" — both must work.
  const url = signInUrl({ pathname: "/", search: "", proto: "https:", host: "example.test" });
  assert.equal(url, "https://example.test/login?callbackUrl=%2F");
});

test("the GitHub webhook is public, because GitHub has no session", () => {
  // Its authentication is the HMAC over the raw body (spec 0228 D), checked
  // before the payload is parsed and before anything is started. An unset
  // secret refuses. Session-gating it would not make it safer, only dead.
  assert.equal(requiresSession("/api/github/webhook"), false);
  // And the exemption must not be broader than the route it was added for.
  assert.equal(requiresSession("/api/github"), true);
  assert.equal(requiresSession("/api/githubx"), true);
});
