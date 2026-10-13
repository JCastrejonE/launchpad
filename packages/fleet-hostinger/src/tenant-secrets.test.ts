import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SecretStore } from "@launchpad/db";
import { FleetError } from "./errors.js";
import {
  TENANT_SECRETS_PATH_ENV,
  defaultTenantSecretsPath,
  ODOO_READONLY_LOGIN,
  readOrCreateDbPassword,
  readOrCreateOdooReadonlyCredentials,
  tenantDbPasswordSecretName,
  tenantOdooReadonlyPasswordSecretName,
  tenantOdooReadonlyUserSecretName,
  tenantSecretsPath,
} from "./tenant-secrets.js";
import { generateDbPassword } from "./stack.js";

// Spec 0014 (file store) re-based by spec 0076: the backend is the encrypted
// control-plane secret store; the JSON file is a READ-ONLY legacy import
// source. Tests inject an in-memory store fake — no Postgres needed.

function memoryStore(initial: Record<string, string> = {}): SecretStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: async (name) => map.get(name) ?? null,
    put: async (name, value) => {
      map.set(name, value);
    },
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "launchpad-tenant-secrets-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("secret names are per-tenant and stable", () => {
  assert.equal(tenantDbPasswordSecretName("acme"), "tenant/acme/db-password");
});

test("store hit returns the stored password without generating", async () => {
  const store = memoryStore({ "tenant/acme/db-password": "already-stored" });
  let calls = 0;
  const password = await readOrCreateDbPassword("acme", {
    store,
    path: "/nonexistent/legacy.json",
    generate: () => `fresh-${++calls}`,
  });
  assert.equal(password, "already-stored");
  assert.equal(calls, 0);
});

test("first call generates, persists to the STORE, and later calls reuse it", async () => {
  await withTempDir(async (dir) => {
    const store = memoryStore();
    let calls = 0;
    const generate = () => `secret-${++calls}`;
    const legacyPath = path.join(dir, "tenant-secrets.json");

    const first = await readOrCreateDbPassword("acme", { store, path: legacyPath, generate });
    const second = await readOrCreateDbPassword("acme", { store, path: legacyPath, generate });

    assert.equal(first, "secret-1");
    assert.equal(second, "secret-1");
    assert.equal(calls, 1);
    assert.equal(store.map.get("tenant/acme/db-password"), "secret-1");
    // 0076: the legacy file is NEVER written (the 0644 finding's write path
    // is gone).
    await assert.rejects(stat(legacyPath), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
  });
});

test("legacy-file hit is imported into the store, returned, and the file is left untouched", async () => {
  await withTempDir(async (dir) => {
    const legacyPath = path.join(dir, "tenant-secrets.json");
    const legacyJson = JSON.stringify({ acme: { dbPassword: "legacy-pass" } }, null, 2);
    await writeFile(legacyPath, legacyJson, "utf8");

    const store = memoryStore();
    const password = await readOrCreateDbPassword("acme", {
      store,
      path: legacyPath,
      generate: () => "never-called",
    });

    assert.equal(password, "legacy-pass");
    assert.equal(store.map.get("tenant/acme/db-password"), "legacy-pass", "one-way import into the store");
    assert.equal(await readFile(legacyPath, "utf8"), legacyJson, "legacy file byte-identical");
  });
});

test("distinct tenants get distinct passwords in the store", async () => {
  const store = memoryStore();
  let calls = 0;
  const generate = () => `secret-${++calls}`;
  const acme = await readOrCreateDbPassword("acme", { store, path: "/nonexistent.json", generate });
  const globex = await readOrCreateDbPassword("globex", { store, path: "/nonexistent.json", generate });
  assert.notEqual(acme, globex);
  assert.equal(store.map.size, 2);
});

test("a config-class store failure surfaces as a nonRetryable FleetError('config')", async () => {
  const { SecretConfigError } = await import("@launchpad/db");
  const store: SecretStore = {
    get: async () => {
      throw new SecretConfigError("LAUNCHPAD_SECRET_MASTER_KEY is not set");
    },
    put: async () => {},
  };
  await assert.rejects(
    readOrCreateDbPassword("acme", { store, path: "/nonexistent.json" }),
    (err: unknown) => err instanceof FleetError && err.kind === "config" && err.retryable === false,
  );
});

test(`tenantSecretsPath honors the ${TENANT_SECRETS_PATH_ENV} env override, else the ~/.launchpad default`, () => {
  const overridden = tenantSecretsPath({ [TENANT_SECRETS_PATH_ENV]: "/tmp/custom-secrets.json" });
  assert.equal(overridden, "/tmp/custom-secrets.json");

  const defaulted = tenantSecretsPath({ HOME: "/home/tester" });
  assert.equal(defaulted, defaultTenantSecretsPath({ HOME: "/home/tester" }));
  assert.equal(defaulted, path.join("/home/tester", ".launchpad", "tenant-secrets.json"));
});

// Spec 0134 QA (2026-08-05): a bare base64url password can START with `-`,
// which the odoo image's `wait-for-psql --db_password <value>` parses as a
// flag ("expected one argument") — the first branch-staging deploy died on a
// 1-in-64 draw. The generator now leads with a letter, always.
test("generateDbPassword can never produce a leading dash (CLI-flag safe)", () => {
  for (let i = 0; i < 200; i++) {
    const password = generateDbPassword();
    assert.match(password, /^[A-Za-z]/, password[0] ?? "(empty)");
    assert.ok(password.length >= 25);
  }
});

// ── spec 0208: the read-only Odoo credentials ────────────────────────────────

test("odoo read-only credentials are created once and returned unchanged after", async () => {
  // Same contract as the db password, and for a sharper reason: regenerating on
  // redeploy would leave the res.users row holding the OLD password and the
  // front unable to authenticate — with no error until someone loads the page.
  const store = memoryStore();
  let n = 0;
  const generate = () => `generated-${++n}`;
  const first = await readOrCreateOdooReadonlyCredentials("acme", { store, generate });
  const second = await readOrCreateOdooReadonlyCredentials("acme", { store, generate });

  assert.deepEqual(first, second);
  assert.equal(first.user, ODOO_READONLY_LOGIN);
  assert.equal(n, 1, "generated exactly once");
});

test("a half-written pair is regenerated, not returned broken", async () => {
  // A store write that failed between the two puts would otherwise hand back a
  // login with no password.
  const store = memoryStore();
  await store.put(tenantOdooReadonlyUserSecretName("acme"), ODOO_READONLY_LOGIN);
  const creds = await readOrCreateOdooReadonlyCredentials("acme", {
    store,
    generate: () => "fresh-pass",
  });
  assert.equal(creds.password, "fresh-pass");
  assert.equal(await store.get(tenantOdooReadonlyPasswordSecretName("acme")), "fresh-pass");
});

test("the credentials are stored under the tenant's own namespace", async () => {
  // `tenant/<slug>/<key>` — the convention the db password already uses, so one
  // tenant's secrets can never be read by a lookup for another.
  assert.equal(tenantOdooReadonlyUserSecretName("acme"), "tenant/acme/odoo-readonly-user");
  assert.equal(
    tenantOdooReadonlyPasswordSecretName("acme"),
    "tenant/acme/odoo-readonly-password",
  );
});
