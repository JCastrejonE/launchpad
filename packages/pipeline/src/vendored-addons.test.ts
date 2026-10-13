/**
 * Spec 0206. The failure these guard: an addon vendored under the wrong name
 * (installs, does nothing), or vendored into a series its manifest does not
 * target (installs, breaks the backend).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { vendoredAddonsFor, cfdiVendoredFor, CFDI_MODULE } from "./vendored-addons.js";
import { SUPPORTED_ODOO_VERSIONS } from "./procesos-modules.js";

test("a tenant on 19 gets the house style, and CFDI only when it was asked for", () => {
  const plain = vendoredAddonsFor(19, { cfdi: false }).map((a) => a.module);
  assert.deepEqual(plain, ["web_responsive", "app_menu_enterprise"]);

  const withCfdi = vendoredAddonsFor(19, { cfdi: true }).map((a) => a.module);
  assert.deepEqual(withCfdi, ["web_responsive", "app_menu_enterprise", CFDI_MODULE]);
});

test("a series no row targets gets NOTHING, never another series' rows", () => {
  // Every manifest in the registry reads 19.0.x. The nine tenants on 18 get
  // nothing — which is the truth, and the alternative is a 19 addon in an 18
  // backend.
  assert.deepEqual(vendoredAddonsFor(18, { cfdi: true }), []);
  assert.deepEqual(vendoredAddonsFor(17, { cfdi: true }), []);
  assert.equal(cfdiVendoredFor(18), false);
  assert.equal(cfdiVendoredFor(19), true);
});

test("every row targets a series we actually provision", () => {
  // A row for a series the wizard cannot offer is a row nobody can ever use.
  for (const v of SUPPORTED_ODOO_VERSIONS) void v;
  for (const addon of vendoredAddonsFor(19, { cfdi: true })) {
    assert.ok(
      SUPPORTED_ODOO_VERSIONS.includes(addon.series),
      `${addon.module} targets Odoo ${addon.series}, which /new cannot offer`,
    );
  }
});

test("a pin is a commit, not a branch", () => {
  // A branch pin means two tenants provisioned months apart get different code
  // from the same row and nothing records which.
  for (const addon of vendoredAddonsFor(19, { cfdi: true })) {
    assert.match(addon.commit, /^[0-9a-f]{40}$/, `${addon.module} is not pinned to a commit`);
  }
});

test("the module name is a bare directory name, never a path", () => {
  // It becomes `/mnt/extra-addons/<module>`; a slash here would place the addon
  // somewhere Odoo does not look.
  for (const addon of vendoredAddonsFor(19, { cfdi: true })) {
    assert.match(addon.module, /^[a-z][a-z0-9_]*$/, `${addon.module} is not a module name`);
  }
});

test("the registry knows the module name is not the repo name", () => {
  // The `app_menu_enterprise` trap, asserted rather than commented: its repo is
  // `odoo19enterprisemenu` and its assets hardcode the module name, so vendoring
  // it as its repo name yields an addon that installs and does nothing.
  const menu = vendoredAddonsFor(19, { cfdi: false }).find(
    (a) => a.module === "app_menu_enterprise",
  );
  assert.ok(menu, "app_menu_enterprise is missing from the registry");
  assert.notEqual(menu.module, menu.repo, "this row exists to prove they can differ");
  assert.equal(menu.subpath, "", "its manifest is at the repo root, not in a subfolder");
});

test("every row records a licence — one of them is not free", () => {
  const cfdi = vendoredAddonsFor(19, { cfdi: true }).find((a) => a.module === CFDI_MODULE);
  assert.equal(cfdi?.licence, "OPL-1", "cdfi_invoice is proprietary and the row must say so");
  for (const addon of vendoredAddonsFor(19, { cfdi: true })) {
    assert.ok(addon.licence.length > 0, `${addon.module} has no licence recorded`);
  }
});
