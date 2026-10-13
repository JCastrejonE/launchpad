import test from "node:test";
import assert from "node:assert/strict";
import { stagingCertResolver, stagingDnsTarget, ACME_RESOLVER } from "./staging-dns.js";

// Spec 0189. The rule is about what Let's Encrypt will actually issue for, which
// is why it is a function and not a constant: rolling the env var back to
// sslip.io must degrade to today's behaviour, not to a failing ACME order.

test("a zone we control gets the ACME resolver", () => {
  for (const d of ["staging.example.com", "example.com", "STAGING.EXAMPLE.COM"]) {
    assert.equal(stagingCertResolver(d), ACME_RESOLVER, d);
  }
});

test("sslip.io and friends get NO resolver — one rate limit shared with the world", () => {
  for (const d of ["203.0.113.20.sslip.io", "sslip.io", "10.0.0.1.nip.io"]) {
    assert.equal(stagingCertResolver(d), undefined, d);
  }
});

test("an IP literal or a bare label gets no resolver", () => {
  for (const d of ["203.0.113.20", "localhost", ""]) {
    assert.equal(stagingCertResolver(d), undefined, d);
  }
});

test("a staging host inside our zone resolves to the record we must write", () => {
  assert.deepEqual(stagingDnsTarget("br-x.panaderia.staging.example.com", "example.com"), {
    domain: "example.com",
    name: "br-x.panaderia.staging",
  });
});

test("a host OUTSIDE our zone is null — there is no record of ours to write", () => {
  // The sslip.io form, and a customer's own domain: both are names we do not
  // serve DNS for, and writing them somewhere else would be worse than skipping.
  assert.equal(stagingDnsTarget("br-x.panaderia.203.0.113.20.sslip.io", "example.com"), null);
  assert.equal(stagingDnsTarget("staging.cliente.mx", "example.com"), null);
  assert.equal(stagingDnsTarget("example.com", "example.com"), null);
});
