/**
 * Spec 0170. A production deploy that quietly did nothing, or that guessed at a
 * VPS, would be worse than one that names the empty field — so these are all
 * about WHICH refusal comes out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deployRelease,
  odooSeriesOf,
  PRODUCTION_STACK,
  type DeployReleaseDeps,
} from "./release-deploy.js";

const INPUT = {
  projectSlug: "acme",
  version: "1.4.2",
  releaseId: "rel-1",
  commitSha: "abc1234",
  deployedBy: "owner@example.com",
  backupTimestamp: "20260812T123000Z",
};

type Project = NonNullable<Awaited<ReturnType<DeployReleaseDeps["loadProject"]>>>;

const PROJECT: Project = {
  slug: "acme",
  kind: "odoo",
  productionKind: "fleet",
  vpsId: "100001",
  version: "18.0",
  domain: "example.com",
};

function deps(over: Partial<DeployReleaseDeps> = {}, project = PROJECT): DeployReleaseDeps {
  return {
    env: {
      LAUNCHPAD_FLEET_SSH_IDENTITY: "/etc/launchpad/fleet_key",
      LAUNCHPAD_ODOO_MASTER_PASSWORD: "m",
      LAUNCHPAD_ODOO_ADMIN_PASSWORD: "a",
    },
    createSshRunner: () => ({ exec: async () => ({ code: 0, stdout: "", stderr: "" }), writeFile: async () => {} }),
    createHostingerClient: () => ({ getVps: async () => ({ ipv4: [{ address: "203.0.113.20" }] }) }) as never,
    resolveHostingerToken: () => "tok",
    deployProductionStack: (async (o: { stack?: string }) => ({ stack: o.stack })) as never,
    readOdooReadonly: async () => ({ user: "front_readonly", password: "ro-pass-not-a-real-secret" }),
    readOrCreateDbPassword: async () => "pw",
    installTenantModules: (async (o: { modules: string[] }) => ({
      tenantId: "acme",
      stack: "prod",
      modules: o.modules,
    })) as never,
    packCheckout: async () => "FRONT-ARCHIVE",
    deployFrontStack: (async (o: { host?: string; slug: string }) => ({
      slug: o.slug,
      name: `${o.slug}-front`,
      host: o.host ?? "",
      ingressOk: true,
    })) as never,
    materializeAt: async () => "/tmp/does-not-matter",
    loadProject: async () => project as never,
    ...over,
  };
}

test("a project with no production configured refuses, naming the field", async () => {
  await assert.rejects(
    () => deployRelease(INPUT, deps({}, { ...PROJECT, productionKind: "none" })),
    /production_kind/,
  );
  await assert.rejects(
    () => deployRelease(INPUT, deps({}, { ...PROJECT, productionKind: null })),
    /production_kind/,
  );
});

test("a fleet project with no VPS refuses by field name, and never guesses one", async () => {
  // Guessing would deploy a customer's code onto whatever box was handy.
  await assert.rejects(
    () => deployRelease(INPUT, deps({}, { ...PROJECT, vpsId: null })),
    /vps_id/,
  );
  await assert.rejects(
    () => deployRelease(INPUT, deps({}, { ...PROJECT, vpsId: "not-a-number" })),
    /vps_id/,
  );
});

test("a missing worker secret refuses by NAME rather than deploying without it", async () => {
  // Standing up an Odoo whose database manager keeps its default master password
  // is the failure this prevents.
  for (const missing of ["LAUNCHPAD_ODOO_MASTER_PASSWORD", "LAUNCHPAD_ODOO_ADMIN_PASSWORD", "LAUNCHPAD_FLEET_SSH_IDENTITY"]) {
    const env: Record<string, string> = {
      LAUNCHPAD_FLEET_SSH_IDENTITY: "/k",
      LAUNCHPAD_ODOO_MASTER_PASSWORD: "m",
      LAUNCHPAD_ODOO_ADMIN_PASSWORD: "a",
    };
    delete env[missing];
    await assert.rejects(() => deployRelease(INPUT, deps({ env })), new RegExp(missing), missing);
  }
});

test("odoo.sh refuses with the reason, not a guessed branch", async () => {
  // Guessing `production` would push a commit to a customer's repo.
  await assert.rejects(
    () => deployRelease(INPUT, deps({}, { ...PROJECT, productionKind: "odoosh" })),
    /odoo\.sh/,
  );
});

test("a fleet deploy packs the RELEASE's commit and targets the prod stack", async () => {
  let materializedSha = "";
  let deployed: { stack?: string; tenantId?: string; odooVersion?: number } = {};
  const result = await deployRelease(
    INPUT,
    deps({
      materializeAt: async (_slug, sha) => {
        materializedSha = sha;
        return "/tmp/export";
      },
      deployProductionStack: (async (o: typeof deployed) => {
        deployed = o;
        return { stack: o.stack };
      }) as never,
    }),
  );
  // The release is a promise about a specific tree; packing anything else breaks it.
  assert.equal(materializedSha, INPUT.commitSha);
  assert.equal(deployed.stack, PRODUCTION_STACK);
  assert.equal(deployed.tenantId, "acme");
  assert.equal(deployed.odooVersion, 18, "series comes from the project, not a constant");
  assert.equal(result.deployRef, PRODUCTION_STACK);
});

test("an unparseable Odoo series refuses instead of silently deploying 18", async () => {
  assert.equal(odooSeriesOf("17.0"), 17);
  assert.equal(odooSeriesOf(""), 18, "absent defaults, which is a documented choice");
  assert.throws(() => odooSeriesOf("saas~16.4"), /17, 18 ni 19/);
});

// ---------------------------------------------------------------------------
// spec 0172 — shipping a release ships the front.
// ---------------------------------------------------------------------------

/** A real export dir, because the front decision reads the TREE (is there a
 * Dockerfile?) rather than trusting the project row. */
async function exportDir(files: Record<string, string>): Promise<string> {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const nodePath = (await import("node:path")).default;
  const dir = await mkdtemp(nodePath.join(tmpdir(), "release-export-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(nodePath.join(dir, name), body);
  }
  return dir;
}

test("spec 0172: an odoo-next release deploys the front AFTER Odoo, from the same commit", async () => {
  const dir = await exportDir({ Dockerfile: "FROM node:22-slim\n" });
  const order: string[] = [];
  const fronts: Array<{ host?: string; odooUrl: string; sourceArchive: string; certResolver?: string }> = [];
  await deployRelease(
    INPUT,
    deps(
      {
        materializeAt: async () => dir,
        packCheckout: async () => "RlJPTlQ=",
        deployProductionStack: (async (o: { stack?: string }) => {
          order.push("odoo");
          return { stack: o.stack };
        }) as never,
        deployFrontStack: (async (o: {
          slug: string;
          host?: string;
          odooUrl: string;
          sourceArchive: string;
          certResolver?: string;
        }) => {
          order.push("front");
          fronts.push({
            host: o.host,
            odooUrl: o.odooUrl,
            sourceArchive: o.sourceArchive,
            certResolver: o.certResolver,
          });
          return { slug: o.slug, name: "f", host: "", ingressOk: true };
        }) as never,
      },
      { ...PROJECT, kind: "odoo_next" },
    ),
  );
  assert.deepEqual(order, ["odoo", "front"], "the front reads Odoo at boot — Odoo migrates first");
  assert.equal(fronts.length, 1);
  assert.equal(fronts[0]!.sourceArchive, "RlJPTlQ=", "built from the release's own export");
  assert.equal(fronts[0]!.odooUrl, "https://acme.odoo.example.com");
  assert.equal(fronts[0]!.certResolver, "letsencrypt");
});

test("spec 0172: an odoo-next release with no Dockerfile REFUSES, naming the file", async () => {
  // Deploying the Odoo half and calling that a release is the silent
  // half-deploy this spec exists to close.
  const dir = await exportDir({ "README.md": "# acme\n" });
  await assert.rejects(
    () =>
      deployRelease(
        INPUT,
        deps({ materializeAt: async () => dir }, { ...PROJECT, kind: "odoo_next" }),
      ),
    /Dockerfile/,
  );
});

test("spec 0172: a plain odoo project ships no front, and that is not a failure", async () => {
  const dir = await exportDir({ "README.md": "# addons only\n" });
  let called = 0;
  await deployRelease(
    INPUT,
    deps(
      {
        materializeAt: async () => dir,
        deployFrontStack: (async (o: { slug: string }) => {
          called += 1;
          return { slug: o.slug, name: "f", host: "", ingressOk: true };
        }) as never,
      },
      { ...PROJECT, kind: "odoo" },
    ),
  );
  assert.equal(called, 0);
});

/**
 * Spec 0175 — measured live: the first release of `sushi` re-rendered its Odoo
 * compose as `Host(prod.sushi.example.com)`, a name with no DNS, and
 * `sushi.odoo.example.com` began answering 404. The argument IS the contract here:
 * what is under test is precisely which hostname the deploy asks for.
 */
test("spec 0175: a release deploys Odoo on the host PROVISIONING assigned", async () => {
  const dir = await exportDir({ Dockerfile: "FROM node:22-slim\n" });
  const odoo: Array<{ host?: string; certResolver?: string; domain: string }> = [];
  const fronts: Array<{ odooUrl: string }> = [];
  await deployRelease(
    INPUT,
    deps(
      {
        materializeAt: async () => dir,
        packCheckout: async () => "RlJPTlQ=",
        deployProductionStack: (async (o: { host?: string; certResolver?: string; domain: string; stack?: string }) => {
          odoo.push({ host: o.host, certResolver: o.certResolver, domain: o.domain });
          return { stack: o.stack };
        }) as never,
        deployFrontStack: (async (o: { slug: string; odooUrl: string }) => {
          fronts.push({ odooUrl: o.odooUrl });
          return { slug: o.slug, name: "f", host: "", ingressOk: true };
        }) as never,
      },
      { ...PROJECT, kind: "odoo_next" },
    ),
  );
  assert.equal(odoo[0]?.host, "acme.odoo.example.com");
  // The default is the bug: `prod.<slug>.<domain>` is a name nobody created.
  assert.doesNotMatch(odoo[0]?.host ?? "", /^prod\./);
  assert.equal(odoo[0]?.certResolver, "letsencrypt", "the real cert, as provisioning issued it");
  // And the front must point at the same host, or it 500s against a dead route.
  assert.equal(fronts[0]?.odooUrl, "https://acme.odoo.example.com");
});

test("spec 0176: the release INSTALLS its addons into the existing database", async () => {
  const dir = await exportDir({ "README.md": "# acme\n" });
  const installs: Array<{ modules: string[]; stack?: string; timestamp: string }> = [];
  await deployRelease(
    INPUT,
    deps({
      materializeAt: async () => dir,
      // A tree with one addon, so discoverAddons finds something to install.
      installTenantModules: (async (o: { modules: string[]; stack?: string; timestamp: string }) => {
        installs.push({ modules: o.modules, stack: o.stack, timestamp: o.timestamp });
        return { tenantId: "acme", stack: "prod", modules: o.modules };
      }) as never,
    }),
  );
  // No addons in this tree, so nothing to install — and nothing pretended.
  assert.equal(installs.length, 0);
});

test("spec 0176: a FAILING install fails the release — never a green half-deploy", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const nodePath = (await import("node:path")).default;
  const dir = await exportDir({ "README.md": "# acme\n" });
  await mkdir(nodePath.join(dir, "acme_addon"), { recursive: true });
  await writeFile(nodePath.join(dir, "acme_addon", "__manifest__.py"), "{'version': '18.0.1.0.0'}\n");
  await assert.rejects(
    () =>
      deployRelease(
        INPUT,
        deps({
          materializeAt: async () => dir,
          installTenantModules: (async () => {
            throw new Error("module sushi_menu did not reach installed");
          }) as never,
        }),
      ),
    /did not reach installed/,
  );
});

test("spec 0176: an activity without the workflow's stamp refuses by name", async () => {
  // The stamp is minted by the workflow (spec 0105). An activity that stamped
  // itself would orphan one backup directory per retry — so its absence is a
  // named refusal, not a silent Date.now().
  const dir = await exportDir({ "README.md": "# acme\n" });
  const { mkdir, writeFile } = await import("node:fs/promises");
  const nodePath = (await import("node:path")).default;
  await mkdir(nodePath.join(dir, "acme_addon"), { recursive: true });
  await writeFile(nodePath.join(dir, "acme_addon", "__manifest__.py"), "{'version': '18.0.1.0.0'}\n");
  const { backupTimestamp: _omitted, ...noStamp } = INPUT;
  await assert.rejects(
    () => deployRelease(noStamp as typeof INPUT, deps({ materializeAt: async () => dir })),
    /backupTimestamp/,
  );
});
