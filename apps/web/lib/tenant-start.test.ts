import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTenantPipelineInput,
  nextSpecId,
  parseOdooVersion,
  validateTenantStartForm,
  tenantStartRedirectPath,
  vanillaTenantRequest,
} from "./tenant-start.js";
import type { PipelineInput } from "@launchpad/pipeline";

// ---------------------------------------------------------------------------
// Scaffolded skipped by the initializer (spec 0027). Each `skip` maps to an
// acceptance-criteria bullet; the coder implementing the referenced Plan item
// fills in the assertions and drops the `skip`. Repo stays green in the
// meantime (skipped tests don't fail, stubs still typecheck).
// ---------------------------------------------------------------------------

// spec 0027 item 1 — target-shape parity with `cli start-tenant`. The literal
// expectation below mirrors packages/pipeline/src/cli.ts lines ~83-93 so a
// drift in either side turns this RED. Keep this fixture in sync with cli.ts.
test("buildTenantPipelineInput matches cli start-tenant's PipelineInput shape", () => {
  const input = buildTenantPipelineInput("0028", "deploy request", "owner@example.com", "/repo", {
    tenantId: "acme",
    vpsId: 100001,
    odooVersion: 18,
  });
  const expected: PipelineInput = {
    specId: "0028",
    target: { kind: "tenant", tenantId: "acme", repo: "/repo", odooVersion: 18, vpsId: 100001 },
    request: "deploy request",
    requestedBy: "owner@example.com",
  };
  assert.deepEqual(input, expected);
});

// spec 0027 item 1 — odoo-version validation (mirrors cli's --odoo-version).
test("parseOdooVersion accepts 17/18/19 and rejects everything else", () => {
  assert.equal(parseOdooVersion("17"), 17);
  assert.equal(parseOdooVersion("18"), 18);
  assert.equal(parseOdooVersion("19"), 19);
  assert.equal(parseOdooVersion("20"), null);
  assert.equal(parseOdooVersion(""), null);
  assert.equal(parseOdooVersion(undefined), null);
  assert.equal(parseOdooVersion("abc"), null);
});

// spec 0027 item 1 — the /fleet form's default spec id.
test("nextSpecId returns the next unused zero-padded NNNN", () => {
  assert.equal(nextSpecId(["0027", "0026", "0002"]), "0028");
  assert.equal(nextSpecId([]), "0001");
  assert.equal(nextSpecId(["0009"]), "0010");
  // non-numeric filename fallbacks are ignored
  assert.equal(nextSpecId(["0005", "notes.md"]), "0006");
});

// spec 0027 item 3 — server-side sandbox re-check + input validation.
// spec 0032 item 4 — no `specId` field: the form no longer carries one, the
// next free id is computed server-side by the caller (app/fleet/actions.ts).
test("validateTenantStartForm accepts a sandbox vpsId with valid fields", () => {
  const res = validateTenantStartForm(
    { tenantId: "acme", odooVersion: "18", vpsId: "100001" },
    [100001],
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.vpsId, 100001);
    assert.equal(res.value.odooVersion, 18);
    assert.equal("specId" in res.value, false);
  }
});

test("validateTenantStartForm refuses a non-sandbox (production) vpsId", () => {
  const res = validateTenantStartForm(
    { tenantId: "acme", odooVersion: "18", vpsId: "100002" },
    [100001],
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /sandbox|production|refus/i);
});

test("validateTenantStartForm refuses invalid odoo version and missing fields", () => {
  assert.equal(
    validateTenantStartForm(
      { tenantId: "acme", odooVersion: "20", vpsId: "100001" },
      [100001],
    ).ok,
    false,
  );
  assert.equal(
    validateTenantStartForm(
      { tenantId: "", odooVersion: "18", vpsId: "100001" },
      [100001],
    ).ok,
    false,
  );
});

// spec 0027 item 3 — redirect target resolves to the spec detail page.
test("tenantStartRedirectPath points at the spec detail page for the id", () => {
  assert.match(tenantStartRedirectPath("0028"), /\/forge\/specs\/.*0028/);
});

// ---------------------------------------------------------------------------
// Spec 0046 item C: the deploy form drops the free-text request field; the
// server synthesizes a deterministic vanilla request.
// ---------------------------------------------------------------------------

// Item C — validation no longer requires a request field (it succeeds when the
// form carries only tenant id + odoo version + a sandbox vps id).
test("validateTenantStartForm succeeds without a request field", () => {
  const res = validateTenantStartForm(
    { tenantId: "acme", odooVersion: "18", vpsId: "100001" },
    [100001],
  );
  assert.equal(res.ok, true);
});

// Item C — the synthesized request is deterministic for given inputs and names
// the tenant + odoo version (so draftSpec gets stable, well-formed input).
test("vanillaTenantRequest is deterministic and names the tenant + odoo version", () => {
  const a = vanillaTenantRequest("acme", 18);
  const b = vanillaTenantRequest("acme", 18);
  assert.equal(a, b, "same inputs → identical request");
  assert.notEqual(vanillaTenantRequest("acme", 18), vanillaTenantRequest("beta", 18));
  assert.match(a, /acme/);
  assert.match(a, /18/);
});
