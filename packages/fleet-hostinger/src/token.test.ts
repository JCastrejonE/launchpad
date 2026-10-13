import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveHostingerToken,
  tenantTokenEnvVar,
  TENANT_TOKEN_ENV_PREFIX,
} from "./token.js";

// Spec 0012 — per-tenant token resolution. These assert the naming convention
// today; the `todo`s become real assertions when `resolveHostingerToken` lands
// (plan step 1). Never put a real token in a fixture or assertion here.

test("tenantTokenEnvVar upper-cases + normalizes the tenant id", () => {
  assert.equal(tenantTokenEnvVar("acme"), "HOSTINGER_API_TOKEN__ACME");
  assert.equal(tenantTokenEnvVar("big-co"), "HOSTINGER_API_TOKEN__BIG_CO");
  assert.ok(tenantTokenEnvVar("x").startsWith(TENANT_TOKEN_ENV_PREFIX));
});

test("prefers the per-tenant override HOSTINGER_API_TOKEN__<TENANT> when set", () => {
  const token = resolveHostingerToken("acme", {
    HOSTINGER_API_TOKEN__ACME: "tenant-token",
    HOSTINGER_API_TOKEN: "shared-token",
  });
  assert.equal(token, "tenant-token");
});

test("falls back to the shared HOSTINGER_API_TOKEN when no override is set", () => {
  const token = resolveHostingerToken("acme", {
    HOSTINGER_API_TOKEN: "shared-token",
  });
  assert.equal(token, "shared-token");
});

test("throws (naming only env vars, never a token value) when neither is set", () => {
  assert.throws(
    () => resolveHostingerToken("acme", { HOSTINGER_API_TOKEN__ACME: "", HOSTINGER_API_TOKEN: "" }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /HOSTINGER_API_TOKEN__ACME/);
      assert.match(err.message, /HOSTINGER_API_TOKEN/);
      assert.doesNotMatch(err.message, /shared-token|tenant-token/);
      return true;
    },
  );
});
