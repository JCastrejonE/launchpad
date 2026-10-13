/**
 * Read-only Odoo-stack inventory for a VPS (spec 0033 Scope B). Given an
 * `SshRunner` (production uses {@link ExecSshRunner}) and a VPS id, enumerates
 * the host's live Odoo stacks and, per stack, the Odoo database(s) it serves —
 * so a /fleet host card can show "what tenants are actually running here" next
 * to the Hostinger facts.
 *
 * STRICTLY READ-ONLY. This module runs `docker`/`psql` INSPECTION commands
 * only (`docker ps`, `docker compose ... ps`, `psql -l` / `SELECT datname`) —
 * NEVER a `docker compose up/down`, `psql` DDL, or any state-changing command.
 * The deploy path (stack.ts) is the only thing that mutates a host.
 *
 * ADR-013 discipline (spec 0033 Scope B): SSH runs ONLY against an allowlisted
 * sandbox host. {@link listTenantStacks} hard-refuses a non-allowlisted /
 * production VPS id BEFORE it ever touches `runner`, exactly like the mutating
 * fleet ops (sandbox.ts) — a production host (100002) is never SSH'd, even for
 * a read. The web layer catches that refusal and renders an honest
 * "live inventory unavailable (production)" note instead of crashing. Agents
 * never edit the allowlist.
 *
 * Ground-truth shapes observed live on sandbox 100001 (spec 0033 Handoff
 * log): containers `prod-odoo-1` (`odoo:18`) / `prod-db-1` (`postgres:16`),
 * DB `sandbox_prod` read via
 * `psql -U odoo -d postgres -tAc "SELECT datname FROM pg_database ..."`.
 */
import { FleetError } from "./errors.js";
import { isSandboxVps } from "./sandbox.js";
import type { SshRunner } from "./ssh.js";

/** Coarse liveness of a discovered stack (from `docker compose ps` / container state). */
export type TenantStackStatus = "running" | "stopped" | "unknown";

/** One Odoo stack discovered on a host, with the Odoo database(s) it serves. */
export interface TenantStack {
  /** The tenant/stack the containers belong to (e.g. the compose project name). */
  tenant: string;
  /**
   * Tenant and stack as separate identities, parsed from the config file PATH
   * (`/opt/launchpad/<tenantId>/<stack>/docker-compose.yml`) — spec 0121.
   *
   * Not split off `tenant` above, because the compose project name is ambiguous:
   * `acme-staging-prod` could be tenant `acme-staging` + stack `prod` or tenant
   * `acme` + stack `staging-prod`. The path is unambiguous, and these two fields
   * are what a URL can be built from (`routerHost(tenantId, stack, domain)`).
   *
   * Absent when the config path was not readable or did not match the deploy
   * layout — a caller must then treat the stack as unaddressable rather than
   * guessing a hostname.
   */
  identity?: { tenantId: string; stack: string; kind: "staging" | "tenant" };
  /**
   * The host this stack is ACTUALLY serving, read out of its deployed compose
   * file's Traefik rule (spec 0121).
   *
   * Read rather than derived, and that distinction matters: the domain is
   * env-driven, so a stack deployed before the env changed is still routing on its
   * OLD hostname. Deriving from the current env would make the UI advertise a URL
   * the stack does not answer on — which is the fabrication rule (spec 0084) with
   * extra steps.
   *
   * Absent when the rule could not be read, in which case there is no host to show.
   */
  routerHost?: string;
  /** Odoo application database(s) in the stack's `db` container (Postgres system DBs filtered out). */
  dbs: string[];
  /** Whether the stack's containers are currently running. */
  status: TenantStackStatus;
}

/**
 * Root directory the deploy path (`stack.ts`'s `remoteStackDir`) writes every
 * tenant stack under (`/opt/launchpad/<tenantId>/<stack>/docker-compose.yml`).
 * Only compose projects whose config file lives under here are reported —
 * this is the "matching the deploy naming" filter: anything else `docker
 * compose ls` reports on the host (unrelated to a launchpad tenant deploy) is
 * out of scope and never surfaced.
 */
const STACK_ROOT_PREFIX = "/opt/launchpad/";

/** Postgres system databases, never surfaced as a tenant's application DB. */
const POSTGRES_SYSTEM_DBS = new Set(["postgres", "template0", "template1"]);

/** One row of `docker compose ls --all --format json` output (fields we read). */
interface ComposeLsEntry {
  Name?: string;
  Status?: string;
  ConfigFiles?: string;
}

/**
 * `docker compose ls` reports e.g. `"running(2)"` / `"exited(1)"` /
 * `"created(1)"` — coarsened to {@link TenantStackStatus} for the card.
 */
function parseComposeStatus(status: string | undefined): TenantStackStatus {
  const lowered = status?.toLowerCase() ?? "";
  if (lowered.startsWith("running")) return "running";
  if (lowered.startsWith("exited") || lowered.startsWith("stopped")) return "stopped";
  return "unknown";
}

/**
 * True when `configFiles` (compose's comma-separated list of `-f` paths) has
 * at least one path under {@link STACK_ROOT_PREFIX} — i.e. this is a
 * launchpad tenant stack, not some unrelated compose project on the host.
 */
function isDeployedStack(configFiles: string | undefined): boolean {
  if (!configFiles) return false;
  return configFiles.split(",").some((file) => file.trim().startsWith(STACK_ROOT_PREFIX));
}

/**
 * Extracts the host out of a Traefik `Host(`…`)` router rule (spec 0121).
 *
 * Pure + exported so the parsing is unit-tested against the real label shape
 * rather than only through a live read.
 */
export function parseRouterHostRule(composeText: string): string | undefined {
  return /routers\.[^.]+\.rule=Host\(`([^`]+)`\)/.exec(composeText)?.[1];
}

/**
 * The host a deployed stack routes on, read from its compose file on the box.
 *
 * Read-only (`grep`), and tolerant: an unreadable file or a stack with no Traefik
 * rule yields `undefined`, so the caller shows no URL instead of guessing one.
 */
async function readRouterHost(runner: SshRunner, configFiles: string): Promise<string | undefined> {
  const composeFile = configFiles.split(",")[0]?.trim();
  if (!composeFile) return undefined;
  const result = await runner.exec(`grep -m1 'routers\\..*\\.rule=Host' ${composeFile} || true`);
  if (result.code !== 0) return undefined;
  return parseRouterHostRule(result.stdout);
}

/**
 * Tenant + stack from a compose config path (spec 0121):
 * `/opt/launchpad/<tenantId>/<stack>/docker-compose.yml`.
 *
 * Pure and exported so the parsing is unit-tested against the real path shapes —
 * including `acme-staging/prod`, which is exactly the case that makes splitting
 * the compose project NAME unreliable.
 *
 * `undefined` rather than a guess when the path does not match: a wrong tenant
 * here becomes a wrong URL in the UI, and a missing link is better than one
 * pointing at somebody else's environment.
 */
export function parseStackIdentity(
  configFiles: string | undefined,
): { tenantId: string; stack: string; kind: "staging" | "tenant" } | undefined {
  const composeFile = configFiles?.split(",")[0]?.trim();
  if (!composeFile || !composeFile.startsWith(STACK_ROOT_PREFIX)) return undefined;
  const parts = composeFile.slice(STACK_ROOT_PREFIX.length).split("/");
  const [tenantId, stack] = parts;
  // Exactly `<tenant>/<stack>/<file>` — anything deeper or shallower is not the
  // deploy layout this can speak for.
  if (parts.length !== 3 || !tenantId || !stack) return undefined;
  return { tenantId, stack, kind: /^spec-\d{4}$/.test(stack) ? "staging" : "tenant" };
}

/**
 * Lists the Odoo application database(s) served by a stack's `db` container
 * (`SELECT datname`, Postgres system DBs filtered both in the query and again
 * client-side as a defensive double-check), given its (first) compose config
 * file path. Read-only — `psql` runs a `SELECT`, never DDL. A non-zero exit
 * (e.g. the `db` container isn't up on a stopped stack) reads as "no DBs"
 * rather than throwing — a stopped stack still gets listed, just with `dbs: []`.
 */
async function listStackDatabases(runner: SshRunner, configFiles: string): Promise<string[]> {
  const composeFile = configFiles.split(",")[0]?.trim();
  if (!composeFile) return [];
  const result = await runner.exec(
    `docker compose -f ${composeFile} exec -T db psql -U odoo -d postgres -tAc ` +
      `"SELECT datname FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1')"`,
  );
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.length > 0 && !POSTGRES_SYSTEM_DBS.has(name));
}

/**
 * Enumerates the read-only Odoo-stack inventory of an allowlisted sandbox host
 * (spec 0033 Scope B). Refuses a non-sandbox / production VPS id up front (no
 * SSH — ADR-013). Read-only: only `docker compose ls` and a `psql SELECT`
 * inspection command ever run over `runner` — never a mutating docker/psql
 * command.
 *
 * Lists every compose project on the host (`docker compose ls --all`, so
 * stopped stacks are included too), keeps only the ones whose config file
 * lives under the deploy root ({@link isDeployedStack}), and for each queries
 * its `db` container's databases ({@link listStackDatabases}). The compose
 * project name (e.g. `"prod"`) is reported as `tenant` — the identity a
 * /fleet host card shows next to the Hostinger facts.
 *
 * `docker compose ls` itself failing (bad exit code / unparseable output) is
 * a real inventory failure and throws a retryable `FleetError` — the web
 * layer (`getHostInventorySafe`, spec 0033 step 4) is what degrades that to
 * an "unavailable" card; this function stays honest about a hard failure
 * rather than silently returning `[]`.
 */
export async function listTenantStacks(
  runner: SshRunner,
  vpsId: number,
): Promise<TenantStack[]> {
  // Guard FIRST, before any `runner` use: a non-allowlisted / production host
  // is NEVER SSH'd, not even read-only (ADR-013 / spec 0033 Scope B).
  if (!isSandboxVps(vpsId)) {
    throw new FleetError(
      "sandbox",
      `refusing read-only inventory of VPS ${vpsId}: not on the fleet sandbox ` +
        `allowlist (infra/fleet-sandbox.json, ADR-013) — production hosts are ` +
        `never SSH'd, even for a read`,
      { retryable: false },
    );
  }

  const listResult = await runner.exec("docker compose ls --all --format json");
  if (listResult.code !== 0) {
    throw new FleetError(
      "docker",
      `docker compose ls failed on VPS ${vpsId} (exit ${listResult.code}): ` +
        listResult.stderr.trim().slice(0, 500),
      { retryable: true },
    );
  }

  const trimmed = listResult.stdout.trim();
  let entries: ComposeLsEntry[];
  try {
    entries = trimmed.length > 0 ? (JSON.parse(trimmed) as ComposeLsEntry[]) : [];
  } catch (err) {
    throw new FleetError(
      "docker",
      `docker compose ls returned unparseable output on VPS ${vpsId}: ${(err as Error).message}`,
      { retryable: true, cause: err },
    );
  }

  // Spec 0198 B: read each stack's databases and router host IN PARALLEL.
  //
  // This loop used to be sequential, and every `exec` is a fresh `ssh` process
  // (no ControlMaster) costing ~0.9 s measured. At 21 stacks that is 43 round
  // trips — about 40 seconds — which the Ramas & builds page awaited before it
  // rendered ANYTHING, so clicking the tab looked like a dead link. It also grew
  // with every branch staging environment we deployed.
  //
  // Bounded at CONCURRENCY, not unbounded: 42 simultaneous connections walk into
  // sshd's default `MaxStartups 10:30:100` and start getting refused, which would
  // trade a slow page for a flaky one. Order is preserved — `stacks` is filled by
  // index, so callers and tests see exactly what they saw before, sooner.
  const deployed = entries.filter(
    (e): e is ComposeLsEntry & { Name: string } => Boolean(e.Name) && isDeployedStack(e.ConfigFiles),
  );
  const stacks: TenantStack[] = new Array<TenantStack>(deployed.length);
  const CONCURRENCY = 6;
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < deployed.length; i = next++) {
      const entry = deployed[i]!;
      const [dbs, host] = await Promise.all([
        entry.ConfigFiles ? listStackDatabases(runner, entry.ConfigFiles) : Promise.resolve([]),
        entry.ConfigFiles ? readRouterHost(runner, entry.ConfigFiles) : Promise.resolve(undefined),
      ]);
      const identity = parseStackIdentity(entry.ConfigFiles);
      stacks[i] = {
        tenant: entry.Name,
        ...(identity ? { identity } : {}),
        ...(host ? { routerHost: host } : {}),
        dbs,
        status: parseComposeStatus(entry.Status),
      };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, deployed.length) }, () => worker()),
  );
  return stacks;
}
