/**
 * VPS bootstrap (spec 0012): given an EXISTING, human-supplied VPS, make it
 * ready to host tenant stacks. This is `provisionClientVps` with its renamed
 * semantics — it bootstraps an existing machine, it does NOT order/purchase one
 * (that's a non-goal; `HostingerClient.createVps` is the purchase flow and is
 * out of scope for this spec).
 *
 * Every step runs through the injectable {@link SshRunner} seam, is idempotent
 * (safe to re-run), and is individually unit-tested with a fake — NO live SSH in
 * CI. The orchestrator writes a marker file recording the bootstrap version so a
 * second run short-circuits to a no-op.
 */
import { posix as posixPath } from "node:path";
import { FleetError } from "./errors.js";
import { assertSandboxVps } from "./sandbox.js";
import type { SshRunner } from "./ssh.js";
import type { HostingerClient } from "./client.js";

/** Single-quotes `value` for safe embedding in a remote shell command. */
function quoteForRemoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Bumped when a bootstrap step changes in a way that must re-run on hosts. */
export const BOOTSTRAP_VERSION = 1;

/** Marker file written on a fully-bootstrapped host (records the version). */
export const BOOTSTRAP_MARKER_PATH = "/etc/launchpad/bootstrap.json";

export interface BootstrapOptions {
  tenantId: string;
  /** The designated, human-supplied VPS id (this spec never orders a VPS). */
  vpsId: number;
  ssh: SshRunner;
  /** Used by `ensureSshKeyAccess` to attach `publicKey` when SSH can't connect yet. */
  client: HostingerClient;
  /**
   * SSH public key to ensure has access. Fully automated via
   * {@link HostingerClient.attachSshKey} when SSH can't connect yet, or a
   * direct `authorized_keys` append once it can — see {@link ensureSshKeyAccess}.
   * No residual manual step: both Hostinger API calls work against a running VM.
   */
  publicKey?: string;
}

export interface BootstrapResult {
  tenantId: string;
  vpsId: number;
  version: number;
  /** True when the marker already recorded this version — nothing to do. */
  alreadyBootstrapped: boolean;
  /** Names of the steps that actually ran this invocation (empty on a no-op). */
  stepsRun: string[];
}

/**
 * Ensures `publicKey` can SSH into the host. Idempotent, and safe to call
 * before ANY SSH access exists (0012's chicken-and-egg finding: the previous
 * ssh-append-only body needed the very access it existed to create):
 *
 *  - No `publicKey`: nothing to automate — access must already be arranged
 *    out-of-band; `verifySshConnectivity` is what actually proves it works.
 *  - `publicKey` given and already authorized (the `grep` check against
 *    `authorized_keys` exits 0): no-op.
 *  - `publicKey` given and SSH can't connect AT ALL (the `grep` attempt
 *    exits 255 — OpenSSH's own "couldn't establish a connection" code, never
 *    a code the remote `grep` itself would produce): access isn't arranged
 *    yet, so this attaches the key via {@link HostingerClient.attachSshKey}
 *    instead, which needs no existing SSH access.
 *  - `publicKey` given and SSH connects fine but the key isn't in
 *    `authorized_keys` yet (a real `grep` miss, exit 1): the additional-key
 *    path — append it directly over the now-working connection.
 */
export async function ensureSshKeyAccess(
  ssh: SshRunner,
  client: HostingerClient,
  vpsId: number,
  publicKey?: string,
): Promise<void> {
  if (!publicKey) {
    return;
  }
  const quotedKey = quoteForRemoteShell(publicKey);
  const check = await ssh.exec(
    `grep -qxF ${quotedKey} ~/.ssh/authorized_keys 2>/dev/null`,
  );
  if (check.code === 0) {
    return; // already authorized — idempotent no-op.
  }
  if (check.code === 255) {
    // SSH itself can't connect yet: bootstrap access from zero via the API.
    await client.attachSshKey(vpsId, { name: `launchpad-${vpsId}`, key: publicKey });
    return;
  }
  const append = await ssh.exec(
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo ${quotedKey} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
  );
  if (append.code !== 0) {
    throw new FleetError(
      "ssh",
      `failed to authorize SSH key (exit ${append.code}): ${append.stderr.trim().slice(0, 500)}`,
      { retryable: false },
    );
  }
}

/** Verifies SSH connectivity by running a trivial command. */
export async function verifySshConnectivity(ssh: SshRunner): Promise<void> {
  const result = await ssh.exec("true");
  if (result.code !== 0) {
    throw new FleetError(
      "ssh",
      `SSH connectivity check failed (exit ${result.code}): ${result.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }
}

/**
 * Installs the docker engine + compose plugin if absent. Returns true if it
 * installed them this run, false if they were already present (idempotent).
 */
export async function installDocker(ssh: SshRunner): Promise<boolean> {
  const check = await ssh.exec(
    "docker --version >/dev/null 2>&1 && docker compose version >/dev/null 2>&1",
  );
  if (check.code === 0) {
    return false; // already present — idempotent no-op.
  }
  const install = await ssh.exec(
    "curl -fsSL https://get.docker.com | sh && systemctl enable --now docker",
  );
  if (install.code !== 0) {
    throw new FleetError(
      "docker",
      `docker install failed (exit ${install.code}): ${install.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }
  return true;
}

/** Basic hardening: ufw allow 22/80/443, fail2ban optional. Idempotent. */
export async function hardenHost(ssh: SshRunner): Promise<void> {
  const result = await ssh.exec(
    "ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable",
  );
  if (result.code !== 0) {
    throw new FleetError(
      "ssh",
      `hardening failed (exit ${result.code}): ${result.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }
}

/** Reads the bootstrap marker's version, or null if the host isn't bootstrapped. */
export async function readBootstrapMarker(ssh: SshRunner): Promise<number | null> {
  const result = await ssh.exec(`cat ${BOOTSTRAP_MARKER_PATH} 2>/dev/null`);
  if (result.code !== 0 || result.stdout.trim() === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout) as { version?: unknown };
    return typeof parsed.version === "number" ? parsed.version : null;
  } catch {
    return null; // malformed marker — treat as unbootstrapped rather than fatal.
  }
}

/** Writes the bootstrap marker file recording `version`. Idempotent (overwrite). */
export async function writeBootstrapMarker(ssh: SshRunner, version: number): Promise<void> {
  const dir = posixPath.dirname(BOOTSTRAP_MARKER_PATH);
  const mkdir = await ssh.exec(`mkdir -p ${dir}`);
  if (mkdir.code !== 0) {
    throw new FleetError(
      "ssh",
      `failed to create ${dir} (exit ${mkdir.code}): ${mkdir.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }
  await ssh.writeFile(
    BOOTSTRAP_MARKER_PATH,
    JSON.stringify({ version, bootstrappedAt: new Date().toISOString() }),
  );
}

/**
 * Bootstraps the existing VPS: ensure key access → verify connectivity → install
 * docker → harden → write marker. Re-running is a no-op once the marker records
 * {@link BOOTSTRAP_VERSION}. All work goes through `opts.ssh`.
 *
 * Refuses a non-sandbox-allowlisted `vpsId` before any side effect (ADR-013 /
 * spec 0014 plan step 2) — see `sandbox.ts`.
 */
export async function provisionClientVps(opts: BootstrapOptions): Promise<BootstrapResult> {
  const { tenantId, vpsId, ssh, client, publicKey } = opts;
  assertSandboxVps(vpsId, "provisionClientVps");

  const existingVersion = await readBootstrapMarker(ssh);
  if (existingVersion === BOOTSTRAP_VERSION) {
    // Already bootstrapped at the current version — nothing to do.
    return { tenantId, vpsId, version: BOOTSTRAP_VERSION, alreadyBootstrapped: true, stepsRun: [] };
  }

  const stepsRun: string[] = [];

  await ensureSshKeyAccess(ssh, client, vpsId, publicKey);
  stepsRun.push("ensureSshKeyAccess");

  await verifySshConnectivity(ssh);
  stepsRun.push("verifySshConnectivity");

  await installDocker(ssh);
  stepsRun.push("installDocker");

  await hardenHost(ssh);
  stepsRun.push("hardenHost");

  await writeBootstrapMarker(ssh, BOOTSTRAP_VERSION);
  stepsRun.push("writeBootstrapMarker");

  return { tenantId, vpsId, version: BOOTSTRAP_VERSION, alreadyBootstrapped: false, stepsRun };
}
