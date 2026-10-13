#!/usr/bin/env node
/**
 * Live bootstrap + deploy smoke for the VPS lifecycle (spec 0012, extended by
 * 0014). MUTATING and human-gated: it bootstraps a VPS (docker install, ufw
 * rules) and deploys a tenant Odoo stack that SERVES its own database (no
 * selector — spec 0014). It runs ONLY with `FLEET_LIVE=1` AND an explicit
 * `--vps-id`. NEVER wired into any test or CI path.
 *
 * Sandbox enforcement (ADR-013, spec 0014): this script no longer gates the
 * VPS id itself — `provisionClientVps`/`deployProductionStack` refuse any
 * `vpsId` not listed in `infra/fleet-sandbox.json` at the fleet layer
 * (`assertSandboxVps`), so passing a non-allowlisted id fails fast with a
 * `FleetError{kind:"sandbox"}` before any SSH/API call, regardless of what
 * this script does or doesn't check.
 *
 * Usage:
 *   FLEET_LIVE=1 HOSTINGER_API_TOKEN=… node scripts/fleet-bootstrap-smoke.mjs \
 *     --vps-id 12345 --identity-file ~/.ssh/fleet_key \
 *     [--tenant sandbox] [--domain sandbox.launchpad.test] [--odoo-version 18] \
 *     [--ssh-user root] [--ssh-port 22] [--public-key-file ~/.ssh/fleet_key.pub]
 *
 * What it does:
 *  1. Resolves the Hostinger token via `resolveHostingerToken(tenant)` (same
 *     dev-env resolution the fleet uses — never a raw token flag).
 *  2. Looks up the VPS's IPv4 via `HostingerClient.getVps` (read-only) to build
 *     the SSH target — this script never orders/purchases a VPS.
 *  3. Runs `provisionClientVps` then `deployProductionStack` against the real
 *     VPS over a real `ExecSshRunner`, printing a token/secret-free summary.
 *     The first deploy initializes the tenant database (`-i base
 *     --stop-after-init`) and the stack then serves it directly — `/web/login`
 *     should answer 200 with no redirect, never the multi-db selector.
 *  4. Re-runs both to prove idempotency: bootstrap should report
 *     `alreadyBootstrapped: true` with no steps run, and the redeploy should
 *     report the same healthy/odooHttpOk result with NO re-init of the tenant
 *     DB. The dbPassword is read-or-created via the tenant secret store (see
 *     below) so it is the SAME value on both runs — a fresh password on
 *     redeploy would desync a Postgres volume that already initialized with
 *     the first one, which is not what "idempotent" means here.
 *
 * Tenant secret store (spec 0014, re-based by spec 0076): `dbPassword` is
 * resolved via `readOrCreateDbPassword(tenantId)`, backed by the ENCRYPTED
 * control-plane secret store (AES-256-GCM `secrets` table) — this process
 * therefore needs `DATABASE_URL` and `LAUNCHPAD_SECRET_MASTER_KEY` in its
 * env (preflight's `.env` sourcing provides both). The pre-0076 JSON file
 * (`~/.launchpad/tenant-secrets.json`, overridable via
 * `LAUNCHPAD_TENANT_SECRETS_PATH`) is a READ-ONLY legacy fallback: a hit is
 * imported into the store once and the file is never written again.
 * Redeploys reuse the SAME password across process restarts, retiring the
 * `docker compose down -v` workaround 0013 needed to clear a stale Postgres
 * password. The password is never logged and never committed.
 *
 * SSH key access (spec 0013 finding b): `--public-key-file`, if passed, is
 * handled entirely by `ensureSshKeyAccess` — from a cold VPS with no prior SSH
 * access at all, it registers + attaches the key via the Hostinger API
 * (`HostingerClient.attachSshKey`); once SSH access exists, it appends the key
 * directly. Both paths work against a running VM, so there is NO residual
 * manual key step to perform before or after running this script.
 *
 * Evidence to capture in the Handoff log: the steps run, the idempotent second
 * run reported as a no-op (including no DB re-init), and Odoo answering HTTP
 * 200 with no redirect (not the database selector) via SSH.
 */

function fail(message) {
  console.error(`refusing: ${message}`);
  process.exit(1);
}

if (process.env.FLEET_LIVE !== "1") {
  fail("set FLEET_LIVE=1 to run the live (mutating) bootstrap+deploy smoke");
}

function flag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const vpsIdRaw = flag("--vps-id");
if (!vpsIdRaw || vpsIdRaw.trim() === "") {
  fail("pass the designated sandbox VPS explicitly, e.g. --vps-id 12345");
}
const vpsId = Number(vpsIdRaw);
if (!Number.isInteger(vpsId)) {
  fail(`--vps-id must be an integer, got ${vpsIdRaw}`);
}

const identityFile = flag("--identity-file");
if (!identityFile || identityFile.trim() === "") {
  fail("pass the SSH private key for the sandbox VPS, e.g. --identity-file ~/.ssh/fleet_key");
}

const tenantId = flag("--tenant") ?? "sandbox";
const domain = flag("--domain") ?? "sandbox.launchpad.test";
const odooVersion = Number(flag("--odoo-version") ?? "18");
if (![17, 18, 19].includes(odooVersion)) {
  fail(`--odoo-version must be 17, 18, or 19, got ${odooVersion}`);
}
const sshUser = flag("--ssh-user") ?? "root";
const sshPortRaw = flag("--ssh-port");
const sshPort = sshPortRaw !== undefined ? Number(sshPortRaw) : undefined;
const publicKeyFile = flag("--public-key-file");

const { resolveHostingerToken } = await import("../packages/fleet-hostinger/dist/token.js");
const { HostingerClient } = await import("../packages/fleet-hostinger/dist/client.js");
const { ExecSshRunner } = await import("../packages/fleet-hostinger/dist/ssh.js");
const { provisionClientVps } = await import("../packages/fleet-hostinger/dist/bootstrap.js");
const { deployProductionStack } = await import("../packages/fleet-hostinger/dist/stack.js");
const { readOrCreateDbPassword } = await import(
  "../packages/fleet-hostinger/dist/tenant-secrets.js"
);

let token;
try {
  token = resolveHostingerToken(tenantId);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

// READ-ONLY: only getVps below, to resolve the SSH target's IP. This script
// never calls createVps/restartVps/createSnapshot — bootstrapping an existing,
// human-supplied VPS is the whole point (0012 non-goal: ordering/purchasing).
const client = new HostingerClient({ apiToken: token });
const vps = await client.getVps(vpsId);
const ipv4 = vps.ipv4?.[0]?.address;
if (!ipv4) {
  fail(`VPS ${vpsId} has no IPv4 address to SSH to`);
}

let publicKey;
if (publicKeyFile) {
  const { readFile } = await import("node:fs/promises");
  publicKey = (await readFile(publicKeyFile, "utf8")).trim();
}

const ssh = new ExecSshRunner({ host: ipv4, user: sshUser, identityFile, port: sshPort });

// Read-or-created via the tenant secret store, reused across both deploy calls
// below — see the file header comment on why redeploying with a fresh
// password isn't a true no-op.
const dbPassword = await readOrCreateDbPassword(tenantId);

function summarizeBootstrap(result) {
  return { alreadyBootstrapped: result.alreadyBootstrapped, stepsRun: result.stepsRun, version: result.version };
}
function summarizeDeploy(result) {
  return {
    stack: result.stack,
    odooVersion: result.odooVersion,
    healthy: result.healthy,
    odooHttpOk: result.odooHttpOk,
  };
}

console.log(`bootstrapping VPS ${vpsId} (${ipv4}) for tenant "${tenantId}"...`);
const bootstrap1 = await provisionClientVps({ tenantId, vpsId, ssh, client, publicKey });
console.log("bootstrap (run 1):", JSON.stringify(summarizeBootstrap(bootstrap1)));

console.log(`deploying production stack (odoo ${odooVersion}, domain ${domain})...`);
const deploy1 = await deployProductionStack({ tenantId, vpsId, ssh, odooVersion, domain, dbPassword });
console.log("deploy (run 1):", JSON.stringify(summarizeDeploy(deploy1)));

console.log("re-running bootstrap + deploy to prove idempotency (expect a no-op)...");
const bootstrap2 = await provisionClientVps({ tenantId, vpsId, ssh, client, publicKey });
console.log("bootstrap (run 2):", JSON.stringify(summarizeBootstrap(bootstrap2)));

const deploy2 = await deployProductionStack({ tenantId, vpsId, ssh, odooVersion, domain, dbPassword });
console.log("deploy (run 2):", JSON.stringify(summarizeDeploy(deploy2)));

let ok = true;
if (!bootstrap2.alreadyBootstrapped || bootstrap2.stepsRun.length !== 0) {
  console.error("NOT IDEMPOTENT: second bootstrap run did more than short-circuit to a no-op");
  ok = false;
}
if (!deploy2.healthy || !deploy2.odooHttpOk) {
  console.error("NOT HEALTHY: second deploy run did not report healthy/odooHttpOk");
  ok = false;
}

if (ok) {
  console.log("OK: bootstrap + deploy succeeded and the second run was an idempotent no-op.");
} else {
  process.exitCode = 1;
}
// Nothing above prints the token, the tenant DB password, or SSH key material.
