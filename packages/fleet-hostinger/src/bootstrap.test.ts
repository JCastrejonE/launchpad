import { test } from "node:test";
import assert from "node:assert/strict";
import {
  provisionClientVps,
  ensureSshKeyAccess,
  verifySshConnectivity,
  installDocker,
  hardenHost,
  readBootstrapMarker,
  BOOTSTRAP_VERSION,
  BOOTSTRAP_MARKER_PATH,
} from "./bootstrap.js";
import { createFakeSshRunner } from "./ssh.js";
import { FleetError } from "./errors.js";
import { HostingerClient, type FetchFn, type VpsAction, type VpsPublicKey } from "./client.js";
import { loadFixture } from "./fixtures.js";

/**
 * Like contract.test.ts's `sequencedFetch`: queues a distinct response per
 * call and records every call — `attachSshKey` makes two sequential requests
 * (register the key, then attach it) that `ensureSshKeyAccess` triggers below.
 */
function sequencedFetch(
  responses: Array<{ status: number; body: unknown }>,
): { fetch: FetchFn; calls: () => Array<{ method: string; url: string; body?: string }> } {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetch: FetchFn = async (url, init) => {
    const index = calls.length;
    calls.push({ method: init.method, url, body: init.body });
    const next = responses[Math.min(index, responses.length - 1)];
    if (!next) throw new Error("sequencedFetch: no response queued for this call");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls: () => calls };
}

/** A client whose `attachSshKey` must never be called (SSH access already works). */
function unreachableClient(): HostingerClient {
  return new HostingerClient({
    apiToken: "t",
    fetch: async () => {
      throw new Error("HostingerClient should not have been called");
    },
  });
}

// Spec 0012 — VPS bootstrap. Each step is exercised with the fake SSH runner
// (zero live SSH). These `todo`s become real assertions across plan steps 3
// (individual steps) and 4 (orchestrator + idempotency).

test("bootstrap constants are stable inputs the marker path/version key off", () => {
  assert.equal(typeof BOOTSTRAP_VERSION, "number");
  assert.ok(BOOTSTRAP_MARKER_PATH.startsWith("/"));
});

test("provisionClientVps is exposed for the fleet/activity layer", () => {
  assert.equal(typeof provisionClientVps, "function");
  // sanity: the fake runner is available for the real tests below
  const ssh = createFakeSshRunner();
  assert.ok(ssh);
});

// Plan step 3 — individual steps, each idempotent, each through the SSH seam:
test("ensureSshKeyAccess is idempotent (no-op when the key is already authorized)", async () => {
  const key = "ssh-ed25519 AAAAtest launchpad@fleet";
  const client = unreachableClient(); // access already works — the API must never be touched.

  // Already authorized: the grep check succeeds, so nothing else should run.
  const alreadyThere = createFakeSshRunner({
    respond: (command) => (command.startsWith("grep") ? { code: 0, stdout: "", stderr: "" } : undefined),
  });
  await ensureSshKeyAccess(alreadyThere, client, 42, key);
  assert.equal(alreadyThere.commands.length, 1);
  assert.match(alreadyThere.commands[0]!, /grep -qxF/);

  // Not yet authorized, but SSH connects fine (grep exits 1, a real remote
  // miss — not 255): the additional-key path appends it over SSH.
  const notThereYet = createFakeSshRunner({
    respond: (command) => (command.startsWith("grep") ? { code: 1, stdout: "", stderr: "" } : undefined),
  });
  await ensureSshKeyAccess(notThereYet, client, 42, key);
  assert.equal(notThereYet.commands.length, 2);
  assert.match(notThereYet.commands[1]!, />> ~\/\.ssh\/authorized_keys/);

  // No key supplied: nothing to automate, no commands run at all.
  const noKey = createFakeSshRunner();
  await ensureSshKeyAccess(noKey, client, 42);
  assert.equal(noKey.commands.length, 0);
});

test("verifySshConnectivity runs a trivial command and fails as retryable on non-zero", async () => {
  const ok = createFakeSshRunner();
  await verifySshConnectivity(ok); // does not throw
  assert.deepEqual(ok.commands, ["true"]);

  const broken = createFakeSshRunner({
    respond: () => ({ code: 255, stdout: "", stderr: "Connection refused" }),
  });
  await assert.rejects(() => verifySshConnectivity(broken), (err: unknown) => {
    assert.ok(err instanceof FleetError);
    assert.equal(err.kind, "ssh");
    assert.equal(err.retryable, true);
    return true;
  });
});

test("installDocker installs when absent and no-ops (returns false) when present", async () => {
  const present = createFakeSshRunner({
    respond: (command) => (command.startsWith("docker") ? { code: 0, stdout: "", stderr: "" } : undefined),
  });
  const noopResult = await installDocker(present);
  assert.equal(noopResult, false);
  assert.equal(present.commands.length, 1);

  const absent = createFakeSshRunner({
    respond: (command) => (command.startsWith("docker") ? { code: 1, stdout: "", stderr: "" } : undefined),
  });
  const installedResult = await installDocker(absent);
  assert.equal(installedResult, true);
  assert.equal(absent.commands.length, 2);
  assert.match(absent.commands[1]!, /get\.docker\.com/);

  const failing = createFakeSshRunner({
    respond: (command) =>
      command.startsWith("docker")
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: "no network" },
  });
  await assert.rejects(() => installDocker(failing), (err: unknown) => {
    assert.ok(err instanceof FleetError);
    assert.equal(err.kind, "docker");
    assert.equal(err.retryable, true);
    return true;
  });
});

test("hardenHost applies ufw allow 22/80/443 idempotently", async () => {
  const ssh = createFakeSshRunner();
  await hardenHost(ssh); // does not throw
  assert.equal(ssh.commands.length, 1);
  assert.match(ssh.commands[0]!, /ufw allow 22\/tcp/);
  assert.match(ssh.commands[0]!, /ufw allow 80\/tcp/);
  assert.match(ssh.commands[0]!, /ufw allow 443\/tcp/);

  // Re-running is safe — ufw allow rules are themselves idempotent.
  await hardenHost(ssh);
  assert.equal(ssh.commands.length, 2);

  const failing = createFakeSshRunner({ respond: () => ({ code: 1, stdout: "", stderr: "ufw: command not found" }) });
  await assert.rejects(() => hardenHost(failing), (err: unknown) => {
    assert.ok(err instanceof FleetError);
    assert.equal(err.kind, "ssh");
    assert.equal(err.retryable, true);
    return true;
  });
});

test("readBootstrapMarker returns null when unbootstrapped, the version when present", async () => {
  const unbootstrapped = createFakeSshRunner({
    respond: () => ({ code: 1, stdout: "", stderr: "No such file or directory" }),
  });
  assert.equal(await readBootstrapMarker(unbootstrapped), null);

  const bootstrapped = createFakeSshRunner({
    respond: (command) =>
      command.startsWith("cat")
        ? { code: 0, stdout: JSON.stringify({ version: BOOTSTRAP_VERSION, bootstrappedAt: "2026-07-03T00:00:00.000Z" }), stderr: "" }
        : undefined,
  });
  assert.equal(await readBootstrapMarker(bootstrapped), BOOTSTRAP_VERSION);
  assert.match(bootstrapped.commands[0]!, new RegExp(BOOTSTRAP_MARKER_PATH.replace(/\//g, "\\/")));

  const malformed = createFakeSshRunner({
    respond: () => ({ code: 0, stdout: "not json", stderr: "" }),
  });
  assert.equal(await readBootstrapMarker(malformed), null);
});

// Spec 0013 plan step 3 — ensureSshKeyAccess bootstraps from zero via the API
// (attaches the key so SSH access exists) then keeps ssh-append as the
// additional-key path; doc comment and implementation must agree exactly.
test("ensureSshKeyAccess attaches the key via the Hostinger API when SSH access is not yet arranged", async () => {
  const key = "ssh-ed25519 AAAAtest launchpad@fleet";
  // SSH can't connect at all yet: the grep attempt exits 255 (OpenSSH's own
  // "couldn't establish a connection" code) — no ssh-append should follow.
  const ssh = createFakeSshRunner({
    respond: (command) =>
      command.startsWith("grep") ? { code: 255, stdout: "", stderr: "Connection refused" } : undefined,
  });
  const registered = await loadFixture<VpsPublicKey>("create-public-key");
  const attached = await loadFixture<VpsAction>("attach-ssh-key");
  const { fetch, calls } = sequencedFetch([
    { status: 200, body: registered },
    { status: 200, body: attached },
  ]);
  const client = new HostingerClient({ apiToken: "t", fetch });

  // attachSshKey is a destructive client helper gated by the fleet sandbox
  // allowlist (spec 0014 / ADR-013) — 100001 is the real allowlisted sandbox
  // id (infra/fleet-sandbox.json), so this exercises the attach flow without
  // tripping the refusal (covered separately in sandbox.test.ts).
  await ensureSshKeyAccess(ssh, client, 100001, key);

  // Exactly the connectivity probe over SSH — no ssh-append attempt.
  assert.deepEqual(ssh.commands, [`grep -qxF '${key}' ~/.ssh/authorized_keys 2>/dev/null`]);
  // The API attach ran: register the key, then attach it to vpsId 100001.
  const [createCall, attachCall] = calls();
  assert.ok(createCall?.url.endsWith("/public-keys"));
  assert.deepEqual(createCall?.body ? JSON.parse(createCall.body) : undefined, {
    name: "launchpad-100001",
    key,
  });
  assert.ok(attachCall?.url.endsWith("/public-keys/attach/100001"));
  assert.deepEqual(attachCall?.body ? JSON.parse(attachCall.body) : undefined, {
    ids: [registered.id],
  });
});

test("ensureSshKeyAccess still ssh-appends an additional key once access exists (idempotent)", async () => {
  const key = "ssh-ed25519 AAAAtest launchpad@fleet";
  const client = unreachableClient(); // access already works — the API must never be touched.

  // SSH connects fine (grep exits 1, a real remote miss, not 255): append.
  const ssh = createFakeSshRunner({
    respond: (command) => (command.startsWith("grep") ? { code: 1, stdout: "", stderr: "" } : undefined),
  });
  await ensureSshKeyAccess(ssh, client, 1001, key);
  assert.equal(ssh.commands.length, 2);
  assert.match(ssh.commands[1]!, />> ~\/\.ssh\/authorized_keys/);

  // Re-running once the key is present is a pure no-op — idempotent.
  const already = createFakeSshRunner({
    respond: (command) => (command.startsWith("grep") ? { code: 0, stdout: "", stderr: "" } : undefined),
  });
  await ensureSshKeyAccess(already, client, 1001, key);
  assert.equal(already.commands.length, 1);
});

// Plan step 4 — orchestrator + idempotency:
test("provisionClientVps runs every step then writes the version marker", async () => {
  const ssh = createFakeSshRunner();
  const client = unreachableClient(); // no publicKey passed — the API must never be touched.
  // 100001 is the real sandbox-allowlisted id (infra/fleet-sandbox.json) —
  // provisionClientVps refuses any other id (spec 0014 plan step 2, covered
  // separately in sandbox.test.ts).
  const result = await provisionClientVps({ tenantId: "acme", vpsId: 100001, ssh, client });

  assert.equal(result.tenantId, "acme");
  assert.equal(result.vpsId, 100001);
  assert.equal(result.version, BOOTSTRAP_VERSION);
  assert.equal(result.alreadyBootstrapped, false);
  assert.deepEqual(result.stepsRun, [
    "ensureSshKeyAccess",
    "verifySshConnectivity",
    "installDocker",
    "hardenHost",
    "writeBootstrapMarker",
  ]);

  // The marker was actually written with the current version.
  const marker = ssh.files.get(BOOTSTRAP_MARKER_PATH);
  assert.ok(marker);
  assert.equal((JSON.parse(marker!) as { version: number }).version, BOOTSTRAP_VERSION);
});

test("a second provisionClientVps run is a no-op (alreadyBootstrapped, stepsRun empty)", async () => {
  const ssh = createFakeSshRunner({
    respond: (command) =>
      command.startsWith("cat")
        ? {
            code: 0,
            stdout: JSON.stringify({ version: BOOTSTRAP_VERSION, bootstrappedAt: "2026-07-03T00:00:00.000Z" }),
            stderr: "",
          }
        : undefined,
  });

  const client = unreachableClient(); // marker already present — the API must never be touched.
  const result = await provisionClientVps({ tenantId: "acme", vpsId: 100001, ssh, client });

  assert.equal(result.alreadyBootstrapped, true);
  assert.deepEqual(result.stepsRun, []);
  // Only the marker-read ran — no bootstrap step commands, no re-write.
  assert.deepEqual(ssh.commands, [`cat ${BOOTSTRAP_MARKER_PATH} 2>/dev/null`]);
  assert.equal(ssh.files.size, 0);
});
