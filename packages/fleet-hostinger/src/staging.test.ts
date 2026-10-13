/**
 * Spec 0119. The fake SSH runner is a Map — it cannot model a filesystem, which
 * is exactly the gap specs 0093/0094/0097 were bitten by. So these tests assert
 * the things a fake CAN prove honestly: naming, the refusal guards, command
 * ORDERING, and that a destroy deletes volumes. Whether the containers actually
 * come up is a live check, marked `(human)` in the spec.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import posix from "node:path/posix";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  addonModuleName,
  packAddonsWithTar,
  destroyStagingStack,
  destroyBranchStack,
  discoverAddons,
  isStagingStack,
  isBranchStack,
  branchStackName,
  frontStackFor,
  claimingBranchStack,
  listStagingStacks,
  listStagingStackRefs,
  stagingStackName,
  deployStagingStack,
  deployBranchStagingStack,
  STAGING_STACKS_PER_VPS,
} from "./staging.js";
import { FleetError } from "./errors.js";
import { createFakeSshRunner } from "./ssh.js";
import { composeProjectName, remoteStackDir } from "./stack.js";

// The refused example is a SYNTHETIC id (999999) that is not, and will never be, in
// infra/fleet-sandbox.json. Spec 0125 is why: it briefly allowlisted a real id, which would
// have made this guard's own tests pass while proving nothing. Keying them to an id nobody
// can allowlist means an edit to that file can never quietly turn these green.

const SANDBOX_VPS = 100001;
const execFileAsync = promisify(execFile);

/** Entry names inside a base64 tar.gz — reads the archive back rather than
 * trusting the flags we passed, which is the difference between proving the
 * call and proving the result. Via a temp FILE, not stdin: `promisify(execFile)`
 * silently ignores an `input` option, so `tar -tzf -` waits on stdin forever. */
async function listTarEntries(b64: string): Promise<string[]> {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "tarcheck-")), "a.tar.gz");
  writeFileSync(file, Buffer.from(b64, "base64"));
  const { stdout } = await execFileAsync("tar", ["-tzf", file], { maxBuffer: 64 * 1024 * 1024 });
  return String(stdout).split("\n").map((x) => x.trim()).filter(Boolean);
}

// --- naming ----------------------------------------------------------------

test("stagingStackName derives a safe DNS label / path segment from the spec id", () => {
  assert.equal(stagingStackName("0120"), "spec-0120");
});

test("stagingStackName refuses anything that is not four digits", () => {
  // It flows into a Traefik Host() rule, a compose project name, a DB name and
  // a remote path — so it is validated at the source rather than sanitized at
  // each of those four places.
  for (const bad of ["", "12", "12345", "0120; rm -rf /", "../etc", "spec-0120", "abcd"]) {
    assert.throws(() => stagingStackName(bad), /invalid spec id/, bad);
  }
});

test("isStagingStack never matches prod — the guard teardown relies on", () => {
  assert.equal(isStagingStack("spec-0120"), true);
  for (const notStaging of ["prod", "staging", "spec-", "spec-abc", "spec-012", "prod-spec-0120"]) {
    assert.equal(isStagingStack(notStaging), false, notStaging);
  }
});

// --- addon discovery --------------------------------------------------------

function repoWith(layout: Record<string, string[]>): string {
  const root = mkdtempSync(path.join(tmpdir(), "staging-test-"));
  for (const [dir, files] of Object.entries(layout)) {
    mkdirSync(path.join(root, dir), { recursive: true });
    for (const f of files) writeFileSync(path.join(root, dir, f), "");
  }
  return root;
}

test("discoverAddons finds directories with a __manifest__.py, at root and under addons/", () => {
  const root = repoWith({
    sale_custom: ["__manifest__.py", "models.py"],
    "addons/stock_custom": ["__manifest__.py"],
    docs: ["README.md"],
    ".git": ["config"],
  });
  assert.deepEqual(discoverAddons(root), ["addons/stock_custom", "sale_custom"]);
});

test("discoverAddons ignores a directory without a manifest — that is Odoo's own definition of an addon", () => {
  const root = repoWith({ scripts: ["deploy.sh"], tests: ["test_thing.py"] });
  assert.deepEqual(discoverAddons(root), []);
});

test("discoverAddons skips dotdirs and is deterministic", () => {
  const root = repoWith({
    ".hidden_addon": ["__manifest__.py"],
    zeta: ["__manifest__.py"],
    alpha: ["__manifest__.py"],
  });
  assert.deepEqual(discoverAddons(root), ["alpha", "zeta"]);
});

test("addonModuleName strips the parent — Odoo installs the basename", () => {
  assert.equal(addonModuleName("addons/stock_custom"), "stock_custom");
  assert.equal(addonModuleName("sale_custom"), "sale_custom");
});


/** A fake that answers the health probes `deployProductionStack` makes, so
 * these tests exercise the staging wiring rather than re-testing the deploy.
 * Same shape as `stack.test.ts`'s `createHealthySshRunner`. */
function healthySsh(extra?: (command: string) => { code: number; stdout: string; stderr: string } | undefined) {
  return createFakeSshRunner({
    respond(command) {
      const override = extra?.(command);
      if (override) return override;
      if (command.includes("ps --status running --services")) return { code: 0, stdout: "db\nodoo\n", stderr: "" };
      if (command.includes("odoo shell")) {
        // Spec 0121: the marker `setAdminPassword` requires — it proves the ORM
        // matched exactly one user, not merely that the command exited 0.
        // Spec 0208: the same `odoo shell` path also creates the read-only user.
        if (command.includes("ODOO_READONLY_USER_READY")) {
          return { code: 0, stdout: "ODOO_READONLY_USER_READY 1\n", stderr: "" };
        }
        return { code: 0, stdout: "ADMIN_PASSWORD_SET 1\n", stderr: "" };
      }
      if (command.includes("curl")) return { code: 0, stdout: "200", stderr: "" };
      return undefined;
    },
  });
}

// --- capacity ---------------------------------------------------------------

/** Scripts the box-wide stack listing the capacity guard reads. */
function sshWithStagingStacks(stacks: readonly string[]) {
  return healthySsh((command) =>
    command.includes("-name 'spec-*'")
      ? { code: 0, stdout: `${stacks.join("\n")}\n`, stderr: "" }
      : undefined,
  );
}

function stagingOpts(ssh: ReturnType<typeof healthySsh>, specId: string, root: string) {
  return {
    tenantId: "acme",
    specId,
    vpsId: SANDBOX_VPS,
    ssh,
    odooVersion: 18 as const,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
  };
}

test("deployStagingStack refuses once the VPS is at STAGING_STACKS_PER_VPS", async () => {
  const root = repoWith({ sale_custom: ["__manifest__.py"] });
  const full = Array.from({ length: STAGING_STACKS_PER_VPS }, (_, i) => `spec-01${String(i).padStart(2, "0")}`);
  const ssh = sshWithStagingStacks(full);
  await assert.rejects(
    () => deployStagingStack(stagingOpts(ssh, "0199", root)),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.retryable, false, "capacity does not clear by retrying");
      assert.match(err.message, new RegExp(String(STAGING_STACKS_PER_VPS)));
      return true;
    },
  );
  // Refused BEFORE doing any work: no compose file was ever written.
  assert.equal(ssh.files.size, 0);
});

test("deployStagingStack proceeds one below the limit", async () => {
  // The negative test above is only meaningful if the positive one passes — a
  // guard that refuses everything would satisfy it too.
  const root = repoWith({ sale_custom: ["__manifest__.py"] });
  const nearlyFull = Array.from({ length: STAGING_STACKS_PER_VPS - 1 }, (_, i) => `spec-02${String(i).padStart(2, "0")}`);
  const ssh = sshWithStagingStacks(nearlyFull);
  const result = await deployStagingStack(stagingOpts(ssh, "0199", root));
  assert.equal(result.stack, "spec-0199");
});

test("deployStagingStack allows REDEPLOYING a stack that is itself at the limit", async () => {
  // Its own stack must not count against it, or a retry at capacity could never
  // converge: it would refuse the very stack it is replacing.
  const root = repoWith({ sale_custom: ["__manifest__.py"] });
  const full = Array.from({ length: STAGING_STACKS_PER_VPS - 1 }, (_, i) => `spec-03${String(i).padStart(2, "0")}`);
  const ssh = sshWithStagingStacks([...full, "spec-0199"]);
  const result = await deployStagingStack(stagingOpts(ssh, "0199", root));
  assert.equal(result.stack, "spec-0199");
});

test("capacity is counted box-wide, not per tenant — RAM and CPU belong to the VPS", async () => {
  const root = repoWith({ sale_custom: ["__manifest__.py"] });
  const ssh = sshWithStagingStacks([]);
  await deployStagingStack(stagingOpts(ssh, "0199", root));
  const listing = ssh.commands.find((c) => c.includes("-name 'spec-*'"));
  assert.ok(listing, `no stack listing in: ${ssh.commands.join(" | ")}`);
  // Rooted at /opt/launchpad, NOT /opt/launchpad/acme — a stack belonging to
  // another tenant consumes the same box.
  assert.match(listing, /find \/opt\/launchpad /);
  assert.equal(listing.includes("/opt/launchpad/acme"), false);
});

// --- deploy -----------------------------------------------------------------

test("deployStagingStack names the stack after the spec and installs the discovered addons", async () => {
  const root = repoWith({ sale_custom: ["__manifest__.py"] });
  const ssh = healthySsh();
  const result = await deployStagingStack({
    tenantId: "acme",
    specId: "0120",
    vpsId: SANDBOX_VPS,
    ssh,
    odooVersion: 18,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
  });
  assert.equal(result.stack, "spec-0120");
  assert.equal(result.specId, "0120");
  assert.deepEqual(result.addons, ["sale_custom"]);
  assert.equal(result.host, "spec-0120.acme.example.test");
});

test("deployStagingStack uploads the archive and extracts it AFTER creating addons/", async () => {
  // The 0097 lesson, in test form: ssh.writeFile is a bare `cat >` and creates
  // no parent directories, so an extract before mkdir dies on the first write.
  const root = repoWith({ sale_custom: ["__manifest__.py"] });
  const ssh = healthySsh();
  await deployStagingStack({
    tenantId: "acme",
    specId: "0120",
    vpsId: SANDBOX_VPS,
    ssh,
    odooVersion: 18,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
  });
  const dir = remoteStackDir("acme", "spec-0120");
  const mkdirIdx = ssh.commands.findIndex((c) => c === `mkdir -p ${dir}/addons`);
  const extractIdx = ssh.commands.findIndex((c) => c.includes("base64 -d"));
  assert.ok(mkdirIdx >= 0, `no addons mkdir in: ${ssh.commands.join(" | ")}`);
  assert.ok(extractIdx > mkdirIdx, "extract must come after the addons mkdir");
  assert.equal(ssh.files.get(`${dir}/addons.tar.gz.b64`), "QkFTRTY0");
});

test("deployStagingStack removes the uploaded archive even when tar fails", async () => {
  const root = repoWith({ sale_custom: ["__manifest__.py"] });
  await assert.rejects(
    deployStagingStack({
      tenantId: "acme",
      specId: "0120",
      vpsId: SANDBOX_VPS,
      ssh: healthySsh((c) =>
        c.includes("base64 -d") ? { code: 2, stdout: "", stderr: "tar: bad archive" } : undefined,
      ),
      odooVersion: 18,
      domain: "example.test",
      dbPassword: "pw-not-a-real-secret",
      masterPassword: "master-not-a-real-secret",
      odooUser: "front_readonly",
      odooPassword: "ro-pass-not-a-real-secret",
      adminPassword: "admin-not-a-real-secret",
      repoRoot: root,
      pack: async () => "QkFTRTY0",
    }),
    /failed to extract addons/,
  );
  // The rm is inside the same remote command as the extract, so a failing tar
  // still deletes the upload. Asserted on the command text because the fake
  // cannot model the remote filesystem.
  const ssh2 = healthySsh();
  await deployStagingStack({
    tenantId: "acme",
    specId: "0121",
    vpsId: SANDBOX_VPS,
    ssh: ssh2,
    odooVersion: 18,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
  });
  const cmd = ssh2.commands.find((c) => c.includes("base64 -d"));
  assert.match(cmd ?? "", /rm -f .*addons\.tar\.gz\.b64/);
  assert.match(cmd ?? "", /exit \$rc/, "must preserve tar's exit code, not rm's");
});

test("deployStagingStack with no addons uploads nothing and installs nothing", async () => {
  const root = repoWith({ docs: ["README.md"] });
  const ssh = healthySsh();
  const result = await deployStagingStack({
    tenantId: "acme",
    specId: "0120",
    vpsId: SANDBOX_VPS,
    ssh,
    odooVersion: 18,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => {
      throw new Error("must not pack when there is nothing to pack");
    },
  });
  assert.deepEqual(result.addons, []);
  assert.ok(!ssh.commands.some((c) => c.includes("base64 -d")));
});

test("deployStagingStack is refused for a VPS outside the ADR-013 allowlist", async () => {
  const root = repoWith({ sale_custom: ["__manifest__.py"] });
  await assert.rejects(
    deployStagingStack({
      tenantId: "acme",
      specId: "0120",
      vpsId: 999999, // not on the allowlist
      ssh: createFakeSshRunner(),
      odooVersion: 18,
      domain: "example.test",
      dbPassword: "pw-not-a-real-secret",
      masterPassword: "master-not-a-real-secret",
      odooUser: "front_readonly",
      odooPassword: "ro-pass-not-a-real-secret",
      adminPassword: "admin-not-a-real-secret",
      repoRoot: root,
      pack: async () => "QkFTRTY0",
    }),
    /999999/,
  );
});

// --- destroy ----------------------------------------------------------------

test("destroyStagingStack brings the stack down WITH volumes, then removes the dir", async () => {
  // -v is the point: without it every teardown leaks a Postgres volume and the
  // box fills up one spec at a time.
  const ssh = createFakeSshRunner();
  const result = await destroyStagingStack({
    tenantId: "acme",
    specId: "0120",
    vpsId: SANDBOX_VPS,
    ssh,
  });
  assert.deepEqual(result, { stack: "spec-0120", existed: true });
  const project = composeProjectName("acme", "spec-0120");
  const dir = remoteStackDir("acme", "spec-0120");
  const downIdx = ssh.commands.findIndex((c) => c.includes(`docker compose -p ${project} down`));
  const rmIdx = ssh.commands.findIndex((c) => c === `rm -rf ${dir}`);
  assert.ok(downIdx >= 0, ssh.commands.join(" | "));
  assert.match(ssh.commands[downIdx] ?? "", / -v\b/, "must delete volumes");
  assert.ok(rmIdx > downIdx, "removing the dir first would orphan the containers");
});

test("destroyStagingStack is idempotent — a missing stack is not an error", async () => {
  // It runs on a run's terminal path, which Temporal may retry.
  const ssh = createFakeSshRunner({
    respond: (c) => (c.startsWith("test -d") ? { code: 1, stdout: "", stderr: "" } : undefined),
  });
  const result = await destroyStagingStack({
    tenantId: "acme",
    specId: "0120",
    vpsId: SANDBOX_VPS,
    ssh,
  });
  assert.deepEqual(result, { stack: "spec-0120", existed: false });
  assert.ok(!ssh.commands.some((c) => c.includes("down")), "must not try to bring down what is not there");
});

test("destroyStagingStack cannot be aimed at prod — no argument reaches a non-staging stack", async () => {
  for (const bad of ["prod", "", "0120 prod"]) {
    await assert.rejects(
      destroyStagingStack({ tenantId: "acme", specId: bad, vpsId: SANDBOX_VPS, ssh: createFakeSshRunner() }),
      /invalid spec id/,
      bad,
    );
  }
});

test("destroyStagingStack is refused outside the ADR-013 allowlist", async () => {
  await assert.rejects(
    destroyStagingStack({ tenantId: "acme", specId: "0120", vpsId: 999999, ssh: createFakeSshRunner() }),
    /999999/,
  );
});

// --- listing ----------------------------------------------------------------

test("listStagingStacks returns only spec-NNNN dirs, sorted", async () => {
  const ssh = createFakeSshRunner({
    respond: (c) =>
      c.startsWith("find")
        ? { code: 0, stdout: "spec-0130\nprod\nspec-0120\nnot-a-stack\n\n", stderr: "" }
        : undefined,
  });
  assert.deepEqual(await listStagingStacks(ssh, "acme"), ["spec-0120", "spec-0130"]);
});

test("listStagingStackRefs keeps the tenant, so a sweep can actually destroy what it finds", async () => {
  const ssh = createFakeSshRunner({
    respond: (c) =>
      c.startsWith("find")
        ? { code: 0, stdout: "acme/spec-0130\nsandbox/spec-0120\nacme/prod\n", stderr: "" }
        : undefined,
  });
  assert.deepEqual(await listStagingStackRefs(ssh), [
    { tenantId: "acme", stack: "spec-0130", family: "spec", specId: "0130" },
    { tenantId: "sandbox", stack: "spec-0120", family: "spec", specId: "0120" },
  ]);
});

test("listStagingStackRefs drops anything that is not a spec stack — prod can never enter a sweep", async () => {
  // The sweep's destroy path takes whatever this returns, so this filter is the
  // first of two locks on a volume-deleting operation (destroyStagingStack
  // refuses a non-spec stack again at the bottom).
  const ssh = createFakeSshRunner({
    respond: (c) =>
      c.startsWith("find")
        ? {
            code: 0,
            stdout: "acme/prod\nacme/staging\nacme/spec-abc\nacme/spec-012\nspec-0120\n\n",
            stderr: "",
          }
        : undefined,
  });
  assert.deepEqual(await listStagingStackRefs(ssh), []);
});

test("listStagingStackRefs degrades to empty on an unreadable path, like its sibling", async () => {
  const ssh = createFakeSshRunner({ respond: () => ({ code: 1, stdout: "", stderr: "boom" }) });
  assert.deepEqual(await listStagingStackRefs(ssh), []);
});

test("listStagingStacks degrades to empty — a capacity read must not break a deploy", async () => {
  const ssh = createFakeSshRunner({
    respond: () => ({ code: 1, stdout: "", stderr: "find: no such path" }),
  });
  assert.deepEqual(await listStagingStacks(ssh, "acme"), []);
});

// --- packing hygiene (found live, spec 0119) --------------------------------

test("packAddonsWithTar produces an archive with NO macOS AppleDouble sidecars", async () => {
  // The first live deploy put `.___manifest__.py` and `.___init__.py` inside a
  // real Odoo container. Odoo ignored them and the deploy reported healthy, so
  // only looking at the container caught it — the fake SSH runner is a Map and
  // models no filesystem at all.
  const root = repoWith({ probe_addon: ["__manifest__.py", "__init__.py"] });
  const b64 = await packAddonsWithTar(root, ["probe_addon"]);
  const names = await listTarEntries(b64);
  assert.ok(names.length > 0, "archive should not be empty");
  assert.deepEqual(
    names.filter((n) => posix.basename(n).startsWith("._")),
    [],
    `AppleDouble sidecars in archive: ${names.join(", ")}`,
  );
  assert.ok(names.some((n) => n.endsWith("probe_addon/__manifest__.py")), names.join(", "));
});

test("packAddonsWithTar excludes __pycache__ and .pyc — stale bytecode must not ship", async () => {
  const root = repoWith({
    probe_addon: ["__manifest__.py", "models.pyc"],
    "probe_addon/__pycache__": ["models.cpython-311.pyc"],
  });
  const names = await listTarEntries(await packAddonsWithTar(root, ["probe_addon"]));
  assert.deepEqual(names.filter((n) => n.includes("__pycache__") || n.endsWith(".pyc")), [], names.join(", "));
  assert.ok(names.some((n) => n.endsWith("__manifest__.py")));
});

test("packAddonsWithTar stores a nested addon at its BASENAME, not its repo path", async () => {
  // /mnt/extra-addons/<module> is the addons_path; `addons/stock_custom` must
  // land as `stock_custom` or Odoo will not see it.
  const root = repoWith({ "addons/stock_custom": ["__manifest__.py"] });
  const names = await listTarEntries(await packAddonsWithTar(root, ["addons/stock_custom"]));
  assert.ok(
    names.every((n) => !n.includes("addons/stock_custom")),
    `must not carry the repo-relative parent: ${names.join(", ")}`,
  );
  assert.ok(names.some((n) => n.replace(/^\.\//, "").startsWith("stock_custom")), names.join(", "));
});

test("packAddonsWithTar returns empty for no addons — nothing to upload", async () => {
  assert.equal(await packAddonsWithTar(repoWith({}), []), "");
});

// --- Spec 0134: per-branch staging stacks ------------------------------------

test("branchStackName: sanitization collisions are killed by the hash", () => {
  const a = branchStackName("feature/foo");
  const b = branchStackName("feature-foo");
  const c = branchStackName("Feature_Foo");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
  for (const s of [a, b, c]) {
    assert.ok(isBranchStack(s), s);
    assert.ok(s.length <= 27, `${s} must fit a DNS label with headroom`);
  }
});

test("branchStackName is deterministic and slug-limited", () => {
  const name = "tester/a-very-long-branch-name-that-keeps-going-and-going";
  const s1 = branchStackName(name);
  assert.equal(s1, branchStackName(name), "same branch, same stack — redeploys must key stably");
  assert.match(s1, /^br-[a-z0-9-]{1,20}-[0-9a-f]{6}$/);
});

test("the br- family is disjoint from spec-NNNN and prod, in BOTH directions", () => {
  assert.equal(isBranchStack("spec-0120"), false);
  assert.equal(isBranchStack("prod"), false);
  assert.equal(isStagingStack(branchStackName("feature/foo")), false);
  assert.equal(isBranchStack(branchStackName("feature/foo")), true);
});

test("deployBranchStagingStack keys the stack on the branch and reports the Traefik host", async () => {
  const root = repoWith({ pos_custom: ["__manifest__.py"] });
  const ssh = healthySsh();
  const result = await deployBranchStagingStack({
    tenantId: "abtest",
    branch: "feature/pos",
    vpsId: SANDBOX_VPS,
    ssh,
    odooVersion: 18,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
  });
  assert.equal(result.stack, branchStackName("feature/pos"));
  assert.equal(result.branch, "feature/pos");
  assert.deepEqual(result.addons, ["pos_custom"]);
  assert.match(result.host, new RegExp(`^${branchStackName("feature/pos")}\\.abtest\\.`));
});

test("branch stacks COUNT toward the same capacity limit as spec stacks", async () => {
  const root = repoWith({ pos_custom: ["__manifest__.py"] });
  // A mixed box: spec stacks + branch stacks together at the limit.
  const mixed = [
    ...Array.from({ length: STAGING_STACKS_PER_VPS - 2 }, (_, i) => `spec-04${String(i).padStart(2, "0")}`),
    branchStackName("other/branch"),
    branchStackName("another/branch"),
  ];
  const ssh = sshWithStagingStacks(mixed);
  await assert.rejects(
    () =>
      deployBranchStagingStack({
        tenantId: "abtest",
        branch: "feature/pos",
        vpsId: SANDBOX_VPS,
        ssh,
        odooVersion: 18,
        domain: "example.test",
        dbPassword: "pw-not-a-real-secret",
        masterPassword: "master-not-a-real-secret",
        odooUser: "front_readonly",
        odooPassword: "ro-pass-not-a-real-secret",
        adminPassword: "admin-not-a-real-secret",
        repoRoot: root,
        pack: async () => "QkFTRTY0",
      }),
    (err: unknown) => err instanceof FleetError && !err.retryable,
  );
});

// Spec 0187 C. The refusal that stopped `autopartes` at gate 2 listed
// `br-owner-catalogo-refaccio-81b71a-front` — this branch's OWN front — among the
// six stacks it was counting, while replacing the Odoo stack beside it. Since
// spec 0172 a branch is a pair, so its front is not a second tenant of the limit.
test("a branch's own FRONT does not count against that branch's redeploy", async () => {
  const root = repoWith({ pos_custom: ["__manifest__.py"] });
  const mine = branchStackName("feature/pos");
  const others = Array.from(
    { length: STAGING_STACKS_PER_VPS - 1 },
    (_, i) => `spec-06${String(i).padStart(2, "0")}`,
  );
  // At the limit only if the front is miscounted: others + mine + mine-front.
  const ssh = sshWithStagingStacks([...others, mine, frontStackFor(mine)]);
  const result = await deployBranchStagingStack({
    tenantId: "abtest",
    branch: "feature/pos",
    vpsId: SANDBOX_VPS,
    ssh,
    odooVersion: 18,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
  });
  assert.equal(result.stack, mine);
});

// Spec 0187 E — finding 1.15's shape on the branch path: `deployProductionStack`
// installs at database INIT and nowhere else, so a REDEPLOY copies the reviewed
// addons into /mnt/extra-addons and tells Odoo nothing. Asserts the RESPONSE
// (what the redeploy reports installing), not merely that a dep was called.
test("a REDEPLOY onto an existing branch DB installs the addons it just copied", async () => {
  const root = repoWith({ pos_custom: ["__manifest__.py"] });
  const asked: Array<{ stack: string; modules: string[]; timestamp: string }> = [];
  const result = await deployBranchStagingStack({
    tenantId: "abtest",
    branch: "feature/pos",
    vpsId: SANDBOX_VPS,
    // The tenant DB is already there, so `deployProductionStack` skips init —
    // and with it the ONLY moment it installs anything.
    ssh: healthySsh((command) =>
      command.includes("SELECT 1 FROM pg_database")
        ? { code: 0, stdout: "1\n", stderr: "" }
        : undefined,
    ),
    odooVersion: 18,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
    backupTimestamp: "20260812T180000Z",
    installModules: async (opts) => {
      asked.push({ stack: opts.stack, modules: opts.modules, timestamp: opts.timestamp });
      return {};
    },
  });
  assert.deepEqual(result.installedOnRedeploy, ["pos_custom"]);
  assert.deepEqual(asked, [
    {
      stack: branchStackName("feature/pos"),
      modules: ["pos_custom"],
      timestamp: "20260812T180000Z",
    },
  ]);
});

// Spec 0189: production has asked for a certificate since 0148 and staging never
// did, so every branch URL served `CN=TRAEFIK DEFAULT CERT` — on the link gate 2
// is validated through. Asserts the resolver reaches BOTH halves: Odoo's router
// labels (read back out of the rendered compose file) and the front's deploy.
test("a branch staging deploy asks for the certificate on Odoo AND on the front", async () => {
  // A root `Dockerfile` is what makes this project have a front at all (0172).
  const root = repoWith({ pos_custom: ["__manifest__.py"] });
  writeFileSync(path.join(root, "Dockerfile"), "FROM node:22\n");
  const ssh = healthySsh();
  let frontResolver: string | undefined = "NOT PASSED";
  await deployBranchStagingStack({
    tenantId: "abtest",
    branch: "feature/pos",
    vpsId: SANDBOX_VPS,
    ssh,
    odooVersion: 18,
    domain: "staging.example.com",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
    packCheckout: async () => "Q0hFQ0tPVVQ=",
    certResolver: "letsencrypt",
    deployFront: async (opts) => {
      frontResolver = opts.certResolver;
      return { slug: opts.slug, name: opts.stack ?? "front", host: opts.host ?? "", ingressOk: true };
    },
  });
  assert.equal(frontResolver, "letsencrypt", "the front is half of what a reviewer opens");
  // The rendered compose file itself, read back out of the fake's filesystem —
  // the labels are the whole point, not the call that produced them.
  const compose = [...ssh.files.values()].join("\n");
  assert.match(compose, /tls\.certresolver=letsencrypt/);
});

test("no resolver renders exactly today's file — a rollback degrades, never fails ACME", async () => {
  const root = repoWith({ pos_custom: ["__manifest__.py"] });
  const ssh = healthySsh();
  await deployBranchStagingStack({
    tenantId: "abtest",
    branch: "feature/pos",
    vpsId: SANDBOX_VPS,
    ssh,
    odooVersion: 18,
    domain: "203.0.113.20.sslip.io",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
  });
  // The LABEL, not the word: the template's own header comment explains what
  // TLS_EXTRA_LABELS does and names the resolver while doing it.
  assert.doesNotMatch([...ssh.files.values()].join("\n"), /tls\.certresolver=/);
});

test("a FIRST deploy installs at init and runs no second install pass", async () => {
  const root = repoWith({ pos_custom: ["__manifest__.py"] });
  let called = 0;
  const result = await deployBranchStagingStack({
    tenantId: "abtest",
    branch: "feature/pos",
    vpsId: SANDBOX_VPS,
    ssh: healthySsh(),
    odooVersion: 18,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
    backupTimestamp: "20260812T180000Z",
    installModules: async () => {
      called += 1;
      return {};
    },
  });
  assert.equal(called, 0, "init already installed them — a second pass would back up for nothing");
  assert.equal(result.installedOnRedeploy, undefined);
});

test("a branch stack REDEPLOY does not count against itself", async () => {
  const root = repoWith({ pos_custom: ["__manifest__.py"] });
  const mine = branchStackName("feature/pos");
  const others = Array.from({ length: STAGING_STACKS_PER_VPS - 1 }, (_, i) => `spec-05${String(i).padStart(2, "0")}`);
  const ssh = sshWithStagingStacks([...others, mine]);
  const result = await deployBranchStagingStack({
    tenantId: "abtest",
    branch: "feature/pos",
    vpsId: SANDBOX_VPS,
    ssh,
    odooVersion: 18,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
  });
  assert.equal(result.stack, mine);
});

test("destroyBranchStack refuses spec- and prod names — no argument reaches a production stack", async () => {
  for (const stack of ["spec-0120", "prod", "PROD", "br-"]) {
    await assert.rejects(
      () =>
        destroyBranchStack({
          tenantId: "abtest",
          stack,
          vpsId: SANDBOX_VPS,
          ssh: createFakeSshRunner(),
        }),
      (err: unknown) => err instanceof FleetError && !err.retryable,
      stack,
    );
  }
});

test("destroyBranchStack outside the allowlist is hard-refused (ADR-013)", async () => {
  await assert.rejects(
    () =>
      destroyBranchStack({
        tenantId: "abtest",
        stack: branchStackName("feature/pos"),
        vpsId: 999999,
        ssh: createFakeSshRunner(),
      }),
    (err: unknown) => err instanceof FleetError,
  );
});

test("destroyBranchStack is idempotent: an absent directory reports existed=false", async () => {
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.startsWith("test -d")) return { code: 1, stdout: "", stderr: "" };
      return undefined;
    },
  });
  const result = await destroyBranchStack({
    tenantId: "abtest",
    stack: branchStackName("feature/pos"),
    vpsId: SANDBOX_VPS,
    ssh,
  });
  assert.equal(result.existed, false);
});

test("destroyBranchStack brings the compose project down WITH volumes before removing the dir", async () => {
  const stack = branchStackName("feature/pos");
  const dir = remoteStackDir("abtest", stack);
  const commands: string[] = [];
  const ssh = createFakeSshRunner({
    respond(command) {
      commands.push(command);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const result = await destroyBranchStack({ tenantId: "abtest", stack, vpsId: SANDBOX_VPS, ssh });
  assert.equal(result.existed, true);
  const down = commands.find((c) => c.includes("docker compose"));
  assert.ok(down?.includes("down -v"), `volumes are the leak: ${down}`);
  assert.ok(down?.includes(composeProjectName("abtest", stack)));
  const downIndex = commands.findIndex((c) => c.includes("down -v"));
  const rmIndex = commands.findIndex((c) => c.startsWith(`rm -rf ${dir}`));
  assert.ok(downIndex >= 0 && rmIndex > downIndex, "rm only after a clean down");
});

test("listStagingStackRefs reports BOTH families with their lifecycle", async () => {
  const branchStack = branchStackName("feature/pos");
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.includes("-name 'spec-*'")) {
        return { code: 0, stdout: `acme/spec-0120\nabtest/${branchStack}\nacme/junk\n`, stderr: "" };
      }
      return undefined;
    },
  });
  const refs = await listStagingStackRefs(ssh);
  // Sorted by tenant/stack (the function's own contract): abtest < acme.
  assert.deepEqual(refs, [
    { tenantId: "abtest", stack: branchStack, family: "branch" },
    { tenantId: "acme", stack: "spec-0120", family: "spec", specId: "0120" },
  ]);
});

// ---------------------------------------------------------------------------
// spec 0172 — a branch's staging is the WHOLE app.
// ---------------------------------------------------------------------------

test("spec 0172: a branch front is named for its Odoo twin, and still a branch stack", () => {
  const stack = branchStackName("owner/sushi-menu");
  const front = frontStackFor(stack);
  assert.equal(front, `${stack}-front`);
  // The destroy guard and the sweep's family split both key on this.
  assert.equal(isBranchStack(front), true, "a front must still be destroyable as a branch stack");
});

test("spec 0172: the front's CLAIM is its Odoo twin — the row records only that one", () => {
  const stack = branchStackName("owner/sushi-menu");
  assert.equal(claimingBranchStack(frontStackFor(stack)), stack);
  // Idempotent for a plain branch stack, so the sweep can call it on everything.
  assert.equal(claimingBranchStack(stack), stack);
  // And it must not maul a branch that merely ENDS in "front".
  const frontish = branchStackName("owner/front");
  assert.equal(claimingBranchStack(frontish), frontish);
});

test("spec 0172: a branch whose tree has a Dockerfile gets its front too, on the branch host", async () => {
  const root = repoWith({ sushi_menu: ["__manifest__.py"] });
  writeFileSync(path.join(root, "Dockerfile"), "FROM node:22-slim\n");
  const fronts: Array<{
    stack?: string;
    host?: string;
    odooUrl: string;
    odooNetwork?: string;
    sourceArchive: string;
  }> = [];
  const result = await deployBranchStagingStack({
    tenantId: "sushi",
    branch: "owner/sushi-menu",
    vpsId: SANDBOX_VPS,
    ssh: healthySsh(),
    odooVersion: 18,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
    packCheckout: async () => "Q0hFQ0tPVVQ=",
    deployFront: async (o) => {
      fronts.push({
        stack: o.stack,
        host: o.host,
        odooUrl: o.odooUrl,
        odooNetwork: o.odooNetwork,
        sourceArchive: o.sourceArchive,
      });
      return { slug: o.slug, name: "x", host: o.host ?? "", ingressOk: true };
    },
  });
  const stack = branchStackName("owner/sushi-menu");
  assert.equal(fronts.length, 1, "the branch's front must deploy alongside its Odoo");
  assert.equal(fronts[0]!.stack, frontStackFor(stack));
  assert.equal(fronts[0]!.host, `${frontStackFor(stack)}.sushi.example.test`);
  // The front is pointed at THIS BRANCH's Odoo, not production's — otherwise
  // staging would show the change against live data. Spec 0173 A2 changed HOW
  // it reaches it (the Odoo stack's own network, not the public TLS edge), not
  // WHICH one: the network name carries the branch stack.
  assert.equal(fronts[0]!.odooUrl, "http://odoo:8069");
  assert.match(fronts[0]!.odooNetwork ?? "", new RegExp(`^sushi-${stack}_default$`));
  assert.equal(fronts[0]!.sourceArchive, "Q0hFQ0tPVVQ=");
  assert.deepEqual(result.front, { stack: frontStackFor(stack), host: `${frontStackFor(stack)}.sushi.example.test` });
});

test("spec 0172: an addons-only branch deploys NO front and says so, rather than failing", async () => {
  const root = repoWith({ pos_custom: ["__manifest__.py"] }); // no Dockerfile
  let called = 0;
  const result = await deployBranchStagingStack({
    tenantId: "abtest",
    branch: "feature/pos",
    vpsId: SANDBOX_VPS,
    ssh: healthySsh(),
    odooVersion: 18,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
    packCheckout: async () => "Q0hFQ0tPVVQ=",
    deployFront: async (o) => {
      called += 1;
      return { slug: o.slug, name: "x", host: "", ingressOk: true };
    },
  });
  assert.equal(called, 0, "a repo with no Dockerfile has no front to build");
  assert.equal(result.front, undefined, "absence is reported as absence");
});

/**
 * Spec 0173 A1 — the regression this replaces: a front that could not come up
 * threw, and `branchStagingOp` failed, marking a branch whose Odoo was healthy
 * and serving as `failed`. Live, on the first Sushi run.
 */
test("spec 0173: a FAILED front leaves the branch's Odoo staging up and the op green", async () => {
  const root = repoWith({ sushi_menu: ["__manifest__.py"] });
  writeFileSync(path.join(root, "Dockerfile"), "FROM node:22-slim\n");
  const result = await deployBranchStagingStack({
    tenantId: "sushi",
    branch: "owner/menu-sushi",
    vpsId: SANDBOX_VPS,
    ssh: healthySsh(),
    odooVersion: 18,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
    packCheckout: async () => "Q0hFQ0tPVVQ=",
    deployFront: async () => {
      throw new Error("stack is not reachable through Traefik (last status 500)");
    },
  });
  // The environment a reviewer needs is up, and the op did not throw.
  assert.equal(result.stack, branchStackName("owner/menu-sushi"));
  assert.match(result.host, /^br-/);
  // BOTH halves matter: reported, and reported as FAILED. Either assertion
  // alone passes for the wrong reason — a silently omitted front satisfies the
  // first, and a thrown error satisfies neither but would have passed 0172's.
  assert.ok(result.front, "a front that failed must still be reported");
  assert.match(result.front?.failed ?? "", /Traefik|500/);
});

test("spec 0173: the branch front reaches Odoo from INSIDE, on the Odoo stack's network", async () => {
  const root = repoWith({ sushi_menu: ["__manifest__.py"] });
  writeFileSync(path.join(root, "Dockerfile"), "FROM node:22-slim\n");
  const seen: Array<{ odooUrl: string; odooNetwork?: string }> = [];
  await deployBranchStagingStack({
    tenantId: "sushi",
    branch: "owner/menu-sushi",
    vpsId: SANDBOX_VPS,
    ssh: healthySsh(),
    odooVersion: 18,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
    packCheckout: async () => "Q0hFQ0tPVVQ=",
    deployFront: async (o) => {
      seen.push({ odooUrl: o.odooUrl, odooNetwork: o.odooNetwork });
      return { slug: o.slug, name: "x", host: o.host ?? "", ingressOk: true };
    },
  });
  // NOT the public https host: that route comes back through Traefik's
  // self-signed staging certificate, which Node's fetch refuses.
  assert.equal(seen[0]?.odooUrl, "http://odoo:8069");
  assert.doesNotMatch(seen[0]?.odooUrl ?? "", /^https:/);
  assert.equal(seen[0]?.odooNetwork, `sushi-${branchStackName("owner/menu-sushi")}_default`);
});

// --- Spec 0226 D3: the COMPOSITION, not the pieces --------------------------

/** The base options every 0226 composition test shares. */
function branchOpts(ssh: ReturnType<typeof healthySsh>, root: string) {
  return {
    tenantId: "abtest",
    branch: "feature/pos",
    vpsId: SANDBOX_VPS,
    ssh,
    odooVersion: 18 as const,
    domain: "example.test",
    dbPassword: "pw-not-a-real-secret",
    masterPassword: "master-not-a-real-secret",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    repoRoot: root,
    pack: async () => "QkFTRTY0",
  };
}

test("spec 0226 D3: without copyProduction, NOTHING touches the production stack", async () => {
  const root = repoWith({ pos_custom: ["__manifest__.py"] });
  const ssh = healthySsh();
  await deployBranchStagingStack(branchOpts(ssh, root));
  // The prod project for this tenant. A branch deploy that did not ask for a
  // copy must never mention it — this is the default path, and it is the one
  // that has been shipping.
  const prodProject = "abtest-prod";
  const touched = ssh.commands.filter((c) => c.includes(`-p ${prodProject} `) || c.includes("pg_dump"));
  assert.deepEqual(touched, [], `a plain branch deploy touched production:\n${touched.join("\n")}`);
});

test("spec 0226 D3: with copyProduction, production is dumped and the copy is neutralized", async () => {
  const root = repoWith({ pos_custom: ["__manifest__.py"] });
  const ssh = healthySsh((command) => {
    // The marker read-back must say `t`, or `assertNeutralized` refuses.
    if (command.includes("is_neutralized")) return { code: 0, stdout: "t\n", stderr: "" };
    // The restore's own end-state check.
    if (command.includes("count(*) from ir_module_module")) return { code: 0, stdout: "312\n", stderr: "" };
    return undefined;
  });
  await deployBranchStagingStack({ ...branchOpts(ssh, root), copyProduction: true });

  const cmds = ssh.commands;
  const dumped = cmds.findIndex((c) => c.includes("pg_dump"));
  const restored = cmds.findIndex((c) => c.includes("pg_restore"));
  const neutralized = cmds.findIndex((c) => c.includes("odoo neutralize"));
  const proved = cmds.findIndex((c) => c.includes("is_neutralized"));
  const upAll = cmds.findIndex((c) => /up -d$/.test(c.trim()));

  assert.ok(dumped >= 0, "production was never dumped");
  assert.ok(restored > dumped, "the restore must follow the dump");
  assert.ok(neutralized > restored, "neutralization must follow the restore");
  assert.ok(proved > neutralized, "the marker must be read AFTER neutralizing");
  // The safety property of the whole spec, as one assertion.
  assert.ok(upAll > proved, "odoo must not start until the copy is provably neutralized");
});

test("spec 0226 D3: a copy that cannot be PROVEN neutralized destroys the stack", async () => {
  const root = repoWith({ pos_custom: ["__manifest__.py"] });
  const ssh = healthySsh((command) => {
    if (command.includes("count(*) from ir_module_module")) return { code: 0, stdout: "312\n", stderr: "" };
    // The marker never becomes true — the exact case that must never be served.
    if (command.includes("is_neutralized")) return { code: 0, stdout: "\n", stderr: "" };
    return undefined;
  });

  await assert.rejects(
    () => deployBranchStagingStack({ ...branchOpts(ssh, root), copyProduction: true }),
    /did not read back as true/,
  );

  const cmds = ssh.commands;
  assert.ok(
    !cmds.some((c) => /up -d$/.test(c.trim())),
    "odoo must never have been started over an unproven copy",
  );
  assert.ok(
    cmds.some((c) => c.includes("down") && c.includes(branchStackName("feature/pos"))),
    `the branch stack must be destroyed after a failed copy:\n${cmds.join("\n")}`,
  );
});

test("spec 0226 E2: the result says `neutralized` only when the copy actually ran", async () => {
  const root = repoWith({ pos_custom: ["__manifest__.py"] });

  // No copy asked for: the field must be ABSENT, not false — the card reads
  // absence as "clean Odoo", and a `false` would be a claim about a copy that
  // was never attempted.
  const plain = await deployBranchStagingStack(branchOpts(healthySsh(), root));
  assert.equal("neutralized" in plain, false);

  // Copy asked for and proven: reaching the return at all means
  // `neutralizeRestoredDb` did not throw, so `true` is a consequence of the
  // deploy succeeding rather than something we assert about ourselves.
  const ssh = healthySsh((command) => {
    if (command.includes("is_neutralized")) return { code: 0, stdout: "t\n", stderr: "" };
    if (command.includes("count(*) from ir_module_module")) return { code: 0, stdout: "312\n", stderr: "" };
    return undefined;
  });
  const copied = await deployBranchStagingStack({ ...branchOpts(ssh, root), copyProduction: true });
  assert.equal(copied.neutralized, true);
});
