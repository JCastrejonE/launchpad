/**
 * Spec 0205. The failure this guards: a customer ticks "Punto de venta (POS)"
 * and nothing installs, or worse, something installs and the thing that did NOT
 * install is never mentioned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  modulesFor,
  procesosFromIntake,
  SUPPORTED_ODOO_VERSIONS,
  DEFAULT_ODOO_VERSION,
  PROCESO_OPTIONS_SEEN_IN_WIZARD,
} from "./procesos-modules.js";

const CFDI = "Facturación electrónica (CFDI)";

test("the answers a customer can actually give all resolve to something", () => {
  // Every option the wizard offers must either install modules or refuse WITH A
  // REASON. An option that does neither is one the table forgot.
  for (const proceso of PROCESO_OPTIONS_SEEN_IN_WIZARD) {
    const plan = modulesFor([proceso], 19);
    assert.ok(
      plan.install.length > 0 || plan.refused.length > 0,
      `"${proceso}" resolves to nothing at all — the map and the wizard have drifted`,
    );
    for (const r of plan.refused) {
      assert.ok(r.why.length > 20, `refusal for "${proceso}" must say why, got: ${r.why}`);
    }
  }
});

test("POS installs point_of_sale — the case that started the spec", () => {
  const plan = modulesFor(["Punto de venta (POS)", "Ventas / CRM"], 19);
  assert.deepEqual(plan.install, ["point_of_sale", "sale_management", "crm"]);
  assert.deepEqual(plan.refused, []);
});

test("CFDI is refused by name, not silently dropped", () => {
  const plan = modulesFor(["Facturación electrónica (CFDI)"], 18);
  assert.deepEqual(plan.install, [], "nothing installable ships for CFDI on Community");
  assert.equal(plan.refused.length, 1);
  assert.match(plan.refused[0]!.why, /cdfi_invoice/, "the refusal must name the addon that would fix it");
});

test("Nómina installs hr AND says payroll is not coming", () => {
  const plan = modulesFor(["RRHH / Nómina"], 19);
  assert.deepEqual(plan.install, ["hr"]);
  assert.equal(plan.refused.length, 1, "a partial answer must still be recorded");
  assert.match(plan.refused[0]!.why, /hr_payroll/);
});

test("18 and 19 resolve identically for everything the IMAGE provides", () => {
  // Verified against both images, not assumed. CFDI is excluded because it is
  // the one proceso the image does not answer — it comes from the vendoring
  // registry (spec 0206), which has a row for 19 and none for 18.
  const fromImage = PROCESO_OPTIONS_SEEN_IN_WIZARD.filter(
    (p) => p !== "Facturación electrónica (CFDI)",
  );
  assert.deepEqual(modulesFor(fromImage, 18).install, modulesFor(fromImage, 19).install);
});

test("CFDI is the one proceso whose answer depends on the series", () => {
  // Spec 0206 turned this refusal into an install — but only where the registry
  // has a verified addon. On 18 it must still refuse, or a tenant gets a promise.
  assert.deepEqual(modulesFor([CFDI], 19).install, ["cdfi_invoice"]);
  assert.deepEqual(modulesFor([CFDI], 18).install, [], "no verified addon for 18");
  assert.match(modulesFor([CFDI], 18).refused[0]!.why, /Odoo 18/);
});

test("installing cdfi_invoice is recorded as NOT being able to stamp", () => {
  // The caveat is the whole reason this is not a silent success: the module
  // arrives, and the first attempt to issue a CFDI still fails until the PAC key
  // and the company's CSD are configured.
  const plan = modulesFor([CFDI], 19);
  assert.equal(plan.refused.length, 1, "an install that cannot yet stamp must say so");
  assert.match(plan.refused[0]!.why, /TIMBRAR/);
  assert.match(plan.refused[0]!.why, /CSD/);
});

test("an unverified version refuses everything by name, never falls back", () => {
  const plan = modulesFor(["Punto de venta (POS)"], 17);
  assert.deepEqual(plan.install, [], "17 must not inherit 18's list");
  assert.match(plan.refused[0]!.why, /Odoo 17/);
});

test("an unknown answer is refused loudly, so wizard/table drift surfaces", () => {
  const plan = modulesFor(["Manufactura"], 19);
  assert.deepEqual(plan.install, []);
  assert.match(plan.refused[0]!.why, /desconocido/);
});

test("duplicate procesos do not duplicate modules", () => {
  const plan = modulesFor(["Ventas / CRM", "Ventas / CRM"], 19);
  assert.deepEqual(plan.install, ["sale_management", "crm"]);
});

test("the default version is one we support", () => {
  assert.ok(SUPPORTED_ODOO_VERSIONS.includes(DEFAULT_ODOO_VERSION));
});

test("a multi-select intake answer becomes the procesos the customer ticked", () => {
  assert.deepEqual(
    procesosFromIntake({ procesos: "Ventas / CRM|Punto de venta (POS)", giro: "Taquería" }),
    ["Ventas / CRM", "Punto de venta (POS)"],
  );
  assert.deepEqual(procesosFromIntake({}), []);
  assert.deepEqual(procesosFromIntake(null), []);
  assert.deepEqual(procesosFromIntake({ procesos: "" }), []);
});

test("the whole chain holds: a real intake string resolves to real modules", () => {
  // The two halves are tested apart; this is the join, which is where a wrong
  // separator would leave `install` empty and every proceso "desconocido".
  const plan = modulesFor(procesosFromIntake({ procesos: "Punto de venta (POS)|Compras" }), 19);
  assert.deepEqual(plan.install, ["point_of_sale", "purchase"]);
  assert.deepEqual(plan.refused, []);
});

test("the separator this file splits on is the one the wizard joins with", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await readFile(path.resolve(here, "../../../apps/web/app/new/NewProject.tsx"), "utf8");
  assert.match(
    src,
    /value\.split\("\|"\)/,
    'the wizard no longer joins multi-select answers with "|" — procesosFromIntake splits on it',
  );
});

test("the copied option list still matches the wizard's own source", async () => {
  // The map keys on exact strings, so a wording change in the wizard silently
  // stops mapping. This package cannot import apps/web, so read it — the same
  // "check the shipped artefact" move front-scaffold.test.ts makes.
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = await readFile(
    path.resolve(here, "../../../apps/web/lib/mock-data.ts"),
    "utf8",
  );
  const line = src.split("\n").find((l) => l.includes('id: "procesos"'));
  assert.ok(line, "could not find the procesos question in apps/web/lib/mock-data.ts");
  // Scope to the options array before pulling strings. Matching quotes across the
  // whole line mis-pairs them, because `placeholder: ""` is empty and a `[^"]+`
  // match skips it — which shifts every quote after it by one.
  const arr = /options:\s*\[([^\]]*)\]/.exec(line);
  assert.ok(arr, "the procesos question has no options array");
  const options = [...arr[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!).filter((s) => s !== "");
  assert.deepEqual(
    options,
    [...PROCESO_OPTIONS_SEEN_IN_WIZARD],
    "the wizard's procesos options and PROCESO_OPTIONS_SEEN_IN_WIZARD have drifted",
  );
});
