import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetError, type SshRunner } from "@launchpad/fleet-hostinger";
import {
  classifyVps,
  indexDeployingSpecsByHost,
  getHostInventorySafe,
  getProjectStackLogsSafe,
  FLEET_SSH_IDENTITY_ENV,
  type FleetVps,
  type GetHostInventoryDeps,
  type GetProjectStackLogsDeps,
} from "./fleet.js";

const SANDBOX_VPS: FleetVps = {
  id: 100001,
  hostname: "sandbox.example",
  state: "running",
  plan: "plan",
  ipv4: "203.0.113.10",
  classification: "sandbox",
};

const PRODUCTION_VPS: FleetVps = { ...SANDBOX_VPS, id: 100002, classification: "production" };

// spec 0022: the sandbox-vs-production badge derives purely from the ADR-013
// allowlist. 100001 is the real sandbox id; 100002 is production
// (erp.example.com) — both hard-coded in infra/fleet-sandbox.json's comment.
test("classifyVps: an allowlisted id is sandbox", () => {
  assert.equal(classifyVps(100001, [100001]), "sandbox");
});

test("classifyVps: a non-allowlisted id is production (blast-radius protected)", () => {
  assert.equal(classifyVps(100002, [100001]), "production");
});

test("classifyVps: empty allowlist means everything is production", () => {
  assert.equal(classifyVps(100001, []), "production");
});

test("classifyVps: multiple sandbox ids", () => {
  assert.equal(classifyVps(222, [111, 222, 333]), "sandbox");
  assert.equal(classifyVps(999, [111, 222, 333]), "production");
});

// Spec 0033 Scope A — a RUNNING deploy is located to its host id so the card
// can link to the deploying spec.
test("indexDeployingSpecsByHost: maps a running deploy to its host id", () => {
  const byHost = indexDeployingSpecsByHost([{ specId: "0030", vpsId: 100001 }]);
  assert.deepEqual(byHost.get(100001), ["0030"]);
});

test("indexDeployingSpecsByHost: zero running deploys ⇒ empty map (no link)", () => {
  assert.equal(indexDeployingSpecsByHost([]).size, 0);
});

test("indexDeployingSpecsByHost: a launchpad run (no vpsId) targets no host", () => {
  const byHost = indexDeployingSpecsByHost([{ specId: "0033" }]);
  assert.equal(byHost.size, 0);
});

test("indexDeployingSpecsByHost: multiple deploys into one host both link", () => {
  const byHost = indexDeployingSpecsByHost([
    { specId: "0030", vpsId: 100001 },
    { specId: "0031", vpsId: 100001 },
  ]);
  assert.deepEqual(byHost.get(100001), ["0030", "0031"]);
});

// Spec 0033 Scope B — live tenants + DBs per host, never SSH'd for
// production, never crashes on a missing identity / SSH failure.
test("getHostInventorySafe: production host is never SSH'd, no deps needed", async () => {
  const deps: GetHostInventoryDeps = {
    env: {},
    createSshRunner: () => {
      throw new Error("must never be called for a production host");
    },
    listTenantStacks: async () => {
      throw new Error("must never be called for a production host");
    },
  };
  const result = await getHostInventorySafe(PRODUCTION_VPS, deps);
  assert.deepEqual(result, { available: false, reason: "production" });
});

test("getHostInventorySafe: sandbox host with no SSH identity degrades to unavailable", async () => {
  const deps: GetHostInventoryDeps = {
    env: {}, // FLEET_SSH_IDENTITY_ENV unset
    createSshRunner: () => {
      throw new Error("must never be called without an SSH identity");
    },
    listTenantStacks: async () => {
      throw new Error("must never be called without an SSH identity");
    },
  };
  const result = await getHostInventorySafe(SANDBOX_VPS, deps);
  assert.deepEqual(result, { available: false, reason: "unavailable" });
});

test("getHostInventorySafe: sandbox host with no IPv4 degrades to unavailable", async () => {
  const deps: GetHostInventoryDeps = {
    env: { [FLEET_SSH_IDENTITY_ENV]: "/tmp/key" },
    createSshRunner: () => {
      throw new Error("must never be called without an IPv4");
    },
    listTenantStacks: async () => {
      throw new Error("must never be called without an IPv4");
    },
  };
  const result = await getHostInventorySafe({ ...SANDBOX_VPS, ipv4: null }, deps);
  assert.deepEqual(result, { available: false, reason: "unavailable" });
});

test("getHostInventorySafe: sandbox happy path returns the live stacks", async () => {
  const fakeRunner = { exec: async () => ({ code: 0, stdout: "", stderr: "" }), writeFile: async () => {} };
  const deps: GetHostInventoryDeps = {
    env: { [FLEET_SSH_IDENTITY_ENV]: "/tmp/key" },
    createSshRunner: (target) => {
      assert.equal(target.host, SANDBOX_VPS.ipv4);
      assert.equal(target.identityFile, "/tmp/key");
      assert.equal(target.user, "root"); // default, FLEET_SSH_USER_ENV unset
      return fakeRunner;
    },
    listTenantStacks: async (runner, vpsId) => {
      assert.equal(runner, fakeRunner);
      assert.equal(vpsId, SANDBOX_VPS.id);
      return [{ tenant: "prod", dbs: ["sandbox_prod"], status: "running" }];
    },
  };
  const result = await getHostInventorySafe(SANDBOX_VPS, deps);
  assert.deepEqual(result, {
    available: true,
    stacks: [{ tenant: "prod", dbs: ["sandbox_prod"], status: "running" }],
  });
});

test("getHostInventorySafe: an SSH/inventory failure degrades to unavailable, never throws", async () => {
  const deps: GetHostInventoryDeps = {
    env: { [FLEET_SSH_IDENTITY_ENV]: "/tmp/key" },
    createSshRunner: () => ({
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      writeFile: async () => {},
    }),
    listTenantStacks: async () => {
      throw new Error("ssh timed out");
    },
  };
  const result = await getHostInventorySafe(SANDBOX_VPS, deps);
  assert.deepEqual(result, { available: false, reason: "unavailable" });
});

// Spec 0214 Parte B — the Logs panel's read. The point of these is that the
// three outcomes stay distinguishable: lines, "the read failed", and "there is
// no stack here (and why)".
const FAKE_RUNNER: SshRunner = {
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  writeFile: async () => {},
};

function logsDeps(over: Partial<GetProjectStackLogsDeps>): GetProjectStackLogsDeps {
  return {
    getFleet: async () => ({ available: true, vps: [SANDBOX_VPS] }),
    getHostInventory: async () => ({
      available: true,
      stacks: [
        {
          tenant: "acme-prod",
          identity: { tenantId: "acme", stack: "prod", kind: "tenant" },
          dbs: [],
          status: "running",
        },
      ],
    }),
    createRunner: () => FAKE_RUNNER,
    readStackLogs: async () => ({ project: "acme-prod", lines: [], truncated: false }),
    ...over,
  };
}

test("getProjectStackLogsSafe: the stack's lines are what comes back (spec 0214, criterion 2)", async () => {
  const result = await getProjectStackLogsSafe(
    "acme",
    logsDeps({
      readStackLogs: async (runner, vpsId, composeProject) => {
        assert.equal(runner, FAKE_RUNNER);
        assert.equal(vpsId, SANDBOX_VPS.id);
        // The compose project NAME the inventory reported, never a directory.
        assert.equal(composeProject, "acme-prod");
        return {
          project: "acme-prod",
          lines: ["odoo-1  | 2026-08-18T14:00:00Z listo", "db-1  | 2026-08-18T14:00:01Z ready"],
          truncated: true,
        };
      },
    }),
  );
  assert.equal(result.state, "read");
  if (result.state !== "read") return;
  assert.match(result.readAt, /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(result.tail, 200);
  assert.deepEqual(result.entries, [
    {
      project: "acme-prod",
      state: "lines",
      lines: ["odoo-1  | 2026-08-18T14:00:00Z listo", "db-1  | 2026-08-18T14:00:01Z ready"],
      truncated: true,
    },
  ]);
});

test("getProjectStackLogsSafe: a failed read is an ERROR entry, never an empty screen", async () => {
  const result = await getProjectStackLogsSafe(
    "acme",
    logsDeps({
      readStackLogs: async () => {
        throw new FleetError("docker", "docker compose logs failed for acme-prod on VPS 100001 (exit 1): no such service", { retryable: true });
      },
    }),
  );
  // NOT "none": the stack was located, so "no lo pudimos leer" is the answer.
  assert.equal(result.state, "read");
  if (result.state !== "read") return;
  assert.equal(result.entries.length, 1);
  const entry = result.entries[0]!;
  assert.equal(entry.state, "error");
  if (entry.state !== "error") return;
  assert.match(entry.message, /no such service/);
});

test("getProjectStackLogsSafe: a production host is never read — zero exec, and ADR-013 is the stated reason (criterion 4)", async () => {
  const result = await getProjectStackLogsSafe(
    "acme",
    logsDeps({
      getFleet: async () => ({ available: true, vps: [PRODUCTION_VPS] }),
      getHostInventory: async () => ({ available: false, reason: "production" }),
      createRunner: () => {
        throw new Error("must never build a runner for a production host");
      },
      readStackLogs: async () => {
        throw new Error("must never exec against a production host");
      },
    }),
  );
  assert.equal(result.state, "none");
  if (result.state !== "none") return;
  assert.match(result.reason, /ADR-013/);
});

test("getProjectStackLogsSafe: a readable host with no stack of this project says so, differently", async () => {
  const result = await getProjectStackLogsSafe(
    "acme",
    logsDeps({
      getHostInventory: async () => ({ available: true, stacks: [] }),
      createRunner: () => {
        throw new Error("must never build a runner when there is nothing to read");
      },
    }),
  );
  assert.equal(result.state, "none");
  if (result.state !== "none") return;
  assert.doesNotMatch(result.reason, /ADR-013/);
  assert.match(result.reason, /No se encontró ningún stack/);
});

test("getProjectStackLogsSafe: a located stack with no SSH identity is an error, not a missing stack", async () => {
  const result = await getProjectStackLogsSafe("acme", logsDeps({ createRunner: () => null }));
  assert.equal(result.state, "read");
  if (result.state !== "read") return;
  assert.equal(result.entries[0]!.state, "error");
});

test("getProjectStackLogsSafe: an unavailable fleet never throws and never claims there is no stack", async () => {
  const result = await getProjectStackLogsSafe(
    "acme",
    logsDeps({ getFleet: async () => ({ available: false, reason: "Hostinger token not set" }) }),
  );
  assert.equal(result.state, "none");
  if (result.state !== "none") return;
  assert.match(result.reason, /inventario de la flotilla/);
});
