// Server-only fleet inventory read (spec 0022). Wraps the Hostinger client
// (@launchpad/fleet-hostinger) for the read-only /fleet page: resolves the
// owner token from env, lists VPSes, and classifies each against the
// ADR-013 sandbox allowlist. Never throws — like getPipelineViewStateSafe,
// a token gap or API outage returns an `unavailable` result the page renders
// as a notice, never a crash. MUST stay server-only (imported by the /fleet
// server component); the Hostinger token never crosses to the browser.
import {
  HostingerClient,
  SHARED_TOKEN_ENV,
  loadSandboxAllowlist,
  ExecSshRunner,
  listTenantBackups,
  listTenantStacks as listTenantStacksReal,
  readStackLogs as readStackLogsReal,
  STACK_LOG_TAIL,
  type VpsInstance,
  type TenantStack,
  type StackLogs,
  type SshRunner,
  type SshTarget,
} from "@launchpad/fleet-hostinger";
import { listRunningPipelineTargets } from "./pipeline";
import { stacksForProject } from "./deployed-stacks";

/** Worker env var naming the SSH private key file for fleet ops (spec 0026,
 * reused here spec 0033 Scope B) — same var name `deployToProduction`
 * (`packages/pipeline/src/activities.ts`) reads, so ops sets it once. Required
 * for a sandbox host's live inventory; missing it degrades to "unavailable"
 * (never a hard error — see the spec's Handoff-log RISK). */
export const FLEET_SSH_IDENTITY_ENV = "LAUNCHPAD_FLEET_SSH_IDENTITY";
/** Optional SSH user override (spec 0026); defaults to {@link DEFAULT_FLEET_SSH_USER}. */
export const FLEET_SSH_USER_ENV = "LAUNCHPAD_FLEET_SSH_USER";
const DEFAULT_FLEET_SSH_USER = "root";

export type FleetClassification = "sandbox" | "production";

/** Pure: a VPS id is `sandbox` iff it's in the ADR-013 allowlist, else
 * `production` (mutations hard-refused). Unit-tested — the blast-radius badge
 * derives from this and must never drift. */
export function classifyVps(id: number, sandboxIds: number[]): FleetClassification {
  return sandboxIds.includes(id) ? "sandbox" : "production";
}

/** A single fleet row, flattened from VpsInstance for the page. */
export interface FleetVps {
  id: number;
  hostname: string;
  state: VpsInstance["state"];
  plan: string | null;
  ipv4: string | null;
  classification: FleetClassification;
}

export type FleetResult =
  | { available: true; vps: FleetVps[] }
  | { available: false; reason: string };

/** First IPv4 address for display, or null. */
function primaryIpv4(vps: VpsInstance): string | null {
  return vps.ipv4?.[0]?.address ?? null;
}

// ---------------------------------------------------------------------------
// Spec 0033 Scope A — map a RUNNING deploy to the host it targets.
//
// The /fleet card for a host shows the spec currently deploying into it,
// linked to /specs/<id>. `deployingSpecsByHost` lists RUNNING `specPipeline`
// executions via Temporal visibility, queries each for `pipelineTarget`, and
// indexes the results by `target.vpsId` — but the visibility + query I/O lives
// in lib/pipeline.ts (where the Temporal client is); this module only shapes
// its output for the page. NEVER throws: a visibility/query failure yields an
// empty map so the page still renders (spec 0033 Scope A / acceptance).
// ---------------------------------------------------------------------------

/** One RUNNING deploy located to its host: the spec id (e.g. "0030") and the
 * VPS id its `pipelineTarget` names. `vpsId` is absent for a `launchpad` run
 * (no host), so those never land in the by-host index. */
export interface RunningDeployTarget {
  specId: string;
  vpsId?: number;
}

/** Host id → the spec id(s) currently deploying into it, for the card's link. */
export type DeployingSpecsByHost = Map<number, string[]>;

/**
 * Pure: indexes RUNNING deploys by the host id their target names, dropping
 * any run without a `vpsId` (a `launchpad` run targets no host). Unit-tested —
 * the "a host with an in-flight deploy shows a link to that spec; zero running
 * deploys ⇒ no link" acceptance criterion rests on this shaping being correct,
 * independent of the Temporal I/O that feeds it.
 */
export function indexDeployingSpecsByHost(
  targets: RunningDeployTarget[],
): DeployingSpecsByHost {
  const byHost: DeployingSpecsByHost = new Map();
  for (const t of targets) {
    if (t.vpsId === undefined) continue;
    const existing = byHost.get(t.vpsId);
    if (existing) existing.push(t.specId);
    else byHost.set(t.vpsId, [t.specId]);
  }
  return byHost;
}

/**
 * Lists RUNNING tenant deploys indexed by host id (spec 0033 Scope A). NEVER
 * throws — `listRunningPipelineTargets()` already degrades a Temporal
 * visibility/query outage to `[]`, so this can never itself fail; it just
 * shapes that list through {@link indexDeployingSpecsByHost}.
 */
export async function deployingSpecsByHost(): Promise<DeployingSpecsByHost> {
  const targets = await listRunningPipelineTargets();
  return indexDeployingSpecsByHost(targets);
}

// ---------------------------------------------------------------------------
// Spec 0033 Scope B — live tenants + DBs per host (read-only SSH, ADR-013).
//
// `getHostInventorySafe` renders one host card's tenant/DB section. A
// production host is NEVER SSH'd (reason: "production" — the card shows an
// honest note); a sandbox host's inventory comes from
// `listTenantStacks(runner, vpsId)` over an `ExecSshRunner`, degrading to
// reason: "unavailable" on any SSH failure/timeout. Server-only; never throws.
// ---------------------------------------------------------------------------

/** Live-inventory result for a single host card. `production` = never SSH'd by
 * design; `unavailable` = sandbox host we couldn't reach / read this request. */
export type HostInventoryResult =
  | { available: true; stacks: TenantStack[] }
  | { available: false; reason: "production" | "unavailable" };

/** Test seam for {@link getHostInventorySafe} — same injectable-deps
 * discipline as `deployToProduction`'s `DeployToProductionDeps`
 * (`packages/pipeline/src/activities.ts`) and `getPrLiveState`'s
 * `GetPrLiveStateDeps` (this package): a fake env/runner/`listTenantStacks`
 * lets the sandbox happy-path, missing-SSH-identity, and SSH-failure cases be
 * unit-tested with NO real SSH connection. Defaults to the real env +
 * `ExecSshRunner` + `listTenantStacks`. */
export interface GetHostInventoryDeps {
  // Record<string, string | undefined>, not NodeJS.ProcessEnv: same choice as
  // getPrLiveState's GetPrLiveStateDeps below — Next's global augmentation
  // makes NODE_ENV a required key on ProcessEnv, which would force every test
  // fake to carry an irrelevant field.
  env: Record<string, string | undefined>;
  createSshRunner: (target: SshTarget) => SshRunner;
  listTenantStacks: (runner: SshRunner, vpsId: number) => Promise<TenantStack[]>;
}

const defaultGetHostInventoryDeps: GetHostInventoryDeps = {
  env: process.env,
  createSshRunner: (target) => new ExecSshRunner(target),
  listTenantStacks: listTenantStacksReal,
};

/**
 * Read-only live inventory for one host card (spec 0033 Scope B). A production
 * host short-circuits to `{ available: false, reason: "production" }` WITHOUT
 * SSH (ADR-013 — never SSH'd, even for a read). A sandbox host builds an
 * `ExecSshRunner` from the VPS ip + the launchpad SSH identity/user env
 * (`LAUNCHPAD_FLEET_SSH_IDENTITY`/`_USER`, same var names
 * `deployToProduction` reads) and calls `listTenantStacks`. Never throws: a
 * missing SSH identity (the spec's Handoff-log RISK — the Next server process
 * may not have it even though the worker does), a host with no IPv4, or any
 * SSH/inventory failure all degrade to `{ available: false, reason:
 * "unavailable" }` rather than a 500.
 */
export async function getHostInventorySafe(
  vps: FleetVps,
  deps: GetHostInventoryDeps = defaultGetHostInventoryDeps,
): Promise<HostInventoryResult> {
  // Never SSH a production host, even read-only (ADR-013 / spec 0033 Scope B).
  if (vps.classification === "production") {
    return { available: false, reason: "production" };
  }
  try {
    const identityFile = deps.env[FLEET_SSH_IDENTITY_ENV];
    if (!identityFile || !vps.ipv4) {
      // Missing SSH identity on this server process, or the VPS has no IPv4
      // to SSH to — degrade honestly rather than throwing (RISK noted in the
      // spec's Handoff log: confirm the Next server env before this ever
      // fires live).
      return { available: false, reason: "unavailable" };
    }
    const sshUser = deps.env[FLEET_SSH_USER_ENV] ?? DEFAULT_FLEET_SSH_USER;
    const runner = deps.createSshRunner({ host: vps.ipv4, user: sshUser, identityFile });
    const stacks = await deps.listTenantStacks(runner, vps.id);
    return { available: true, stacks };
  } catch {
    return { available: false, reason: "unavailable" };
  }
}

/** Reads the live fleet server-side, classified against the sandbox
 * allowlist. Never throws: a missing token or API failure becomes
 * `{ available: false, reason }`. `resolveHostingerToken`'s error names only
 * env-var names (never a token value), so it's safe to surface as-is; other
 * failures get a generic message so nothing sensitive leaks. */
export async function getFleetSafe(): Promise<FleetResult> {
  // Account-wide read (all VPSes on the owner account), so the shared owner
  // token — not a per-tenant one — is what listVps needs.
  const apiToken = process.env[SHARED_TOKEN_ENV];
  if (!apiToken) {
    return { available: false, reason: `Hostinger token not set (${SHARED_TOKEN_ENV})` };
  }

  try {
    const client = new HostingerClient({ apiToken });
    const [instances, sandboxIds] = await Promise.all([
      client.listVps(),
      Promise.resolve(loadSandboxAllowlist()),
    ]);
    const vps: FleetVps[] = instances.map((v) => ({
      id: v.id,
      hostname: v.hostname,
      state: v.state,
      plan: v.plan,
      ipv4: primaryIpv4(v),
      classification: classifyVps(v.id, sandboxIds),
    }));
    // Stable order: production first (blast-radius awareness), then by id.
    vps.sort((a, b) =>
      a.classification !== b.classification
        ? a.classification === "production"
          ? -1
          : 1
        : a.id - b.id,
    );
    return { available: true, vps };
  } catch (err) {
    // Never surface the token or raw API internals; a generic reason is enough.
    const detail = err instanceof Error ? err.message : "unknown error";
    return { available: false, reason: `Hostinger API unavailable (${detail})` };
  }
}


/**
 * Restore points for one tenant, for the gate-3 evidence panel (spec 0111).
 *
 * Deliberately the SAME shape and discipline as {@link getHostInventorySafe}: a
 * **production** host short-circuits WITHOUT SSH (ADR-013 — never SSH'd, even for
 * a read), a missing SSH identity or IPv4 degrades, and any failure degrades. It
 * returns `undefined` rather than `[]` on every non-answer, because
 * `deriveGate3Evidence` reports "could not be read" differently from "none exist" —
 * collapsing the two would tell the reader we know something we do not.
 *
 * Called only when a **promote gate is actually open on a tenant run**, so this
 * adds at most one SSH round trip at the one moment the answer matters, never on
 * an ordinary workspace load.
 */
export async function getTenantRestorePointsSafe(
  tenantId: string,
  vpsId: number,
): Promise<string[] | undefined> {
  try {
    const fleet = await getFleetSafe();
    if (!fleet.available) return undefined;
    const vps = fleet.vps.find((v) => v.id === vpsId);
    // Never SSH a production host, even read-only (ADR-013).
    if (!vps || vps.classification === "production" || !vps.ipv4) return undefined;
    const identityFile = process.env[FLEET_SSH_IDENTITY_ENV];
    if (!identityFile) return undefined;
    const sshUser = process.env[FLEET_SSH_USER_ENV] ?? DEFAULT_FLEET_SSH_USER;
    const ssh = new ExecSshRunner({ host: vps.ipv4, user: sshUser, identityFile });
    return await listTenantBackups({ tenantId, ssh });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Spec 0214 Parte B — container logs for ONE project's deployed stacks.
//
// Same discipline as `getTenantRestorePointsSafe` above (never throws, never
// SSHes a production host), with one extra requirement the spec is explicit
// about: the three outcomes must stay DISTINGUISHABLE. "the read failed" and
// "there is no stack here" are different answers, and a panel that renders one
// "sin logs" for both is the fallback-identical-to-the-deliberate-case failure
// (CLAUDE.md verification rule #9).
//
// Everything returned is plain data — strings, arrays, booleans — because the
// panel that renders it is a client component (`panels.tsx` is `"use client"`),
// so a `Date` or an `Error` could not cross.
// ---------------------------------------------------------------------------

/** One located stack: its lines, or why they could not be read. */
export type ProjectLogEntry =
  | { project: string; state: "lines"; lines: string[]; truncated: boolean }
  | { project: string; state: "error"; message: string };

export type ProjectLogsResult =
  /** At least one stack of this project was located on a readable host. */
  | { state: "read"; readAt: string; tail: number; entries: ProjectLogEntry[] }
  /** No stack to read, and why — never confused with "the read failed". */
  | { state: "none"; reason: string };

/** Test seam, same shape as {@link GetHostInventoryDeps}: the fleet read, the
 * per-host inventory, the SSH runner and the log read are all injectable so
 * every branch is testable with no real SSH. */
export interface GetProjectStackLogsDeps {
  getFleet: () => Promise<FleetResult>;
  getHostInventory: (vps: FleetVps) => Promise<HostInventoryResult>;
  /** `null` when this process has no SSH identity, or the host has no IPv4. */
  createRunner: (vps: FleetVps) => SshRunner | null;
  readStackLogs: (runner: SshRunner, vpsId: number, composeProject: string) => Promise<StackLogs>;
}

const defaultGetProjectStackLogsDeps: GetProjectStackLogsDeps = {
  getFleet: getFleetSafe,
  getHostInventory: (vps) => getHostInventorySafe(vps),
  createRunner: (vps) => {
    const identityFile = process.env[FLEET_SSH_IDENTITY_ENV];
    if (!identityFile || !vps.ipv4) return null;
    const sshUser = process.env[FLEET_SSH_USER_ENV] ?? DEFAULT_FLEET_SSH_USER;
    return new ExecSshRunner({ host: vps.ipv4, user: sshUser, identityFile });
  },
  readStackLogs: readStackLogsReal,
};

/** `HH:MM:SS` in the SERVER's clock — the panel says so, rather than implying
 * it is the reader's local time. */
function formatReadAt(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * Reads the last {@link STACK_LOG_TAIL} log lines of every stack belonging to
 * `slug`, on the hosts ADR-013 lets us read. Never throws.
 *
 * A production host is skipped WITHOUT SSH (`getHostInventorySafe` refuses it,
 * and `readStackLogs` refuses again underneath), so a non-sandbox VPS produces
 * zero `exec` calls and a `none` result that names ADR-013 as the reason.
 */
export async function getProjectStackLogsSafe(
  slug: string,
  deps: GetProjectStackLogsDeps = defaultGetProjectStackLogsDeps,
): Promise<ProjectLogsResult> {
  const fleet = await deps.getFleet();
  if (!fleet.available) {
    return {
      state: "none",
      reason: `No se pudo leer el inventario de la flotilla (${fleet.reason}), así que no sabemos en qué host vive este proyecto.`,
    };
  }

  const entries: ProjectLogEntry[] = [];
  let production = 0;
  let unreadable = 0;
  for (const vps of fleet.vps) {
    const inventory = await deps.getHostInventory(vps);
    if (!inventory.available) {
      if (inventory.reason === "production") production += 1;
      else unreadable += 1;
      continue;
    }
    // Spec 0181: this project's stacks, not the box's.
    const stacks = stacksForProject(inventory.stacks, slug);
    if (stacks.length === 0) continue;
    const runner = deps.createRunner(vps);
    for (const stack of stacks) {
      if (!runner) {
        // The stack EXISTS and we still could not read it — an error, not a
        // silent disappearance into "este proyecto no tiene stack".
        entries.push({
          project: stack.tenant,
          state: "error",
          message: `Sin identidad SSH en este proceso (${FLEET_SSH_IDENTITY_ENV}) o el host no tiene IPv4: el stack existe pero no se pudo leer.`,
        });
        continue;
      }
      try {
        const logs = await deps.readStackLogs(runner, vps.id, stack.tenant);
        entries.push({
          project: logs.project,
          state: "lines",
          lines: logs.lines,
          truncated: logs.truncated,
        });
      } catch (err) {
        entries.push({
          project: stack.tenant,
          state: "error",
          message: err instanceof Error ? err.message : "fallo desconocido al leer los logs",
        });
      }
    }
  }

  if (entries.length === 0) {
    const why: string[] = [];
    if (production > 0) {
      why.push(
        `${production} host(s) de producción no se leen por ADR-013 (ni siquiera de solo lectura)`,
      );
    }
    if (unreadable > 0) why.push(`${unreadable} host(s) sandbox no se pudieron inspeccionar`);
    return {
      state: "none",
      reason:
        `No se encontró ningún stack de este proyecto en los VPS que podemos inspeccionar` +
        (why.length > 0 ? ` · ${why.join(" · ")}` : "") +
        `.`,
    };
  }

  return { state: "read", readAt: formatReadAt(), tail: STACK_LOG_TAIL, entries };
}
