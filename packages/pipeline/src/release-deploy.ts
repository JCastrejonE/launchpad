/**
 * Deploying a release to production (spec 0170).
 *
 * Lives in the worker because everything production needs is worker-only: the
 * fleet SSH identity, the Hostinger token, the tenant DB passwords. The web side
 * decides and starts; this does.
 *
 * Dispatches on the project's `productionKind`, and **refuses by name** when the
 * configuration a target needs is missing. A deploy that quietly did nothing, or
 * that guessed at a VPS, would be worse than one that says which field is empty.
 */
import { ApplicationFailure } from "@temporalio/activity";
import {
  ExecSshRunner,
  HostingerClient,
  deployFrontStack,
  deployProductionStack,
  installTenantModules,
  discoverAddons,
  packAddonsWithTar,
  readOrCreateDbPassword,
  readOrCreateOdooReadonlyCredentials,
  tenantDbName,
  resolveHostingerToken,
  type DeployFrontStackOptions,
  type FrontDeployResult,
  type OdooReadonlyCredentials,
  type OdooVersion,
  type SshRunner,
  type SshTarget,
} from "@launchpad/fleet-hostinger";
import { packCheckoutWithTar, type PackCheckout } from "./pack-checkout.js";
import { odooHostFor, provisionedZone } from "./hosts.js";

export interface DeployReleaseInput {
  projectSlug: string;
  /** The release being deployed — carried so failures name it. */
  version: string;
  releaseId: string;
  commitSha: string;
  deployedBy: string;
  /** Spec 0176: compact UTC stamp for the pre-install backup, minted by the
   * WORKFLOW so an activity retry reuses one directory (spec 0105). */
  backupTimestamp?: string;
}

/**
 * A throwaway copy of the repo AT `commitSha`.
 *
 * `git archive` rather than a checkout: the project's checkout is shared with
 * pipeline runs, and leaving it on a detached HEAD would break the next one. An
 * export mutates nothing and gives exactly the tree the release names.
 */
export async function exportCommitToTemp(slug: string, commitSha: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);

  const { checkoutPathFor } = await import("./checkout.js");
  const repoRoot = checkoutPathFor(slug);
  // The checkout may predate this commit — fetch before asking for it, or the
  // export fails on a sha the worker has simply never seen.
  await exec("git", ["fetch", "origin"], { cwd: repoRoot });
  const dest = await mkdtemp(path.join(tmpdir(), `release-${slug}-`));
  await exec("bash", ["-c", `git -C ${JSON.stringify(repoRoot)} archive ${JSON.stringify(commitSha)} | tar -x -C ${JSON.stringify(dest)}`]);
  return dest;
}

export interface DeployReleaseResult {
  /** Whatever identifies the deploy on its target: a stack name, a branch. */
  deployRef: string;
}

const FLEET_SSH_IDENTITY_ENV = "LAUNCHPAD_FLEET_SSH_IDENTITY";
const FLEET_SSH_USER_ENV = "LAUNCHPAD_FLEET_SSH_USER";

/** Production stacks are `prod`, the name `remoteStackDir` already expects. */
export const PRODUCTION_STACK = "prod";

// Spec 0182: the hosts come from `hosts.ts`, which provisioning also imports —
// so the release cannot derive a different name than the one that was created.
// The `project.domain` this used to read is the CUSTOMER's domain now: theirs to
// point at us, verified by spec 0185, never a source for the records we deploy.

/** Does this project kind run a Next front alongside its Odoo (spec 0172)? */
function hasFront(kind: string | null | undefined): boolean {
  return kind === "odoo_next";
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    return configFailure(`release deploy: falta ${name} en el worker`);
  }
  return value;
}

function configFailure(message: string): never {
  throw ApplicationFailure.create({ message, type: "ReleaseDeployConfig", nonRetryable: true });
}

/** The project's Odoo major, or a NAMED refusal — never a silent different major. */
export function odooSeriesOf(version: string | null | undefined): OdooVersion {
  const raw = (version ?? "").trim();
  if (!raw) return 18;
  const major = Number(raw.split(".")[0]);
  if (major === 17 || major === 18 || major === 19) return major;
  return configFailure(
    `release deploy: la versión de Odoo del proyecto (${JSON.stringify(raw)}) no es 17, 18 ni 19`,
  );
}

export interface DeployReleaseDeps {
  env: NodeJS.ProcessEnv;
  createSshRunner: (target: SshTarget) => SshRunner;
  createHostingerClient: (token: string) => Pick<HostingerClient, "getVps">;
  resolveHostingerToken: (tenantId: string) => string;
  deployProductionStack: typeof deployProductionStack;
  /** Spec 0176: the install pass for a database that ALREADY exists — where
   * `deployProductionStack`'s init-time `-i` never runs. */
  installTenantModules: typeof installTenantModules;
  readOrCreateDbPassword: (tenantId: string) => Promise<string>;
  /** Spec 0208: the tenant's read-only Odoo credentials for its front. */
  readOdooReadonly: (tenantId: string) => Promise<OdooReadonlyCredentials>;
  /** Spec 0172: the release's front — packed from the same export the addons
   * come from, so the site and the backend ship the same commit. */
  packCheckout: PackCheckout;
  deployFrontStack: (opts: DeployFrontStackOptions) => Promise<FrontDeployResult>;
  /** The checkout to pack addons from, already at `commitSha`. */
  materializeAt: (slug: string, commitSha: string) => Promise<string>;
  loadProject: (slug: string) => Promise<{
    slug: string;
    kind: string | null;
    productionKind: string | null;
    vpsId: string | null;
    version: string | null;
    domain: string | null;
  } | null>;
}

/**
 * Deploy to our own fleet: the release's addons, installed on the tenant's own
 * production stack.
 *
 * The addons are packed from a checkout AT THE RELEASE'S COMMIT, not from
 * whatever the checkout happened to be on — the release is a promise about a
 * specific tree, and packing anything else would break it.
 */
async function deployToFleet(
  input: DeployReleaseInput,
  project: NonNullable<Awaited<ReturnType<DeployReleaseDeps["loadProject"]>>>,
  deps: DeployReleaseDeps,
): Promise<DeployReleaseResult> {
  if (!project.vpsId) {
    configFailure(
      `release deploy: el proyecto "${project.slug}" es de flota pero no tiene VPS asignada ` +
        `(campo vps_id). Asígnala antes de desplegar.`,
    );
  }
  const vpsId = Number(project.vpsId);
  if (!Number.isInteger(vpsId) || vpsId <= 0) {
    configFailure(`release deploy: vps_id ${JSON.stringify(project.vpsId)} no es un id de VPS`);
  }
  const identityFile = deps.env[FLEET_SSH_IDENTITY_ENV];
  if (!identityFile) configFailure(`release deploy: falta ${FLEET_SSH_IDENTITY_ENV} en el worker`);

  const client = deps.createHostingerClient(deps.resolveHostingerToken(project.slug));
  const vps = await client.getVps(vpsId);
  const ipv4 = vps.ipv4?.[0]?.address;
  if (!ipv4) configFailure(`release deploy: la VPS ${vpsId} no tiene IPv4`);

  const ssh = deps.createSshRunner({
    host: ipv4,
    user: deps.env[FLEET_SSH_USER_ENV] ?? "root",
    identityFile,
  });

  const { existsSync } = await import("node:fs");
  const nodePath = (await import("node:path")).default;

  const repoRoot = await deps.materializeAt(project.slug, input.commitSha);
  let addonPaths: string[];
  let archive: string;
  // Spec 0172: the front's build context, packed from the SAME export as the
  // addons — the site and the backend must ship one commit, not two.
  let frontArchive = "";
  try {
    addonPaths = discoverAddons(repoRoot);
    archive = addonPaths.length > 0 ? await packAddonsWithTar(repoRoot, addonPaths) : "";
    const hasDockerfile = existsSync(nodePath.join(repoRoot, "Dockerfile"));
    if (hasFront(project.kind)) {
      if (!hasDockerfile) {
        // A project whose kind says it HAS a front, whose release tree has
        // nothing to build it from. Deploying the Odoo half and calling that a
        // release is the silent-half-deploy this spec exists to close.
        configFailure(
          `release deploy: "${project.slug}" es odoo-next pero el commit ${input.commitSha.slice(0, 9)} ` +
            `no tiene Dockerfile en la raíz, así que no hay front que construir.`,
        );
      }
      frontArchive = await deps.packCheckout(repoRoot);
    }
  } finally {
    // The export is a throwaway; leaving one per deploy would fill /tmp on the
    // worker over time.
    const { rm } = await import("node:fs/promises");
    await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
  }

  const result = await deps.deployProductionStack({
    tenantId: project.slug,
    vpsId,
    ssh,
    odooVersion: odooSeriesOf(project.version),
    domain: provisionedZone(),
    stack: PRODUCTION_STACK,
    // Spec 0175: the host provisioning assigned, not `deployProductionStack`'s
    // `prod.<slug>` default. Without these two lines a release re-renders the
    // compose on a hostname the customer's DNS never knew, and the old one
    // stops routing — measured live: 404 on the real name, 000 on the new one.
    host: odooHostFor(project.slug),
    certResolver: "letsencrypt",
    dbPassword: await deps.readOrCreateDbPassword(project.slug),
    // The master and admin passwords are worker-only env, exactly as the
    // provisioning deploy takes them. A missing one refuses by name rather than
    // standing up an Odoo whose database manager has a default password.
    masterPassword: requireEnv(deps.env, "LAUNCHPAD_ODOO_MASTER_PASSWORD"),
    adminPassword: requireEnv(deps.env, "LAUNCHPAD_ODOO_ADMIN_PASSWORD"),
    // Spec 0208: re-asserted on every release, like the admin password.
    odooReadonlyUser: (await deps.readOdooReadonly(project.slug)).user,
    odooReadonlyPassword: (await deps.readOdooReadonly(project.slug)).password,
    ...(addonPaths.length > 0
      ? { modules: addonPaths.map((p) => p.split("/").pop() as string), addonsArchive: archive }
      : {}),
  });

  // Spec 0176: install the addons INTO the database. `deployProductionStack`
  // only installs at init, and a project's database is created by provisioning
  // — so every release after the first copied the addon to disk and left Odoo
  // unaware of it. Measured on sushi 1.0.0: `sushi_menu` in /mnt/extra-addons,
  // absent from `ir_module_module`, deploy green.
  //
  // Not swallowed. A release whose code shipped and whose module never
  // installed is the silent half-deploy this exists to end.
  const modules = addonPaths.map((p) => p.split("/").pop() as string);
  if (modules.length > 0) {
    await deps.installTenantModules({
      tenantId: project.slug,
      ssh,
      stack: PRODUCTION_STACK,
      modules,
      // Caller-supplied on purpose (spec 0105): an activity retry with a
      // self-generated stamp orphans one backup directory per attempt. The
      // release id is stable and unique for this deploy.
      timestamp: input.backupTimestamp ?? configFailure(
        "release deploy: falta backupTimestamp — lo genera el workflow, no la actividad (spec 0176)",
      ),
    });
  }

  // Spec 0172: then the front, from the same commit. AFTER Odoo deliberately —
  // the front reads Odoo at boot, and a front pointed at a backend that has not
  // migrated yet shows an error page instead of the change that was shipped.
  if (frontArchive) {
    const readonly = await deps.readOdooReadonly(project.slug);
    await deps.deployFrontStack({
      slug: project.slug,
      vpsId,
      ssh,
      domain: provisionedZone(),
      odooUrl: `https://${odooHostFor(project.slug)}`,
      certResolver: "letsencrypt",
      sourceArchive: frontArchive,
      // Spec 0208. Same production database the Odoo half just deployed to.
      odooDb: tenantDbName(project.slug, PRODUCTION_STACK),
      odooUser: readonly.user,
      odooPassword: readonly.password,
    });
  }

  return { deployRef: result.stack ?? PRODUCTION_STACK };
}

/**
 * Deploy the release to production.
 *
 * `odoosh` is deliberately NOT implemented here yet: on odoo.sh the customer's
 * own platform builds from their production branch, so "deploy" means pushing
 * that commit to a branch whose name this model does not record. Refusing with
 * that sentence is more useful than guessing `production` and pushing to a
 * customer's repo.
 */
export async function deployRelease(
  input: DeployReleaseInput,
  deps: DeployReleaseDeps,
): Promise<DeployReleaseResult> {
  const project = await deps.loadProject(input.projectSlug);
  if (!project) configFailure(`release deploy: no existe el proyecto "${input.projectSlug}"`);

  switch (project.productionKind) {
    case "fleet":
      return deployToFleet(input, project, deps);
    case "odoosh":
      return configFailure(
        `release deploy: el despliegue a odoo.sh todavía no está implementado. En odoo.sh la ` +
          `plataforma del cliente construye desde SU rama de producción, y este modelo aún no ` +
          `guarda cuál es. Haz el merge a esa rama a mano por ahora.`,
      );
    default:
      return configFailure(
        `release deploy: el proyecto "${project.slug}" no tiene producción configurada ` +
          `(production_kind = ${JSON.stringify(project.productionKind)}).`,
      );
  }
}

export const defaultDeployReleaseDeps: DeployReleaseDeps = {
  env: process.env,
  readOdooReadonly: (tenantId) => readOrCreateOdooReadonlyCredentials(tenantId),
  createSshRunner: (target) => new ExecSshRunner(target),
  createHostingerClient: (token) => new HostingerClient({ apiToken: token }),
  resolveHostingerToken,
  deployProductionStack,
  installTenantModules,
  readOrCreateDbPassword,
  packCheckout: packCheckoutWithTar,
  deployFrontStack,
  materializeAt: async (slug, commitSha) => exportCommitToTemp(slug, commitSha),
  loadProject: async (slug) => {
    const { createDb, createPool, projectBySlug } = await import("@launchpad/db");
    const pool = createPool();
    try {
      const row = await projectBySlug(createDb(pool), slug);
      if (!row) return null;
      return {
        slug: row.slug,
        kind: row.kind,
        productionKind: row.productionKind,
        vpsId: row.vpsId,
        version: row.version,
        domain: row.domain,
      };
    } finally {
      await pool.end();
    }
  },
};
