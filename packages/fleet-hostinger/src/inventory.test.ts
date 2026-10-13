import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRouterHostRule, parseStackIdentity, listTenantStacks } from "./inventory.js";
import { createFakeSshRunner } from "./ssh.js";
import { FleetError } from "./errors.js";

// Spec 0033 Scope B — read-only Odoo-stack inventory, ADR-013-guarded.
// The real allowlist (infra/fleet-sandbox.json) allowlists 100001 (sandbox)
// and NOT 999999 (any id absent from the allowlist).
// The refused example is a SYNTHETIC id (999999) that is not, and will never be, in
// infra/fleet-sandbox.json. Spec 0125 is why: it briefly allowlisted a real id, which would
// have made this guard's own tests pass while proving nothing. Keying them to an id nobody
// can allowlist means an edit to that file can never quietly turn these green.

const SANDBOX_VPS_ID = 100001;
const UNLISTED_VPS_ID = 999999;

test("listTenantStacks refuses a production host WITHOUT SSHing it (ADR-013)", async () => {
  const runner = createFakeSshRunner();
  await assert.rejects(
    () => listTenantStacks(runner, UNLISTED_VPS_ID),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "sandbox");
      return true;
    },
  );
  // The guard runs BEFORE any command — a refused host is never SSH'd.
  assert.equal(runner.commands.length, 0);
  assert.equal(runner.files.size, 0);
});

const ACME_CONFIG_FILE = "/opt/launchpad/acme/prod/docker-compose.yml";

test("listTenantStacks enumerates deployed stacks + their DBs, filtering system DBs and unrelated projects", async () => {
  const runner = createFakeSshRunner({
    respond: (command) => {
      if (command === "docker compose ls --all --format json") {
        return {
          code: 0,
          stdout: JSON.stringify([
            { Name: "prod", Status: "running(2)", ConfigFiles: ACME_CONFIG_FILE },
            // Not one of ours (config file outside /opt/launchpad) — must be filtered out
            // and never queried for DBs.
            { Name: "unrelated", Status: "running(1)", ConfigFiles: "/etc/other/docker-compose.yml" },
          ]),
          stderr: "",
        };
      }
      if (command.includes(`docker compose -f ${ACME_CONFIG_FILE} exec -T db psql`)) {
        // Postgres system DBs would already be excluded by the query's own WHERE
        // clause; include one anyway to prove the client-side filter is real too.
        return { code: 0, stdout: "acme_prod\ntemplate1\n\n", stderr: "" };
      }
      return undefined;
    },
  });

  const stacks = await listTenantStacks(runner, SANDBOX_VPS_ID);

  // Spec 0121: `identity` is parsed from the config PATH, which is unambiguous —
  // the compose project name ("prod") cannot say which tenant it belongs to.
  assert.deepEqual(stacks, [
    { tenant: "prod", identity: { tenantId: "acme", stack: "prod", kind: "tenant" as const }, dbs: ["acme_prod"], status: "running" },
  ]);
  // Read-only: only inspection commands ever ran, never a mutating one, and the
  // unrelated project's config file was never queried for DBs.
  assert.deepEqual(runner.commands, [
    "docker compose ls --all --format json",
    `docker compose -f ${ACME_CONFIG_FILE} exec -T db psql -U odoo -d postgres -tAc ` +
      `"SELECT datname FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1')"`,
    // Spec 0121: reads the host the stack is ACTUALLY routing on. A `grep`, so it
    // stays within this function's read-only contract.
    `grep -m1 'routers\\..*\\.rule=Host' ${ACME_CONFIG_FILE} || true`,
  ]);
  assert.equal(runner.files.size, 0);
});

test("listTenantStacks reports a stopped stack with no DBs rather than throwing (db container not up)", async () => {
  const runner = createFakeSshRunner({
    respond: (command) => {
      if (command === "docker compose ls --all --format json") {
        return {
          code: 0,
          stdout: JSON.stringify([
            { Name: "prod", Status: "exited(2)", ConfigFiles: ACME_CONFIG_FILE },
          ]),
          stderr: "",
        };
      }
      if (command.includes("psql")) {
        return { code: 1, stdout: "", stderr: "container not running" };
      }
      return undefined;
    },
  });

  const stacks = await listTenantStacks(runner, SANDBOX_VPS_ID);
  assert.deepEqual(stacks, [
    { tenant: "prod", identity: { tenantId: "acme", stack: "prod", kind: "tenant" as const }, dbs: [], status: "stopped" },
  ]);
});

test("listTenantStacks throws a retryable FleetError when `docker compose ls` itself fails", async () => {
  const runner = createFakeSshRunner({
    respond: (command) =>
      command === "docker compose ls --all --format json"
        ? { code: 1, stdout: "", stderr: "docker: command not found" }
        : undefined,
  });

  await assert.rejects(
    () => listTenantStacks(runner, SANDBOX_VPS_ID),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "docker");
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

// --- spec 0121: the host a stack actually routes on -------------------------

test("parseRouterHostRule extracts the host from a Traefik rule label", () => {
  const compose = [
    "      - traefik.enable=true",
    "      - traefik.http.routers.acme-prod.rule=Host(`prod.acme.example.com`)",
    "      - traefik.http.routers.acme-prod.tls=true",
  ].join("\n");
  assert.equal(parseRouterHostRule(compose), "prod.acme.example.com");
});

test("parseRouterHostRule yields undefined rather than guessing when there is no rule", () => {
  // The caller then shows no URL — better than a hostname nobody answers on.
  assert.equal(parseRouterHostRule("services:\n  odoo:\n    image: odoo:18\n"), undefined);
  assert.equal(parseRouterHostRule(""), undefined);
});

test("parseStackIdentity splits tenant and stack from the PATH, including the ambiguous case", () => {
  // `acme-staging-prod` as a compose project name could be tenant `acme-staging` +
  // stack `prod`, or tenant `acme` + stack `staging-prod`. The path is not ambiguous.
  assert.deepEqual(parseStackIdentity("/opt/launchpad/acme-staging/prod/docker-compose.yml"), {
    tenantId: "acme-staging",
    stack: "prod",
    kind: "tenant",
  });
  assert.deepEqual(parseStackIdentity("/opt/launchpad/sandbox/spec-0120/docker-compose.yml"), {
    tenantId: "sandbox",
    stack: "spec-0120",
    kind: "staging",
  });
});

test("parseStackIdentity refuses paths outside the deploy layout", () => {
  for (const bad of [
    undefined,
    "",
    "/etc/other/docker-compose.yml",
    "/opt/launchpad/only-one-level.yml",
    "/opt/launchpad/a/b/c/docker-compose.yml",
  ]) {
    assert.equal(parseStackIdentity(bad), undefined, String(bad));
  }
});

// --- spec 0198 B: the inventory reads stacks in parallel --------------------
//
// This loop was sequential and every `exec` is a fresh `ssh` (~0.9 s measured,
// no multiplexing): 21 stacks meant 43 round trips, ~40 s, awaited by the Ramas
// & builds page BEFORE it rendered anything — which is why the tab read as a
// dead link. The fix must keep the output identical and stay under sshd's
// MaxStartups.

test("listTenantStacks reads stacks concurrently, bounded, and preserves order", async () => {
  const names = Array.from({ length: 12 }, (_, i) => `tenant${i}`);
  const ls = names.map((n) => ({
    Name: n,
    Status: "running(2)",
    ConfigFiles: `/opt/launchpad/${n}/prod/docker-compose.yml`,
  }));
  let inFlight = 0;
  let peak = 0;
  const runner = {
    async exec(command: string) {
      if (command.includes("compose ls")) {
        return { code: 0, stdout: JSON.stringify(ls), stderr: "" };
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      if (command.includes("psql")) return { code: 0, stdout: "odoo_db\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    async writeFile() {},
  };

  const stacks = await listTenantStacks(runner as never, SANDBOX_VPS_ID);
  assert.deepEqual(
    stacks.map((s) => s.tenant),
    names,
    "order must survive the parallelism — callers and the UI depend on it",
  );
  // > 2, not > 1: even a SEQUENTIAL worker has both of one stack's reads in
  // flight at once (they are a `Promise.all` pair), so `peak > 1` passes with
  // CONCURRENCY = 1 and proves nothing. More than two means more than one STACK
  // is being read — which is the property this exists for. Verified by setting
  // CONCURRENCY to 1 and watching this line go red.
  assert.ok(peak > 2, `only one stack in flight (peak ${peak}) — still sequential per stack`);
  assert.ok(peak <= 12, `unbounded fan-out (peak ${peak}) walks into sshd MaxStartups`);
});
