import { test } from "node:test";
import assert from "node:assert/strict";
import { ApplicationFailure } from "@temporalio/common";
import { GithubApiError } from "@launchpad/github";
import type { CreatedRepo, CommittedFile } from "@launchpad/github";
import { HostingerApiError } from "@launchpad/fleet-hostinger";
import type {
  VpsInstance,
  UpsertDnsRecordInput,
  DnsUpsertResult,
  SshRunner,
  DeployOptions,
  DeployResult,
  DeployFrontStackOptions,
  FrontDeployResult,
} from "@launchpad/fleet-hostinger";
import {
  provisionRepo,
  provisionDns,
  provisionOdoo,
  provisionFront,
  verifyProvision,
  provisionOdooHost,
  PROVISION_VPS_ID_ENV,
  type ProvisionRepoDeps,
  type ProvisionDnsDeps,
  type ProvisionOdooDeps,
  type ModuleOutcome,
  type ProvisionFrontDeps,
  type ProvisionVerifyDeps,
} from "./provisioning-activities.js";
import type { ProvisionCheckoutInput, ProvisionCheckoutOutcome } from "./checkout.js";
import type { ProvisionProjectInput } from "./provisioning-phase.js";
import { odooHostFor } from "./hosts.js";

// Spec 0161 F2 phase A. provisionRepo composes the 0148 mechanisms:
// createRepoInOrg → provisionRepoCheckout → (optional) commitFileToRepo. These
// drive it through injected fakes — no GitHub, no git, no DB.

const CREATED: CreatedRepo = {
  id: 1,
  fullName: "example-org/acme",
  htmlUrl: "https://github.com/example-org/acme",
  cloneUrl: "https://github.com/example-org/acme.git",
  sshUrl: "git@github.com:example-org/acme.git",
  private: true,
  defaultBranch: "main",
};

const CHECKOUT_OUT: ProvisionCheckoutOutcome = {
  root: "/tmp/checkouts/acme",
  cloned: true,
  originUrl: "https://github.com/example-org/acme.git",
};

const COMMITTED: CommittedFile = { commitSha: "x", commitUrl: "x" };

interface Recorded {
  createReq: Array<Record<string, unknown>>;
  checkoutReq: ProvisionCheckoutInput[];
  commitReq: Array<Record<string, unknown>>;
}

function fakeDeps(
  over: Partial<ProvisionRepoDeps> & {
    createResult?: () => Promise<CreatedRepo>;
    commitResult?: () => Promise<CommittedFile>;
  } = {},
): { deps: ProvisionRepoDeps; rec: Recorded } {
  const rec: Recorded = { createReq: [], checkoutReq: [], commitReq: [] };
  const { createResult, commitResult, ...depsOver } = over;
  const deps: ProvisionRepoDeps = {
    githubToken: () => "tok",
    resolveProjectKind: async () => "odoo_next",
    // Spec 0169: a one-file stand-in. Tests that care about the real scaffold
    // read `infra/front/` themselves (front-scaffold.test.ts).
    loadFrontScaffold: async () => [{ path: "Dockerfile", contentBase64: "RlJPTSBub2Rl" }],
    // Spec 0191: the business facts the landing page renders from.
    resolveProjectSite: async () => ({ nombre: "Acme", giro: "", procesos: [], marca: "" }),
    createGithubClient: () => ({
      createRepoInOrg: async (req) => {
        rec.createReq.push(req as unknown as Record<string, unknown>);
        return (createResult ?? (async () => CREATED))();
      },
      commitFileToRepo: async (req) => {
        rec.commitReq.push(req as unknown as Record<string, unknown>);
        return (commitResult ??
          (async () => ({
            commitSha: "RESPONSE-SHA-7638417",
            commitUrl: "https://github.com/example-org/acme/commit/RESPONSE-SHA-7638417",
          })))();
      },
    }),
    checkoutRepo: async (input) => {
      rec.checkoutReq.push(input);
      return CHECKOUT_OUT;
    },
    ...depsOver,
  };
  return { deps, rec };
}

const INPUT: ProvisionProjectInput = { slug: "acme" };
const INPUT_WITH_LOGO: ProvisionProjectInput = {
  slug: "acme",
  logo: { path: "public/logo.png", contentBase64: "aGVsbG8=" },
};

test("provisionRepo creates the private repo, clones, and commits the logo", async () => {
  const { deps, rec } = fakeDeps();
  await provisionRepo(INPUT_WITH_LOGO, deps);

  assert.deepEqual(rec.createReq, [
    {
      org: "example-org",
      name: "acme",
      private: true,
      description: "Front odoo-next de acme (aprovisionado por Hangar).",
    },
  ]);
  assert.deepEqual(rec.checkoutReq, [
    { slug: "acme", owner: "example-org", name: "acme", kind: "odoo_next" },
  ]);
  // Spec 0169: the scaffold is committed FIRST, then the logo. The order is the
  // point — the clone has to come down with a Dockerfile, or the front phase
  // packs an empty tree (spec 0161's live failure).
  assert.deepEqual(
    rec.commitReq.map((r) => r["path"]),
    ["Dockerfile", "public/logo.png"],
  );
  assert.deepEqual(rec.commitReq.at(-1), {
    owner: "example-org",
    name: "acme",
    path: "public/logo.png",
    contentBase64: "aGVsbG8=",
    message: "chore: add brand logo",
  });
});

/**
 * Spec 0169. The scaffold must land BEFORE the clone, or the checkout that
 * `provisionFront` tars is empty — which is exactly how spec 0161's live proof
 * died, with `open Dockerfile: no such file or directory`.
 */
test("provisionRepo commits the scaffold before cloning", async () => {
  const order: string[] = [];
  const { deps } = fakeDeps({
    loadFrontScaffold: async () => [{ path: "Dockerfile", contentBase64: "RlJPTSBub2Rl" }],
    checkoutRepo: async () => {
      order.push("clone");
      return CHECKOUT_OUT;
    },
    commitResult: async () => {
      order.push("commit");
      return COMMITTED;
    },
  });
  await provisionRepo(INPUT, deps);
  assert.deepEqual(order, ["commit", "clone"], "a clone before the scaffold yields an empty tree");
});

test("provisionRepo refuses when the scaffold has no Dockerfile", async () => {
  // The loader guards this too, but the activity must not proceed on a scaffold
  // that cannot build — a repo created and left half-populated is worse than a
  // named refusal.
  const { deps } = fakeDeps({
    loadFrontScaffold: async () => {
      throw new Error("front scaffold at /x has no Dockerfile");
    },
  });
  await assert.rejects(() => provisionRepo(INPUT, deps), /Dockerfile/);
});

test("provisionRepo skips the commit when no logo was uploaded", async () => {
  const { deps, rec } = fakeDeps();
  await provisionRepo(INPUT, deps);
  // Spec 0169: the scaffold always commits; only the LOGO is conditional.
  assert.deepEqual(
    rec.commitReq.map((r) => r["path"]),
    ["Dockerfile"],
    "the scaffold ships; no logo commit without a logo",
  );
  assert.equal(rec.checkoutReq.length, 1, "still creates + clones the repo");
});

// VERIFICATION #1: the "commit landed" proof reads GitHub's RESPONSE. A response
// with no commit sha (the request carried real bytes) must FAIL, not be adopted.
test("provisionRepo fails when GitHub returns no commit sha for the logo", async () => {
  // Only the LOGO commit answers without a sha — the scaffold succeeds — so this
  // still tests what its name says rather than tripping on spec 0169's earlier
  // commits.
  const { deps } = fakeDeps({
    commitResult: async () => ({ commitSha: "", commitUrl: "" }),
    createGithubClient: () => ({
      createRepoInOrg: async () => CREATED,
      commitFileToRepo: async (req) =>
        req.path === "public/logo.png" ? { commitSha: "", commitUrl: "" } : COMMITTED,
    }),
  });
  await assert.rejects(
    () => provisionRepo(INPUT_WITH_LOGO, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.type === "ProvisionRepoLogoCommit",
  );
});

test("provisionRepo surfaces a name collision as a non-retryable failure", async () => {
  const { deps, rec } = fakeDeps({
    createResult: async () => {
      throw new GithubApiError("name_taken", 'A repository named "acme" already exists', {
        status: 422,
        retryable: false,
      });
    },
  });
  await assert.rejects(
    () => provisionRepo(INPUT, deps),
    (e: unknown) =>
      e instanceof ApplicationFailure && e.type === "ProvisionRepoNameTaken" && e.nonRetryable === true,
  );
  assert.equal(rec.checkoutReq.length, 0, "no clone attempted after the create failed");
});

test("provisionRepo refuses to run without a worker GITHUB_TOKEN", async () => {
  let clientBuilt = false;
  const { deps } = fakeDeps({
    githubToken: () => undefined,
    createGithubClient: () => {
      clientBuilt = true;
      return { createRepoInOrg: async () => CREATED, commitFileToRepo: async () => COMMITTED };
    },
  });
  await assert.rejects(
    () => provisionRepo(INPUT, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.type === "ProvisionRepoConfig",
  );
  assert.equal(clientBuilt, false, "never builds a client without a token");
});

test("provisionRepo refuses when the project row is absent", async () => {
  const { deps, rec } = fakeDeps({ resolveProjectKind: async () => null });
  await assert.rejects(
    () => provisionRepo(INPUT, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.type === "ProvisionRepoConfig",
  );
  assert.equal(rec.createReq.length, 0, "no repo created for an unknown project");
});

// Spec 0161 F2 phase B. provisionDns wraps the collision-safe upsertDnsRecord:
// getVps → sandbox IPv4 → two A-records into example.com. Driven through injected
// fakes — no live Hostinger.

const SANDBOX_IPV4 = "203.0.113.20";

function fakeDnsDeps(
  over: {
    env?: NodeJS.ProcessEnv;
    getVps?: () => Promise<VpsInstance>;
    upsert?: (input: UpsertDnsRecordInput) => Promise<DnsUpsertResult>;
  } = {},
): { deps: ProvisionDnsDeps; upserts: UpsertDnsRecordInput[] } {
  const upserts: UpsertDnsRecordInput[] = [];
  const deps: ProvisionDnsDeps = {
    env: over.env ?? { [PROVISION_VPS_ID_ENV]: "100001" },
    resolveHostingerToken: () => "tok",
    createHostingerClient: () => ({
      getVps:
        over.getVps ??
        (async () => ({ ipv4: [{ address: SANDBOX_IPV4 }] }) as unknown as VpsInstance),
      upsertDnsRecord: async (input) => {
        upserts.push(input);
        return (
          over.upsert ??
          (async (i: UpsertDnsRecordInput) => ({
            domain: i.domain,
            name: i.name,
            type: "A" as const,
            content: i.content,
            outcome: "created" as const,
          }))
        )(input);
      },
    }),
  };
  return { deps, upserts };
}

test("provisionDns writes both A-records to the sandbox VPS IPv4", async () => {
  const { deps, upserts } = fakeDnsDeps();
  await provisionDns(INPUT, deps);
  assert.deepEqual(upserts, [
    { domain: "example.com", name: "acme", content: SANDBOX_IPV4 },
    { domain: "example.com", name: "acme.odoo", content: SANDBOX_IPV4 },
  ]);
});

test("provisionDns refuses without a configured sandbox VPS id", async () => {
  const { deps, upserts } = fakeDnsDeps({ env: {} });
  await assert.rejects(
    () => provisionDns(INPUT, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.type === "ProvisionConfig",
  );
  assert.equal(upserts.length, 0, "no DNS write when the VPS id is missing");
});

test("provisionDns refuses when the VPS has no IPv4 address", async () => {
  const { deps, upserts } = fakeDnsDeps({
    getVps: async () => ({ ipv4: null }) as unknown as VpsInstance,
  });
  await assert.rejects(
    () => provisionDns(INPUT, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.type === "ProvisionConfig",
  );
  assert.equal(upserts.length, 0, "no DNS write without a target IPv4");
});

// The collision-safe refusal (a slug pointing at a live customer's other VPS)
// must surface as a NON-retryable failure carrying the conflict's classification.
test("provisionDns surfaces a DNS collision as a non-retryable failure", async () => {
  const { deps } = fakeDnsDeps({
    upsert: async () => {
      throw new HostingerApiError("conflict", "refusing to overwrite DNS A record", {
        retryable: false,
      });
    },
  });
  await assert.rejects(
    () => provisionDns(INPUT, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.nonRetryable === true,
  );
});

// Spec 0161 F2 phase C. provisionOdoo wraps deployProductionStack with the
// <slug>.odoo.example.com host override + ACME certresolver on the sandbox VPS.
// Driven through injected fakes — no live SSH/Hostinger/DB.

const SSH_SENTINEL = { sentinel: "ssh" } as unknown as SshRunner;

function fakeOdooDeps(
  over: {
    env?: NodeJS.ProcessEnv;
    getVps?: () => Promise<VpsInstance>;
    deploy?: (opts: DeployOptions) => Promise<DeployResult>;
    resolveProject?: (slug: string) => Promise<{ version: string | null; intake: Record<string, string> }>;
  } = {},
): {
  deps: ProvisionOdooDeps;
  deployReq: DeployOptions[];
  store: Map<string, string>;
  outcomes: ModuleOutcome[];
  vendorReq: string[][];
} {
  const deployReq: DeployOptions[] = [];
  const outcomes: ModuleOutcome[] = [];
  const vendorReq: string[][] = [];
  // Spec 0171: a STORE, not a spy on the call. The question is what the project
  // row ends up saying, and asserting the argument we passed would prove intent
  // rather than outcome (VERIFICATION #1).
  const store = new Map<string, string>();
  const env = over.env ?? {
    [PROVISION_VPS_ID_ENV]: "100001",
    LAUNCHPAD_FLEET_SSH_IDENTITY: "/keys/id_ed25519",
    LAUNCHPAD_ODOO_MASTER_PASSWORD: "master-pw",
    LAUNCHPAD_ODOO_ADMIN_PASSWORD: "admin-pw",
  };
  const deps: ProvisionOdooDeps = {
    env,
    resolveHostingerToken: () => "tok",
    createHostingerClient: () => ({
      getVps:
        over.getVps ??
        (async () => ({ ipv4: [{ address: SANDBOX_IPV4 }] }) as unknown as VpsInstance),
    }),
    createSshRunner: () => SSH_SENTINEL,
    readOrCreateDbPassword: async () => "db-pw",
    deployProductionStack: async (opts) => {
      deployReq.push(opts);
      return (
        over.deploy ??
        (async () =>
          ({
            tenantId: opts.tenantId,
            stack: "prod",
            odooVersion: opts.odooVersion,
            healthy: true,
            odooHttpOk: true,
            ingressOk: true,
          }) as DeployResult)
      )(opts);
    },
    resolveProject: over.resolveProject ?? (async () => ({ version: "18", intake: {} })),
    readOdooReadonly: async () => ({ user: "front_readonly", password: "ro-pass-not-a-real-secret" }),
    // Spec 0206: record what was asked for and hand back a sentinel, so a test
    // asserts WHICH addons were fetched rather than tar's output.
    fetchVendoredAddons: async (addons) => {
      vendorReq.push(addons.map((a) => a.module));
      return addons.length > 0 ? "VENDORED-ARCHIVE" : "";
    },
    recordModuleOutcome: async (o) => void outcomes.push(o),
    persistVpsId: async (slug, vpsId) => void store.set(slug, String(vpsId)),
  };
  return { deps, deployReq, store, outcomes, vendorReq };
}

test("provisionOdoo deploys with the odoo host override + letsencrypt certresolver", async () => {
  const { deps, deployReq } = fakeOdooDeps();
  await provisionOdoo(INPUT, deps);
  assert.equal(deployReq.length, 1);
  const opts = deployReq[0]!;
  assert.equal(opts.tenantId, "acme");
  assert.equal(opts.host, "acme.odoo.example.com");
  assert.equal(opts.host, provisionOdooHost("acme"));
  assert.equal(opts.certResolver, "letsencrypt");
  assert.equal(opts.domain, "example.com");
  assert.equal(opts.odooVersion, 18);
  assert.equal(opts.dbPassword, "db-pw");
  assert.equal(opts.masterPassword, "master-pw");
  assert.equal(opts.adminPassword, "admin-pw");
  assert.equal(opts.ssh, SSH_SENTINEL);
});

test("provisionOdoo carries the project's Odoo major from its version column", async () => {
  const { deps, deployReq } = fakeOdooDeps({ resolveProject: async () => ({ version: "19.0", intake: {} }) });
  await provisionOdoo(INPUT, deps);
  assert.equal(deployReq[0]!.odooVersion, 19);
});

// ── spec 0205 C+D: the processes they ticked become modules, and the record
// says what actually installed ──────────────────────────────────────────────

test("provisionOdoo asks for the modules the customer's procesos map to", async () => {
  const { deps, deployReq } = fakeOdooDeps({
    resolveProject: async () => ({
      version: "19",
      intake: { procesos: "Punto de venta (POS)|Compras", giro: "Taquería" },
    }),
  });
  await provisionOdoo(INPUT, deps);
  // Spec 0206 appended the house-style pair; the procesos still lead the list.
  assert.deepEqual(deployReq[0]!.modules, [
    "point_of_sale",
    "purchase",
    "web_responsive",
    "app_menu_enterprise",
  ]);
});

test("a project with no procesos still gets the house style (spec 0206)", async () => {
  // It used to deploy stock. The Enterprise-look pair is not a proceso — it is
  // what every tenant we provision gets.
  const { deps, deployReq, vendorReq } = fakeOdooDeps({
    resolveProject: async () => ({ version: "19", intake: {} }),
  });
  await provisionOdoo(INPUT, deps);
  assert.deepEqual(deployReq[0]!.modules, ["web_responsive", "app_menu_enterprise"]);
  assert.deepEqual(vendorReq, [["web_responsive", "app_menu_enterprise"]]);
  assert.equal(deployReq[0]!.addonsArchive, "VENDORED-ARCHIVE");
});

test("an 18 tenant vendors NOTHING — every registry row targets 19", async () => {
  // The nine existing tenants are on 18. Shipping a 19.0.x addon into one is the
  // silent-wrong-default spec 0205 exists to stop.
  const { deps, deployReq, vendorReq } = fakeOdooDeps({
    resolveProject: async () => ({ version: "18", intake: { procesos: "Compras" } }),
  });
  await provisionOdoo(INPUT, deps);
  assert.deepEqual(deployReq[0]!.modules, ["purchase"]);
  assert.deepEqual(vendorReq, [[]], "asked for nothing");
  assert.equal(deployReq[0]!.addonsArchive, undefined, "no archive at all, not an empty one");
});

test("cdfi_invoice is vendored only when the customer ticked CFDI", async () => {
  const { deps, deployReq, vendorReq } = fakeOdooDeps({
    resolveProject: async () => ({
      version: "19",
      intake: { procesos: "Facturación electrónica (CFDI)" },
    }),
  });
  await provisionOdoo(INPUT, deps);
  assert.ok(vendorReq[0]!.includes("cdfi_invoice"), "CFDI was ticked, so the addon must ship");
  assert.ok(
    deployReq[0]!.modules?.includes("cdfi_invoice"),
    "shipping the files without naming the module leaves Odoo unaware of it (spec 0176)",
  );
});

test("the outcome records what ir_module_module confirms, not what we asked for", async () => {
  // The deploy reports only `point_of_sale` back — `purchase` did not install.
  // That gap is the whole reason this record exists.
  const { deps, outcomes } = fakeOdooDeps({
    deploy: async (opts) =>
      ({
        tenantId: opts.tenantId,
        stack: "prod",
        odooVersion: opts.odooVersion,
        healthy: true,
        odooHttpOk: true,
        ingressOk: true,
        modules: ["point_of_sale"],
      }) as DeployResult,
    resolveProject: async () => ({
      version: "19",
      intake: { procesos: "Punto de venta (POS)|Compras" },
    }),
  });
  await provisionOdoo(INPUT, deps);
  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0]!.installed, ["point_of_sale"]);
  // Spec 0206: the vendored pair is requested too, so a vendored addon that
  // failed to install shows up as missing rather than disappearing.
  assert.deepEqual(outcomes[0]!.missing, ["purchase", "web_responsive", "app_menu_enterprise"]);
});

test("a refused proceso is recorded even though it installs nothing", async () => {
  // On 18 there is no verified `cdfi_invoice` to vendor (spec 0206), so CFDI
  // installs nothing. Recording only the installs would make it indistinguishable
  // from a proceso nobody asked for.
  const { deps, deployReq, outcomes } = fakeOdooDeps({
    resolveProject: async () => ({
      version: "18",
      intake: { procesos: "Facturación electrónica (CFDI)" },
    }),
  });
  await provisionOdoo(INPUT, deps);
  assert.equal(deployReq[0]!.modules, undefined, "nothing installable, so no modules argument");
  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0]!.requested, []);
  assert.equal(outcomes[0]!.refused.length, 1);
  assert.match(outcomes[0]!.refused[0]!.why, /cdfi_invoice/);
});

test("a module gap does not fail the provision — the Odoo is up and serving", async () => {
  const { deps, store } = fakeOdooDeps({
    deploy: async (opts) =>
      ({
        tenantId: opts.tenantId,
        stack: "prod",
        odooVersion: opts.odooVersion,
        healthy: true,
        odooHttpOk: true,
        ingressOk: true,
        modules: [],
      }) as DeployResult,
    resolveProject: async () => ({ version: "19", intake: { procesos: "Compras" } }),
  });
  await provisionOdoo(INPUT, deps);
  assert.equal(store.get("acme"), "100001", "provisioning completed and recorded the VPS");
});

test("provisionOdoo refuses an unparseable project version", async () => {
  const { deps, deployReq } = fakeOdooDeps({ resolveProject: async () => ({ version: "banana", intake: {} }) });
  await assert.rejects(
    () => provisionOdoo(INPUT, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.type === "ProvisionConfig",
  );
  assert.equal(deployReq.length, 0, "no deploy on a bad version");
});

test("provisionOdoo refuses without a worker SSH identity", async () => {
  const { deps, deployReq } = fakeOdooDeps({
    env: {
      [PROVISION_VPS_ID_ENV]: "100001",
      LAUNCHPAD_ODOO_MASTER_PASSWORD: "master-pw",
      LAUNCHPAD_ODOO_ADMIN_PASSWORD: "admin-pw",
    },
  });
  await assert.rejects(
    () => provisionOdoo(INPUT, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.type === "ProvisionConfig",
  );
  assert.equal(deployReq.length, 0, "no deploy without an SSH identity");
});

test("provisionOdoo refuses when an Odoo password is missing", async () => {
  const { deps, deployReq } = fakeOdooDeps({
    env: {
      [PROVISION_VPS_ID_ENV]: "100001",
      LAUNCHPAD_FLEET_SSH_IDENTITY: "/keys/id_ed25519",
      LAUNCHPAD_ODOO_MASTER_PASSWORD: "master-pw",
    },
  });
  await assert.rejects(
    () => provisionOdoo(INPUT, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.type === "ProvisionConfig",
  );
  assert.equal(deployReq.length, 0, "no deploy without both Odoo passwords");
});

test("provisionOdoo surfaces a fleet deploy failure as a non-retryable failure", async () => {
  const { deps } = fakeOdooDeps({
    deploy: async () => {
      throw new HostingerApiError("conflict", "VPS is not in the sandbox allowlist", {
        retryable: false,
      });
    },
  });
  await assert.rejects(
    () => provisionOdoo(INPUT, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.nonRetryable === true,
  );
});

// Spec 0161 F2 phase D. provisionFront tars the project's checkout (repo_root) →
// base64 → deployFrontStack onto the sandbox VPS, reaching Odoo at the phase-C
// host. Driven through injected fakes — no live tar/SSH/Hostinger/DB.

function fakeFrontDeps(
  over: {
    env?: NodeJS.ProcessEnv;
    getVps?: () => Promise<VpsInstance>;
    deploy?: (opts: DeployFrontStackOptions) => Promise<FrontDeployResult>;
    resolveProjectRepoRoot?: (slug: string) => Promise<string | null>;
    packCheckout?: (repoRoot: string) => Promise<string>;
  } = {},
): { deps: ProvisionFrontDeps; deployReq: DeployFrontStackOptions[]; packedRoots: string[] } {
  const deployReq: DeployFrontStackOptions[] = [];
  const packedRoots: string[] = [];
  const deps: ProvisionFrontDeps = {
    env: over.env ?? {
      [PROVISION_VPS_ID_ENV]: "100001",
      LAUNCHPAD_FLEET_SSH_IDENTITY: "/keys/id_ed25519",
    },
    resolveHostingerToken: () => "tok",
    createHostingerClient: () => ({
      getVps:
        over.getVps ??
        (async () => ({ ipv4: [{ address: SANDBOX_IPV4 }] }) as unknown as VpsInstance),
    }),
    createSshRunner: () => SSH_SENTINEL,
    packCheckout:
      over.packCheckout ??
      (async (root) => {
        packedRoots.push(root);
        return "BASE64TARGZ==";
      }),
    deployFrontStack: async (opts) => {
      deployReq.push(opts);
      return (
        over.deploy ??
        (async () =>
          ({
            slug: opts.slug,
            name: `${opts.slug}-front`,
            host: `${opts.slug}.example.com`,
            ingressOk: true,
          }) as FrontDeployResult)
      )(opts);
    },
    readOdooReadonly: async () => ({ user: "front_readonly", password: "ro-pass-not-a-real-secret" }),
    resolveProjectRepoRoot: over.resolveProjectRepoRoot ?? (async () => "/checkouts/acme"),
  };
  return { deps, deployReq, packedRoots };
}

test("provisionFront packs the checkout and deploys the front at the odoo host + letsencrypt", async () => {
  const { deps, deployReq, packedRoots } = fakeFrontDeps();
  await provisionFront(INPUT, deps);
  assert.deepEqual(packedRoots, ["/checkouts/acme"], "tars the project's persisted repo_root");
  assert.equal(deployReq.length, 1);
  const opts = deployReq[0]!;
  assert.equal(opts.slug, "acme");
  assert.equal(opts.domain, "example.com");
  assert.equal(opts.odooUrl, `https://${provisionOdooHost("acme")}`);
  assert.equal(opts.odooUrl, "https://acme.odoo.example.com");
  assert.equal(opts.certResolver, "letsencrypt");
  assert.equal(opts.sourceArchive, "BASE64TARGZ==");
  assert.equal(opts.ssh, SSH_SENTINEL);
});

test("provisionFront refuses when the project has no checkout (repo_root)", async () => {
  const { deps, deployReq } = fakeFrontDeps({ resolveProjectRepoRoot: async () => null });
  await assert.rejects(
    () => provisionFront(INPUT, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.type === "ProvisionConfig",
  );
  assert.equal(deployReq.length, 0, "no deploy without a checkout to build from");
});

test("provisionFront refuses without a configured sandbox VPS id", async () => {
  const { deps, deployReq } = fakeFrontDeps({ env: {} });
  await assert.rejects(
    () => provisionFront(INPUT, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.type === "ProvisionConfig",
  );
  assert.equal(deployReq.length, 0, "no deploy when the VPS id is missing");
});

test("provisionFront surfaces a fleet deploy failure as a non-retryable failure", async () => {
  const { deps } = fakeFrontDeps({
    deploy: async () => {
      throw new HostingerApiError("conflict", "VPS is not in the sandbox allowlist", {
        retryable: false,
      });
    },
  });
  await assert.rejects(
    () => provisionFront(INPUT, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.nonRetryable === true,
  );
});

// Spec 0161 F2 phase F. verifyProvision asserts the end state the deploys CANNOT
// (each verifies from the VPS with `curl --resolve -k`): public DNS → sandbox
// IPv4, and a VALID ACME cert + 200 on the odoo host. The front's "renders data
// FROM Odoo" stays (human) by design. Driven through injected fakes — no live
// DNS/HTTPS/Hostinger.

function fakeVerifyDeps(
  over: {
    env?: NodeJS.ProcessEnv;
    getVps?: () => Promise<VpsInstance>;
    resolve4?: (hostname: string) => Promise<string[]>;
    httpsStatus?: (url: string) => Promise<number>;
    deadlineMs?: number;
    intervalMs?: number;
  } = {},
): { deps: ProvisionVerifyDeps; resolved: string[]; fetched: string[] } {
  const resolved: string[] = [];
  const fetched: string[] = [];
  const deps: ProvisionVerifyDeps = {
    env: over.env ?? { [PROVISION_VPS_ID_ENV]: "100001" },
    resolveHostingerToken: () => "tok",
    createHostingerClient: () => ({
      getVps:
        over.getVps ??
        (async () => ({ ipv4: [{ address: SANDBOX_IPV4 }] }) as unknown as VpsInstance),
    }),
    resolve4: async (hostname) => {
      resolved.push(hostname);
      return (over.resolve4 ?? (async () => [SANDBOX_IPV4]))(hostname);
    },
    httpsStatus: async (url) => {
      fetched.push(url);
      return (over.httpsStatus ?? (async () => 200))(url);
    },
    // deadline 0 → a single pass then break, so failure tests never really sleep.
    deadlineMs: over.deadlineMs ?? 0,
    intervalMs: over.intervalMs ?? 1,
    sleep: async () => {},
  };
  return { deps, resolved, fetched };
}

test("verifyProvision passes when both hosts resolve to the sandbox VPS and Odoo serves 200 over a valid cert", async () => {
  const { deps, resolved, fetched } = fakeVerifyDeps();
  await verifyProvision(INPUT, deps);
  assert.deepEqual(resolved, ["acme.example.com", "acme.odoo.example.com"]);
  assert.deepEqual(fetched, ["https://acme.odoo.example.com/web/login"]);
});

test("verifyProvision fails when a hostname resolves to a different box", async () => {
  const { deps, fetched } = fakeVerifyDeps({ resolve4: async () => ["203.0.113.40"] });
  await assert.rejects(
    () => verifyProvision(INPUT, deps),
    (e: unknown) =>
      e instanceof ApplicationFailure &&
      e.type === "ProvisionVerifyFailed" &&
      /not the sandbox VPS/.test(e.message),
  );
  assert.equal(fetched.length, 0, "never checks the cert while DNS is wrong");
});

test("verifyProvision fails when the odoo host has no valid certificate", async () => {
  const { deps } = fakeVerifyDeps({
    httpsStatus: async () => {
      throw new Error("self signed certificate");
    },
  });
  await assert.rejects(
    () => verifyProvision(INPUT, deps),
    (e: unknown) =>
      e instanceof ApplicationFailure &&
      e.type === "ProvisionVerifyFailed" &&
      /valid certificate/.test(e.message),
  );
});

test("verifyProvision fails when the odoo host answers a non-200 status", async () => {
  const { deps } = fakeVerifyDeps({ httpsStatus: async () => 404 });
  await assert.rejects(
    () => verifyProvision(INPUT, deps),
    (e: unknown) =>
      e instanceof ApplicationFailure &&
      e.type === "ProvisionVerifyFailed" &&
      /answered 404/.test(e.message),
  );
});

test("verifyProvision polls until DNS propagates", async () => {
  let calls = 0;
  const { deps } = fakeVerifyDeps({
    deadlineMs: 10,
    intervalMs: 5,
    resolve4: async () => (++calls <= 2 ? [] : [SANDBOX_IPV4]),
  });
  await verifyProvision(INPUT, deps);
  assert.ok(calls > 2, "retried the DNS lookup until it resolved");
});

test("verifyProvision refuses without a configured sandbox VPS id", async () => {
  const { deps, resolved } = fakeVerifyDeps({ env: {} });
  await assert.rejects(
    () => verifyProvision(INPUT, deps),
    (e: unknown) => e instanceof ApplicationFailure && e.type === "ProvisionConfig",
  );
  assert.equal(resolved.length, 0, "no DNS lookup without a target VPS");
});

// ---------------------------------------------------------------------------
// spec 0171 — provisioning records WHERE production is.
//
// Without this the project's Odoo runs on exactly one known VPS while the
// Versiones button (spec 0170) refuses "es de flota pero no tiene VPS asignada"
// — a correct refusal about an absurd state.
// ---------------------------------------------------------------------------

test("spec 0171: provisionOdoo persists the VPS it deployed to, readable from the store", async () => {
  const { deps, store } = fakeOdooDeps();
  await provisionOdoo(INPUT, deps);
  assert.equal(store.get("acme"), "100001", "the row must name the box the stack is on");
});

test("spec 0171: a FAILED deploy records no VPS — an intention is not a deployment", async () => {
  const { deps, store } = fakeOdooDeps({
    deploy: async () => {
      throw new Error("compose up failed");
    },
  });
  await assert.rejects(() => provisionOdoo(INPUT, deps));
  assert.equal(store.size, 0, "a vps_id written ahead of the deploy would read true and not be");
});

// ---------------------------------------------------------------------------
// spec 0182 — the owner: "domain means the zone."
//
// The constant this replaces is why `ab-test-sandbox` is recorded `1.0.0
// deployed` at `prod.ab-test-sandbox.abtest.example.com`, a name whose whole zone
// does not resolve: provisioning wrote DNS into `example.com` while the project's
// `domain` said `abtest.example.com`, and the release deploy believed the project.
// ---------------------------------------------------------------------------

/**
 * Spec 0182 as the owner revised it: we always provision into a zone WE control, and a
 * customer's own domain never drives the records we create — we cannot write
 * them. A project's `domain` is theirs to point at us, verified later by resolve
 * tests (spec 0185).
 *
 * The first cut of this took the zone from the project, which would have turned
 * `ab-test-sandbox`'s unwritable `abtest.example.com` from a silently-wrong record
 * into a failed provisioning. Loud beats silent, but neither is what a customer
 * needs: a working hostname on day one.
 */
test("spec 0182: DNS always lands in the zone we control, whatever the project says", async () => {
  const { deps, upserts } = fakeDnsDeps();
  // A zone on the input is ignored on purpose — it is not ours to write.
  await provisionDns({ slug: "acme", zone: "clientezone.mx" }, deps);
  assert.deepEqual(upserts.map((r) => `${r.name}.${r.domain}`), [
    "acme.example.com",
    "acme.odoo.example.com",
  ]);
});

test("spec 0182: the odoo host comes from the SAME definition the release uses", () => {
  // `provisionOdooHost` and the release deploy's host both call `hosts.ts` now.
  // Two callers deriving one host from different inputs is spec 0175's defect.
  assert.equal(provisionOdooHost("acme"), odooHostFor("acme"));
  assert.equal(provisionOdooHost("acme"), "acme.odoo.example.com");
});
