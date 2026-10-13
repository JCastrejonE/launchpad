/**
 * Tenant secret access (spec 0014; re-based onto the encrypted control-plane
 * secret store in spec 0076). One `db-password` per tenant, read-or-create so
 * redeploys reuse the SAME password across process restarts.
 *
 * Backend order (0076):
 *   1. the AES-256-GCM `secrets` table (`@launchpad/db`, SPEC §13 — decrypted
 *      only in worker/host processes; agents never see the master key);
 *   2. the LEGACY pre-0076 JSON file (`~/.launchpad/tenant-secrets.json`,
 *      audit: world-readable 0644) — READ-ONLY: a hit is imported into the
 *      store and the file is never written again (the save path is deleted,
 *      which is what closes the 0644 finding). Delete the file once every
 *      tenant has redeployed;
 *   3. generate a fresh password and persist it to the store.
 *
 * Passwords are never logged. Config-class store failures (missing
 * LAUNCHPAD_SECRET_MASTER_KEY / DATABASE_URL) map to a nonRetryable
 * `FleetError("config")`; transient DB errors propagate as-is (Temporal
 * retries them).
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { envSecretStore, SecretConfigError, type SecretStore } from "@launchpad/db";
import { FleetError } from "./errors.js";
import { generateDbPassword } from "./stack.js";

/** Env var that overrides {@link defaultTenantSecretsPath} (absolute path). */
export const TENANT_SECRETS_PATH_ENV = "LAUNCHPAD_TENANT_SECRETS_PATH";

/** `~/.launchpad/tenant-secrets.json` — the LEGACY (pre-0076) file location,
 * still resolved for the one-way import fallback. */
export function defaultTenantSecretsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env.HOME ?? homedir();
  return path.join(home, ".launchpad", "tenant-secrets.json");
}

/** Resolves the legacy-file path: env override if set, else {@link defaultTenantSecretsPath}. */
export function tenantSecretsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[TENANT_SECRETS_PATH_ENV];
  return override && override.length > 0 ? override : defaultTenantSecretsPath(env);
}

/** Store name for a tenant's Postgres password. */
export function tenantDbPasswordSecretName(tenantId: string): string {
  return `tenant/${tenantId}/db-password`;
}

/** Spec 0208: login of the read-only Odoo user the tenant's own front reads
 *  with. Stored rather than derived so it can be rotated without a code change. */
export function tenantOdooReadonlyUserSecretName(tenantId: string): string {
  return `tenant/${tenantId}/odoo-readonly-user`;
}

/** Spec 0208: that user's password. */
export function tenantOdooReadonlyPasswordSecretName(tenantId: string): string {
  return `tenant/${tenantId}/odoo-readonly-password`;
}

/** The login every tenant's read-only front user gets. A constant, not the
 *  slug: it lives INSIDE that tenant's own database, where there is nothing to
 *  collide with, and a fixed name is one less thing to look up when debugging. */
export const ODOO_READONLY_LOGIN = "front_readonly";

/** Legacy on-disk shape: one record per tenant. Only `dbPassword` ever existed. */
export interface TenantSecretRecord {
  dbPassword: string;
}

type TenantSecretsFile = Record<string, TenantSecretRecord>;

export interface ReadOrCreateOptions {
  /** Overrides the LEGACY file path read as import fallback (tests use temp files). */
  path?: string;
  /** Injected in tests; defaults to {@link generateDbPassword}. */
  generate?: () => string;
  /** Injected in tests; defaults to the env-backed encrypted store. */
  store?: SecretStore;
}

/** Read the legacy JSON file; {} when absent. Read-only — 0076 deleted the
 * write path. */
async function loadLegacyFile(storePath: string): Promise<TenantSecretsFile> {
  try {
    const raw = await readFile(storePath, "utf8");
    return JSON.parse(raw) as TenantSecretsFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new FleetError(
      "config",
      `failed to read legacy tenant secrets file at ${storePath}`,
      { retryable: false, cause: err },
    );
  }
}

function asFleetConfigError(err: unknown): never {
  if (err instanceof SecretConfigError) {
    throw new FleetError("config", `tenant secret store is not configured: ${err.message}`, {
      retryable: false,
      cause: err,
    });
  }
  throw err;
}

/**
 * Returns the tenant's stored `dbPassword`, creating (and persisting) a new
 * one on first call so subsequent calls — including across process restarts
 * and redeploys — return the SAME value. Never logs the password.
 */
export async function readOrCreateDbPassword(
  tenantId: string,
  opts?: ReadOrCreateOptions,
): Promise<string> {
  const store = opts?.store ?? envSecretStore();
  const name = tenantDbPasswordSecretName(tenantId);

  const existing = await store.get(name).catch(asFleetConfigError);
  if (existing !== null) return existing;

  const legacyPath = opts?.path ?? tenantSecretsPath();
  const legacy = (await loadLegacyFile(legacyPath))[tenantId];
  if (legacy) {
    await store.put(name, legacy.dbPassword).catch(asFleetConfigError);
    return legacy.dbPassword;
  }

  const dbPassword = (opts?.generate ?? generateDbPassword)();
  await store.put(name, dbPassword).catch(asFleetConfigError);
  return dbPassword;
}

/** The read-only Odoo credentials a tenant's front authenticates with. */
export interface OdooReadonlyCredentials {
  user: string;
  password: string;
}

/**
 * Spec 0208: the tenant's read-only Odoo login, created on first call and
 * returned unchanged after — the same read-or-create contract as
 * {@link readOrCreateDbPassword}, and for the same reason: a redeploy that
 * generated a fresh password would leave the `res.users` row holding the old
 * one and the front unable to authenticate.
 *
 * Returns the credentials only. Creating the matching user INSIDE the tenant's
 * Odoo is `ensureOdooReadonlyUser` (stack.ts) — a password with no `res.users`
 * behind it is the half of this that would have shipped silently.
 */
export async function readOrCreateOdooReadonlyCredentials(
  tenantId: string,
  opts?: Pick<ReadOrCreateOptions, "store" | "generate">,
): Promise<OdooReadonlyCredentials> {
  const store = opts?.store ?? envSecretStore();
  const userName = tenantOdooReadonlyUserSecretName(tenantId);
  const passwordName = tenantOdooReadonlyPasswordSecretName(tenantId);

  const existingUser = await store.get(userName).catch(asFleetConfigError);
  const existingPassword = await store.get(passwordName).catch(asFleetConfigError);
  // BOTH or neither. A half-written pair (a store write that failed between the
  // two puts) would otherwise return a login with no password, or a password
  // for a login nobody created — regenerate instead of returning a broken pair.
  if (existingUser !== null && existingPassword !== null) {
    return { user: existingUser, password: existingPassword };
  }

  const password = (opts?.generate ?? generateDbPassword)();
  await store.put(userName, ODOO_READONLY_LOGIN).catch(asFleetConfigError);
  await store.put(passwordName, password).catch(asFleetConfigError);
  return { user: ODOO_READONLY_LOGIN, password };
}
