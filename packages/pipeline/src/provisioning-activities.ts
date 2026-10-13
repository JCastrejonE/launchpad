/**
 * odoo-next provisioning activities (spec 0161 F2) — the SIDE-EFFECT half of the
 * `provisionProject` workflow. One activity per work phase: repo → dns → odoo →
 * front → verify. The workflow (provisioning-workflow.ts) is pure orchestration;
 * every network/SSH/git effect lives here, so the workflow stays deterministic
 * (CLAUDE.md: "side effects only in activities").
 *
 * Each activity wraps the MECHANISMS spec 0148 already built and tested — it
 * adds no second copy of that logic:
 *   - repo   → `createRepoInOrg` + `provisionRepoCheckout` (+ optional logo via
 *              `commitFileToRepo`, spec 0161 E2b);
 *   - dns    → `HostingerClient.upsertDnsRecord` for `<slug>.example.com` and
 *              `<slug>.odoo.example.com`;
 *   - odoo   → `deployProductionStack` with the `<slug>.odoo.example.com` host
 *              override + ACME `certResolver`;
 *   - front  → `deployFrontStack`;
 *   - verify → the end-state assertions (spec 0161 acceptance B–D).
 *
 * These are exported from `activities.ts` (`export * from
 * "./provisioning-activities.js"`) so the worker's `import * as activities`
 * registers them with no worker change. Injected-deps + DB-resolve posture
 * mirrors `runBranchStagingOp` in activities.ts — the coder fills these in.
 */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { resolve4 as dnsResolve4 } from "node:dns/promises";
import https from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import { ApplicationFailure } from "@temporalio/common";
import { GithubClient, GithubApiError } from "@launchpad/github";
import type { GithubConfig } from "@launchpad/github";
import {
  HostingerClient,
  ExecSshRunner,
  resolveHostingerToken,
  deployProductionStack,
  deployFrontStack,
  readOrCreateDbPassword,
  readOrCreateOdooReadonlyCredentials,
  tenantDbName,
  toActivityFailure,
} from "@launchpad/fleet-hostinger";
import type {
  SshTarget,
  SshRunner,
  DeployOptions,
  DeployResult,
  DeployFrontStackOptions,
  FrontDeployResult,
  OdooReadonlyCredentials,
} from "@launchpad/fleet-hostinger";
import {
  provisionRepoCheckout,
  CheckoutError,
  type ProvisionCheckoutDeps,
  type ProvisionCheckoutInput,
  type ProvisionCheckoutOutcome,
} from "./checkout.js";
import { git, run } from "./git.js";
import type { OdooVersion } from "./spec.js";
import { modulesFor, procesosFromIntake, type RefusedProceso } from "./procesos-modules.js";
import { vendoredAddonsFor, CFDI_MODULE, type VendoredAddon } from "./vendored-addons.js";
import { fetchVendoredAddons } from "./vendor-fetch.js";
import type { ProvisionProjectInput } from "./provisioning-phase.js";
import {
  loadFrontScaffold,
  renderFrontScaffold,
  siteFromIntake,
  type ScaffoldFile,
  type SiteData,
} from "./front-scaffold.js";
import { frontHostFor, odooHostFor, provisionedZone } from "./hosts.js";
import { packCheckoutWithTar, type PackCheckout } from "./pack-checkout.js";

/**
 * The GitHub org odoo-next fronts are provisioned into (spec 0148 A). Gate-1
 * open question 2 measured `example-org` and found NO template repo, so phase A
 * is a plain `POST /orgs/{org}/repos` create, and the repo is named for the slug.
 */
const PROVISION_ORG = "example-org";

/**
 * Real git/fs/DB I/O for {@link provisionRepoCheckout}. Deliberately a local
 * copy of the inline deps `ensureCheckout` (activities.ts) builds rather than an
 * import: `activities.ts` re-exports THIS module (`export *`), so importing back
 * from it would be a cycle. The bodies are the same boring clone/stat/append/
 * persist primitives.
 */
const defaultProvisionCheckoutDeps: ProvisionCheckoutDeps = {
  isCheckout: async (dir) => {
    try {
      await stat(path.join(dir, ".git"));
      return true;
    } catch {
      return false;
    }
  },
  clone: async (url, dest) => {
    await mkdir(path.dirname(dest), { recursive: true });
    // cwd is the PARENT: git resolves the destination relative to it.
    const r = await run("git", ["clone", url, dest], path.dirname(dest));
    return { ok: r.ok, out: r.out };
  },
  addExcludes: async (root, lines) => {
    const file = path.join(root, ".git", "info", "exclude");
    await mkdir(path.dirname(file), { recursive: true });
    const existing = await readFile(file, "utf8").catch(() => "");
    if (existing.includes(lines[lines.length - 1] as string)) return; // idempotent
    await writeFile(
      file,
      `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}${lines.join("\n")}\n`,
      "utf8",
    );
  },
  persistRepoRoot: async (slug, root) => {
    const { createDb, createPool, setProjectRepoRoot } = await import("@launchpad/db");
    const pool = createPool();
    try {
      await setProjectRepoRoot(createDb(pool), slug, root);
    } finally {
      await pool.end();
    }
  },
  persistRepo: async (slug, owner, name) => {
    const { createDb, createPool, setProjectRepo } = await import("@launchpad/db");
    const pool = createPool();
    try {
      await setProjectRepo(createDb(pool), slug, owner, name);
    } finally {
      await pool.end();
    }
  },
  originUrl: (root) => git.originUrl(root),
};

/**
 * Collaborators {@link provisionRepo} needs beyond its input — injectable so the
 * create → checkout → logo-commit sequence is unit-testable without real
 * GitHub/git/DB (the `runBranchStagingOp` deps posture). Defaults resolve the
 * server `GITHUB_TOKEN`, a real `GithubClient`, the real checkout I/O, and the
 * project row from the DB.
 */
export interface ProvisionRepoDeps {
  githubToken: () => string | undefined;
  createGithubClient: (
    cfg: GithubConfig,
  ) => Pick<GithubClient, "createRepoInOrg" | "commitFileToRepo">;
  checkoutRepo: (input: ProvisionCheckoutInput) => Promise<ProvisionCheckoutOutcome>;
  /** The project's `kind` (null when the row is absent) — drives the specs
   * exclude, and its absence means "no such project". */
  resolveProjectKind: (slug: string) => Promise<string | null>;
  /** Spec 0169: the front scaffold committed into the new repo. Injectable so a
   * test can assert what gets committed without touching `infra/front/`. */
  loadFrontScaffold: () => Promise<ScaffoldFile[]>;
  /**
   * Spec 0191: the business's own facts, for the landing page this scaffold
   * becomes. `null` when the project has no intake (every project created before
   * that column existed) — the scaffold then renders with empty strings and an
   * empty process list, which is exactly the generic page it shipped before.
   */
  resolveProjectSite: (slug: string) => Promise<SiteData | null>;
}

const defaultProvisionRepoDeps: ProvisionRepoDeps = {
  githubToken: () => process.env["GITHUB_TOKEN"],
  createGithubClient: (cfg) => new GithubClient(cfg),
  checkoutRepo: (input) => provisionRepoCheckout(input, defaultProvisionCheckoutDeps),
  loadFrontScaffold: () => loadFrontScaffold(),
  resolveProjectSite: async (slug) => {
    const { createDb, createPool, projectBySlug } = await import("@launchpad/db");
    const pool = createPool();
    try {
      const project = await projectBySlug(createDb(pool), slug);
      if (!project) return null;
      // Spec 0192 D: the parsing lives in `siteFromIntake`, where a test can
      // hold a REAL stored intake value against it.
      return siteFromIntake(
        project.name,
        (project as { intake?: Record<string, string> | null }).intake,
      );
    } finally {
      await pool.end();
    }
  },
  resolveProjectKind: async (slug) => {
    const { createDb, createPool, projectBySlug } = await import("@launchpad/db");
    const pool = createPool();
    try {
      return (await projectBySlug(createDb(pool), slug))?.kind ?? null;
    } finally {
      await pool.end();
    }
  },
};

/**
 * Phase A: create the repo in `example-org`, clone + verify origin, and — when a
 * logo was uploaded — commit it into that repo (spec 0161 E2b).
 *
 * The logo's boundary refusal (`validateLogoUpload`) lives in apps/web (the
 * wizard field and the start action, spec 0161 items E2b + start) — the pipeline
 * package must not depend on apps/web (see checkout.ts). Here the accepted bytes
 * simply land as a commit, and that the commit is REAL is proven by the sha
 * GitHub RETURNS, never the request we sent (VERIFICATION #1).
 */
export async function provisionRepo(
  input: ProvisionProjectInput,
  deps: ProvisionRepoDeps = defaultProvisionRepoDeps,
): Promise<void> {
  const token = deps.githubToken();
  if (!token) {
    throw ApplicationFailure.create({
      message: "provisionRepo: GITHUB_TOKEN no está configurado en el worker.",
      type: "ProvisionRepoConfig",
      nonRetryable: true,
    });
  }
  const kind = await deps.resolveProjectKind(input.slug);
  if (!kind) {
    throw ApplicationFailure.create({
      message: `provisionRepo: no existe el proyecto "${input.slug}".`,
      type: "ProvisionRepoConfig",
      nonRetryable: true,
    });
  }

  const client = deps.createGithubClient({ token, owner: PROVISION_ORG, repo: input.slug });

  try {
    // Create the private repo. `createRepoInOrg` never overwrites: a taken name
    // comes back as a distinct `name_taken`, surfaced non-retryably below.
    await client.createRepoInOrg({
      org: PROVISION_ORG,
      name: input.slug,
      private: true,
      description: `Front odoo-next de ${input.slug} (aprovisionado por Hangar).`,
    });

    // Spec 0169: commit the front scaffold BEFORE cloning, so the checkout comes
    // down with it. Without these files `provisionFront` packs an empty tree and
    // the front phase dies on `open Dockerfile: no such file or directory` —
    // measured on spec 0161's probe.
    //
    // Committed one file per request through the Contents API, the same call the
    // logo already uses. On a repo with no commits the first PUT creates the
    // default branch, so this also initialises it.
    // Spec 0191: the scaffold is a LANDING PAGE for this business, so its
    // `app/site.ts` is filled in with what the customer told us before the first
    // commit. A project with no intake renders empty strings — the generic page
    // this used to be, rather than a placeholder leaking into a customer's repo.
    const site = (await deps.resolveProjectSite(input.slug)) ?? {
      nombre: input.slug,
      giro: "",
      procesos: [],
      marca: "",
    };
    const scaffold = renderFrontScaffold(await deps.loadFrontScaffold(), site);
    for (const file of scaffold) {
      const committed = await client.commitFileToRepo({
        owner: PROVISION_ORG,
        name: input.slug,
        path: file.path,
        contentBase64: file.contentBase64,
        message: `chore: scaffold ${file.path}`,
      });
      // Assert the RESPONSE, not the request (VERIFICATION #1): a scaffold that
      // reported success without landing is exactly the empty-repo failure
      // repeating with extra steps.
      if (!committed.commitSha) {
        throw ApplicationFailure.create({
          message: `provisionRepo: GitHub no devolvió un commit al subir ${file.path} de "${input.slug}".`,
          type: "ProvisionRepoScaffoldCommit",
          nonRetryable: true,
        });
      }
    }

    // Clone it and confirm the clone points at THAT repo by reading `origin`
    // back (VERIFICATION #1) — never trusting the value we persisted.
    await deps.checkoutRepo({ slug: input.slug, owner: PROVISION_ORG, name: input.slug, kind });

    // E2b: the accepted logo lands as a commit in this repo, proven by the sha
    // GitHub returns (never the request).
    if (input.logo) {
      const committed = await client.commitFileToRepo({
        owner: PROVISION_ORG,
        name: input.slug,
        path: input.logo.path,
        contentBase64: input.logo.contentBase64,
        message: "chore: add brand logo",
      });
      if (!committed.commitSha) {
        throw ApplicationFailure.create({
          message: `provisionRepo: GitHub no devolvió un commit al subir el logo de "${input.slug}".`,
          type: "ProvisionRepoLogoCommit",
          nonRetryable: true,
        });
      }
    }
  } catch (err) {
    if (err instanceof ApplicationFailure) throw err;
    if (err instanceof GithubApiError) {
      throw ApplicationFailure.create({
        type: err.kind === "name_taken" ? "ProvisionRepoNameTaken" : "ProvisionRepoGithubError",
        message: err.message,
        nonRetryable: !err.retryable,
      });
    }
    if (err instanceof CheckoutError) {
      throw ApplicationFailure.create({
        type: `Checkout_${err.kind}`,
        message: err.message,
        nonRetryable: !err.retryable,
      });
    }
    throw err;
  }
}

/**
 * The public DNS zone odoo-next fronts are provisioned under (spec 0161 B).
 * Both A-records — `<slug>` (`<slug>.example.com`) and `<slug>.odoo`
 * (`<slug>.odoo.example.com`) — are written into this zone, resolving to the
 * sandbox VPS IPv4.
 */
/**
 * The zone we provision into — OURS (spec 0182, revised by the owner 2026-08-12).
 *
 * An earlier cut of this took the zone from the project's `domain`, on the
 * reading that "domain means the zone". The owner's fuller decision: a customer may set
 * whatever domain they like, but the records for it depend on them and their
 * hosts — so we always provide a `example.com` hostname, and their domain is
 * verified later by resolve tests (spec 0185) rather than written by us. We
 * cannot create records in a zone we do not control, and pretending otherwise is
 * how a project ends up recorded as deployed at a name that never resolved.
 */
function zoneOf(_input: { zone?: string }): string {
  return provisionedZone();
}

/**
 * Worker env var naming the sandbox VPS provisioning points DNS at (and later
 * deploys to). The SAME box and the SAME var name as branch staging's
 * `STAGING_VPS_ID_ENV` in activities.ts — REDECLARED here rather than imported,
 * because activities.ts re-exports this module (`export *`) and importing back
 * would be a load cycle (see `defaultProvisionCheckoutDeps`'s note). The fleet
 * layer's `assertSandboxVps` remains the real guard on the deploy phases.
 */
export const PROVISION_VPS_ID_ENV = "LAUNCHPAD_STAGING_VPS_ID";

/** The sandbox VPS id from the worker env — a refusal names the var, never a
 * silent wrong box. */
function provisionVpsIdFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env[PROVISION_VPS_ID_ENV];
  const vpsId = Number(raw);
  if (!raw || !Number.isInteger(vpsId) || vpsId <= 0) {
    throw ApplicationFailure.create({
      message: `provisioning: set ${PROVISION_VPS_ID_ENV} to the sandbox VPS id (e.g. 100001)`,
      type: "ProvisionConfig",
      nonRetryable: true,
    });
  }
  return vpsId;
}

/**
 * Collaborators {@link provisionDns} needs beyond its input — injectable so the
 * getVps → two-upsert sequence is unit-testable with no live Hostinger call
 * (the `runBranchStagingOp` deps posture). Defaults resolve the worker's
 * Hostinger token and a real client; the sandbox VPS id comes from
 * {@link PROVISION_VPS_ID_ENV}.
 */
export interface ProvisionDnsDeps {
  env: NodeJS.ProcessEnv;
  resolveHostingerToken: (tenantId: string) => string;
  createHostingerClient: (token: string) => Pick<HostingerClient, "getVps" | "upsertDnsRecord">;
}

const defaultProvisionDnsDeps: ProvisionDnsDeps = {
  env: process.env,
  resolveHostingerToken,
  createHostingerClient: (token) => new HostingerClient({ apiToken: token }),
};

/**
 * Phase B: idempotent, collision-safe A-record upserts for `<slug>.example.com`
 * and `<slug>.odoo.example.com`, both pointing at the sandbox VPS IPv4.
 *
 * `upsertDnsRecord` drives its decision off a zone read, never a write's status
 * code: a record already pointing elsewhere (a live customer like `client-b` on a
 * different VPS, spec 0148 B) is REFUSED, never overwritten; one already at the
 * target is a no-op. The VPS/token resolve worker-side from env, never input.
 */
export async function provisionDns(
  input: ProvisionProjectInput,
  deps: ProvisionDnsDeps = defaultProvisionDnsDeps,
): Promise<void> {
  try {
    const vpsId = provisionVpsIdFromEnv(deps.env);
    const token = deps.resolveHostingerToken("provisioning");
    const client = deps.createHostingerClient(token);
    const vps = await client.getVps(vpsId);
    const ipv4 = vps.ipv4?.[0]?.address;
    if (!ipv4) {
      throw ApplicationFailure.create({
        message: `provisionDns: VPS ${vpsId} has no IPv4 address to point DNS at`,
        type: "ProvisionConfig",
        nonRetryable: true,
      });
    }
    const zone = zoneOf(input);
    await client.upsertDnsRecord({ domain: zone, name: input.slug, content: ipv4 });
    await client.upsertDnsRecord({
      domain: zone,
      name: `${input.slug}.odoo`,
      content: ipv4,
    });
  } catch (err) {
    if (err instanceof ApplicationFailure) throw err;
    // A Hostinger conflict/API error carries its own retryable classification.
    const failure = toActivityFailure(err);
    throw ApplicationFailure.create({
      type: failure.type,
      message: failure.message,
      nonRetryable: !failure.retryable,
    });
  }
}

/** The Odoo host an odoo-next front sits behind: `<slug>.odoo.example.com`. The
 * `<slug>.odoo` A-record phase B upserts is what lets ACME issue for it, and
 * phase D's front points its `odooUrl` at `https://` this. One definition so the
 * two phases can never drift (VERIFICATION #11). */
/** Spec 0182: one definition, shared with the release deploy (`hosts.ts`). The
 * `zone` argument is gone — there is one zone, and it is ours. */
export function provisionOdooHost(slug: string): string {
  return odooHostFor(slug);
}

/** Worker env vars for the fleet SSH connection — SAME names/values as
 * activities.ts's `FLEET_SSH_IDENTITY_ENV`/`FLEET_SSH_USER_ENV`, REDECLARED
 * (not imported) because activities.ts re-exports this module (`export *`) and
 * importing back would be a load cycle (see `PROVISION_VPS_ID_ENV`'s note). */
const PROVISION_FLEET_SSH_IDENTITY_ENV = "LAUNCHPAD_FLEET_SSH_IDENTITY";
const PROVISION_FLEET_SSH_USER_ENV = "LAUNCHPAD_FLEET_SSH_USER";
const DEFAULT_FLEET_SSH_USER = "root";

/** The two Odoo passwords — same env vars as activities.ts's
 * `ODOO_MASTER_PASSWORD_ENV`/`ODOO_ADMIN_PASSWORD_ENV`, redeclared for the same
 * cycle reason as the SSH vars above. */
const PROVISION_ODOO_MASTER_PASSWORD_ENV = "LAUNCHPAD_ODOO_MASTER_PASSWORD";
const PROVISION_ODOO_ADMIN_PASSWORD_ENV = "LAUNCHPAD_ODOO_ADMIN_PASSWORD";

/** The SSH target for the sandbox box — identity file from the worker env
 * (required; no safe default), user overridable, host = the resolved IPv4. */
function provisionSshTarget(env: NodeJS.ProcessEnv, host: string): SshTarget {
  const identityFile = env[PROVISION_FLEET_SSH_IDENTITY_ENV];
  if (!identityFile) {
    throw ApplicationFailure.create({
      message: `provisioning: set ${PROVISION_FLEET_SSH_IDENTITY_ENV} (SSH private key path) on the worker`,
      type: "ProvisionConfig",
      nonRetryable: true,
    });
  }
  return { host, user: env[PROVISION_FLEET_SSH_USER_ENV] ?? DEFAULT_FLEET_SSH_USER, identityFile };
}

/** The two Odoo passwords from the worker env, failing (before any deploy) with
 * a message that names the missing variable — an optional security control is
 * one that silently is not there (spec 0121). */
function provisionOdooPasswords(env: NodeJS.ProcessEnv): {
  masterPassword: string;
  adminPassword: string;
} {
  const masterPassword = env[PROVISION_ODOO_MASTER_PASSWORD_ENV];
  const adminPassword = env[PROVISION_ODOO_ADMIN_PASSWORD_ENV];
  if (!masterPassword || !adminPassword) {
    const missing = [
      !masterPassword ? PROVISION_ODOO_MASTER_PASSWORD_ENV : null,
      !adminPassword ? PROVISION_ODOO_ADMIN_PASSWORD_ENV : null,
    ].filter(Boolean);
    throw ApplicationFailure.create({
      message: `provisionOdoo: set ${missing.join(" and ")} on the worker (spec 0121)`,
      type: "ProvisionConfig",
      nonRetryable: true,
    });
  }
  return { masterPassword, adminPassword };
}

/** The project's Odoo major from its `version` column — default 18 when absent,
 * a NAMED refusal when unparseable (never a silent different major). Mirrors
 * activities.ts's `odooVersionForProject`, redeclared for the same cycle reason. */
function provisionOdooVersion(version: string | null): OdooVersion {
  const raw = (version ?? "").trim();
  if (!raw) return 18;
  const major = Number(raw.split(".")[0]);
  if (major === 17 || major === 18 || major === 19) return major;
  throw ApplicationFailure.create({
    message: `provisionOdoo: project version ${JSON.stringify(raw)} is not an Odoo major (17|18|19) — fix the project's "version" field`,
    type: "ProvisionConfig",
    nonRetryable: true,
  });
}

/**
 * Collaborators {@link provisionOdoo} needs beyond its input — injectable so the
 * getVps → ssh → deploy sequence is unit-testable with no live SSH/Hostinger
 * call (the `runBranchStagingOp` deps posture). Defaults resolve the worker's
 * Hostinger token, a real client + `ExecSshRunner`, the DB password, the real
 * `deployProductionStack`, and the project's `version` column from the DB.
 */
/**
 * What a provision did about the customer's processes (spec 0205 D).
 *
 * `installed` is read from `ir_module_module`, so `requested` minus `installed`
 * is a real gap and not a difference of opinion between two log lines.
 */
export interface ModuleOutcome {
  slug: string;
  odooVersion: OdooVersion;
  requested: string[];
  installed: string[];
  missing: string[];
  refused: RefusedProceso[];
}

export interface ProvisionOdooDeps {
  env: NodeJS.ProcessEnv;
  resolveHostingerToken: (tenantId: string) => string;
  createHostingerClient: (token: string) => Pick<HostingerClient, "getVps">;
  createSshRunner: (target: SshTarget) => SshRunner;
  readOrCreateDbPassword: (tenantId: string) => Promise<string>;
  deployProductionStack: (opts: DeployOptions) => Promise<DeployResult>;
  /** The two things provisioning needs off the project row: which Odoo to run
   * and which processes the customer ticked (spec 0205). One read, because the
   * second one used to be a column nothing consumed. */
  resolveProject: (slug: string) => Promise<{ version: string | null; intake: Record<string, string> }>;
  /** Spec 0208: the read-only Odoo credentials this deploy creates in the tenant. */
  readOdooReadonly: (slug: string) => Promise<OdooReadonlyCredentials>;
  /** Spec 0205 D: record what was asked for, what `ir_module_module` confirms,
   * and what we refused — FAIL-OPEN, the `recordAgentRun` posture: a down
   * control-plane DB must not fail a provision whose Odoo is up and serving. */
  recordModuleOutcome: (outcome: ModuleOutcome) => Promise<void>;
  /** Spec 0206: the company's addons, cloned at their pinned commits and packed
   * into the archive `deployProductionStack` unpacks into `/mnt/extra-addons`. */
  fetchVendoredAddons: (addons: readonly VendoredAddon[]) => Promise<string>;
  /** Spec 0171: record the VPS this project's production actually runs on, so
   * the Versiones button has a target instead of a refusal. */
  persistVpsId: (slug: string, vpsId: number) => Promise<void>;
}

const defaultProvisionOdooDeps: ProvisionOdooDeps = {
  env: process.env,
  resolveHostingerToken,
  createHostingerClient: (token) => new HostingerClient({ apiToken: token }),
  createSshRunner: (target) => new ExecSshRunner(target),
  readOrCreateDbPassword,
  deployProductionStack,
  resolveProject: async (slug) => {
    const { createDb, createPool, projectBySlug } = await import("@launchpad/db");
    const pool = createPool();
    try {
      const row = await projectBySlug(createDb(pool), slug);
      return {
        version: row?.version ?? null,
        intake: (row?.intake as Record<string, string> | null) ?? {},
      };
    } finally {
      await pool.end();
    }
  },
  fetchVendoredAddons: (addons) => fetchVendoredAddons(addons),
  readOdooReadonly: (slug) => readOrCreateOdooReadonlyCredentials(slug),
  recordModuleOutcome: async (outcome) => {
    try {
      const { createDb, createPool, insertAuditLog } = await import("@launchpad/db");
      const pool = createPool();
      try {
        await insertAuditLog(createDb(pool), {
          actor: "provisioning",
          action: "provision.modules",
          target: outcome.slug,
          // Module names and our own refusal reasons only — never the customer's
          // words (CLAUDE.md's rule for audit metadata).
          metadata: {
            odooVersion: outcome.odooVersion,
            requested: outcome.requested,
            installed: outcome.installed,
            missing: outcome.missing,
            refused: outcome.refused,
          },
        });
      } finally {
        await pool.end();
      }
    } catch (err) {
      console.error(`provisionOdoo: could not record module outcome for ${outcome.slug}:`, err);
    }
  },
  persistVpsId: async (slug, vpsId) => {
    const { createDb, createPool, setProjectVpsId } = await import("@launchpad/db");
    const pool = createPool();
    try {
      await setProjectVpsId(createDb(pool), slug, String(vpsId));
    } finally {
      await pool.end();
    }
  },
};

/**
 * Phase C: deploy Odoo with the `<slug>.odoo.example.com` router-host override +
 * ACME `letsencrypt` certresolver, onto the sandbox VPS. `deployProductionStack`
 * verifies the stack is healthy and the ingress serves that host over TLS
 * internally; a fleet failure (including the sandbox refusal for a
 * non-allowlisted VPS) surfaces via `toActivityFailure`. VPS/token/passwords
 * resolve worker-side from env, never from input.
 */
export async function provisionOdoo(
  input: ProvisionProjectInput,
  deps: ProvisionOdooDeps = defaultProvisionOdooDeps,
): Promise<void> {
  try {
    const vpsId = provisionVpsIdFromEnv(deps.env);
    const token = deps.resolveHostingerToken("provisioning");
    const client = deps.createHostingerClient(token);
    const vps = await client.getVps(vpsId);
    const ipv4 = vps.ipv4?.[0]?.address;
    if (!ipv4) {
      throw ApplicationFailure.create({
        message: `provisionOdoo: VPS ${vpsId} has no IPv4 address to SSH to`,
        type: "ProvisionConfig",
        nonRetryable: true,
      });
    }
    const ssh = deps.createSshRunner(provisionSshTarget(deps.env, ipv4));
    const project = await deps.resolveProject(input.slug);
    const odooVersion = provisionOdooVersion(project.version);
    // Spec 0205 C: the processes the customer ticked in `/new`, as modules. Until
    // now this call had no `modules:` at all — the answers were stored and the
    // tenant came up stock, so ticking "Punto de venta (POS)" changed nothing.
    const plan = modulesFor(procesosFromIntake(project.intake), odooVersion);
    // Spec 0206: the addons the company owns, which are NOT in the Odoo image — the
    // house style on every tenant, plus `cdfi_invoice` when the procesos asked
    // for it (`modulesFor` only names it on a series the registry covers).
    const vendored = vendoredAddonsFor(odooVersion, { cfdi: plan.install.includes(CFDI_MODULE) });
    const addonsArchive = await deps.fetchVendoredAddons(vendored);
    // One install list. The vendored names must be here too or the archive lands
    // on disk and Odoo is never told about it — the defect spec 0176 paid for.
    const modules = [...plan.install];
    for (const a of vendored) if (!modules.includes(a.module)) modules.push(a.module);
    const { masterPassword, adminPassword } = provisionOdooPasswords(deps.env);
    // Spec 0208: the read-only login the front will authenticate with, created
    // by this deploy inside the tenant's own database.
    const readonly = await deps.readOdooReadonly(input.slug);
    const dbPassword = await deps.readOrCreateDbPassword(input.slug);
    const deployed = await deps.deployProductionStack({
      tenantId: input.slug,
      vpsId,
      ssh,
      odooVersion,
      domain: zoneOf(input),
      host: provisionOdooHost(input.slug),
      certResolver: "letsencrypt",
      dbPassword,
      masterPassword,
      adminPassword,
      odooReadonlyUser: readonly.user,
      odooReadonlyPassword: readonly.password,
      ...(modules.length > 0 ? { modules } : {}),
      ...(addonsArchive ? { addonsArchive } : {}),
    });
    // Spec 0205 D. `deployed.modules` is now read from `ir_module_module`, so a
    // module in `plan.install` and absent here did NOT install — record it
    // instead of failing the provision: the Odoo is up and reachable, and a red
    // run would hide a working tenant. Refusals ride along, because a proceso
    // asked for and silently skipped is the thing this spec exists to stop.
    // Spec 0206: `modules`, not `plan.install` — a vendored addon that failed to
    // install is exactly as invisible as a proceso one, and it is the one whose
    // files travelled furthest to get there.
    if (modules.length > 0 || plan.refused.length > 0) {
      const installed = deployed.modules ?? [];
      await deps.recordModuleOutcome({
        slug: input.slug,
        odooVersion,
        requested: modules,
        installed,
        missing: modules.filter((m) => !installed.includes(m)),
        refused: plan.refused,
      });
    }
    // Spec 0171: AFTER the deploy returns, never before — a `vps_id` written
    // ahead of it would record an intention, and an intention that reads like a
    // deployed fact is worse than a null. Without this the project's Odoo runs
    // on exactly one known box while the Versiones button refuses for lack of a
    // target (spec 0170's `deployToFleet` guard).
    await deps.persistVpsId(input.slug, vpsId);
  } catch (err) {
    if (err instanceof ApplicationFailure) throw err;
    const failure = toActivityFailure(err);
    throw ApplicationFailure.create({
      type: failure.type,
      message: failure.message,
      nonRetryable: !failure.retryable,
    });
  }
}

const execFileP = promisify(execFile);

// Spec 0172: the pack seam moved to `pack-checkout.ts` when a branch front and a
// release front became callers too. Re-exported so every existing importer of
// `PackCheckout` from this module keeps working.
export { packCheckoutWithTar, type PackCheckout } from "./pack-checkout.js";

/**
 * Collaborators {@link provisionFront} needs beyond its input — injectable so
 * the resolve-root → pack → getVps → ssh → deploy sequence is unit-testable with
 * no live tar/SSH/Hostinger/DB call (the `runBranchStagingOp` deps posture).
 */
export interface ProvisionFrontDeps {
  env: NodeJS.ProcessEnv;
  resolveHostingerToken: (tenantId: string) => string;
  createHostingerClient: (token: string) => Pick<HostingerClient, "getVps">;
  createSshRunner: (target: SshTarget) => SshRunner;
  packCheckout: PackCheckout;
  deployFrontStack: (opts: DeployFrontStackOptions) => Promise<FrontDeployResult>;
  /** The project's persisted `repo_root` (phase A) — null means no checkout to
   * build the front from. */
  resolveProjectRepoRoot: (slug: string) => Promise<string | null>;
  /** Spec 0208: the tenant's read-only Odoo credentials, read-or-created. The
   * matching `res.users` is created by `deployProductionStack` in phase C, so
   * by the time the front deploys the login already works. */
  readOdooReadonly: (slug: string) => Promise<OdooReadonlyCredentials>;
}

const defaultProvisionFrontDeps: ProvisionFrontDeps = {
  env: process.env,
  readOdooReadonly: (slug) => readOrCreateOdooReadonlyCredentials(slug),
  resolveHostingerToken,
  createHostingerClient: (token) => new HostingerClient({ apiToken: token }),
  createSshRunner: (target) => new ExecSshRunner(target),
  packCheckout: packCheckoutWithTar,
  deployFrontStack,
  resolveProjectRepoRoot: async (slug) => {
    const { createDb, createPool, projectBySlug } = await import("@launchpad/db");
    const pool = createPool();
    try {
      return (await projectBySlug(createDb(pool), slug))?.repoRoot ?? null;
    } finally {
      await pool.end();
    }
  },
};

/**
 * Phase D: tar the project's phase-A checkout → base64 → {@link deployFrontStack}
 * onto the sandbox VPS, routed at `<slug>.example.com` and reaching its Odoo at
 * `https://<slug>.odoo.example.com` (the phase-C stack). ACME `letsencrypt` — the
 * `<slug>` A-record phase B upserts is what lets it issue. VPS/token resolve
 * worker-side from env, never from input; the `odooUrl` reuses
 * {@link provisionOdooHost} so it cannot drift from phase C (VERIFICATION #11).
 */
export async function provisionFront(
  input: ProvisionProjectInput,
  deps: ProvisionFrontDeps = defaultProvisionFrontDeps,
): Promise<void> {
  try {
    const vpsId = provisionVpsIdFromEnv(deps.env);
    const repoRoot = await deps.resolveProjectRepoRoot(input.slug);
    if (!repoRoot) {
      throw ApplicationFailure.create({
        message: `provisionFront: no hay checkout (repo_root) para "${input.slug}" — la fase repo debe correr primero.`,
        type: "ProvisionConfig",
        nonRetryable: true,
      });
    }
    const token = deps.resolveHostingerToken("provisioning");
    const client = deps.createHostingerClient(token);
    const vps = await client.getVps(vpsId);
    const ipv4 = vps.ipv4?.[0]?.address;
    if (!ipv4) {
      throw ApplicationFailure.create({
        message: `provisionFront: VPS ${vpsId} has no IPv4 address to SSH to`,
        type: "ProvisionConfig",
        nonRetryable: true,
      });
    }
    const ssh = deps.createSshRunner(provisionSshTarget(deps.env, ipv4));
    const sourceArchive = await deps.packCheckout(repoRoot);
    const readonly = await deps.readOdooReadonly(input.slug);
    await deps.deployFrontStack({
      slug: input.slug,
      vpsId,
      ssh,
      domain: zoneOf(input),
      odooUrl: `https://${provisionOdooHost(input.slug)}`,
      certResolver: "letsencrypt",
      sourceArchive,
      // Spec 0208: the front reads its own Odoo. Server-side only — never
      // `NEXT_PUBLIC_`, which would inline the password into the browser bundle.
      odooDb: tenantDbName(input.slug, "prod"),
      odooUser: readonly.user,
      odooPassword: readonly.password,
    });
  } catch (err) {
    if (err instanceof ApplicationFailure) throw err;
    const failure = toActivityFailure(err);
    throw ApplicationFailure.create({
      type: failure.type,
      message: failure.message,
      nonRetryable: !failure.retryable,
    });
  }
}

/**
 * HTTPS GET returning the response status, with TLS validation ON (Node's
 * default `rejectUnauthorized: true`). A self-signed / Traefik-default cert makes
 * the handshake REJECT — which is exactly how this proves the ACME cert is a
 * real, publicly-trusted one and not the placeholder the deploy's `curl -k`
 * ingress check cannot tell apart. Rejects on a network error or a >15s hang.
 */
function httpsStatusGet(url: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = https.get(url, (res) => {
      res.resume(); // drain so the socket frees
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("request timed out after 15s")));
  });
}

/** Poll defaults for {@link verifyProvision} — generous like the deploy
 * verifiers, since public DNS propagation and first-boot ACME issuance both lag
 * the deploy that requested them. */
const DEFAULT_PROVISION_VERIFY_DEADLINE_MS = 180_000;
const DEFAULT_PROVISION_VERIFY_INTERVAL_MS = 5_000;

/**
 * Collaborators {@link verifyProvision} needs — injectable so the getVps →
 * poll(DNS + cert) sequence is unit-testable with no live DNS/HTTPS/Hostinger
 * call (the `runBranchStagingOp` deps posture). Defaults use Node's public
 * `dns.resolve4`, a real cert-validating HTTPS GET, and the worker's Hostinger
 * token/client.
 */
export interface ProvisionVerifyDeps {
  env: NodeJS.ProcessEnv;
  resolveHostingerToken: (tenantId: string) => string;
  createHostingerClient: (token: string) => Pick<HostingerClient, "getVps">;
  /** Public DNS A-record lookup (Node's `dns.resolve4`), NOT the Hostinger API —
   * the acceptance is that the name RESOLVES, not that the write was accepted. */
  resolve4: (hostname: string) => Promise<string[]>;
  /** HTTPS GET status with TLS validation on — rejects on an invalid cert. */
  httpsStatus: (url: string) => Promise<number>;
  deadlineMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
}

const defaultProvisionVerifyDeps: ProvisionVerifyDeps = {
  env: process.env,
  resolveHostingerToken,
  createHostingerClient: (token) => new HostingerClient({ apiToken: token }),
  resolve4: (hostname) => dnsResolve4(hostname),
  httpsStatus: httpsStatusGet,
  deadlineMs: DEFAULT_PROVISION_VERIFY_DEADLINE_MS,
  intervalMs: DEFAULT_PROVISION_VERIFY_INTERVAL_MS,
  sleep: (ms) => sleep(ms),
};

/**
 * Phase F (spec 0161 acceptance B–D): assert the END STATE the two deploys
 * structurally CANNOT, because each verifies from the VPS with `curl --resolve`
 * + `-k` — bypassing public DNS and skipping cert validation. The gap this
 * closes, and ONLY this:
 *   1. both hostnames resolve, THROUGH public DNS, to the sandbox VPS IPv4 (a
 *      record pointing at another box — the `client-b` collision shape, spec 0148 B
 *      — fails here; the deploy's `--resolve` could never see it);
 *   2. `https://<slug>.odoo.example.com` answers 200 with a VALID, publicly-trusted
 *      cert — the ACME proof the deploy's `-k` cannot make.
 *
 * What stays (human), by design (spec 0161 acceptance B–D `(human)` item):
 * `https://<slug>.example.com` rendering data *from* that Odoo. "A static 200
 * cannot fail for the right reason" (spec 0161) — a programmatic 200 on the front
 * cannot tell real Odoo-sourced content from a fallback page, so a human eye is
 * the only check that can actually fail there. This activity deliberately does
 * NOT assert the front's body, to avoid a green that proves nothing.
 *
 * Polls to a deadline (the `verifyOdooHttp`/`verifyIngress` pattern): DNS
 * propagation and first-boot ACME issuance both lag the deploy that asked for
 * them. VPS/token resolve worker-side from env, never from input.
 */
export async function verifyProvision(
  input: ProvisionProjectInput,
  deps: ProvisionVerifyDeps = defaultProvisionVerifyDeps,
): Promise<void> {
  const frontHost = frontHostFor(input.slug);
  const odooHost = provisionOdooHost(input.slug);
  try {
    const vpsId = provisionVpsIdFromEnv(deps.env);
    const token = deps.resolveHostingerToken("provisioning");
    const client = deps.createHostingerClient(token);
    const vps = await client.getVps(vpsId);
    const ipv4 = vps.ipv4?.[0]?.address;
    if (!ipv4) {
      throw ApplicationFailure.create({
        message: `verifyProvision: VPS ${vpsId} has no IPv4 address to check DNS against`,
        type: "ProvisionConfig",
        nonRetryable: true,
      });
    }

    let elapsedMs = 0;
    let lastFailure = "(no check ran)";
    for (;;) {
      lastFailure = await checkProvisionEndState(deps, frontHost, odooHost, ipv4);
      if (!lastFailure) return;
      if (elapsedMs >= deps.deadlineMs) break;
      await deps.sleep(deps.intervalMs);
      elapsedMs += deps.intervalMs;
    }
    throw ApplicationFailure.create({
      message: `verifyProvision: ${input.slug} end-state checks did not pass within ${deps.deadlineMs}ms: ${lastFailure}`,
      type: "ProvisionVerifyFailed",
      nonRetryable: true,
    });
  } catch (err) {
    if (err instanceof ApplicationFailure) throw err;
    const failure = toActivityFailure(err);
    throw ApplicationFailure.create({
      type: failure.type,
      message: failure.message,
      nonRetryable: !failure.retryable,
    });
  }
}

/**
 * One pass of the end-state checks — returns "" on success, else the FIRST
 * failing check as a human-readable reason (so the poll can report the last one
 * on timeout). DNS/HTTPS errors are caught HERE and turned into a reason rather
 * than thrown: a still-propagating record or a not-yet-issued cert is a
 * retry-until-deadline condition, not a fatal one.
 */
async function checkProvisionEndState(
  deps: ProvisionVerifyDeps,
  frontHost: string,
  odooHost: string,
  ipv4: string,
): Promise<string> {
  for (const host of [frontHost, odooHost]) {
    let addrs: string[];
    try {
      addrs = await deps.resolve4(host);
    } catch (err) {
      return `${host} does not resolve yet (${(err as Error).message})`;
    }
    if (!addrs.includes(ipv4)) {
      return `${host} resolves to ${addrs.join(", ") || "(none)"}, not the sandbox VPS ${ipv4}`;
    }
  }
  let status: number;
  try {
    status = await deps.httpsStatus(`https://${odooHost}/web/login`);
  } catch (err) {
    return `https://${odooHost} has no valid certificate yet (${(err as Error).message})`;
  }
  if (status !== 200) {
    return `https://${odooHost}/web/login answered ${status}, not 200`;
  }
  return "";
}
