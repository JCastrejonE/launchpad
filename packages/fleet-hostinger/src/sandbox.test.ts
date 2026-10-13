import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSandboxAllowlist, isSandboxVps, assertSandboxVps } from "./sandbox.js";
import { provisionClientVps } from "./bootstrap.js";
import { deployProductionStack } from "./stack.js";
import { createFakeSshRunner } from "./ssh.js";
import { HostingerClient, type FetchFn } from "./client.js";
import { FleetError } from "./errors.js";

// Spec 0014 plan step 2 — fleet-layer sandbox allowlist enforcement (ADR-013).
// The real `infra/fleet-sandbox.json` allowlists 100001 (sandbox) and NOT
// 999999 (unlisted). These tests exercise the REAL allowlist file (no path
// override) since its two known ids are exactly what the spec asks to prove.

// The refused example is a SYNTHETIC id (999999) that is not, and will never be, in
// infra/fleet-sandbox.json. Spec 0125 is why: it briefly allowlisted a real id, which would
// have made this guard's own tests pass while proving nothing. Keying them to an id nobody
// can allowlist means an edit to that file can never quietly turn these green.

const SANDBOX_VPS_ID = 100001; // allowlisted in infra/fleet-sandbox.json
const UNLISTED_VPS_ID = 999999; // not on the allowlist — must always be refused

test("sandbox module exposes its allowlist + assertion surface", () => {
  assert.equal(typeof loadSandboxAllowlist, "function");
  assert.equal(typeof isSandboxVps, "function");
  assert.equal(typeof assertSandboxVps, "function");
});

test("loadSandboxAllowlist reads sandboxVpsIds from infra/fleet-sandbox.json", () => {
  const ids = loadSandboxAllowlist();
  assert.ok(Array.isArray(ids));
  assert.ok(ids.every((id) => typeof id === "number"));
  assert.ok(ids.includes(SANDBOX_VPS_ID));
  assert.ok(!ids.includes(UNLISTED_VPS_ID));
});

test("isSandboxVps: 100001 allowed, 999999 refused (unlisted-host guard)", () => {
  assert.equal(isSandboxVps(SANDBOX_VPS_ID), true);
  assert.equal(isSandboxVps(UNLISTED_VPS_ID), false);
});

test("assertSandboxVps throws a non-retryable FleetError{kind:'sandbox'} for 999999", () => {
  assert.throws(() => assertSandboxVps(UNLISTED_VPS_ID, "wipe"), (err: unknown) => {
    assert.ok(err instanceof FleetError);
    assert.equal(err.kind, "sandbox");
    assert.equal(err.retryable, false);
    assert.match(err.message, /999999/);
    assert.match(err.message, /wipe/);
    return true;
  });
});

test("assertSandboxVps is a no-op for 100001", () => {
  assert.doesNotThrow(() => assertSandboxVps(SANDBOX_VPS_ID, "wipe"));
});

/** A client whose fetch must never be called — proves refusal happens before any side effect. */
function unreachableClient(): HostingerClient {
  const fetch: FetchFn = async () => {
    throw new Error("HostingerClient should not have been called");
  };
  return new HostingerClient({ apiToken: "t", fetch });
}

test("provisionClientVps refuses a non-allowlisted VPS before any SSH side effect", async () => {
  const ssh = createFakeSshRunner();
  const client = unreachableClient();
  await assert.rejects(
    () => provisionClientVps({ tenantId: "acme", vpsId: UNLISTED_VPS_ID, ssh, client }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "sandbox");
      assert.equal(err.retryable, false);
      assert.match(err.message, /999999/);
      return true;
    },
  );
  assert.equal(ssh.commands.length, 0, "no SSH command should run before the refusal");
});

test("deployProductionStack refuses a non-allowlisted VPS before any SSH side effect", async () => {
  const ssh = createFakeSshRunner();
  await assert.rejects(
    () =>
      deployProductionStack({
        tenantId: "acme",
        vpsId: UNLISTED_VPS_ID,
        ssh,
        odooVersion: 18,
        domain: "example.com",
        dbPassword: "s3cr3t-pass",
        masterPassword: "master-not-a-real-secret",
        odooReadonlyUser: "front_readonly",
        odooReadonlyPassword: "ro-pass-not-a-real-secret",
        adminPassword: "admin-not-a-real-secret",
      }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "sandbox");
      assert.equal(err.retryable, false);
      assert.match(err.message, /999999/);
      return true;
    },
  );
  assert.equal(ssh.commands.length, 0, "no SSH command should run before the refusal");
  assert.equal(ssh.files.size, 0, "no compose file should be written before the refusal");
});

test("destructive client helpers refuse a non-allowlisted VPS at the lowest layer", async () => {
  let fetchCalls = 0;
  const fetch: FetchFn = async () => {
    fetchCalls++;
    throw new Error("fetch should not have been called");
  };
  const client = new HostingerClient({ apiToken: "t", fetch });

  await assert.rejects(() => client.restartVps(UNLISTED_VPS_ID), (err: unknown) => {
    assert.ok(err instanceof FleetError);
    assert.equal(err.kind, "sandbox");
    return true;
  });
  await assert.rejects(() => client.createSnapshot(UNLISTED_VPS_ID), (err: unknown) => {
    assert.ok(err instanceof FleetError);
    assert.equal(err.kind, "sandbox");
    return true;
  });
  await assert.rejects(
    () => client.attachSshKey(UNLISTED_VPS_ID, { name: "x", key: "ssh-ed25519 AAAA" }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "sandbox");
      return true;
    },
  );
  assert.equal(fetchCalls, 0, "no HTTP request should be made before the refusal");
});
