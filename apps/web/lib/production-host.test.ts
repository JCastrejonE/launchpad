import assert from "node:assert/strict";
import test from "node:test";

import { productionHostFor } from "./production-host.js";

const fleet = { productionKind: "fleet", productionHost: null, slug: "taqueria-sol-conectada" };

test("derive: a project we are creating gets the host provisioning will make", () => {
  assert.equal(productionHostFor("derive", fleet), "taqueria-sol-conectada.odoo.example.com");
});

test("none: a CONNECTED fleet tenant records no host rather than an invented one", () => {
  // The live defect: taqueria-sol lives at taqueria-sol.odoo.example.com, and
  // connecting it recorded taqueria-sol-conectada.odoo.example.com.
  assert.equal(productionHostFor("none", fleet), null);
});

test("an explicitly supplied host wins under either policy (the odoo.sh case)", () => {
  const odoosh = { productionKind: "odoosh", productionHost: "client-d.odoo.com", slug: "client-d" };
  assert.equal(productionHostFor("derive", odoosh), "client-d.odoo.com");
  assert.equal(productionHostFor("none", odoosh), "client-d.odoo.com");
});

test("a non-fleet kind is never derived, even under derive", () => {
  assert.equal(productionHostFor("derive", { productionKind: "none", productionHost: null, slug: "x" }), null);
  assert.equal(productionHostFor("derive", { productionKind: null, productionHost: null, slug: "x" }), null);
});
