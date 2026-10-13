/**
 * Per-spec staging environments on our own fleet (spec 0119).
 *
 * ## Why we build these rather than use odoo.sh's
 *
 * The owner: *"not all our customers will have an odoo.sh account."* Staging has to be
 * something we provide, not something we borrow. Production deployment stays
 * delegated — for an odoo.sh customer the merge to `main` deploys it, and for a
 * customer we host, the existing `deployProductionStack` path already does.
 *
 * ## How little of this is new
 *
 * Almost none of it. `deployProductionStack` is misnamed: it already takes
 * `stack?: StackName`, and `remoteStackDir`, `composeProjectName`,
 * `tenantDbName` and the template's Traefik router are ALL stack-scoped
 * already. The template even says so — *"`${STACK}` … prod today;
 * staging/spec-<id> reserved for a future add"*. Three tenant stacks coexist on
 * the sandbox VPS today, which is the multi-stack model already proven live.
 *
 * So this module is: name the stack after the spec, get the change's addons
 * onto the box, and — the part that actually matters — **take the stack down
 * again**.
 *
 * ## Teardown is not optional
 *
 * Each stack is an Odoo container, a Postgres container, and two named volumes.
 * A staging environment created per spec and never destroyed leaks a database
 * volume per spec, forever, onto one 16 GB box. `destroyStagingStack` exists in
 * this first slice for that reason and not as a nicety.
 *
 * ## ADR-013 confines this to the sandbox VPS
 *
 * `deployProductionStack` calls `assertSandboxVps` at the lowest layer, so a
 * staging deploy to any VPS outside `infra/fleet-sandbox.json` is hard-refused
 * without this module doing anything. Widening the fleet is a human commit to
 * that allowlist — agents never edit it.
 */
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import posixPath from "node:path/posix";
import { createHash } from "node:crypto";
import { FleetError } from "./errors.js";
import { assertSandboxVps } from "./sandbox.js";
import {
  decideProductionCopy,
  dumpProduction,
  restoreIntoBranch,
} from "./prod-copy.js";
import { neutralizeRestoredDb } from "./neutralize.js";
import type { SshRunner } from "./ssh.js";
import {
  composeProjectName,
  deployProductionStack,
  tenantDbName,
  remoteComposePath,
  remoteStackDir,
  routerHost,
  type DeployFrontStackOptions,
  type DeployResult,
  type FrontDeployResult,
  type OdooVersion,
  type StackName,
} from "./stack.js";

const execFileAsync = promisify(execFile);

/** A spec id is four digits — the same shape `workflowIdFor` uses. */
const SPEC_ID_RE = /^\d{4}$/;

/**
 * The stack name a spec's staging environment uses: `spec-0120`.
 *
 * This is the value that ends up in the compose project name, the database
 * name, the remote directory and the Traefik host rule, so it must be a safe
 * DNS label and a safe path segment. Deriving it from a validated four-digit id
 * makes that true by construction rather than by sanitizing later.
 */
export function stagingStackName(specId: string): StackName {
  if (!SPEC_ID_RE.test(specId)) {
    throw new FleetError("config", `invalid spec id ${JSON.stringify(specId)} (must be exactly 4 digits)`, {
      retryable: false,
    });
  }
  return `spec-${specId}`;
}

/** True iff `stack` is a per-spec staging stack — the one predicate that
 * decides what teardown and capacity accounting may touch. `prod` must never
 * match; that is the whole point. */
export function isStagingStack(stack: StackName): boolean {
  return /^spec-\d{4}$/.test(stack);
}

/**
 * The stack name a BRANCH's staging server uses (spec 0134):
 * `br-<slug≤20>-<sha256(branch)[0..6]>`.
 *
 * Branch names carry `/`, `_` and other characters illegal in a compose
 * project name and a DNS label, so a slug is unavoidable — and a bare slug
 * invites collisions (`feature/foo` vs `feature-foo` slug identically). The
 * 6-hex hash of the EXACT branch name kills them. ≤27 chars total fits the
 * DNS label; `composeProjectName`/`tenantDbName` sanitize further downstream.
 *
 * The `br-` prefix is deliberately disjoint from `spec-NNNN`: every existing
 * spec-only refusal, teardown and sweep path provably cannot touch a branch
 * stack, and vice versa.
 */
export function branchStackName(branch: string): StackName {
  const name = branch.trim();
  if (!name) {
    throw new FleetError("config", "branchStackName: branch must not be empty", { retryable: false });
  }
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 20)
      .replace(/-+$/g, "") || "b";
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 6);
  return `br-${slug}-${hash}`;
}

/** True iff `stack` is a per-branch staging stack — `br-` is disjoint from
 * both `spec-NNNN` and `prod` by construction. */
export function isBranchStack(stack: StackName): boolean {
  return /^br-[a-z0-9][a-z0-9-]*$/.test(stack);
}

/**
 * The stack a branch's Next front runs as (spec 0172): its Odoo stack's name
 * plus `-front`, so the two are one glance apart on the box and the front is
 * still a `br-*` stack for `isBranchStack` and the destroy guard.
 */
export function frontStackFor(branchStack: StackName): StackName {
  return `${branchStack}-front`;
}

/**
 * The branch stack that CLAIMS `stack` — itself, or, for a front, its Odoo
 * twin. The `project_branches` row records only the Odoo stack, so without this
 * the sweep sees every branch front as unclaimed and `--destroy` takes down
 * live staging (spec 0172).
 */
export function claimingBranchStack(stack: StackName): StackName {
  return stack.endsWith("-front") ? stack.slice(0, -"-front".length) : stack;
}

/**
 * Addon directories in `repoRoot`: immediate subdirectories containing an
 * `__manifest__.py`. That file IS Odoo's own definition of an addon, so this
 * asks the repository what it contains rather than imposing a layout on the
 * customer.
 *
 * One level deep only. Odoo repos commonly nest addons under an `addons/` or
 * `odoo-addons/` directory, so those are checked too — but a full recursive
 * walk would pick up test fixtures and vendored copies, which is worse than
 * missing an unusual layout the caller can point at explicitly.
 *
 * Sorted, so an install pass is deterministic and two runs of the same commit
 * produce the same archive.
 */
export function discoverAddons(repoRoot: string, subdirs: readonly string[] = ["", "addons", "odoo-addons"]): string[] {
  const found = new Set<string>();
  for (const sub of subdirs) {
    const base = sub ? path.join(repoRoot, sub) : repoRoot;
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue; // A missing conventional dir is normal, not an error.
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      if (existsSync(path.join(base, e.name, "__manifest__.py"))) {
        found.add(sub ? posixPath.join(sub, e.name) : e.name);
      }
    }
  }
  return [...found].sort();
}

/** The module name Odoo installs for a discovered addon path — the basename,
 * since `addons/sale_custom` is installed as `sale_custom`. */
export function addonModuleName(addonPath: string): string {
  return posixPath.basename(addonPath);
}

/** Injectable pack seam. The real one shells out to the system `tar`; tests
 * inject a stub so the archive contents are not what is under test. */
export type PackAddons = (repoRoot: string, addonPaths: readonly string[]) => Promise<string>;

/**
 * Files that must never reach a customer's staging container.
 *
 * `__pycache__`/`*.pyc` is the one that matters: bytecode compiled by the
 * developer's Python, shipped into an Odoo image running a different one, is a
 * stale-import bug waiting to happen. The other two are host litter.
 */
const PACK_EXCLUDES = ["__pycache__", "*.pyc", ".DS_Store"];

/**
 * Pack `addonPaths` (relative to `repoRoot`) into a base64 `tar.gz`.
 *
 * `--strip-components` is NOT used: an addon nested at `addons/sale_custom`
 * must land as `sale_custom` under the mount, and `-C` on the parent achieves
 * that per-path without flattening anything else. Paths are passed as argv to
 * `execFile` (no shell), so a directory name cannot become a command.
 *
 * `COPYFILE_DISABLE=1` is not cosmetic. macOS's BSD tar writes an AppleDouble
 * `._<name>` sidecar for every entry, and the first live run of this function
 * put `.___manifest__.py` and `.___init__.py` inside a real Odoo container's
 * addons path. Odoo ignored them, so nothing broke — but shipping a developer
 * laptop's resource forks into a customer's environment is not something to
 * leave in. The fake SSH runner is a `Map` and could never have shown it;
 * `ls` on the container did.
 */
export const packAddonsWithTar: PackAddons = async (repoRoot, addonPaths) => {
  if (addonPaths.length === 0) return "";
  // One tar per parent directory keeps each entry's stored name at its
  // basename, which is what `/mnt/extra-addons/<module>` requires.
  const byParent = new Map<string, string[]>();
  for (const p of addonPaths) {
    const parent = posixPath.dirname(p);
    byParent.set(parent, [...(byParent.get(parent) ?? []), posixPath.basename(p)]);
  }
  const args: string[] = ["-czf", "-"];
  for (const pattern of PACK_EXCLUDES) args.push("--exclude", pattern);
  for (const [parent, names] of byParent) {
    args.push("-C", path.join(repoRoot, parent === "." ? "" : parent), ...names);
  }
  const { stdout } = await execFileAsync("tar", args, {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return (stdout as unknown as Buffer).toString("base64");
};

/**
 * Concurrent staging stacks allowed per VPS.
 *
 * **Measured**, not guessed — on the sandbox box (2026-08-03, three production
 * stacks live):
 *
 * | resource | per stack | box |
 * |---|---|---|
 * | volumes  | ~85 MB (DB ~80 MB + filestore <1 MB) | 193 GB, 183 GB free |
 * | RAM idle | ~180 MB (odoo ~100 + postgres ~70)   | 16 GB, 14.7 GB available |
 * | CPU      | a module install pegs a core ~60 s   | 4 cores |
 *
 * So disk is not the constraint: 183 GB of free space is roughly 1800 stacks.
 * RAM under actual review load and 4 shared cores are. Budgeting 1 GB per stack
 * in use (versus 180 MB idle) and reserving headroom for the production stacks
 * that share the box puts the true ceiling somewhere near 8–10.
 *
 * The limit is set deliberately BELOW that, because the two failure modes are
 * not symmetric: a refused create is visible and this constant is trivial to
 * raise, while an over-committed box degrades the production stacks beside it in
 * a way that is hard to attribute.
 *
 * **Re-measured 2026-08-12** (spec 0187 C), while this guard was refusing a
 * deploy at six: 21 containers up, **13.5 GB of 16 GB available**, 178 GB disk
 * free, load average 0.02, and the heaviest Odoo container at 160 MB. Six was
 * not protecting anything — and since spec 0172 every BRANCH is a pair (Odoo +
 * front), so six stacks meant three branches, and the refusal counted the very
 * front sibling of the stack it was replacing.
 *
 * Twelve: still four times the observed per-stack cost with the production
 * stacks' headroom intact, and six branches rather than three. Revisit with
 * numbers, not vibes — re-measure `docker stats` under a real review session
 * before raising it again.
 */
export const STAGING_STACKS_PER_VPS = 12;

export interface DeployStagingOptions {
  /** The project/tenant this staging environment belongs to. */
  tenantId: string;
  /** Four-digit spec id — becomes the stack name. */
  specId: string;
  vpsId: number;
  ssh: SshRunner;
  odooVersion: OdooVersion;
  domain: string;
  /** Same contract as `DeployOptions.dbPassword`: never invented silently. */
  dbPassword: string;
  /** Odoo master password — `/web/database/manager` rights (spec 0121). Required
   * for the same reason as on `DeployOptions`: a staging host is exposed too, and
   * the image's default would otherwise govern it. */
  masterPassword: string;
  /** Password for the `admin` login on this staging DB (spec 0121). A reviewer has
   * to be able to log in, or the environment is a URL that shows a login form and
   * nothing else. */
  adminPassword: string;
  /** Spec 0208: the read-only login created in this stack's database. */
  odooUser: string;
  odooPassword: string;
  /** Spec 0189: Traefik's ACME resolver, so a staging URL opens without a
   * certificate interstitial. Absent renders exactly today's file. */
  certResolver?: string;
  /** Checkout at the reviewed commit; its addons are what gets deployed. */
  repoRoot: string;
  /** Overrides addon discovery when a repo's layout is unusual. */
  addonPaths?: readonly string[];
  pack?: PackAddons;
}

export interface StagingDeployResult extends DeployResult {
  specId: string;
  /** Addon module names installed into the fresh database. */
  addons: string[];
  /** Host the Traefik router answers on. Reachable only once a wildcard DNS
   * record for `domain` points at this VPS — see the spec's DNS note. */
  host: string;
}

/**
 * Deploy the change under review as its own Odoo stack.
 *
 * The database is **fresh** — `base` plus the change's addons — not a copy of
 * production. odoo.sh gives you a neutralized production duplicate, and for a
 * customer whose production we do not host we simply cannot: their data is on
 * odoo.sh. Seeding from a production backup is possible where we DO host
 * production (spec 0105 already has backup/restore) and is deliberately a later
 * step, not a silent half-measure now.
 */
export async function deployStagingStack(opts: DeployStagingOptions): Promise<StagingDeployResult> {
  const stack = stagingStackName(opts.specId);
  assertSandboxVps(opts.vpsId, "deployStagingStack");

  // Capacity lives HERE, beside the sandbox guard, rather than in the calling
  // activity: a limit a caller can forget to check is not a limit. Counted
  // box-wide rather than per tenant, because RAM and CPU belong to the VPS, not
  // to a tenant.
  //
  // This stack is excluded from the count. A redeploy of the same spec is not an
  // additional stack, and without the exclusion a retry at the limit could never
  // converge — it would refuse the very stack it is replacing.
  const existing = (await listStagingStacks(opts.ssh)).filter((s) => s !== stack);
  if (existing.length >= STAGING_STACKS_PER_VPS) {
    throw new FleetError(
      "config",
      `staging capacity reached on VPS ${opts.vpsId}: ${existing.length} staging stacks ` +
        `already up (limit ${STAGING_STACKS_PER_VPS}) — ${existing.join(", ")}. ` +
        `Tear one down, or raise STAGING_STACKS_PER_VPS after re-measuring the box.`,
      { retryable: false },
    );
  }

  const addonPaths = opts.addonPaths ?? discoverAddons(opts.repoRoot);
  const pack = opts.pack ?? packAddonsWithTar;
  const archive = addonPaths.length > 0 ? await pack(opts.repoRoot, addonPaths) : "";
  const addons = addonPaths.map(addonModuleName);

  const result = await deployProductionStack({
    tenantId: opts.tenantId,
    vpsId: opts.vpsId,
    ssh: opts.ssh,
    odooVersion: opts.odooVersion,
    domain: opts.domain,
    stack,
    dbPassword: opts.dbPassword,
    masterPassword: opts.masterPassword,
    adminPassword: opts.adminPassword,
    // Spec 0208: created in every staging database too — a branch front reads
    // the branch's Odoo, so the login has to exist there as well as in prod.
    odooReadonlyUser: opts.odooUser,
    odooReadonlyPassword: opts.odooPassword,
    ...(addons.length > 0 ? { modules: addons } : {}),
    ...(archive ? { addonsArchive: archive } : {}),
    // Spec 0189: the same ACME resolver production has used since 0148. Absent
    // on a domain nobody can validate (`stagingCertResolver`), so a rollback of
    // LAUNCHPAD_STAGING_DOMAIN degrades instead of failing ACME orders.
    ...(opts.certResolver ? { certResolver: opts.certResolver } : {}),
  });

  return {
    ...result,
    specId: opts.specId,
    addons,
    // Spec 0120: the SAME helper the ingress verification uses, so the host we
    // report and the host we proved reachable cannot drift apart.
    host: routerHost(opts.tenantId, stack, opts.domain),
  };
}

export interface DeployBranchStagingOptions {
  /** The project/tenant this branch server belongs to. */
  tenantId: string;
  /** The EXACT branch name — the stack name is derived (`branchStackName`). */
  branch: string;
  vpsId: number;
  ssh: SshRunner;
  odooVersion: OdooVersion;
  domain: string;
  dbPassword: string;
  masterPassword: string;
  adminPassword: string;
  /** Spec 0208: the read-only login created in this stack's database. */
  odooUser: string;
  odooPassword: string;
  /** A checkout/worktree AT THE BRANCH'S TIP; its addons are what deploys. */
  repoRoot: string;
  addonPaths?: readonly string[];
  pack?: PackAddons;
  /**
   * Spec 0172: pack the branch's tree as the front's build context. Injectable
   * for the same reason `pack` is — a test asserts WHAT was deployed, not what a
   * tar produced. Absent, the front phase is skipped, which is the shape every
   * pre-0172 caller has.
   */
  packCheckout?: (repoRoot: string) => Promise<string>;
  /** Spec 0172: the front deployer, injectable so a test never builds a container. */
  deployFront?: (opts: DeployFrontStackOptions) => Promise<FrontDeployResult>;
  /**
   * Spec 0187 E: the install pass for a branch database that ALREADY exists.
   *
   * `deployProductionStack` installs modules at database INIT and nowhere else,
   * so the FIRST deploy of a branch installs its addons and every redeploy
   * copies new code into `/mnt/extra-addons` and installs nothing — the exact
   * shape of finding 1.15, which spec 0176 fixed for production only. Without
   * this, a reviewer opening the staging URL after a redeploy sees the server
   * from before the change.
   *
   * Injected (not imported) for the same reason as `deployFront`: a test asserts
   * what was asked of the boundary, and nothing here should reach a real box.
   */
  installModules?: (opts: {
    tenantId: string;
    stack: StackName;
    ssh: SshRunner;
    modules: string[];
    timestamp: string;
  }) => Promise<unknown>;
  /**
   * Spec 0189: Traefik's ACME resolver, for BOTH halves of the environment.
   *
   * Production has passed `letsencrypt` since spec 0148; staging never passed
   * anything, so every branch URL served Traefik's self-signed default and the
   * reviewer that gate 2 depends on met a browser interstitial. Absent (or on a
   * domain nobody can validate — see `stagingCertResolver`) renders exactly
   * today's file.
   */
  certResolver?: string;
  /**
   * Compact UTC stamp (`YYYYMMDDTHHMMSSZ`) for the pre-install backup the
   * install pass takes. MUST come from the caller — a Temporal activity retries,
   * and a self-generated stamp orphans a backup directory each time (spec 0105).
   * Absent, the install pass is skipped and `installedOnRedeploy` says so.
   */
  backupTimestamp?: string;
  /**
   * Spec 0226 D2: make this branch's Odoo a NEUTRALIZED copy of the tenant's
   * production instead of a clean one.
   *
   * Honoured only on the deploy that CREATES the branch's database — odoo.sh
   * copies production at branch creation and on later pushes "the database is
   * not re-created", and our gate-2 redeploy would otherwise wipe whatever the
   * tester had captured.
   */
  copyProduction?: boolean;
}

export interface BranchStagingDeployResult extends DeployResult {
  /**
   * Spec 0226 E2: this environment is a neutralized copy of production, and the
   * marker was PROVEN before odoo started (`neutralizeRestoredDb` asserts
   * `database.is_neutralized` from the branch DB, and throws otherwise — so this
   * being true is not a claim, it is a consequence of the deploy not failing).
   *
   * Absent means a clean Odoo, which is what every branch before this was.
   */
  neutralized?: true;
  branch: string;
  stack: StackName;
  addons: string[];
  host: string;
  /** Spec 0187 E: modules installed by the REDEPLOY pass, i.e. onto a database
   * that already existed. Absent on a first deploy (`modules` carries those) and
   * absent when no install pass ran — which is itself worth being able to see. */
  installedOnRedeploy?: string[];
  /** Spec 0172: the branch's OWN front, when its tree carries one. Absent means
   * the tree had no `Dockerfile` — a project with no front, not a failure.
   * Spec 0173 A1: `failed` when the tree HAS a front and deploying it did not
   * work. Reported, never thrown: the Odoo half of this environment is up, and
   * a front that cannot start is not a reason to take a reviewable branch
   * server away from whoever is reviewing it. */
  front?: { stack: StackName; host: string; failed?: string };
}

/**
 * Deploy a BRANCH's staging server (spec 0134) — the odoo.sh model's
 * per-branch environment. Same guts as `deployStagingStack` (fresh DB, addons
 * from the checkout, Traefik host routing, sandbox-allowlist confinement,
 * shared capacity), different keying and different LIFECYCLE: this stack
 * outlives every run on the branch; only the UI's destroy or the sweep's
 * orphan pass takes it down.
 *
 * Deliberately a sibling of `deployStagingStack` rather than a refactor of
 * it: that path is live-verified, and reshaping it to save thirty lines is a
 * bad trade (the 0119 `listStagingStackRefs` reasoning).
 */
export async function deployBranchStagingStack(
  opts: DeployBranchStagingOptions,
): Promise<BranchStagingDeployResult> {
  const stack = branchStackName(opts.branch);
  assertSandboxVps(opts.vpsId, "deployBranchStagingStack");

  // Same capacity rule, same self-exclusion (a redeploy is not an additional
  // stack), counted across BOTH families — RAM belongs to the box.
  //
  // Spec 0187 C: the exclusion covers the FRONT sibling too. Since 0172 a branch
  // is a pair, and counting this branch's own front against this branch's own
  // redeploy is what refused `autopartes` at gate 2 — the refusal listed
  // `br-owner-catalogo-refaccio-81b71a-front` while replacing
  // `br-owner-catalogo-refaccio-81b71a`.
  const own = new Set<string>([stack, frontStackFor(stack)]);
  const existing = (await listStagingStacks(opts.ssh)).filter((s) => !own.has(s));
  if (existing.length >= STAGING_STACKS_PER_VPS) {
    throw new FleetError(
      "config",
      `staging capacity reached on VPS ${opts.vpsId}: ${existing.length} staging stacks ` +
        `already up (limit ${STAGING_STACKS_PER_VPS}) — ${existing.join(", ")}. ` +
        `Tear one down, or raise STAGING_STACKS_PER_VPS after re-measuring the box.`,
      { retryable: false },
    );
  }

  const addonPaths = opts.addonPaths ?? discoverAddons(opts.repoRoot);
  const pack = opts.pack ?? packAddonsWithTar;
  const archive = addonPaths.length > 0 ? await pack(opts.repoRoot, addonPaths) : "";
  const addons = addonPaths.map(addonModuleName);

  // Spec 0226 D2. Built HERE and handed down, because only this layer knows both
  // stacks: `deployProductionStack` is told what to do, not how to find
  // production. The decision is separate from the doing (`decideProductionCopy`)
  // because getting it wrong destroys a tester's work rather than merely failing.
  const prodProject = composeProjectName(opts.tenantId, "prod");
  const copyDecision = decideProductionCopy({
    stackExists: (await listStagingStacks(opts.ssh)).includes(stack),
    wantsCopy: opts.copyProduction === true,
    hasProduction: true,
  });

  const restoreFromProduction = copyDecision.copy
    ? async (target: { project: string; composePath: string; dbName: string }) => {
        const copyOpts = {
          ssh: opts.ssh,
          prodProject,
          prodComposePath: remoteComposePath(opts.tenantId, "prod"),
          prodDbName: tenantDbName(opts.tenantId, "prod"),
          prodFilestoreVolume: `${prodProject}_odoo-filestore`,
          branchProject: target.project,
          branchComposePath: target.composePath,
          branchDbName: target.dbName,
          branchFilestoreVolume: `${target.project}_odoo-filestore`,
        };
        const dump = await dumpProduction(copyOpts);
        await restoreIntoBranch(copyOpts, dump);
        // Nothing is serving yet — this is the window `deployProductionStack`
        // leaves open on purpose. Neutralize and PROVE it before returning; a
        // throw here fails the deploy and its `up -d` never runs.
        await neutralizeRestoredDb({
          ssh: opts.ssh,
          project: target.project,
          composePath: target.composePath,
          dbName: target.dbName,
        });
      }
    : undefined;

  // Spec 0226 decision 2: fail CLOSED. If the copy threw, the branch's `db` is
  // up holding production data that may not be neutralized, and `odoo` never
  // started — so nothing is serving it, but leaving it there is a copy of a
  // customer's database sitting on the box for someone to find. Destroy it, and
  // let the original failure propagate: the destroy is cleanup, not the news.
  let result: Awaited<ReturnType<typeof deployProductionStack>>;
  try {
    result = await deployProductionStack({
      tenantId: opts.tenantId,
      vpsId: opts.vpsId,
      ssh: opts.ssh,
      ...(restoreFromProduction ? { restoreFromProduction } : {}),
      odooVersion: opts.odooVersion,
      domain: opts.domain,
      stack,
      dbPassword: opts.dbPassword,
      masterPassword: opts.masterPassword,
      adminPassword: opts.adminPassword,
      // Spec 0208: created in every staging database too — a branch front reads
      // the branch's Odoo, so the login has to exist there as well as in prod.
      odooReadonlyUser: opts.odooUser,
      odooReadonlyPassword: opts.odooPassword,
      ...(addons.length > 0 ? { modules: addons } : {}),
      ...(archive ? { addonsArchive: archive } : {}),
      // Spec 0189: the same ACME resolver production has used since 0148. Absent
      // on a domain nobody can validate (`stagingCertResolver`), so a rollback of
      // LAUNCHPAD_STAGING_DOMAIN degrades instead of failing ACME orders.
      ...(opts.certResolver ? { certResolver: opts.certResolver } : {}),
    });
  } catch (err) {
    if (restoreFromProduction) {
      await destroyBranchStack({
        ssh: opts.ssh,
        vpsId: opts.vpsId,
        tenantId: opts.tenantId,
        stack,
      }).catch((cleanupErr: unknown) => {
        // Best-effort, and SAID: a failed cleanup after a failed copy is the one
        // case where data really is left behind, and it must not be silent.
        console.error(
          `[0226] copy failed AND the branch stack could not be destroyed — ` +
            `${stack} may hold un-neutralized production data:`,
          cleanupErr,
        );
      });
    }
    throw err;
  }

  const host = routerHost(opts.tenantId, stack, opts.domain);
  // Spec 0226 E2. Keyed on the hook having been BUILT and the deploy having
  // returned: `restoreFromProduction` throws unless the marker read back true,
  // so reaching this line with the hook set means it was proven.
  const neutralized = restoreFromProduction ? (true as const) : undefined;

  // Spec 0187 E: `result.modules` is present only when this deploy INITIALISED
  // the database — which is the only moment `deployProductionStack` installs
  // anything. Its absence with addons in hand means "redeploy onto an existing
  // branch DB": the code is on disk and Odoo has not been told about it.
  let installedOnRedeploy: string[] | undefined;
  if (addons.length > 0 && !result.modules && opts.installModules && opts.backupTimestamp) {
    await opts.installModules({
      tenantId: opts.tenantId,
      stack,
      ssh: opts.ssh,
      modules: addons,
      timestamp: opts.backupTimestamp,
    });
    installedOnRedeploy = addons;
  }

  // Spec 0172: a branch's staging is the WHOLE app. The front deploys AFTER
  // Odoo — it reads Odoo at boot, and a front pointed at a backend that has not
  // migrated yet shows an error page that has nothing to do with the change
  // under review.
  //
  // A tree with no root Dockerfile is a project with no front (an addons-only
  // repo), not a failure: skip, and say so by returning no `front`.
  let front: { stack: StackName; host: string; failed?: string } | undefined;
  if (opts.deployFront && opts.packCheckout && existsSync(path.join(opts.repoRoot, "Dockerfile"))) {
    const frontStack = frontStackFor(stack);
    const frontHost = routerHost(opts.tenantId, frontStack, opts.domain);
    try {
      await opts.deployFront({
        slug: opts.tenantId,
        vpsId: opts.vpsId,
        ssh: opts.ssh,
        domain: opts.domain,
        stack: frontStack,
        host: frontHost,
        // Spec 0173 A2: from INSIDE the box, over the Odoo stack's own network.
        // The public route would come back through Traefik's self-signed
        // staging certificate, which Node's fetch refuses — the front then
        // serves 500 and the ingress check fails a healthy environment.
        odooUrl: "http://odoo:8069",
        odooNetwork: `${composeProjectName(opts.tenantId, stack)}_default`,
        // Spec 0208: the BRANCH's own database, not production's — a branch
        // front reading production would make a review lie about what the
        // change does. The credentials are the tenant's, and
        // `deployProductionStack` has already created that user in this
        // database.
        odooDb: tenantDbName(opts.tenantId, stack),
        odooUser: opts.odooUser,
        odooPassword: opts.odooPassword,
        sourceArchive: await opts.packCheckout(opts.repoRoot),
        // Spec 0189: the front is half the environment a reviewer opens, so it
        // needs the certificate as much as Odoo does.
        ...(opts.certResolver ? { certResolver: opts.certResolver } : {}),
      });
      front = { stack: frontStack, host: frontHost };
    } catch (err) {
      // Spec 0173 A1. The regression this replaces: a front that could not come
      // up threw, and the whole op failed — marking a branch whose Odoo was
      // healthy and serving as `failed`.
      front = {
        stack: frontStack,
        host: frontHost,
        failed: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    ...result,
    branch: opts.branch,
    stack,
    addons,
    host,
    ...(neutralized ? { neutralized } : {}),
    ...(installedOnRedeploy ? { installedOnRedeploy } : {}),
    ...(front ? { front } : {}),
  };
}

export interface DestroyBranchStackOptions {
  tenantId: string;
  /** The literal stack name — the `project_branches.staging_stack` value. Taken
   * as a name (not a branch) so the sweep can destroy an orphan whose branch
   * row no longer exists. */
  stack: StackName;
  vpsId: number;
  ssh: SshRunner;
}

/**
 * Tear a BRANCH stack down — containers, networks, volumes. Refuses any name
 * that is not `br-*`: like `destroyStagingStack`, there is no argument that
 * makes this delete a production (or spec) stack.
 */
export async function destroyBranchStack(
  opts: DestroyBranchStackOptions,
): Promise<DestroyStagingResult> {
  if (!isBranchStack(opts.stack)) {
    throw new FleetError("config", `refusing to destroy non-branch stack ${opts.stack}`, {
      retryable: false,
    });
  }
  assertSandboxVps(opts.vpsId, "destroyBranchStack");

  const dir = remoteStackDir(opts.tenantId, opts.stack);
  const project = composeProjectName(opts.tenantId, opts.stack);

  const present = await opts.ssh.exec(`test -d ${dir}`);
  if (present.code !== 0) return { stack: opts.stack, existed: false };

  const down = await opts.ssh.exec(`cd ${dir} && docker compose -p ${project} down -v --remove-orphans`);
  if (down.code !== 0) {
    throw new FleetError(
      "deploy",
      `failed to bring down ${project} (exit ${down.code}): ${down.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }
  const rm = await opts.ssh.exec(`rm -rf ${dir}`);
  if (rm.code !== 0) {
    throw new FleetError(
      "deploy",
      `brought down ${project} but failed to remove ${dir} (exit ${rm.code})`,
      { retryable: true },
    );
  }
  return { stack: opts.stack, existed: true };
}

export interface DestroyStagingOptions {
  tenantId: string;
  specId: string;
  vpsId: number;
  ssh: SshRunner;
}

export interface DestroyStagingResult {
  stack: StackName;
  /** False when the stack directory was already gone — a destroy is idempotent,
   * because it runs on the terminal path of a run that may be retried. */
  existed: boolean;
}

/**
 * Tear a staging stack down: containers, networks, and **volumes**.
 *
 * `-v` is the point. Without it the Postgres and filestore volumes survive
 * every teardown and the box fills up one spec at a time.
 *
 * Refuses any stack that is not `spec-NNNN`. That guard is the reason this
 * function takes a spec id rather than a stack name: there is no argument a
 * caller can pass that makes this delete a production stack.
 */
export async function destroyStagingStack(opts: DestroyStagingOptions): Promise<DestroyStagingResult> {
  const stack = stagingStackName(opts.specId);
  /* c8 ignore next 3 -- unreachable: stagingStackName only ever returns spec-NNNN.
     Kept as a second lock on an irreversible, volume-deleting operation. */
  if (!isStagingStack(stack)) {
    throw new FleetError("config", `refusing to destroy non-staging stack ${stack}`, { retryable: false });
  }
  assertSandboxVps(opts.vpsId, "destroyStagingStack");

  const dir = remoteStackDir(opts.tenantId, stack);
  const project = composeProjectName(opts.tenantId, stack);

  const present = await opts.ssh.exec(`test -d ${dir}`);
  if (present.code !== 0) return { stack, existed: false };

  const down = await opts.ssh.exec(`cd ${dir} && docker compose -p ${project} down -v --remove-orphans`);
  if (down.code !== 0) {
    throw new FleetError(
      "deploy",
      `failed to bring down ${project} (exit ${down.code}): ${down.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }
  // Only after a clean `down`: removing the directory first would orphan the
  // containers, leaving no compose file to bring them down with.
  const rm = await opts.ssh.exec(`rm -rf ${dir}`);
  if (rm.code !== 0) {
    throw new FleetError(
      "deploy",
      `brought down ${project} but failed to remove ${dir} (exit ${rm.code})`,
      { retryable: true },
    );
  }
  return { stack, existed: true };
}

/**
 * Spec ids of staging stacks currently on the VPS — for capacity accounting and
 * for finding leaks (a stack whose run ended without a teardown).
 *
 * Reads directory names under `/opt/launchpad/<tenant>/`, which is where
 * `remoteStackDir` puts them. Tolerant: an unreadable path yields nothing
 * rather than throwing, because this feeds a capacity check that must not be
 * the thing that breaks a deploy.
 */
/** A staging stack located well enough to be torn down. */
export interface StagingStackRef {
  tenantId: string;
  stack: StackName;
  /** Which lifecycle owns it (spec 0134): `spec` stacks tear down with their
   * run; `branch` stacks live until the UI destroys them or the sweep finds
   * them orphaned (no `project_branches` row claiming the name). */
  family: "spec" | "branch";
  /** The four digits in `spec-NNNN` — what `destroyStagingStack` takes.
   * Absent for branch stacks. */
  specId?: string;
}

/**
 * Every staging stack on the box, WITH its tenant — what a sweep needs.
 *
 * {@link listStagingStacks} deliberately returns bare names because that is all
 * capacity accounting compares, but a bare `spec-0120` cannot be destroyed:
 * teardown needs the tenant to find the directory. Rather than change a function
 * verified live, this adds the one thing the sweep is missing; the overlapping
 * `find` is a few lines, and reshaping a live deploy path to save them is a bad
 * trade.
 *
 * Same tolerance as its sibling: an unreadable path yields nothing rather than
 * throwing.
 */
export async function listStagingStackRefs(ssh: SshRunner): Promise<StagingStackRef[]> {
  const res = await ssh.exec(
    `find /opt/launchpad -mindepth 2 -maxdepth 2 -type d \\( -name 'spec-*' -o -name 'br-*' \\) -printf '%P\\n' 2>/dev/null || true`,
  );
  if (res.code !== 0) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((rel): StagingStackRef[] => {
      const [tenantId, stack] = rel.split("/");
      if (!tenantId || !stack) return [];
      if (isStagingStack(stack)) {
        return [{ tenantId, stack, family: "spec", specId: stack.slice("spec-".length) }];
      }
      if (isBranchStack(stack)) return [{ tenantId, stack, family: "branch" }];
      return [];
    })
    .sort((a, b) => `${a.tenantId}/${a.stack}`.localeCompare(`${b.tenantId}/${b.stack}`));
}

export async function listStagingStacks(ssh: SshRunner, tenantId?: string): Promise<string[]> {
  const base = tenantId ? posixPath.join("/opt/launchpad", tenantId) : "/opt/launchpad";
  const depth = tenantId ? 1 : 2;
  // Both families (spec 0134): branch stacks consume the same RAM/CPU, so they
  // MUST count toward the same capacity limit the spec stacks do.
  const res = await ssh.exec(
    `find ${base} -mindepth ${depth} -maxdepth ${depth} -type d \\( -name 'spec-*' -o -name 'br-*' \\) -printf '%f\\n' 2>/dev/null || true`,
  );
  if (res.code !== 0) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => isStagingStack(s) || isBranchStack(s))
    .sort();
}
