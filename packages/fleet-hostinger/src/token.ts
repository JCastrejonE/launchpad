/**
 * Multi-account Hostinger token resolution (spec 0012). `HostingerClient` takes
 * one token per instance; the fleet needs to pick the right token for a given
 * tenant. This is the thin account-resolution layer above the client.
 *
 * Resolution order (dev / env today):
 *  1. `HOSTINGER_API_TOKEN__<TENANT>` — per-tenant override (tenant id upper-cased,
 *     non-alphanumerics → `_`, matching {@link tenantTokenEnvVar}).
 *  2. `HOSTINGER_API_TOKEN` — the shared dev token.
 *
 * Phase-5 (documented, NOT wired here): the production path is Vault
 * `tenants/<id>/hostinger`, loaded the same way `loadCredential` will read the
 * per-tenant LLM config. Until Vault lands, tenant resolution falls back to env.
 *
 * The token is a secret: it must never be logged or placed in an error message,
 * and the env-scrub denylist (packages/agents/src/env-scrub.ts) drops BOTH the
 * shared `HOSTINGER_API_TOKEN` and every `HOSTINGER_API_TOKEN__*` per-tenant
 * variant before any agent session sees the environment.
 */

/** Prefix shared by every per-tenant token override var (mirrors the scrubber). */
export const TENANT_TOKEN_ENV_PREFIX = "HOSTINGER_API_TOKEN__";

/** Shared dev token env var (owner / default account). */
export const SHARED_TOKEN_ENV = "HOSTINGER_API_TOKEN";

/**
 * Env var name holding `tenantId`'s per-tenant token override, e.g.
 * `acme` → `HOSTINGER_API_TOKEN__ACME`.
 */
export function tenantTokenEnvVar(tenantId: string): string {
  const normalized = tenantId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `${TENANT_TOKEN_ENV_PREFIX}${normalized}`;
}

/**
 * Resolves the Hostinger API token for `tenantId` from the environment (dev
 * path). Throws if neither the per-tenant override nor the shared token is set.
 * The thrown message names only the env vars checked — never any token value.
 */
export function resolveHostingerToken(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const tenantVar = tenantTokenEnvVar(tenantId);
  const tenantToken = env[tenantVar];
  if (tenantToken) return tenantToken;

  const sharedToken = env[SHARED_TOKEN_ENV];
  if (sharedToken) return sharedToken;

  throw new Error(
    `Hostinger token not found: set ${tenantVar} or ${SHARED_TOKEN_ENV}`,
  );
}
