import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubAgentEnv, isAgentEnvAllowed } from "./env-scrub.js";
import { credentialEnv } from "./credentials.js";

// spec 0069 / SPEC-ALIGNMENT §3 A.1: env-scrub is an ALLOWLIST. Only
// infra-neutral vars pass; every secret (current or future) is dropped by
// default. The LLM credential vars are NOT allowlisted — credentialEnv overlays
// the selected one.

test("scrubAgentEnv passes allowlisted infra vars through unchanged", () => {
  const out = scrubAgentEnv({
    PATH: "/usr/bin:/bin",
    HOME: "/home/agent",
    LANG: "en_US.UTF-8",
    TMPDIR: "/tmp",
    HTTPS_PROXY: "http://proxy:8080",
  });
  assert.equal(out["PATH"], "/usr/bin:/bin");
  assert.equal(out["HOME"], "/home/agent");
  assert.equal(out["LANG"], "en_US.UTF-8");
  assert.equal(out["TMPDIR"], "/tmp");
  assert.equal(out["HTTPS_PROXY"], "http://proxy:8080");
});

test("scrubAgentEnv passes allowlisted prefixes (LC_*, XDG_*) through", () => {
  const out = scrubAgentEnv({
    LC_ALL: "C",
    XDG_CONFIG_HOME: "/home/agent/.config",
    PATH: "/usr/bin",
  });
  assert.equal(out["LC_ALL"], "C");
  assert.equal(out["XDG_CONFIG_HOME"], "/home/agent/.config");
});

test("scrubAgentEnv drops secrets that were never on any denylist (the fail-open bug)", () => {
  const out = scrubAgentEnv({
    DATABASE_URL: "postgres://u:p@host/db",
    LAUNCHPAD_FLEET_SSH_IDENTITY: "/home/agent/.ssh/fleet_key",
    AWS_SECRET_ACCESS_KEY: "aws-secret", // note: only S3_ was denied before
    SOME_FUTURE_TOKEN: "leaked-by-default-under-a-denylist",
    STRIPE_SECRET_KEY: "sk_live_xxx",
    PATH: "/usr/bin",
  });
  assert.equal("DATABASE_URL" in out, false);
  assert.equal("LAUNCHPAD_FLEET_SSH_IDENTITY" in out, false);
  assert.equal("AWS_SECRET_ACCESS_KEY" in out, false);
  assert.equal("SOME_FUTURE_TOKEN" in out, false);
  assert.equal("STRIPE_SECRET_KEY" in out, false);
  assert.equal(out["PATH"], "/usr/bin"); // infra still passes
});

test("scrubAgentEnv still drops the originally-denylisted infra secrets", () => {
  const out = scrubAgentEnv({
    HOSTINGER_API_TOKEN: "secret",
    HOSTINGER_API_TOKEN__ACME: "tenant-secret",
    VAULT_TOKEN: "vault-secret",
    S3_SECRET_KEY: "s3-secret",
    GITHUB_TOKEN: "gh-secret",
    PATH: "/usr/bin",
  });
  for (const k of [
    "HOSTINGER_API_TOKEN",
    "HOSTINGER_API_TOKEN__ACME",
    "VAULT_TOKEN",
    "S3_SECRET_KEY",
    "GITHUB_TOKEN",
  ]) {
    assert.equal(k in out, false, `${k} must be dropped`);
  }
});

test("scrubAgentEnv drops BOTH LLM credential vars (they come from credentialEnv, not here)", () => {
  const out = scrubAgentEnv({
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-host",
    ANTHROPIC_API_KEY: "sk-host",
    PATH: "/usr/bin",
  });
  assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in out, false);
  assert.equal("ANTHROPIC_API_KEY" in out, false);
});

test("composition carries ONLY the selected credential — the non-selected host token does not ride along", () => {
  // Host has BOTH credentials set (the cross-credential-leak scenario). The
  // session is built for api-key mode; it must NOT inherit the host OAuth token.
  const host = {
    CLAUDE_CODE_OAUTH_TOKEN: "owner-oauth-token",
    ANTHROPIC_API_KEY: "host-api-key",
    PATH: "/usr/bin",
  };
  const composed = {
    ...scrubAgentEnv(host),
    ...credentialEnv({ mode: "api-key", apiKey: "the-tenant-key" }),
  };
  assert.equal(composed["ANTHROPIC_API_KEY"], "the-tenant-key");
  assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in composed, false);
  assert.equal(composed["PATH"], "/usr/bin");
});

test("scrubAgentEnv drops undefined values", () => {
  const out = scrubAgentEnv({ PATH: "/usr/bin", MISSING: undefined });
  assert.equal(out["PATH"], "/usr/bin");
  assert.equal("MISSING" in out, false);
});

test("isAgentEnvAllowed: exact names and prefixes allowed; secrets and LLM tokens not", () => {
  assert.equal(isAgentEnvAllowed("PATH"), true);
  assert.equal(isAgentEnvAllowed("HOME"), true);
  assert.equal(isAgentEnvAllowed("LC_ALL"), true);
  assert.equal(isAgentEnvAllowed("XDG_CACHE_HOME"), true);
  assert.equal(isAgentEnvAllowed("ANTHROPIC_BASE_URL"), true);
  assert.equal(isAgentEnvAllowed("DATABASE_URL"), false);
  assert.equal(isAgentEnvAllowed("CLAUDE_CODE_OAUTH_TOKEN"), false);
  assert.equal(isAgentEnvAllowed("ANTHROPIC_API_KEY"), false);
  assert.equal(isAgentEnvAllowed("LAUNCHPAD_FLEET_SSH_IDENTITY"), false);
});
