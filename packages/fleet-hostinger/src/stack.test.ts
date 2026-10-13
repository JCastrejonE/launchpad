import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  loadStackTemplate,
  deployProductionStack,
  generateDbPassword,
  renderStack,
  remoteComposePath,
  remoteStackDir,
  tenantDbName,
  composeProjectName,
  validateModuleNames,
  ODOO_BUSINESS_MODULES,
  validateBrandColors,
  renderCompanyThemeAddon,
  COMPANY_THEME_MODULE,
  installTenantModules,
  backupTenant,
  listTenantBackups,
  restoreTenant,
  remoteBackupsDir,
  BACKUP_RETENTION,
  routerHost,
  renderOdooConf,
  remoteOdooConfPath,
  loadFrontStackTemplate,
  renderFrontStack,
  ensureOdooReadonlyUser,
  READONLY_MODELS,
  READONLY_GROUP_NAME,
  deployFrontStack,
  renderTemplate,
} from "./stack.js";
import { createFakeSshRunner, type SshRunner } from "./ssh.js";
import { FleetError } from "./errors.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * A deploy-ready SshRunner that reports the stack healthy + Odoo answering 200.
 *
 * Spec 0205 D: it also models the tenant DATABASE, because `deployProductionStack`
 * now reads `ir_module_module` instead of echoing `opts.modules` back. By default
 * the DB reports whatever the `-i` pass actually asked Odoo to install — the happy
 * path. Pass `installed` to make the database disagree with the request, which is
 * the case a fake that echoed the argument could never express.
 */
function createHealthySshRunner(over: { installed?: string[] } = {}) {
  let installedByInit: string[] = [];
  return createFakeSshRunner({
    respond(command) {
      if (command.includes("run --rm odoo") && command.includes(" -i ")) {
        const list = / -i ([^ ]+)/.exec(command);
        installedByInit = list ? list[1]!.split(",") : [];
        return undefined; // the install itself still succeeds
      }
      if (command.includes("ir_module_module")) {
        const rows = over.installed ?? installedByInit;
        return { code: 0, stdout: rows.length ? `${rows.join("\n")}\n` : "", stderr: "" };
      }
      if (command.includes("ps --status running --services")) {
        return { code: 0, stdout: "db\nodoo\n", stderr: "" };
      }
      if (command.includes("odoo shell")) {
        // Spec 0121: the marker `setAdminPassword` requires — it proves the ORM
        // matched exactly one user, not merely that the command exited 0.
        // Spec 0208: the same `odoo shell` path also creates the read-only user.
        if (command.includes("ODOO_READONLY_USER_READY")) {
          return { code: 0, stdout: "ODOO_READONLY_USER_READY 1\n", stderr: "" };
        }
        return { code: 0, stdout: "ADMIN_PASSWORD_SET 1\n", stderr: "" };
      }
      if (command.includes("curl")) {
        return { code: 0, stdout: "200", stderr: "" };
      }
      return undefined; // default {code:0, stdout:"", stderr:""} covers mkdir/up
    },
  });
}

// Spec 0012 — production stack deploy. Template rendering is pure (plan step 5);
// the deploy path uses the fake SSH runner and asserts the generated DB password
// never lands in the repo (plan step 6). Zero live SSH.

test("the tenant stack template loads and declares the expected variables", async () => {
  const tmpl = await loadStackTemplate();
  for (const v of ["${TENANT}", "${STACK}", "${ODOO_VERSION}", "${ROUTER_HOST}", "${TLS_EXTRA_LABELS}", "${ODOO_DB_PASSWORD}"]) {
    assert.ok(tmpl.includes(v), `template should contain ${v}`);
  }
});

test("deploy + password helpers are exposed for the fleet/activity layer", () => {
  assert.equal(typeof deployProductionStack, "function");
  assert.equal(typeof generateDbPassword, "function");
  assert.ok(createFakeSshRunner());
});

// Plan step 5 — render + password generation:
test("renderStack substitutes every ${VAR} and leaves no unresolved placeholder", async () => {
  const tmpl = await loadStackTemplate();
  const rendered = renderStack(tmpl, {
    tenant: "acme",
    stack: "prod",
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
  });
  assert.ok(rendered.includes("odoo:18"));
  assert.ok(rendered.includes("acme"));
  assert.ok(rendered.includes("prod"));
  assert.ok(rendered.includes("example.com"));
  assert.ok(rendered.includes("s3cr3t-pass"));
  assert.doesNotMatch(rendered, /\$\{[A-Z_]+\}/, "no unresolved placeholder should remain");
});

test("generateDbPassword returns a strong, non-empty, non-repeating secret", () => {
  const a = generateDbPassword();
  const b = generateDbPassword();
  assert.equal(typeof a, "string");
  assert.ok(a.length >= 24, "password should be long enough to be strong");
  assert.notEqual(a, b, "each call should generate a distinct password");
});

// Plan step 6 — deploy (idempotent) + secret hygiene:
test("deployProductionStack writes the rendered compose to the VPS and runs `compose up -d`", async () => {
  const ssh = createHealthySshRunner();
  const result = await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });

  const composePath = remoteComposePath("acme", "prod");
  const project = composeProjectName("acme", "prod");
  assert.ok(ssh.files.has(composePath), "rendered compose should be written to the VPS");
  const written = ssh.files.get(composePath) ?? "";
  assert.ok(written.includes("odoo:18"));
  assert.ok(written.includes("s3cr3t-pass"));
  assert.ok(
    ssh.commands.some((c) => c.includes(`docker compose -p ${project} -f ${composePath} up -d`)),
    "should run `docker compose up -d` against the written compose file",
  );
  assert.equal(result.tenantId, "acme");
  assert.equal(result.stack, "prod");
  assert.equal(result.odooVersion, 18);
});

test("deployProductionStack verifies container health + Odoo HTTP 200 on 8069 via SSH curl", async () => {
  const ssh = createHealthySshRunner();
  const result = await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });
  assert.equal(result.healthy, true);
  assert.equal(result.odooHttpOk, true);

  // A stack that never reports both services running should fail verification.
  const unhealthySsh = createFakeSshRunner({
    respond(command) {
      if (command.includes("ps --status running --services")) {
        return { code: 0, stdout: "db\n", stderr: "" }; // odoo not up yet
      }
      return undefined;
    },
  });
  await assert.rejects(
    () =>
      deployProductionStack({
        tenantId: "acme",
        vpsId: 100001,
        ssh: unhealthySsh,
        odooVersion: 18,
        domain: "example.com",
        dbPassword: "s3cr3t-pass",
        masterPassword: "master-not-a-real-secret",
        odooReadonlyUser: "front_readonly",
        odooReadonlyPassword: "ro-pass-not-a-real-secret",
        adminPassword: "admin-not-a-real-secret",
      }),
    /stack services not all running/,
  );

  // A stack that's up but where Odoo doesn't yet answer 200 should also fail.
  const notRespondingSsh = createFakeSshRunner({
    respond(command) {
      if (command.includes("ps --status running --services")) {
        return { code: 0, stdout: "db\nodoo\n", stderr: "" };
      }
      if (command.includes("odoo shell")) {
        // Spec 0121: the marker `setAdminPassword` requires — it proves the ORM
        // matched exactly one user, not merely that the command exited 0.
        // Spec 0208: the same `odoo shell` path also creates the read-only user.
        if (command.includes("ODOO_READONLY_USER_READY")) {
          return { code: 0, stdout: "ODOO_READONLY_USER_READY 1\n", stderr: "" };
        }
        return { code: 0, stdout: "ADMIN_PASSWORD_SET 1\n", stderr: "" };
      }
      if (command.includes("curl")) {
        return { code: 0, stdout: "502", stderr: "" };
      }
      return undefined;
    },
  });
  await assert.rejects(
    () =>
      deployProductionStack({
        tenantId: "acme",
        vpsId: 100001,
        ssh: notRespondingSsh,
        odooVersion: 18,
        domain: "example.com",
        dbPassword: "s3cr3t-pass",
        masterPassword: "master-not-a-real-secret",
        odooReadonlyUser: "front_readonly",
        odooReadonlyPassword: "ro-pass-not-a-real-secret",
        adminPassword: "admin-not-a-real-secret",
        // Fast + deterministic: no real sleeps, deadline hits after a couple of attempts.
        verify: { deadlineMs: 10, intervalMs: 5, sleep: async () => {} },
      }),
    /Odoo did not answer HTTP 200/,
  );
});

test("a re-deploy is idempotent (compose reconciles; no error on second run)", async () => {
  const ssh = createHealthySshRunner();
  const first = await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });
  const second = await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });
  assert.deepEqual(first, second);
  const composePath = remoteComposePath("acme", "prod");
  const project = composeProjectName("acme", "prod");
  // Exact match (not substring) so the `up -d db` pre-step (spec 0014 plan
  // step 4 — brings up Postgres before the tenant DB init check) isn't
  // double-counted as a full-stack `up -d`.
  const upCommands = ssh.commands.filter((c) => c === `docker compose -p ${project} -f ${composePath} up -d`);
  assert.equal(upCommands.length, 2, "compose up should be safe to run again — no special-casing needed");
});

test("the generated DB password never appears in any repo-committed file", async () => {
  const ssh = createHealthySshRunner();
  const password = generateDbPassword();
  await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: password,
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });

  // The fake SSH runner's in-memory "VPS" is where the password should land —
  // the repo tree (checked via `git grep`) should never see it.
  const composePath = remoteComposePath("acme", "prod");
  assert.ok(ssh.files.get(composePath)?.includes(password));

  let foundInRepo = false;
  try {
    execFileSync("git", ["grep", "-F", password], { cwd: REPO_ROOT, stdio: "pipe" });
    foundInRepo = true; // git grep exits 0 only when it finds a match
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 1) {
      throw err; // anything other than "no matches" is an unexpected failure
    }
  }
  assert.equal(foundInRepo, false, "generated DB password should never appear in a repo-committed file");
});

// ── Spec 0013 scaffolds ──────────────────────────────────────────────────────

// Plan step 1 — poll-with-timeout Odoo-200 verify (inject interval/`sleep`;
// NO real sleeps). Fake-runner curl sequence 503 → conn-refused → 200 must
// eventually pass within the deadline.
test("verify polls past first-boot latency: curl 503 → conn-refused → 200 succeeds before the deadline", async () => {
  let curlAttempts = 0;
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.includes("ps --status running --services")) {
        return { code: 0, stdout: "db\nodoo\n", stderr: "" };
      }
      if (command.includes("odoo shell")) {
        // Spec 0121: the marker `setAdminPassword` requires — it proves the ORM
        // matched exactly one user, not merely that the command exited 0.
        // Spec 0208: the same `odoo shell` path also creates the read-only user.
        if (command.includes("ODOO_READONLY_USER_READY")) {
          return { code: 0, stdout: "ODOO_READONLY_USER_READY 1\n", stderr: "" };
        }
        return { code: 0, stdout: "ADMIN_PASSWORD_SET 1\n", stderr: "" };
      }
      // Spec 0120 added a second curl — the ingress check — which is
      // distinguishable by `--resolve` and is not what this test is counting.
      if (command.includes("--resolve")) {
        return { code: 0, stdout: "200", stderr: "" };
      }
      if (command.includes("curl")) {
        curlAttempts += 1;
        if (curlAttempts === 1) {
          return { code: 22, stdout: "", stderr: "curl: (22) The requested URL returned error: 503" };
        }
        if (curlAttempts === 2) {
          return { code: 7, stdout: "", stderr: "curl: (7) Failed to connect to localhost port 8069: Connection refused" };
        }
        return { code: 0, stdout: "200", stderr: "" };
      }
      return undefined;
    },
  });

  const result = await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    verify: { deadlineMs: 30, intervalMs: 10, sleep: async () => {} },
  });

  assert.equal(result.odooHttpOk, true);
  assert.equal(curlAttempts, 3, "should retry the curl until it succeeds");
});

// Deadline hit while containers are up but Odoo never answers → retryable FleetError.
test("verify times out (containers up, Odoo not answering) as a RETRYABLE FleetError", async () => {
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.includes("ps --status running --services")) {
        return { code: 0, stdout: "db\nodoo\n", stderr: "" };
      }
      if (command.includes("odoo shell")) {
        // Spec 0121: the marker `setAdminPassword` requires — it proves the ORM
        // matched exactly one user, not merely that the command exited 0.
        // Spec 0208: the same `odoo shell` path also creates the read-only user.
        if (command.includes("ODOO_READONLY_USER_READY")) {
          return { code: 0, stdout: "ODOO_READONLY_USER_READY 1\n", stderr: "" };
        }
        return { code: 0, stdout: "ADMIN_PASSWORD_SET 1\n", stderr: "" };
      }
      if (command.includes("curl")) {
        return { code: 7, stdout: "", stderr: "curl: (7) Failed to connect to localhost port 8069: Connection refused" };
      }
      return undefined;
    },
  });

  await assert.rejects(
    () =>
      deployProductionStack({
        tenantId: "acme",
        vpsId: 100001,
        ssh,
        odooVersion: 18,
        domain: "example.com",
        dbPassword: "s3cr3t-pass",
        masterPassword: "master-not-a-real-secret",
        odooReadonlyUser: "front_readonly",
        odooReadonlyPassword: "ro-pass-not-a-real-secret",
        adminPassword: "admin-not-a-real-secret",
        verify: { deadlineMs: 20, intervalMs: 10, sleep: async () => {} },
      }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "verify");
      assert.equal(err.retryable, true);
      assert.match(err.message, /Odoo did not answer HTTP 200/);
      return true;
    },
  );
});

// Containers not running → fatal FleetError including a `compose ps` summary.
test("verify with containers down fails FATALLY and includes a compose ps summary", async () => {
  const composePath = remoteComposePath("acme", "prod");
  const project = composeProjectName("acme", "prod");
  let healthCheckAttempts = 0;
  const psSummary =
    "NAME          IMAGE         STATUS\n" +
    "acme-db-1     postgres:16   Up 2 minutes\n" +
    "acme-odoo-1   odoo:18       Restarting (1) 5 seconds ago\n";
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.includes("ps --status running --services")) {
        healthCheckAttempts += 1;
        // Healthy for the up-front post-`compose up` check, then the odoo
        // container crash-loops during boot — the deadline re-check must see it.
        return healthCheckAttempts === 1
          ? { code: 0, stdout: "db\nodoo\n", stderr: "" }
          : { code: 0, stdout: "db\n", stderr: "" };
      }
      if (command === `docker compose -p ${project} -f ${composePath} ps`) {
        return { code: 0, stdout: psSummary, stderr: "" };
      }
      if (command.includes("curl")) {
        return { code: 7, stdout: "", stderr: "curl: (7) Failed to connect to localhost port 8069: Connection refused" };
      }
      return undefined;
    },
  });

  await assert.rejects(
    () =>
      deployProductionStack({
        tenantId: "acme",
        vpsId: 100001,
        ssh,
        odooVersion: 18,
        domain: "example.com",
        dbPassword: "s3cr3t-pass",
        masterPassword: "master-not-a-real-secret",
        odooReadonlyUser: "front_readonly",
        odooReadonlyPassword: "ro-pass-not-a-real-secret",
        adminPassword: "admin-not-a-real-secret",
        verify: { deadlineMs: 20, intervalMs: 10, sleep: async () => {} },
      }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "verify");
      assert.equal(err.retryable, false);
      assert.match(err.message, /containers are not all running/);
      assert.match(err.message, /Restarting/);
      return true;
    },
  );
});

// Plan step 4 — dbPassword required input + reconcile.

test("deployProductionStack throws a typed, non-retryable error when dbPassword is omitted", async () => {
  const ssh = createHealthySshRunner();
  await assert.rejects(
    () =>
      deployProductionStack({
        tenantId: "acme",
        vpsId: 100001,
        ssh,
        odooVersion: 18,
        domain: "example.com",
        // dbPassword deliberately omitted — cast needed since the type is now required.
      } as unknown as Parameters<typeof deployProductionStack>[0]),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "config");
      assert.equal(err.retryable, false);
      assert.match(err.message, /dbPassword is required/);
      assert.match(err.message, /re-deploy/);
      return true;
    },
  );
});

test("re-deploy with the SAME dbPassword reconciles as a no-op (idempotent)", async () => {
  const ssh = createHealthySshRunner();
  const first = await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });
  const composePath = remoteComposePath("acme", "prod");
  const firstRendered = ssh.files.get(composePath);

  const second = await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });
  const secondRendered = ssh.files.get(composePath);

  assert.deepEqual(first, second);
  assert.equal(firstRendered, secondRendered, "re-deploy with the same password renders an identical compose file");
  assert.ok(secondRendered?.includes("s3cr3t-pass"));
});

// Spec 0014 plan step 3 — serve the tenant DB directly (no selector):
test("renderStack pins db_name/dbfilter to tenantDbName so the stack serves the tenant DB, for odoo 17/18/19", async () => {
  const tmpl = await loadStackTemplate();
  const dbName = tenantDbName("acme", "prod");
  for (const odooVersion of [17, 18, 19] as const) {
    const rendered = renderStack(tmpl, {
      tenant: "acme",
      stack: "prod",
      odooVersion,
      domain: "example.com",
      dbPassword: "s3cr3t-pass",
    });
    assert.ok(rendered.includes(`"-d"`), "should pin the served database via -d");
    assert.ok(rendered.includes(dbName), `rendered compose should reference ${dbName}`);
    assert.ok(
      // The trailing `$$` (not a single `$`) is intentional: docker compose
      // interpolates `$`/`${...}` when it parses the compose file on the VPS,
      // so a literal `$` end-anchor must be escaped as `$$` in the file, or
      // `docker compose up` fails to parse it. See the template's header
      // comment for the full explanation.
      rendered.includes(`--db-filter=^${dbName}$$`),
      "should pin db-filter (with $ escaped as $$ for docker compose's own interpolation) so no other db is selectable",
    );
    assert.doesNotMatch(rendered, /\$\{[A-Z_]+\}/, "no unresolved placeholder should remain");
  }
});

test("tenantDbName is stable per tenant/stack, distinct across tenants/stacks, and a safe identifier", () => {
  assert.equal(tenantDbName("acme", "prod"), tenantDbName("acme", "prod"), "stable across calls");
  assert.notEqual(tenantDbName("acme", "prod"), tenantDbName("acme", "spec-42"), "distinct per stack");
  assert.notEqual(tenantDbName("acme", "prod"), tenantDbName("beta", "prod"), "distinct per tenant");
  assert.match(
    tenantDbName("acme", "spec-42"),
    /^[a-zA-Z0-9_]+$/,
    "must be safe as both a Postgres DB name and a --db-filter regex (no dashes/dots)",
  );
});

// Spec 0014 plan step 4 — first-deploy tenant DB init (idempotent):
test("first deploy initializes the tenant DB (odoo -d <db> -i base --stop-after-init) before serving", async () => {
  const ssh = createHealthySshRunner();
  const composePath = remoteComposePath("acme", "prod");
  const project = composeProjectName("acme", "prod");
  const dbName = tenantDbName("acme", "prod");

  const result = await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });
  assert.equal(result.odooHttpOk, true);

  const existsCheckIndex = ssh.commands.findIndex((c) => c.includes("pg_database") && c.includes(dbName));
  const initIndex = ssh.commands.findIndex(
    (c) => c.includes("run --rm odoo") && c.includes(`-d ${dbName}`) && c.includes("-i base") && c.includes("--stop-after-init"),
  );
  const serveIndex = ssh.commands.findIndex((c) => c === `docker compose -p ${project} -f ${composePath} up -d`);

  assert.ok(existsCheckIndex >= 0, "should check whether the tenant DB already exists");
  assert.ok(initIndex >= 0, "a not-yet-initialized DB should be initialized on first deploy");
  assert.ok(serveIndex >= 0, "should still bring the full stack up to serve");
  assert.ok(existsCheckIndex < initIndex, "the existence check must happen before init");
  assert.ok(initIndex < serveIndex, "init must complete before the stack is brought up to serve");
});

test("re-deploy detects the already-initialized DB and SKIPS init (no re-init, no wipe)", async () => {
  const dbName = tenantDbName("acme", "prod");
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.includes("ps --status running --services")) {
        return { code: 0, stdout: "db\nodoo\n", stderr: "" };
      }
      if (command.includes("odoo shell")) {
        // Spec 0121: the marker `setAdminPassword` requires — it proves the ORM
        // matched exactly one user, not merely that the command exited 0.
        // Spec 0208: the same `odoo shell` path also creates the read-only user.
        if (command.includes("ODOO_READONLY_USER_READY")) {
          return { code: 0, stdout: "ODOO_READONLY_USER_READY 1\n", stderr: "" };
        }
        return { code: 0, stdout: "ADMIN_PASSWORD_SET 1\n", stderr: "" };
      }
      if (command.includes("pg_database")) {
        return { code: 0, stdout: "1", stderr: "" }; // already initialized
      }
      if (command.includes("curl")) {
        return { code: 0, stdout: "200", stderr: "" };
      }
      return undefined;
    },
  });

  const result = await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });
  assert.equal(result.odooHttpOk, true);

  const initRan = ssh.commands.some((c) => c.includes("run --rm odoo") && c.includes(`-d ${dbName}`));
  assert.equal(initRan, false, "an already-initialized DB should never be re-initialized");
});

// Spec 0014 plan step 5 — honest readiness:
test("verify passes when /web/login returns 200 WITHOUT redirect on an initialized stack", async () => {
  // createHealthySshRunner's curl responds "200" (via `-fsS` without `-L`, so
  // a redirect would already show up as a non-200 code) — a plain pass proves
  // the 200-no-redirect path stays intact alongside the new 303 handling.
  const ssh = createHealthySshRunner();
  const result = await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });
  assert.equal(result.odooHttpOk, true);
});

test("verify fails FAST with a 'serving selector — DB not initialized' diagnostic on a 303 → /web/database/selector (no poll to deadline)", async () => {
  let curlAttempts = 0;
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.includes("ps --status running --services")) {
        return { code: 0, stdout: "db\nodoo\n", stderr: "" };
      }
      if (command.includes("odoo shell")) {
        // Spec 0121: the marker `setAdminPassword` requires — it proves the ORM
        // matched exactly one user, not merely that the command exited 0.
        // Spec 0208: the same `odoo shell` path also creates the read-only user.
        if (command.includes("ODOO_READONLY_USER_READY")) {
          return { code: 0, stdout: "ODOO_READONLY_USER_READY 1\n", stderr: "" };
        }
        return { code: 0, stdout: "ADMIN_PASSWORD_SET 1\n", stderr: "" };
      }
      if (command.includes("curl")) {
        curlAttempts += 1;
        return { code: 0, stdout: "303", stderr: "" };
      }
      return undefined;
    },
  });

  await assert.rejects(
    () =>
      deployProductionStack({
        tenantId: "acme",
        vpsId: 100001,
        ssh,
        odooVersion: 18,
        domain: "example.com",
        dbPassword: "s3cr3t-pass",
        masterPassword: "master-not-a-real-secret",
        odooReadonlyUser: "front_readonly",
        odooReadonlyPassword: "ro-pass-not-a-real-secret",
        adminPassword: "admin-not-a-real-secret",
        // A generous deadline/interval: if this fails fast (no polling), the
        // deadline is irrelevant; if it were (wrongly) polling, this test
        // would time out instead of asserting a fast failure.
        verify: { deadlineMs: 10_000, intervalMs: 5_000, sleep: async () => {} },
      }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "verify");
      assert.equal(err.retryable, false, "a selector response is a config problem, not worth retrying");
      assert.match(err.message, /serving selector — DB not initialized/);
      return true;
    },
  );
  assert.equal(curlAttempts, 1, "should fail on the FIRST 303, never poll to the deadline");
});

// ── Spec 0046 scaffolds (skipped by the initializer; the coder implementing
// the referenced item fills the assertions in and drops the `.skip`). Repo
// stays green in the meantime — skipped tests don't run, the throwing stubs
// they reference still typecheck. ─────────────────────────────────────────────

// Item A — tenant-scoped compose project name: valid charset + first char,
// lowercase, sanitization, and tenant-distinctness for the SAME stack (the
// regression this locks: two tenants on `prod` must NOT collide on one project).
test("composeProjectName is a valid, lowercase, tenant-distinct docker compose project name", () => {
  assert.equal(composeProjectName("test", "prod"), "test-prod");
  assert.equal(composeProjectName("acme", "prod"), "acme-prod");
  // docker compose project names must match ^[a-z0-9][a-z0-9_-]*$
  for (const [t, s] of [["Acme", "Prod"], ["a.b/c", "spec-42"], ["9x", "prod"]] as const) {
    assert.match(composeProjectName(t, s), /^[a-z0-9][a-z0-9_-]*$/);
  }
  // two DIFFERENT tenants on the SAME stack → two DIFFERENT projects (0045 fix)
  assert.notEqual(composeProjectName("test", "prod"), composeProjectName("acme", "prod"));
});

// Item A — every `docker compose` invocation in a deploy carries `-p <project>`
// (a single missing `-p` silently splits the deploy across two projects). Extend
// the existing fake-SshRunner command capture: assert `-p <project>` on the
// `up -d db`, `tenantDbExists` psql, `initTenantDb` run, full `up -d`,
// `verifyStackHealthy` ps, and `checkOdooHttp` curl commands.
test("every docker compose command in a deploy carries -p <project>", async () => {
  const ssh = createHealthySshRunner();
  await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });
  const project = composeProjectName("acme", "prod");
  const composeCommands = ssh.commands.filter((c) => c.includes("docker compose"));
  assert.ok(composeCommands.length > 0, "the deploy should issue docker compose commands");
  for (const c of composeCommands) {
    assert.ok(c.includes(`-p ${project}`), `compose command missing -p ${project}: ${c}`);
  }
});

// Item B — rendered compose is otherwise vanilla stock Odoo (no seed/snapshot
// machinery), keeps the stock odoo/db services and the -d/--db-filter pin.
// Spec 0097 supersedes this test's original "no addons mount" claim: the
// stack now mounts its own (empty-unless-branded) addons dir read-only — see
// that spec's "Verified before writing" for why an empty mount is harmless.
test("renderStack output mounts ./addons:/mnt/extra-addons:ro and keeps stock services + db pin", async () => {
  const tmpl = await loadStackTemplate();
  const dbName = tenantDbName("acme", "prod");
  const rendered = renderStack(tmpl, {
    tenant: "acme",
    stack: "prod",
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
  });
  assert.match(rendered, /\.\/addons:\/mnt\/extra-addons:ro/, "mounts the stack's addons dir read-only");
  assert.ok(rendered.includes("odoo:18"), "keeps the stock odoo image");
  assert.ok(rendered.includes("postgres:16"), "keeps the stock postgres service");
  assert.ok(rendered.includes(`--db-filter=^${dbName}$$`), "keeps the db_name/db-filter pin");
  assert.doesNotMatch(rendered, /\$\{[A-Z_]+\}/, "no unresolved placeholder should remain");
});

// Spec 0215 item 1 — on 2026-08-14 a docker daemon restart brought the `-front`
// stacks back and left the six `-prod` ones down: front-stack.tmpl.yml declared
// `restart: unless-stopped` and odoo-stack.tmpl.yml declared no policy at all.
// Regression guard over EVERY service of the rendered stack, not "the string
// appears twice" — a newly added policy-less service has to turn this red.
test("every service of the rendered stack declares restart: unless-stopped", async () => {
  const rendered = renderStack(await loadStackTemplate(), {
    tenant: "acme",
    stack: "prod",
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
  });
  const lines = rendered.split("\n");
  const servicesAt = lines.indexOf("services:");
  assert.ok(servicesAt >= 0, "the rendered stack should have a top-level services: block");
  const services = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines.slice(servicesAt + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key ends the services block
    const header = /^ {2}([a-z][a-z0-9_-]*):$/.exec(line);
    if (header) {
      current = [];
      services.set(header[1]!, current);
      continue;
    }
    current?.push(line);
  }
  // Without this the loop below would pass vacuously if the scan found nothing.
  assert.ok(services.has("odoo") && services.has("db"), `scan found services: ${[...services.keys()]}`);
  for (const [name, body] of services) {
    assert.ok(
      body.some((l) => l.trim() === "restart: unless-stopped"),
      `service ${name} declares no restart policy — it will not come back after a docker daemon restart`,
    );
  }
});

// ── Spec 0093 (initializer scaffolded these; step 1 + step 2 are both
// implemented and unskipped now — `modules` is threaded through
// `deployProductionStack`). ───────────────────────────────────────────────

// [code] step 1 — validateModuleNames is THE injection boundary: accept
// lower_snake names, reject every shell-metacharacter / traversal / quote /
// empty shape with a NON-RETRYABLE FleetError("config").
test("validateModuleNames accepts lower_snake names and rejects every injection shape", () => {
  for (const ok of [[], ["sale"], ["point_of_sale"], ["l10n_mx_edi"], ["sale", "stock"]]) {
    assert.doesNotThrow(() => validateModuleNames(ok));
  }
  const bad = ["", " ", "sale;rm -rf /", "sale && x", "$(x)", "`x`", "..", "a-b", "Sale", "a.b", "'x'", '"x"', "sale stock"];
  for (const name of bad) {
    assert.throws(
      () => validateModuleNames([name]),
      (err: unknown) => {
        assert.ok(err instanceof FleetError);
        assert.equal(err.kind, "config");
        assert.equal(err.retryable, false);
        return true;
      },
      `should reject ${JSON.stringify(name)}`,
    );
  }
});

// [code] step 1 — the default set is the SPEC §10 step-5 modules WITHOUT the two
// deliberate exclusions, and every entry is itself a valid module name.
test("ODOO_BUSINESS_MODULES excludes l10n_mx_edi and company_menu and contains only valid names", () => {
  assert.ok(!ODOO_BUSINESS_MODULES.includes("l10n_mx_edi"), "CFDI is conditional — the caller appends it");
  assert.ok(!ODOO_BUSINESS_MODULES.includes("company_menu"), "custom addon doesn't exist yet");
  assert.ok(ODOO_BUSINESS_MODULES.length > 0, "the default set should not be empty once implemented");
  assert.doesNotThrow(() => validateModuleNames([...ODOO_BUSINESS_MODULES]));
});

// [code] step 2 — omitting `modules` is byte-identical to today's `-i base`
// (regression guard on the default path).
test("omitting modules produces exactly today's `-i base` install command (regression guard)", async () => {
  const ssh = createHealthySshRunner();
  await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });
  const initCmds = ssh.commands.filter((c) => c.includes("run --rm odoo") && c.includes(" -i "));
  assert.equal(initCmds.length, 1, "exactly one init invocation");
  assert.ok(initCmds[0]!.includes(" -i base "), "default path installs `base` alone");
  assert.ok(!initCmds[0]!.includes("-i base,"), "no extra modules on the default path");
});

// [code] step 2 — a requested list installs in ONE `-i base,<mods>` pass and
// DeployResult reports it.
test("modules install in ONE `-i base,sale,stock` pass and DeployResult reports them", async () => {
  const ssh = createHealthySshRunner();
  const result = await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    modules: ["sale", "stock"],
  });
  const initCmds = ssh.commands.filter((c) => c.includes("run --rm odoo") && c.includes(" -i "));
  assert.equal(initCmds.length, 1, "ONE invocation — Odoo resolves deps across the whole -i set");
  assert.ok(initCmds[0]!.includes("-i base,sale,stock"), "base + requested modules in a single pass");
  assert.deepEqual(result.modules, ["sale", "stock"]);
});

// [code] Spec 0205 D. The field's doc comment has always said "modules actually
// INSTALLED by this deploy"; the code returned the ARGUMENT, so it read the same
// whether Odoo installed them or not (VERIFICATION #1). Here the database
// reports only one of the two — the result must follow the database.
test("DeployResult.modules follows ir_module_module, not the request", async () => {
  const ssh = createHealthySshRunner({ installed: ["base", "sale"] });
  const result = await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    modules: ["sale", "stock"],
  });
  assert.deepEqual(result.modules, ["sale"], "stock was asked for and is not in the database");
});

// [code] step 2 — an invalid module name fails FATALLY before any SSH side
// effect: the fake runner must have recorded nothing.
test("an invalid module name throws a non-retryable FleetError('config') BEFORE any ssh.exec", async () => {
  const ssh = createHealthySshRunner();
  await assert.rejects(
    () =>
      deployProductionStack({
        tenantId: "acme",
        vpsId: 100001,
        ssh,
        odooVersion: 18,
        domain: "example.com",
        dbPassword: "s3cr3t-pass",
        masterPassword: "master-not-a-real-secret",
        odooReadonlyUser: "front_readonly",
        odooReadonlyPassword: "ro-pass-not-a-real-secret",
        adminPassword: "admin-not-a-real-secret",
        modules: ["sale; rm -rf /"],
      }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "config");
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(ssh.commands.length, 0, "validation must run before any SSH call");
  assert.equal(ssh.files.size, 0, "and before any file is written to the VPS");
});

// ── Spec 0094 — DeployResult.modules must report what was INSTALLED, not what
// was asked for.
//
// The other two cases the spec lists are already covered by unskipped tests
// above: first-deploy → modules reports the installed list is asserted by
// "modules install in ONE `-i base,sale,stock` pass and DeployResult reports
// them" (createHealthySshRunner → DB absent → init runs), and the default
// (no-`modules`) path by "omitting modules produces exactly today's `-i base`"
// + the idempotency tests. So this is the only genuinely new assertion.
// ──────────────────────────────────────────────────────────────────────────

// [code] The defect only a live run could see: on a re-deploy the tenant DB
// already exists, so `initTenantDb` is SKIPPED entirely by the `tenantDbExists`
// guard and nothing installs — yet the current code echoes `opts.modules` into
// `DeployResult.modules`, advertising (in an audit row) an install that never
// happened. Truthful behaviour: `modules` must be ABSENT on a re-deploy even
// when `opts.modules` is non-empty.
test(
  "re-deploy (DB exists) reports NO modules even when opts.modules is non-empty (installs nothing)",
  async () => {
    const dbName = tenantDbName("acme", "prod");
    const ssh = createFakeSshRunner({
      respond(command) {
        if (command.includes("ps --status running --services")) {
          return { code: 0, stdout: "db\nodoo\n", stderr: "" };
        }
        if (command.includes("pg_database")) {
          return { code: 0, stdout: "1", stderr: "" }; // DB already initialized → init is skipped
        }
        if (command.includes("odoo shell")) {
          // Spec 0121: the admin password is set on EVERY deploy, including this
          // re-deploy — that is how an existing tenant's password gets corrected.
          // Spec 0208: the same `odoo shell` path also creates the read-only user.
          if (command.includes("ODOO_READONLY_USER_READY")) {
            return { code: 0, stdout: "ODOO_READONLY_USER_READY 1\n", stderr: "" };
          }
          return { code: 0, stdout: "ADMIN_PASSWORD_SET 1\n", stderr: "" };
        }
        if (command.includes("curl")) {
          return { code: 0, stdout: "200", stderr: "" };
        }
        return undefined;
      },
    });

    const result = await deployProductionStack({
      tenantId: "acme",
      vpsId: 100001,
      ssh,
      odooVersion: 18,
      domain: "example.com",
      dbPassword: "s3cr3t-pass",
      masterPassword: "master-not-a-real-secret",
      odooReadonlyUser: "front_readonly",
      odooReadonlyPassword: "ro-pass-not-a-real-secret",
      adminPassword: "admin-not-a-real-secret",
      modules: ["sale", "stock", "crm"],
    });

    // The guard must have skipped init...
    const initRan = ssh.commands.some((c) => c.includes("run --rm odoo") && c.includes(`-d ${dbName}`));
    assert.equal(initRan, false, "an already-initialized DB is never re-initialized");
    // ...so the result must not claim it installed anything.
    assert.equal(result.modules, undefined, "a re-deploy installs nothing, so modules must be absent");
  },
);

// ── Spec 0097 (initializer scaffolds; each is `{ skip: true }` until its
// [code] item lands — the coder fills any missing assertions and drops the
// skip). Repo stays green meanwhile: skipped tests don't run and the throwing
// stubs they reference still typecheck. ─────────────────────────────────────

// [code] item 1 — validateBrandColors is the brand twin of validateModuleNames:
// accept `#rrggbb` (either case) and empty/partial brands, reject a colour
// name / 3-digit / bad-hex / injection shape with a NON-RETRYABLE
// FleetError("config").
test("validateBrandColors accepts #rrggbb and rejects non-hex / injection shapes", () => {
  for (const ok of [
    {},
    { primaryColor: "#0af0AF" },
    { secondaryColor: "#ffffff" },
    { primaryColor: "#000000", secondaryColor: "#ABCDEF" },
  ]) {
    assert.doesNotThrow(() => validateBrandColors(ok));
  }
  for (const bad of ["red", "#fff", "#12345g", '"; rm -rf /"', "#1234567", "0af0af"]) {
    assert.throws(
      () => validateBrandColors({ primaryColor: bad }),
      (err: unknown) => {
        assert.ok(err instanceof FleetError);
        assert.equal(err.kind, "config");
        assert.equal(err.retryable, false);
        return true;
      },
      `should reject ${JSON.stringify(bad)}`,
    );
  }
});

// [code] item 1 — renderCompanyThemeAddon renders the three addon files, and the
// data XML sets primary_color/secondary_color on base.main_company.
test("renderCompanyThemeAddon renders __init__.py, __manifest__.py and a data XML setting the two colours", () => {
  const files = renderCompanyThemeAddon({ primaryColor: "#123456", secondaryColor: "#abcdef" });
  assert.ok("__init__.py" in files, "renders __init__.py");
  assert.ok("__manifest__.py" in files, "renders __manifest__.py");
  const xmlEntry = Object.entries(files).find(([name]) => name.endsWith(".xml"));
  assert.ok(xmlEntry, "renders a data XML");
  const xml = xmlEntry![1];
  assert.match(xml, /base\.main_company/, "targets the main company");
  assert.match(xml, /primary_color/);
  assert.match(xml, /secondary_color/);
  assert.match(xml, /#123456/);
  assert.match(xml, /#abcdef/);
});

// [code] item 2 — landed by reconciling the spec-0046 template test above
// (renamed, addons-mount assertion flipped) rather than keeping a second,
// now-redundant copy of the same renderStack assertions.

// [code] item 3 — with `brand`, the addon files are written under
// <stackDir>/addons/company_theme/ and company_theme lands in the ONE -i pass.
test("deploy with brand writes the company_theme addon and installs it in the single -i pass", async () => {
  const ssh = createHealthySshRunner();
  const result = await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    brand: { primaryColor: "#123456", secondaryColor: "#abcdef" },
  });
  const addonDir = `${remoteStackDir("acme", "prod")}/addons/${COMPANY_THEME_MODULE}`;
  const written = [...ssh.files.keys()];
  assert.ok(written.some((p) => p.startsWith(`${addonDir}/`)), `addon files should be written under ${addonDir}/`);
  const initCmds = ssh.commands.filter((c) => c.includes("run --rm odoo") && c.includes(" -i "));
  assert.equal(initCmds.length, 1, "ONE -i pass — company_theme installs alongside base");
  assert.ok(initCmds[0]!.includes(COMPANY_THEME_MODULE), "company_theme is in the single -i pass");
  assert.ok(result.modules?.includes(COMPANY_THEME_MODULE), "DeployResult reports company_theme installed");
});

// [code] item 3 — omitting `brand` writes NO addon files and installs no
// company_theme: byte-identical to today's deploy (regression guard).
test("omitting brand writes no addon files and installs no company_theme (regression guard)", async () => {
  const ssh = createHealthySshRunner();
  await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });
  const written = [...ssh.files.keys()];
  assert.ok(!written.some((p) => p.includes("/addons/")), "no addon files written when brand is omitted");
  assert.ok(!ssh.commands.some((c) => c.includes(COMPANY_THEME_MODULE)), "company_theme is never installed");
});

// [code] item 3 — a bad colour fails FATALLY before any ssh side effect: the
// fake runner must have recorded nothing.
test("a bad brand colour throws non-retryable FleetError('config') BEFORE any ssh.exec/writeFile", async () => {
  const ssh = createHealthySshRunner();
  await assert.rejects(
    () =>
      deployProductionStack({
        tenantId: "acme",
        vpsId: 100001,
        ssh,
        odooVersion: 18,
        domain: "example.com",
        dbPassword: "s3cr3t-pass",
        masterPassword: "master-not-a-real-secret",
        odooReadonlyUser: "front_readonly",
        odooReadonlyPassword: "ro-pass-not-a-real-secret",
        adminPassword: "admin-not-a-real-secret",
        brand: { primaryColor: "#12345g" },
      }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "config");
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(ssh.commands.length, 0, "validation must run before any SSH call");
  assert.equal(ssh.files.size, 0, "and before any file is written to the VPS");
});

// Gate-2 defect (spec 0097): the addon files were written to
// `<stackDir>/addons/company_theme/` with NOTHING creating that directory.
// `ssh.writeFile` is a bare `cat > <path>` — no parent creation — and the
// deploy's own `mkdir -p` only makes the stack dir, so every branded deploy
// would have died on the first write with "No such file or directory".
//
// The 97 unit tests could not see it: `FakeSshRunner.writeFile` is a `Map.set`
// with no notion of parent directories, so the fake cannot model the constraint
// that breaks it — the same fake-vs-reality gap specs 0093/0094 hit. What a
// fake CAN prove is ORDERING, so this wraps it in a combined event log and
// asserts the mkdir precedes every write.
test("deploy with brand mkdirs the addon dir BEFORE writing into it", async () => {
  const fake = createHealthySshRunner();
  const events: string[] = [];
  const addonDir = `${remoteStackDir("acme", "prod")}/addons/${COMPANY_THEME_MODULE}`;
  const ssh: SshRunner = {
    exec: async (command) => {
      if (command.includes(`mkdir -p ${addonDir}`)) events.push("mkdir-addon");
      return fake.exec(command);
    },
    writeFile: async (remotePath, content) => {
      if (remotePath.startsWith(`${addonDir}/`)) events.push(`write:${remotePath}`);
      return fake.writeFile(remotePath, content);
    },
  };

  await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    brand: { primaryColor: "#123456" },
  });

  const firstWrite = events.findIndex((e) => e.startsWith("write:"));
  const mkdirAt = events.indexOf("mkdir-addon");
  assert.notEqual(mkdirAt, -1, "the addon dir must be created — writeFile does not create parents");
  assert.ok(firstWrite !== -1, "addon files must be written");
  assert.ok(mkdirAt < firstWrite, `mkdir must precede the first write (events: ${events.join(", ")})`);
});

// --- installTenantModules (spec 0100) ---------------------------------------
//
// READ THIS BEFORE TRUSTING THESE TESTS. The fake runner records command
// STRINGS; nothing here proves a module was installed on a real host. That
// distinction is not pedantic — it is exactly how spec 0093 shipped a wrong
// DeployResult claim, 0094 shipped wrong re-deploy behaviour, and 0097 shipped a
// missing `mkdir` past a fully green suite. What these lock is the part a fake
// CAN prove: that validation happens before we touch the network, that a missing
// DB is refused, that the steps are issued in the right order, and that a
// success claim requires reading state back. Effect is proven live (see the
// spec's Progress).

/** A runner that fails the test if it is used at all. */
function refuseAllSsh(): ReturnType<typeof createFakeSshRunner> {
  return createFakeSshRunner({
    respond() {
      throw new Error("no SSH call should have been made");
    },
  });
}

/**
 * Scripts the happy path: DB exists, the pre-install backup (spec 0105) writes
 * cleanly (`stat`/`ls -1` answer), install ok, restart ok, modules present.
 */
function liveTenantSsh(installed: string[]) {
  return createFakeSshRunner({
    respond(command) {
      if (command.includes("FROM pg_database")) return { code: 0, stdout: "1\n", stderr: "" };
      if (command.includes("ir_module_module"))
        return { code: 0, stdout: installed.join("\n") + "\n", stderr: "" };
      if (command.includes("curl")) return { code: 0, stdout: "200", stderr: "" };
      if (command.startsWith("stat -c %s")) return { code: 0, stdout: "21000\n4000\n", stderr: "" };
      if (command.startsWith("ls -1")) return { code: 0, stdout: `${TS}\n`, stderr: "" };
      return undefined; // install / restart / backup steps succeed
    },
  });
}

test("installTenantModules validates module names BEFORE any SSH call (injection surface)", async () => {
  for (const bad of ["crm; rm -rf /", "$(id)", "sale stock", "../etc", "CRM", ""]) {
    await assert.rejects(
      () => installTenantModules({ tenantId: "sandbox", ssh: refuseAllSsh(), modules: [bad], timestamp: TS }),
      /invalid Odoo module name/,
      `should have refused ${JSON.stringify(bad)} without touching SSH`,
    );
  }
});

test("installTenantModules refuses an empty module list", async () => {
  await assert.rejects(
    () => installTenantModules({ tenantId: "sandbox", ssh: refuseAllSsh(), modules: [], timestamp: TS }),
    /no modules requested/,
  );
});

test("installTenantModules refuses NON-RETRYABLY when the tenant DB does not exist", async () => {
  // Without this guard `odoo -i` would CREATE the DB, manufacturing a tenant
  // from a typo instead of failing.
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.includes("FROM pg_database")) return { code: 0, stdout: "", stderr: "" };
      throw new Error(`must not proceed past the DB-exists check; got: ${command}`);
    },
  });
  await assert.rejects(
    () => installTenantModules({ tenantId: "ghost", ssh, modules: ["crm"], timestamp: TS }),
    (err: unknown) => {
      const e = err as { retryable?: boolean; message: string };
      assert.equal(e.retryable, false);
      assert.match(e.message, /does not exist/);
      assert.match(e.message, /would CREATE it/);
      return true;
    },
  );
});

test("installTenantModules installs in ONE pass, restarts odoo, then verifies", async () => {
  const ssh = liveTenantSsh(["base", "web", "crm", "sales_team", "mail"]);
  const result = await installTenantModules({
    tenantId: "sandbox",
    ssh,
    modules: ["crm"],
    timestamp: TS,
    verify: { deadlineMs: 1000, intervalMs: 1, sleep: async () => {} },
  });
  assert.deepEqual(result, {
    tenantId: "sandbox",
    stack: "prod",
    modules: ["crm"],
    odooHttpOk: true,
  });

  const install = ssh.commands.findIndex((c) => c.includes("--stop-after-init"));
  const restart = ssh.commands.findIndex((c) => c.includes("restart odoo"));
  const readBack = ssh.commands.findIndex((c) => c.includes("ir_module_module"));
  const httpCheck = ssh.commands.findIndex((c) => c.includes("curl"));
  assert.ok(install > -1 && restart > -1 && readBack > -1 && httpCheck > -1);
  // Order is the correctness claim: the registry changes, THEN the serving
  // worker is restarted, THEN we read state back, THEN we confirm it still serves.
  assert.ok(install < restart, "must restart odoo AFTER the install");
  assert.ok(restart < readBack, "must read module state AFTER the restart");
  assert.ok(readBack < httpCheck, "HTTP verify comes last");

  // One -i pass for the whole set (N containers = N chances to half-apply).
  assert.equal(ssh.commands.filter((c) => c.includes("--stop-after-init")).length, 1);
  assert.match(ssh.commands[install]!, / -i crm --stop-after-init$/);
  assert.match(ssh.commands[install]!, /-d sandbox_prod/);
  assert.match(ssh.commands[install]!, /run --rm odoo/);
});

test("installTenantModules puts multiple modules in a single -i pass", async () => {
  const ssh = liveTenantSsh(["base", "sale", "stock", "crm"]);
  await installTenantModules({
    tenantId: "sandbox",
    ssh,
    modules: ["sale", "stock"],
    timestamp: TS,
    verify: { deadlineMs: 1000, intervalMs: 1, sleep: async () => {} },
  });
  const install = ssh.commands.find((c) => c.includes("--stop-after-init"))!;
  assert.match(install, / -i sale,stock --stop-after-init$/);
});

test("installTenantModules FAILS when the install exits 0 but the module is not installed", async () => {
  // The whole point of reading ir_module_module back: an exit code is not
  // evidence the world changed.
  const ssh = liveTenantSsh(["base", "web"]); // crm conspicuously absent
  await assert.rejects(
    () =>
      installTenantModules({
        tenantId: "sandbox",
        ssh,
        modules: ["crm"],
        timestamp: TS,
        verify: { deadlineMs: 1000, intervalMs: 1, sleep: async () => {} },
      }),
    (err: unknown) => {
      const e = err as { message: string };
      assert.match(e.message, /reported success but crm is not in state='installed'/);
      return true;
    },
  );
});

test("installTenantModules surfaces a failed install as retryable", async () => {
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.includes("FROM pg_database")) return { code: 0, stdout: "1\n", stderr: "" };
      // Let the pre-install backup (spec 0105) succeed so we reach the install pass.
      if (command.startsWith("stat -c %s")) return { code: 0, stdout: "21000\n4000\n", stderr: "" };
      if (command.startsWith("ls -1")) return { code: 0, stdout: `${TS}\n`, stderr: "" };
      if (command.includes("--stop-after-init"))
        return { code: 1, stdout: "", stderr: "odoo: unknown module 'nope'" };
      return undefined;
    },
  });
  await assert.rejects(
    () => installTenantModules({ tenantId: "sandbox", ssh, modules: ["nope"], timestamp: TS }),
    (err: unknown) => {
      const e = err as { retryable?: boolean; message: string };
      assert.equal(e.retryable, true);
      assert.match(e.message, /module install failed for sandbox_prod \(exit 1\)/);
      return true;
    },
  );
});

test("installTenantModules aborts the install when the pre-install backup fails (no backup, no mutation)", async () => {
  // spec 0105: an install mutates a live tenant DB, so a backup is taken first
  // and a failed backup must abort BEFORE the install pass — no backup, no mutation.
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.includes("FROM pg_database")) return { code: 0, stdout: "1\n", stderr: "" };
      if (command.includes("pg_dump"))
        return { code: 1, stdout: "", stderr: "pg_dump: connection to database failed" };
      return undefined; // mkdir succeeds; the dump is what fails
    },
  });
  await assert.rejects(
    () => installTenantModules({ tenantId: "sandbox", ssh, modules: ["crm"], timestamp: TS }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.match(err.message, /pg_dump/);
      return true;
    },
  );
  assert.ok(
    !ssh.commands.some((c) => c.includes("--stop-after-init")),
    "the install pass must NOT run after a failed backup",
  );
});

// --- Per-tenant backup + restore (spec 0105) --------------------------------
//
// Same fake-runner caveat as installTenantModules above: real per-step tests
// (added with each Progress [code] item) lock command SHAPE and ORDER, never
// that Postgres actually restored — effect is proven live by the (human)
// round-trip in the spec's Progress. This foundations smoke test only fixes
// that the new surface is exported and the shared path helper is correct.
test("spec 0105 backup/restore surface is exported", () => {
  assert.equal(typeof backupTenant, "function");
  assert.equal(typeof listTenantBackups, "function");
  assert.equal(typeof restoreTenant, "function");
  assert.equal(BACKUP_RETENTION, 3);
  assert.equal(remoteBackupsDir("sandbox", "prod"), "/opt/launchpad/sandbox/prod/backups");
});

// --- backupTenant (spec 0105 item 1) ----------------------------------------
//
// Same fake-runner caveat as installTenantModules: these lock command SHAPE and
// ORDER, never that Postgres actually dumped/restored — effect is proven live by
// the (human) round-trip in the spec's Progress.

const TS = "20260729T123456Z";

/** Scripts a live-tenant backup: DB exists, `stat` and `ls -1` return values. */
function backupSsh(opts?: { dbExists?: boolean; dbBytes?: number; filestoreBytes?: number; ls?: string }) {
  const dbExists = opts?.dbExists ?? true;
  return createFakeSshRunner({
    respond(command) {
      if (command.includes("FROM pg_database")) return { code: 0, stdout: dbExists ? "1\n" : "", stderr: "" };
      if (command.startsWith("stat -c %s"))
        return { code: 0, stdout: `${opts?.dbBytes ?? 21_000}\n${opts?.filestoreBytes ?? 4_000}\n`, stderr: "" };
      if (command.startsWith("ls -1")) return { code: 0, stdout: opts?.ls ?? `${TS}\n`, stderr: "" };
      return undefined; // mkdir / pg_dump / docker run / cp / rm all succeed
    },
  });
}

test("backupTenant validates tenant/stack/timestamp BEFORE any SSH call", async () => {
  for (const bad of [
    { tenantId: "acme; rm -rf /", stack: "prod", timestamp: TS },
    { tenantId: "../etc", stack: "prod", timestamp: TS },
    { tenantId: "acme", stack: "$(id)", timestamp: TS },
    { tenantId: "acme", stack: "", timestamp: TS },
    { tenantId: "acme", stack: "prod", timestamp: "2026-07-29" },
    { tenantId: "acme", stack: "prod", timestamp: "latest; rm -rf /" },
  ]) {
    const ssh = refuseAllSsh();
    await assert.rejects(
      () => backupTenant({ ...bad, ssh }),
      (err: unknown) => {
        assert.ok(err instanceof FleetError);
        assert.equal(err.kind, "config");
        assert.equal(err.retryable, false);
        return true;
      },
      `should reject ${JSON.stringify(bad)}`,
    );
    assert.equal(ssh.commands.length, 0, "validation must run before any SSH call");
    assert.equal(ssh.files.size, 0);
  }
});

test("backupTenant refuses NON-RETRYABLY when the tenant DB does not exist (no mutation)", async () => {
  const ssh = backupSsh({ dbExists: false });
  await assert.rejects(
    () => backupTenant({ tenantId: "ghost", ssh, timestamp: TS }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.retryable, false);
      assert.match(err.message, /does not exist/);
      return true;
    },
  );
  // Refusal comes right after the existence check — nothing was written.
  assert.ok(!ssh.commands.some((c) => c.includes("pg_dump")), "must not dump a nonexistent tenant");
  assert.ok(!ssh.commands.some((c) => c.startsWith("mkdir")), "must not create a backup dir");
});

test("backupTenant writes all three artifacts in order and reports their sizes", async () => {
  const ssh = backupSsh({ dbBytes: 21_000, filestoreBytes: 4_000 });
  const project = composeProjectName("acme", "prod");
  const dbName = tenantDbName("acme", "prod");
  const backupDir = `${remoteBackupsDir("acme", "prod")}/${TS}`;

  const result = await backupTenant({ tenantId: "acme", ssh, timestamp: TS });
  assert.deepEqual(result, {
    tenantId: "acme",
    stack: "prod",
    backupId: TS,
    dbBytes: 21_000,
    filestoreBytes: 4_000,
  });

  const dbExists = ssh.commands.findIndex((c) => c.includes("FROM pg_database"));
  const mkdir = ssh.commands.findIndex((c) => c === `mkdir -p ${backupDir}`);
  const dump = ssh.commands.findIndex((c) => c.includes("pg_dump"));
  const tar = ssh.commands.findIndex((c) => c.includes("tar czf"));
  const cp = ssh.commands.findIndex((c) => c.startsWith("cp "));
  const ls = ssh.commands.findIndex((c) => c.startsWith("ls -1"));

  assert.ok(dbExists > -1 && mkdir > -1 && dump > -1 && tar > -1 && cp > -1 && ls > -1);
  // Order is the correctness claim: check the DB is there, make the dir, THEN
  // write the three artifacts, THEN prune.
  assert.ok(dbExists < mkdir, "existence check precedes any write");
  assert.ok(mkdir < dump && mkdir < tar && mkdir < cp, "the backup dir is created before it is written into");
  assert.ok(dump < ls && tar < ls && cp < ls, "retention runs after the artifacts are written");

  // DB dump: pipefail-guarded pg_dump | gzip into db.sql.gz.
  assert.match(ssh.commands[dump]!, /set -o pipefail/);
  assert.match(ssh.commands[dump]!, new RegExp(`pg_dump -U odoo ${dbName} \\| gzip > ${backupDir}/db\\.sql\\.gz`));
  // Filestore: the named volume mounted READ-ONLY (no Odoo downtime).
  assert.ok(ssh.commands[tar]!.includes(`-v ${project}_odoo-filestore:/src:ro`), "filestore volume mounted read-only");
  assert.ok(ssh.commands[tar]!.includes(`-v ${backupDir}:/backup`));
  assert.ok(ssh.commands[tar]!.includes("tar czf /backup/filestore.tar.gz -C /src ."));
  // Compose: a byte-identical host copy of the live file.
  assert.equal(ssh.commands[cp]!, `cp ${remoteComposePath("acme", "prod")} ${backupDir}/docker-compose.yml`);
});

test("backupTenant keeps exactly the newest BACKUP_RETENTION backups and removes older ones", async () => {
  const backupsDir = remoteBackupsDir("acme", "prod");
  const all = [
    "20260725T000000Z",
    "20260726T000000Z",
    "20260727T000000Z",
    "20260728T000000Z",
    TS, // 20260729… — the newest, just written
  ];
  const ssh = backupSsh({ ls: all.join("\n") + "\n" });
  await backupTenant({ tenantId: "acme", ssh, timestamp: TS });

  const rm = ssh.commands.find((c) => c.startsWith("rm -rf"));
  assert.ok(rm, "old backups beyond the retention limit should be pruned");
  // The two oldest are removed; the newest three are kept.
  assert.ok(rm!.includes(`${backupsDir}/20260725T000000Z`), "oldest removed");
  assert.ok(rm!.includes(`${backupsDir}/20260726T000000Z`), "second-oldest removed");
  for (const keep of ["20260727T000000Z", "20260728T000000Z", TS]) {
    assert.ok(!rm!.includes(`${backupsDir}/${keep}`), `newest three kept (${keep})`);
  }
});

test("backupTenant with backups at the retention limit prunes nothing", async () => {
  const ssh = backupSsh({ ls: ["20260727T000000Z", "20260728T000000Z", TS].join("\n") + "\n" });
  await backupTenant({ tenantId: "acme", ssh, timestamp: TS });
  assert.ok(!ssh.commands.some((c) => c.startsWith("rm -rf")), "nothing to prune at exactly the limit");
});

// --- listTenantBackups (spec 0105 item 2) -----------------------------------

test("listTenantBackups validates tenant/stack BEFORE any SSH call", async () => {
  for (const bad of [
    { tenantId: "acme; rm -rf /", stack: "prod" },
    { tenantId: "../etc", stack: "prod" },
    { tenantId: "acme", stack: "$(id)" },
    { tenantId: "acme", stack: "" },
  ]) {
    const ssh = refuseAllSsh();
    await assert.rejects(
      () => listTenantBackups({ ...bad, ssh }),
      (err: unknown) => {
        assert.ok(err instanceof FleetError);
        assert.equal(err.kind, "config");
        assert.equal(err.retryable, false);
        return true;
      },
      `should reject ${JSON.stringify(bad)}`,
    );
    assert.equal(ssh.commands.length, 0, "validation must run before any SSH call");
  }
});

test("listTenantBackups returns restore points newest first, ignoring non-backup entries", async () => {
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.startsWith("ls -1")) {
        // Deliberately unsorted, with a stray file that must be filtered out.
        return {
          code: 0,
          stdout: "20260727T000000Z\n20260729T123456Z\nnot-a-backup\n20260728T000000Z\n",
          stderr: "",
        };
      }
      return undefined;
    },
  });
  const result = await listTenantBackups({ tenantId: "acme", ssh });
  assert.deepEqual(result, ["20260729T123456Z", "20260728T000000Z", "20260727T000000Z"]);
  assert.ok(
    ssh.commands.some((c) => c === `ls -1 ${remoteBackupsDir("acme", "prod")}`),
    "lists the tenant/stack backups dir",
  );
});

test("listTenantBackups returns [] when the backups dir does not exist yet", async () => {
  // A tenant that has never been backed up has no backups/ dir ⇒ `ls` exits
  // non-zero. That is zero restore points, not an error.
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.startsWith("ls -1")) {
        return { code: 2, stdout: "", stderr: "ls: cannot access: No such file or directory" };
      }
      return undefined;
    },
  });
  assert.deepEqual(await listTenantBackups({ tenantId: "fresh", ssh }), []);
});

// --- restoreTenant (spec 0105 item 3) ---------------------------------------
//
// Same fake-runner caveat as the rest of the family: these lock command SHAPE
// and ORDER, never that Postgres actually restored — effect is proven live by
// the (human) round-trip in the spec's Progress.

/** Scripts a live restore: the backups dir lists `backups`, stack healthy, Odoo 200. */
function restoreSsh(backups: string[]) {
  return createFakeSshRunner({
    respond(command) {
      if (command.startsWith("ls -1")) return { code: 0, stdout: backups.join("\n") + "\n", stderr: "" };
      if (command.includes("ps --status running --services")) return { code: 0, stdout: "db\nodoo\n", stderr: "" };
      if (command.includes("curl")) return { code: 0, stdout: "200", stderr: "" };
      return undefined; // stop / dropdb / createdb / reload / docker run / up all succeed
    },
  });
}

test("restoreTenant validates tenant/stack/backupId BEFORE any SSH call", async () => {
  for (const bad of [
    { tenantId: "acme; rm -rf /", stack: "prod", backupId: TS },
    { tenantId: "../etc", stack: "prod", backupId: TS },
    { tenantId: "acme", stack: "$(id)", backupId: TS },
    { tenantId: "acme", stack: "", backupId: TS },
    { tenantId: "acme", stack: "prod", backupId: "2026-07-29" },
    { tenantId: "acme", stack: "prod", backupId: "latest; rm -rf /" },
  ]) {
    const ssh = refuseAllSsh();
    await assert.rejects(
      () => restoreTenant({ ...bad, ssh }),
      (err: unknown) => {
        assert.ok(err instanceof FleetError);
        assert.equal(err.kind, "config");
        assert.equal(err.retryable, false);
        return true;
      },
      `should reject ${JSON.stringify(bad)}`,
    );
    assert.equal(ssh.commands.length, 0, "validation must run before any SSH call");
  }
});

test("restoreTenant rejects an unknown backupId NON-RETRYABLY, before any mutation", async () => {
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.startsWith("ls -1")) return { code: 0, stdout: "20260728T000000Z\n", stderr: "" };
      throw new Error(`must not mutate on an unknown backupId; got: ${command}`);
    },
  });
  await assert.rejects(
    () => restoreTenant({ tenantId: "acme", ssh, backupId: TS }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "config");
      assert.equal(err.retryable, false);
      assert.match(err.message, /unknown backupId/);
      return true;
    },
  );
  // Only the enumeration ran — nothing was stopped, dropped, or brought up.
  assert.ok(!ssh.commands.some((c) => c.includes("stop odoo")), "must not stop odoo");
  assert.ok(!ssh.commands.some((c) => c.includes("dropdb")), "must not drop the DB");
});

test("restoreTenant restores DB + filestore, brings the stack up, and verifies 200 — in order", async () => {
  const ssh = restoreSsh([TS]);
  const project = composeProjectName("acme", "prod");
  const composePath = remoteComposePath("acme", "prod");
  const dbName = tenantDbName("acme", "prod");
  const backupDir = `${remoteBackupsDir("acme", "prod")}/${TS}`;

  const result = await restoreTenant({
    tenantId: "acme",
    ssh,
    backupId: TS,
    verify: { deadlineMs: 1000, intervalMs: 1, sleep: async () => {} },
  });
  assert.deepEqual(result, { tenantId: "acme", stack: "prod", backupId: TS, odooHttpOk: true });

  const stop = ssh.commands.findIndex((c) => c.includes("stop odoo"));
  const dropdb = ssh.commands.findIndex((c) => c.includes("dropdb"));
  const createdb = ssh.commands.findIndex((c) => c.includes("createdb"));
  const reload = ssh.commands.findIndex((c) => c.includes("gunzip -c") && c.includes("psql"));
  const filestore = ssh.commands.findIndex((c) => c.includes("tar xzf"));
  const up = ssh.commands.findIndex((c) => c === `docker compose -p ${project} -f ${composePath} up -d`);
  const httpCheck = ssh.commands.findIndex((c) => c.includes("curl"));

  assert.ok(
    stop > -1 && dropdb > -1 && createdb > -1 && reload > -1 && filestore > -1 && up > -1 && httpCheck > -1,
    "every restore step should have been issued",
  );
  // Order is the correctness claim: stop odoo, restore DB then filestore, bring
  // the stack up, and only then confirm it still serves.
  assert.ok(stop < dropdb, "stop odoo before dropping the DB");
  assert.ok(dropdb < createdb && createdb < reload, "drop → recreate → reload");
  assert.ok(reload < filestore, "DB restored before the filestore");
  assert.ok(filestore < up, "artifacts restored before the stack comes up");
  assert.ok(up < httpCheck, "HTTP verify comes last");

  // Shapes. Stop only odoo (db stays up).
  assert.equal(ssh.commands[stop]!, `docker compose -p ${project} -f ${composePath} stop odoo`);
  // DB drop/recreate against the still-running db service.
  assert.ok(ssh.commands[dropdb]!.includes(`exec -T db dropdb -U odoo ${dbName}`));
  assert.ok(ssh.commands[createdb]!.includes(`exec -T db createdb -U odoo ${dbName}`));
  // Reload: pipefail-guarded gunzip | psql from the backup's db.sql.gz.
  assert.match(ssh.commands[reload]!, /set -o pipefail/);
  assert.ok(ssh.commands[reload]!.includes(`gunzip -c ${backupDir}/db.sql.gz`));
  assert.ok(ssh.commands[reload]!.includes(`exec -T db psql -U odoo -d ${dbName}`));
  // Filestore: REPLACE the volume (clear then extract), mounted read-WRITE.
  assert.ok(ssh.commands[filestore]!.includes(`-v ${project}_odoo-filestore:/dst`), "volume mounted read-write");
  assert.ok(!ssh.commands[filestore]!.includes("_odoo-filestore:/dst:ro"), "restore must write the volume");
  assert.ok(ssh.commands[filestore]!.includes("find /dst -mindepth 1 -delete"), "clears stale files first");
  assert.ok(ssh.commands[filestore]!.includes("tar xzf /backup/filestore.tar.gz -C /dst"), "extracts the archive");
});

test("restoreTenant throws if Odoo does not answer 200 after the restore", async () => {
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.startsWith("ls -1")) return { code: 0, stdout: `${TS}\n`, stderr: "" };
      if (command.includes("ps --status running --services")) return { code: 0, stdout: "db\nodoo\n", stderr: "" };
      if (command.includes("curl")) return { code: 0, stdout: "502", stderr: "" };
      return undefined;
    },
  });
  await assert.rejects(
    () =>
      restoreTenant({
        tenantId: "acme",
        ssh,
        backupId: TS,
        verify: { deadlineMs: 10, intervalMs: 5, sleep: async () => {} },
      }),
    /Odoo did not answer HTTP 200/,
  );
});

// ---------------------------------------------------------------------------
// Spec 0120 — the ingress. Every tenant stack on the fleet answered 404 through
// Traefik for months while Odoo was healthy on :8069, because the router had no
// `tls` label and the container-exec curl could never see the difference.
//
// These tests exist so that cannot recur silently. The important ones are the
// negatives: a deploy MUST fail on 404, and MUST fail on the 301 that the global
// redirect returns for any host at all.
// ---------------------------------------------------------------------------

/** Fake whose ingress curl (identified by `--resolve`) answers `status`. */
function sshWithIngress(status: string) {
  return createFakeSshRunner({
    respond(command) {
      if (command.includes("ps --status running --services")) {
        return { code: 0, stdout: "db\nodoo\n", stderr: "" };
      }
      if (command.includes("odoo shell")) {
        // Spec 0121: the marker `setAdminPassword` requires — it proves the ORM
        // matched exactly one user, not merely that the command exited 0.
        // Spec 0208: the same `odoo shell` path also creates the read-only user.
        if (command.includes("ODOO_READONLY_USER_READY")) {
          return { code: 0, stdout: "ODOO_READONLY_USER_READY 1\n", stderr: "" };
        }
        return { code: 0, stdout: "ADMIN_PASSWORD_SET 1\n", stderr: "" };
      }
      if (command.includes("--resolve")) return { code: 0, stdout: status, stderr: "" };
      if (command.includes("curl")) return { code: 0, stdout: "200", stderr: "" };
      return undefined;
    },
  });
}

function deployOpts(ssh: SshRunner) {
  return {
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 18 as const,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    verify: { deadlineMs: 30, intervalMs: 10, sleep: async () => {} },
  };
}

test("the rendered stack carries the TLS router label — without it HTTPS matches no router", async () => {
  const rendered = renderStack(await loadStackTemplate(), {
    tenant: "acme",
    stack: "prod",
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "pw",
  });
  assert.match(rendered, /traefik\.http\.routers\.acme-prod\.tls=true/);
  // And the rule it must accompany, so a "tidy-up" cannot leave one without the other.
  assert.match(rendered, /traefik\.http\.routers\.acme-prod\.rule=Host\(`prod\.acme\.example\.com`\)/);
});

test("routerHost matches the host in the router rule — one definition, so they cannot drift", async () => {
  const rendered = renderStack(await loadStackTemplate(), {
    tenant: "acme",
    stack: "prod",
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "pw",
  });
  assert.ok(rendered.includes(`Host(\`${routerHost("acme", "prod", "example.com")}\`)`));
});

// ---------------------------------------------------------------------------
// Spec 0148 phase C — odoo-next: a Traefik host override + an opt-in ACME cert
// resolver, so a resolving domain (`<slug>.odoo.example.com`) gets a real cert
// while every non-resolving `.test` tenant keeps its self-signed default
// unchanged. The certresolver path MUST be strictly opt-in.
// ---------------------------------------------------------------------------

test("renderStack default: self-signed only — no ACME certresolver/websecure labels reach .test tenants", async () => {
  const rendered = renderStack(await loadStackTemplate(), {
    tenant: "acme",
    stack: "prod",
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "pw",
  });
  // Regression guard: existing tenants must be byte-for-byte the old behaviour.
  // Anchor to the traefik LABEL line, not the template's explanatory comment.
  assert.doesNotMatch(rendered, /- traefik\.http\.routers\.[\w-]+\.tls\.certresolver=/);
  assert.doesNotMatch(rendered, /- traefik\.http\.routers\.[\w-]+\.entrypoints=websecure/);
  assert.match(rendered, /traefik\.http\.routers\.acme-prod\.tls=true/);
});

test("renderStack with host + certResolver: the odoo-next host and the ACME labels on the SAME router", async () => {
  const rendered = renderStack(await loadStackTemplate(), {
    tenant: "myshop",
    stack: "prod",
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "pw",
    host: "myshop.odoo.example.com",
    certResolver: "letsencrypt",
  });
  assert.match(rendered, /rule=Host\(`myshop\.odoo\.example\.com`\)/);
  // Staging's ACME pattern, attached to the router the .rule/.tls labels use —
  // a certresolver on a different router name would never take effect.
  assert.match(rendered, /traefik\.http\.routers\.myshop-prod\.tls\.certresolver=letsencrypt/);
  assert.match(rendered, /traefik\.http\.routers\.myshop-prod\.entrypoints=websecure/);
  // The injected label block leaves no stray unresolved placeholder.
  assert.doesNotMatch(rendered, /\$\{[A-Z_]+\}/);
});

test("deploy verifies the ingress against the OVERRIDE host — host served == host proved reachable", async () => {
  const ssh = sshWithIngress("200");
  const result = await deployProductionStack({
    ...deployOpts(ssh),
    domain: "example.com",
    host: "myshop.odoo.example.com",
    certResolver: "letsencrypt",
  });
  assert.equal(result.ingressOk, true);
  const call = ssh.commands.find((c) => c.includes("--resolve"));
  assert.ok(call, `no ingress curl in: ${ssh.commands.join(" | ")}`);
  // The override, NOT the default prod.acme.example.com — the check would pass
  // against the wrong host if the two ever drifted apart.
  assert.match(call, /--resolve myshop\.odoo\.example\.com:443:127\.0\.0\.1/);
  assert.match(call, /https:\/\/myshop\.odoo\.example\.com\/web\/login/);
  // And the compose actually written to the box carries the ACME label.
  const compose = ssh.files.get(remoteComposePath("acme", "prod"));
  assert.ok(compose, "compose was never written to the VPS");
  assert.match(compose, /tls\.certresolver=letsencrypt/);
});

test("deploy refuses a NON-sandbox VPS id before any SSH — the ADR-013 floor holds for phase C", async () => {
  const ssh = createHealthySshRunner();
  await assert.rejects(
    () =>
      deployProductionStack({
        ...deployOpts(ssh),
        vpsId: 100002, // production erp.example.com — never mutable by fleet tooling
        host: "myshop.odoo.example.com",
        certResolver: "letsencrypt",
      }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "sandbox");
      assert.equal(err.retryable, false);
      return true;
    },
  );
  // The break-it check: refusal is at the LOWEST layer, before any side effect.
  assert.equal(ssh.commands.length, 0, `expected no SSH before refusal, got: ${ssh.commands.join(" | ")}`);
});

// ---------------------------------------------------------------------------
// Spec 0148 phase D — odoo-next Next front stack render. Twin of phase C's
// odoo render: a Traefik-routed front at `<slug>.example.com`, ODOO_URL injected
// pointing at the phase-C stack, ACME certresolver strictly opt-in.
// ---------------------------------------------------------------------------

test("renderFrontStack: routes <slug>.example.com, injects ODOO_URL at the phase-C host", async () => {
  const rendered = renderFrontStack(await loadFrontStackTemplate(), {
    slug: "acme",
    name: "myshop-front",
    host: "myshop.example.com",
    odooUrl: "https://myshop.odoo.example.com",
    odooDb: "myshop_prod",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
  });
  assert.match(rendered, /traefik\.http\.routers\.myshop-front\.rule=Host\(`myshop\.example\.com`\)/);
  assert.match(rendered, /- ODOO_URL=https:\/\/myshop\.odoo\.example\.com/);
  assert.match(rendered, /traefik\.http\.services\.myshop-front\.loadbalancer\.server\.port=3000/);
  // No placeholder survives substitution.
  assert.doesNotMatch(rendered, /\$\{[A-Z_]+\}/);
});

test("renderFrontStack default: self-signed only — no ACME certresolver/websecure labels", async () => {
  const rendered = renderFrontStack(await loadFrontStackTemplate(), {
    slug: "acme",
    name: "myshop-front",
    host: "myshop.example.com",
    odooUrl: "https://myshop.odoo.example.com",
    odooDb: "myshop_prod",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
  });
  assert.doesNotMatch(rendered, /- traefik\.http\.routers\.[\w-]+\.tls\.certresolver=/);
  assert.doesNotMatch(rendered, /- traefik\.http\.routers\.[\w-]+\.entrypoints=websecure/);
  assert.match(rendered, /traefik\.http\.routers\.myshop-front\.tls=true/);
});

test("renderFrontStack with certResolver: ACME labels on the SAME router as .rule/.tls", async () => {
  const rendered = renderFrontStack(await loadFrontStackTemplate(), {
    slug: "acme",
    name: "myshop-front",
    host: "myshop.example.com",
    odooUrl: "https://myshop.odoo.example.com",
    odooDb: "myshop_prod",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    certResolver: "letsencrypt",
  });
  assert.match(rendered, /traefik\.http\.routers\.myshop-front\.tls\.certresolver=letsencrypt/);
  assert.match(rendered, /traefik\.http\.routers\.myshop-front\.entrypoints=websecure/);
  assert.doesNotMatch(rendered, /\$\{[A-Z_]+\}/);
});

// Phase D2 — the front DEPLOY. `sshWithIngress` already answers the ingress
// curl with the scripted status and every other command (mkdir/extract/up) with
// the default code 0.
function frontDeployOpts(ssh: SshRunner) {
  return {
    slug: "myshop",
    vpsId: 100001,
    ssh,
    domain: "example.com",
    odooUrl: "https://myshop.odoo.example.com",
    odooDb: "acme_prod",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
    sourceArchive: "BASE64TARGZ==",
    verify: { deadlineMs: 30, intervalMs: 10, sleep: async () => {} },
  };
}

test("deployFrontStack uploads+extracts the checkout, builds, and verifies ingress at / on the rule's host", async () => {
  const ssh = sshWithIngress("200");
  const result = await deployFrontStack(frontDeployOpts(ssh));
  assert.equal(result.ingressOk, true);
  assert.equal(result.name, "myshop-front");
  assert.equal(result.host, "myshop.example.com");

  // The deploy compose landed in the front's OWN stack dir (distinct from the
  // odoo stack), carrying the front host + injected ODOO_URL.
  const composePath = remoteComposePath("myshop", "front");
  const compose = ssh.files.get(composePath);
  assert.ok(compose, `front compose was never written to the VPS: ${[...ssh.files.keys()].join(", ")}`);
  assert.match(compose, /rule=Host\(`myshop\.example\.com`\)/);
  assert.match(compose, /ODOO_URL=https:\/\/myshop\.odoo\.example\.com/);

  // Source uploaded + extracted into the stack dir so `context: .` is the repo.
  const extract = ssh.commands.find((c) => c.includes("base64 -d") && c.includes("tar -xzf"));
  assert.ok(extract, `no source extract command in: ${ssh.commands.join(" | ")}`);
  assert.match(extract, /-C \/opt\/launchpad\/myshop\/front/);

  // Rebuild from that context, and NOT against the odoo compose project.
  assert.ok(
    ssh.commands.some((c) => c.includes("docker compose -p myshop-front") && c.includes("up -d --build")),
    `no build in: ${ssh.commands.join(" | ")}`,
  );

  // Ingress checked at `/` (a Next front, not Odoo) on the SAME host the rule
  // uses — the host proved reachable is the host served.
  const ing = ssh.commands.find((c) => c.includes("--resolve"));
  assert.ok(ing, `no ingress curl in: ${ssh.commands.join(" | ")}`);
  assert.match(ing, /--resolve myshop\.example\.com:443:127\.0\.0\.1/);
  assert.match(ing, /https:\/\/myshop\.example\.com\//);
  assert.doesNotMatch(ing, /\/web\/login/);
});

test("deployFrontStack FAILS when Traefik does not route to the front (404) — the check can fail", async () => {
  await assert.rejects(
    () => deployFrontStack(frontDeployOpts(sshWithIngress("404"))),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.match(err.message, /not reachable through Traefik/);
      return true;
    },
  );
});

/**
 * Spec 0192 A2. The half that A missed, found by deploying A and watching the
 * SAME error come back: tar extraction does not delete what the new archive
 * omits, and the front's stack dir is reused every redeploy — so the `specs`
 * symlink from the first deploy was still sitting in the build context an hour
 * after the packer stopped shipping it.
 *
 * A fake can only prove the context is cleared before the extract, which is what
 * this asserts; that it FIXES the build is the spec's live item, verified on the
 * box.
 */
test("deployFrontStack REPLACES the build context — no file survives a redeploy", async () => {
  const ssh = sshWithIngress("200");
  await deployFrontStack(frontDeployOpts(ssh));
  const dir = remoteStackDir("myshop", "front");
  const wipe = ssh.commands.findIndex((c) => c.includes(`rm -rf ${dir}`));
  const extract = ssh.commands.findIndex((c) => c.includes("base64 -d") && c.includes("tar -xzf"));
  assert.ok(wipe >= 0, `the context is never cleared: ${ssh.commands.join(" | ")}`);
  assert.ok(extract > wipe, "the clear must happen BEFORE the extract, or it deletes the checkout");
});

test("deployFrontStack refuses a name that could escape the rm -rf path", async () => {
  const ssh = sshWithIngress("200");
  await assert.rejects(
    () => deployFrontStack({ ...frontDeployOpts(ssh), slug: "../../etc" }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "config");
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(ssh.commands.length, 0, `expected no SSH before refusal: ${ssh.commands.join(" | ")}`);
});

/**
 * Spec 0192 C. Run 4's front died and recorded `RUN npm run build … exit code: 1`
 * — the step, never the reason. The reason was the LAST thing buildkit printed
 * (`ENOENT: no such file or directory, stat '/app/specs'`), and a head slice
 * cuts exactly that end off. Finding it took a hand-run rebuild of the deployed
 * context on the tenant box; nobody reading the record could have.
 */
test("deployFrontStack records the build's OWN error, not just docker's summary", async () => {
  const buildOutput =
    "#0 building with docker driver\n" +
    "x".repeat(3000) + // the layer noise a head slice would keep
    "\n------\n > [builder 4/4] RUN npm run build:\n" +
    "2.345 [Error: ENOENT: no such file or directory, stat '/app/specs']\n" +
    "------\n" +
    'failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1';
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.includes("up -d --build")) return { code: 1, stdout: "", stderr: buildOutput };
      return undefined;
    },
  });
  await assert.rejects(
    () => deployFrontStack(frontDeployOpts(ssh)),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.match(err.message, /ENOENT: no such file or directory, stat '\/app\/specs'/);
      assert.match(err.message, /RUN npm run build/, "and the step it died in");
      return true;
    },
  );
});

test("deployFrontStack refuses a NON-sandbox VPS id before any SSH — the ADR-013 floor holds", async () => {
  const ssh = sshWithIngress("200");
  await assert.rejects(
    () => deployFrontStack({ ...frontDeployOpts(ssh), vpsId: 100002 }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "sandbox");
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(ssh.commands.length, 0, `expected no SSH before refusal, got: ${ssh.commands.join(" | ")}`);
  assert.equal(ssh.files.size, 0, "expected nothing written before refusal");
});

test("deployFrontStack refuses an empty sourceArchive — nothing to build without the checkout", async () => {
  const ssh = sshWithIngress("200");
  await assert.rejects(
    () => deployFrontStack({ ...frontDeployOpts(ssh), sourceArchive: "" }),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "config");
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("deploy FAILS when Traefik answers 404 — the exact defect spec 0120 found", async () => {
  await assert.rejects(
    () => deployProductionStack(deployOpts(sshWithIngress("404"))),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.match(err.message, /not reachable through Traefik/);
      // The message must point at the cause, not just report a number.
      assert.match(err.message, /tls/);
      return true;
    },
  );
});

test("deploy FAILS on 301 — the redirect answers for ANY host and is not evidence of routing", async () => {
  // This is the check that could not fail, in test form. Both spec 0119 sessions
  // read this 301 as "Traefik answered".
  await assert.rejects(
    () => deployProductionStack(deployOpts(sshWithIngress("301"))),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.match(err.message, /ANY host/);
      return true;
    },
  );
});

test("deploy succeeds and reports ingressOk when Traefik actually serves the host", async () => {
  // The positive control: the two negatives above would also pass against an
  // implementation that rejected everything.
  const result = await deployProductionStack(deployOpts(sshWithIngress("200")));
  assert.equal(result.ingressOk, true);
  assert.equal(result.odooHttpOk, true);
});

test("the ingress check is DNS-independent — it pins the name to loopback", async () => {
  // Every tenant to date is on `.test`, which can never resolve. A check that
  // needed working DNS would be untestable on exactly the stacks that have none.
  const ssh = sshWithIngress("200");
  await deployProductionStack(deployOpts(ssh));
  const call = ssh.commands.find((c) => c.includes("--resolve"));
  assert.ok(call, `no ingress curl in: ${ssh.commands.join(" | ")}`);
  assert.match(call, /--resolve prod\.acme\.example\.com:443:127\.0\.0\.1/);
  assert.match(call, /https:\/\/prod\.acme\.example\.com\/web\/login/);
});

// ---------------------------------------------------------------------------
// Spec 0121 — the two Odoo passwords. They are different things, and conflating
// them is how you lock a tenant out: `masterPassword` governs
// /web/database/manager (create/drop/duplicate/backup), `adminPassword` is what
// you type at /web/login.
// ---------------------------------------------------------------------------

test("renderOdooConf sets admin_passwd — without this file the image's default governs the DB manager", () => {
  const conf = renderOdooConf("company-test-master");
  assert.match(conf, /^\[options\]$/m);
  assert.match(conf, /^admin_passwd = company-test-master$/m);
});

test("renderOdooConf repeats addons_path and data_dir — it REPLACES the image's config", () => {
  // Omitting either is silent breakage: no extra-addons mount (spec 0097) and a
  // filestore that moves out from under the existing volume.
  const conf = renderOdooConf("company-test-master");
  assert.match(conf, /^addons_path = \/mnt\/extra-addons$/m);
  assert.match(conf, /^data_dir = \/var\/lib\/odoo$/m);
});

test("both passwords refuse shell/Python metacharacters — they are interpolated into both", () => {
  // The trust boundary. A quote or backtick here would break out of the remote
  // shell command or the Python literal the ORM script is built from.
  for (const bad of ["short", "has space", "has'quote", 'has"quote', "back`tick", "dollar$sign", "back\\slash", ""]) {
    assert.throws(
      () => renderOdooConf(bad),
      (err: unknown) => {
        assert.ok(err instanceof FleetError);
        assert.equal(err.retryable, false);
        // The message must not echo the rejected value — it gets logged.
        assert.equal(err.message.includes(bad) && bad.length > 0, false);
        return true;
      },
      `should reject ${JSON.stringify(bad)}`,
    );
  }
  assert.doesNotThrow(() => renderOdooConf("company3036-ok_value"));
});

test("the rendered stack mounts odoo.conf over the image's own", async () => {
  const rendered = renderStack(await loadStackTemplate(), {
    tenant: "acme",
    stack: "prod",
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "pw",
  });
  assert.match(rendered, /\.\/odoo\.conf:\/etc\/odoo\/odoo\.conf:ro/);
});

test("deploy writes odoo.conf BEFORE compose up — docker would otherwise create it as a directory", async () => {
  const ssh = createHealthySshRunner();
  await deployProductionStack(deployOpts(ssh));
  const confPath = remoteOdooConfPath("acme", "prod");
  const conf = ssh.files.get(confPath);
  assert.ok(conf, `odoo.conf was never written; files: ${[...ssh.files.keys()].join(", ")}`);
  assert.match(conf, /admin_passwd = /);
  // Ordering: the write must precede the `up` that mounts it.
  const upIdx = ssh.commands.findIndex((c) => c.includes("up -d"));
  assert.ok(upIdx >= 0, "no compose up in the command log");
});

test("deploy FAILS when the admin-password ORM step matches no user", async () => {
  // `exec` exiting 0 while the ORM matched nothing would otherwise read as success
  // and leave the old password in place — so the marker, not the exit code, is the
  // check.
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.includes("ps --status running --services")) {
        return { code: 0, stdout: "db\nodoo\n", stderr: "" };
      }
      if (command.includes("odoo shell")) {
        // Spec 0208: the same `odoo shell` path also creates the read-only user.
        if (command.includes("ODOO_READONLY_USER_READY")) {
          return { code: 0, stdout: "ODOO_READONLY_USER_READY 1\n", stderr: "" };
        }
        return { code: 0, stdout: "ADMIN_PASSWORD_SET 0\n", stderr: "" };
      }
      if (command.includes("curl")) return { code: 0, stdout: "200", stderr: "" };
      return undefined;
    },
  });
  await assert.rejects(
    () => deployProductionStack(deployOpts(ssh)),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.match(err.message, /ADMIN_PASSWORD_SET 1/);
      return true;
    },
  );
});

test("a failed admin-password step never echoes the password", async () => {
  const secret = "company3036-secret-value";
  const ssh = createFakeSshRunner({
    respond(command) {
      if (command.includes("ps --status running --services")) {
        return { code: 0, stdout: "db\nodoo\n", stderr: "" };
      }
      if (command.includes("odoo shell")) return { code: 1, stdout: "boom", stderr: "" };
      if (command.includes("curl")) return { code: 0, stdout: "200", stderr: "" };
      return undefined;
    },
  });
  await assert.rejects(
    () => deployProductionStack({ ...deployOpts(ssh), adminPassword: secret }),
    (err: unknown) => {
      assert.equal((err as Error).message.includes(secret), false);
      return true;
    },
  );
});

test("the admin password goes through the ORM, not raw SQL — a hand-written hash locks the tenant out", async () => {
  const ssh = createHealthySshRunner();
  await deployProductionStack(deployOpts(ssh));
  const call = ssh.commands.find((c) => c.includes("odoo shell"));
  assert.ok(call, `no odoo shell call in: ${ssh.commands.join(" | ")}`);
  // Asserted without depending on quoting: the script is single-quoted for the
  // remote shell, so every `'` in the Python literal arrives as `'\''`.
  assert.match(call, /res\.users/);
  assert.match(call, /search/);
  assert.match(call, /login/);
  assert.equal(call.includes("browse("), false, "looks the user up by login, not by a hardcoded row id");
  // Via the entrypoint, so the DB password comes from the service env rather than
  // this command line (it would otherwise sit in the box's process list).
  assert.match(call, /\/entrypoint\.sh odoo shell/);
  assert.equal(call.includes("--db_password"), false);
});

/**
 * Spec 0161 live proof, first attempt: `docker compose up -d db` died with
 * "top-level object must be a mapping". Both templates documented their
 * variables as `${NAME}` in a header comment, rendering is a blunt split/join
 * over the whole file, and TLS_EXTRA_LABELS is TWO lines — so its second line
 * escaped the `#` and became top-level YAML.
 */
test("renderTemplate refuses a multi-line value that would be substituted mid-line", () => {
  assert.throws(
    () =>
      renderTemplate("# documented as ${LABELS} in a comment\nservices:\n", {
        "${LABELS}": "      - one\n      - two\n",
      }),
    (err: unknown) => err instanceof FleetError && /mid-line/.test((err as Error).message),
  );
});

test("renderTemplate allows a multi-line value at the start of a line (the body usage)", () => {
  const out = renderTemplate("labels:\n${LABELS}      - last\n", {
    "${LABELS}": "      - one\n      - two\n",
  });
  assert.match(out, /labels:\n {6}- one\n {6}- two\n {6}- last/);
});

/**
 * The end state the failure violated, asserted on the SHIPPED template with ACME
 * on: an ACME label must never sit directly beneath a comment line, which is
 * what "escaped the comment" looks like in the rendered file.
 */
test("the shipped odoo template keeps its ACME labels inside the labels block", async () => {
  const rendered = renderStack(await loadStackTemplate(), {
    tenant: "acme",
    stack: "prod",
    odooVersion: 18,
    domain: "example.com",
    dbPassword: "pw",
    certResolver: "letsencrypt",
  });
  const lines = rendered.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (/^\s+- traefik\.http\.routers\..*certresolver/.test(lines[i]!)) {
      assert.equal(
        /^\s*#/.test(lines[i - 1]!),
        false,
        `an ACME label landed straight after a comment (line ${i + 1}) — the escape that corrupted probe0161`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// spec 0172 — the front stack learns to be somewhere other than production.
// ---------------------------------------------------------------------------

test("spec 0172: with no overrides the front deploy is byte-identical to before", async () => {
  // The regression that matters: production's front must keep landing in the
  // same dir, compose project and host it always has.
  const ssh = sshWithIngress("200");
  const result = await deployFrontStack(frontDeployOpts(ssh));
  assert.equal(result.name, "myshop-front");
  assert.equal(result.host, "myshop.example.com");
  assert.ok(ssh.files.get(remoteComposePath("myshop", "front")), "production's front compose path");
});

test("spec 0172: a branch's front lands on ITS OWN stack and host, never production's", async () => {
  const ssh = sshWithIngress("200");
  const stack = "br-sushi-menu-a1b2c3-front";
  const host = `${stack}.sushi.203.0.113.20.sslip.io`;
  const result = await deployFrontStack({
    ...frontDeployOpts(ssh),
    slug: "sushi",
    stack,
    host,
    odooUrl: "https://br-sushi-menu-a1b2c3.sushi.203.0.113.20.sslip.io",
  });
  assert.equal(result.host, host);
  assert.equal(result.name, `sushi-${stack}`);

  const compose = ssh.files.get(remoteComposePath("sushi", stack));
  assert.ok(compose, `branch front compose missing: ${[...ssh.files.keys()].join(", ")}`);
  assert.match(compose, new RegExp(`rule=Host\\(\`${host.replace(/\./g, "\\.")}\`\\)`));
  // THE property: nothing touched production's front.
  assert.equal(
    ssh.files.get(remoteComposePath("sushi", "front")),
    undefined,
    "a branch deploy must never write production's front compose",
  );
  assert.ok(
    !ssh.commands.some((c) => c.includes("-p sushi-front ")),
    `a branch deploy must never rebuild production's compose project: ${ssh.commands.join(" | ")}`,
  );
});

test("spec 0173: with no odooNetwork the front compose is byte-identical to today's", async () => {
  // Production must not move: it reaches its Odoo over the public name with a
  // real certificate, and that works.
  const ssh = sshWithIngress("200");
  await deployFrontStack(frontDeployOpts(ssh));
  const compose = ssh.files.get(remoteComposePath("myshop", "front")) ?? "";
  assert.doesNotMatch(compose, /networks:/);
  assert.doesNotMatch(compose, /traefik\.docker\.network/);
});

test("spec 0173: an odooNetwork joins that network AND pins Traefik to the front's own", async () => {
  const ssh = sshWithIngress("200");
  await deployFrontStack({
    ...frontDeployOpts(ssh),
    slug: "sushi",
    stack: "br-x-front",
    host: "br-x-front.sushi.example.test",
    odooUrl: "http://odoo:8069",
    odooNetwork: "sushi-br-x_default",
  });
  const compose = ssh.files.get(remoteComposePath("sushi", "br-x-front")) ?? "";
  assert.match(compose, /external: true/);
  assert.match(compose, /name: sushi-br-x_default/);
  // Traefik runs on the HOST network here, so with two networks it needs to be
  // told which container IP to route to — otherwise the choice is made for us.
  assert.match(compose, /traefik\.docker\.network=sushi-br-x-front_default/);
  assert.match(compose, /ODOO_URL=http:\/\/odoo:8069/);
});

// ---------------------------------------------------------------------------
// Spec 0208 — the front reads its own Odoo. The failure these guard: a
// container that boots without the credentials (so every page shows "no
// disponible"), or a password that reaches the browser.
// ---------------------------------------------------------------------------

test("renderFrontStack injects the read-only credentials, and never as NEXT_PUBLIC_", async () => {
  const rendered = renderFrontStack(await loadFrontStackTemplate(), {
    slug: "acme",
    name: "acme-front",
    host: "acme.example.com",
    odooUrl: "https://acme.odoo.example.com",
    odooDb: "acme_prod",
    odooUser: "front_readonly",
    odooPassword: "ro-pass-not-a-real-secret",
  });
  assert.match(rendered, /- ODOO_DB=acme_prod/);
  assert.match(rendered, /- ODOO_USER=front_readonly/);
  assert.match(rendered, /- ODOO_PASSWORD=ro-pass-not-a-real-secret/);
  // `NEXT_PUBLIC_` is the one prefix that would inline a value into the browser
  // bundle. A password behind it is a leak with no error message. Scoped to env
  // LINES: the template's own comment names the prefix in order to warn about it.
  assert.doesNotMatch(rendered, /^\s*- NEXT_PUBLIC_/m);
  assert.doesNotMatch(rendered, /\$\{[A-Z_]+\}/, "no placeholder survives substitution");
});

test("ensureOdooReadonlyUser refuses unless the ORM reports exactly one user", async () => {
  // The marker discipline spec 0121 paid for: `exec` exiting 0 while the ORM
  // matched or created nothing reads as success and leaves no user behind.
  const silent = createFakeSshRunner({ respond: () => ({ code: 0, stdout: "", stderr: "" }) });
  await assert.rejects(
    () =>
      ensureOdooReadonlyUser(silent, "acme-prod", "/opt/x/docker-compose.yml", "acme_prod",
        "front_readonly", "ro-pass-not-a-real-secret"),
    /ODOO_READONLY_USER_READY 1/,
  );
});

/** Recover the Python from a `printf '%s' '<script>' | … odoo shell` command.
 *  Assertions written against the raw command keep tripping on the shell's
 *  single-quote escaping (`'perm_read'` becomes `'\''perm_read'\''`) — three
 *  assertions in this spec silently matched nothing before this existed. */
function odooShellScript(commands: readonly string[]): string {
  const cmd = commands.find((c) => c.includes("odoo shell")) ?? "";
  const m = /^printf '%s' '([\s\S]*?)' \| /.exec(cmd);
  return m ? m[1]!.split(`'\\''`).join("'") : "";
}

test("ensureOdooReadonlyUser grants read on exactly the named models, and nothing else", async () => {
  // "No groups" was the first version and it was WRONG: in Odoo, access comes
  // from `ir.model.access` rows hanging off groups, so a user with none can read
  // nothing either. Measured live — `base.group_portal` and `base.group_public`
  // cannot read `product.template`, and `base.group_user` can also WRITE. So the
  // guarantee is an own group carrying read-only rows on an enumerated list.
  const ssh = createFakeSshRunner({
    respond: () => ({ code: 0, stdout: "ODOO_READONLY_USER_READY 1 acl= 2\n", stderr: "" }),
  });
  await ensureOdooReadonlyUser(ssh, "acme-prod", "/opt/x/docker-compose.yml", "acme_prod",
    "front_readonly", "ro-pass-not-a-real-secret");
  const script = odooShellScript(ssh.commands);

  for (const model of READONLY_MODELS) {
    assert.ok(script.includes(model), `${model} must be granted`);
  }
  assert.ok(script.includes(READONLY_GROUP_NAME), "the grants hang off our OWN group");
  assert.match(script, /'perm_read': True/);
  for (const perm of ["perm_write", "perm_create", "perm_unlink"]) {
    assert.match(
      script,
      new RegExp(`'${perm}': False`),
      `${perm} must be explicitly False — a read-only user that can ${perm} is a lie`,
    );
  }
  // The groups field is named differently in 18 (`groups_id`) and 19
  // (`group_ids`), so the script must ASK the ORM rather than hardcode either.
  assert.match(script, /Users\._fields/, "the field name must be resolved from the ORM");
  assert.doesNotMatch(script, /group_system|group_user|group_portal|group_public/,
    "never a built-in group — those carry access we did not enumerate");
});

test("ensureOdooReadonlyUser refuses a login that is not a plain identifier", async () => {
  // It is interpolated into a Python literal, exactly like the password.
  const ssh = createFakeSshRunner({ respond: () => ({ code: 0, stdout: "", stderr: "" }) });
  await assert.rejects(
    () =>
      ensureOdooReadonlyUser(ssh, "acme-prod", "/opt/x/docker-compose.yml", "acme_prod",
        "front'); import os; os.system('x", "ro-pass-not-a-real-secret"),
    /lowercase/,
  );
  assert.equal(ssh.commands.length, 0, "refused before any ssh call");
});

// [code] Spec 0208. The defect this exists for is one I shipped and caught by
// hand: `ensureOdooReadonlyUser` was written, exported and unit-tested, and
// NOTHING CALLED IT. Every suite stayed green, because a function nobody calls
// breaks no test — and the front would have shipped credentials authenticating
// against a user that does not exist. This asserts the DEPLOY issues it.
test("deployProductionStack creates the read-only user, not just the admin password", async () => {
  const ssh = createHealthySshRunner();
  await deployProductionStack({
    tenantId: "acme",
    vpsId: 100001,
    ssh,
    odooVersion: 19,
    domain: "example.com",
    dbPassword: "s3cr3t-pass",
    masterPassword: "master-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    odooReadonlyUser: "front_readonly",
    odooReadonlyPassword: "ro-pass-not-a-real-secret",
  });
  const shellCalls = ssh.commands.filter((c) => c.includes("odoo shell"));
  assert.ok(
    shellCalls.some((c) => c.includes("ODOO_READONLY_USER_READY")),
    "the deploy must create the front's read-only user — removing the call leaves every other test green",
  );
  assert.ok(
    shellCalls.some((c) => c.includes("ADMIN_PASSWORD_SET")),
    "and still set the admin password (spec 0121)",
  );
});

// --- Spec 0226 D: the copy hook is opt-in, and fires only at creation --------

test("spec 0226 D: a production deploy never restores — the hook is absent, so the path is unchanged", async () => {
  const ssh = createHealthySshRunner();
  let restoreCalls = 0;
  await deployProductionStack({
    tenantId: "acme", vpsId: 100001, ssh, odooVersion: 18, domain: "example.com",
    dbPassword: "s3cr3t-pass", masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly", odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
  });
  assert.equal(restoreCalls, 0);
  // And the ordinary init DID run: the hook replaces it, it does not stack with it.
  assert.ok(
    ssh.commands.some((c) => c.includes("run --rm odoo") && c.includes(" -i ")),
    "an empty DB must still be initialised when no copy was asked for",
  );
});

test("spec 0226 D: with the hook, the copy REPLACES init and runs before `up -d`", async () => {
  const ssh = createHealthySshRunner();
  const order: string[] = [];
  await deployProductionStack({
    tenantId: "acme", vpsId: 100001, ssh, odooVersion: 18, domain: "example.com",
    dbPassword: "s3cr3t-pass", masterPassword: "master-not-a-real-secret",
    odooReadonlyUser: "front_readonly", odooReadonlyPassword: "ro-pass-not-a-real-secret",
    adminPassword: "admin-not-a-real-secret",
    restoreFromProduction: async () => { order.push("restore"); },
  });
  assert.deepEqual(order, ["restore"], "the hook ran exactly once");

  // The safety property, as an ORDERING over what actually reached the host:
  // `up -d db` happens, then the restore, then the full `up -d` that starts
  // odoo. Anything else means an un-neutralized copy was reachable.
  const upDb = ssh.commands.findIndex((c) => /up -d db\b/.test(c));
  const upAll = ssh.commands.findIndex((c) => /up -d$/.test(c.trim()));
  assert.ok(upDb >= 0 && upAll >= 0, "both compose steps must have run");
  assert.ok(upDb < upAll, "`up -d db` must precede the full `up -d`");

  // And the ordinary init must NOT also have run — a restored copy already has
  // everything, and installing `base` over it would be a second source of truth.
  assert.ok(
    !ssh.commands.some((c) => c.includes("run --rm odoo") && c.includes(" -i ")),
    "init must not run when production was copied",
  );
});

test("spec 0226 D: a hook that throws fails the deploy — a half-copy is never served", async () => {
  const ssh = createHealthySshRunner();
  await assert.rejects(
    () =>
      deployProductionStack({
        tenantId: "acme", vpsId: 100001, ssh, odooVersion: 18, domain: "example.com",
        dbPassword: "s3cr3t-pass", masterPassword: "master-not-a-real-secret",
        odooReadonlyUser: "front_readonly", odooReadonlyPassword: "ro-pass-not-a-real-secret",
        adminPassword: "admin-not-a-real-secret",
        restoreFromProduction: async () => { throw new Error("neutralization could not be proven"); },
      }),
    /neutralization could not be proven/,
  );
  // The decisive assertion: odoo was never started.
  assert.ok(
    !ssh.commands.some((c) => /up -d$/.test(c.trim())),
    "the full `up -d` must not run after a failed copy",
  );
});
