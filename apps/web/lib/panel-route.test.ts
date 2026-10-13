import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PANEL, isPanel, panelRedirectPath } from "./panel-route";

test("panelRedirectPath honours a pre-0157 ?tab= link", () => {
  assert.equal(panelRedirectPath("platform", { tab: "specs" }), "/projects/platform/specs");
  assert.equal(panelRedirectPath("platform", { tab: "ramas" }), "/projects/platform/ramas");
});

test("panelRedirectPath falls back to the default panel, never to a made-up one", () => {
  assert.equal(panelRedirectPath("platform"), `/projects/platform/${DEFAULT_PANEL}`);
  assert.equal(panelRedirectPath("platform", { tab: "nope" }), `/projects/platform/${DEFAULT_PANEL}`);
  // A path segment must never be attacker-chosen: an unknown tab is discarded,
  // not concatenated.
  assert.equal(panelRedirectPath("platform", { tab: "../../etc" }), `/projects/platform/${DEFAULT_PANEL}`);
});

test("panelRedirectPath carries the error and the open chat through", () => {
  assert.equal(
    panelRedirectPath("platform", { tab: "specs", error: "no se pudo" }),
    "/projects/platform/specs?error=no+se+pudo",
  );
  assert.equal(panelRedirectPath("p", { tab: "chats", chat: "t1" }), "/projects/p/chats?chat=t1");
});

test("isPanel accepts every tab in the rail and nothing else", () => {
  for (const p of ["overview", "chats", "agentes", "specs", "ramas", "ajustes"]) assert.ok(isPanel(p));
  assert.equal(isPanel("resumen"), false);
  assert.equal(isPanel(undefined), false);
});
