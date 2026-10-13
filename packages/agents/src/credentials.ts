/**
 * Per-account agent credentials. Every account (the owner AND each client)
 * chooses one of two modes — both stored in that account's Vault namespace:
 *
 * - "subscription": Claude plan OAuth token (`claude setup-token`). Usage
 *   draws from THAT account holder's own plan limits. This is how the owner
 *   funds launchpad construction, and how clients can connect their own
 *   Team/Pro/Max plans individually.
 *   Constraints: per-user token (seats can't be pooled); pipelines stall when
 *   the plan's limits are exhausted until they reset.
 * - "api-key": Anthropic API key, pay-as-you-go on the account holder's own
 *   Console account. Recommended for heavy/production automation; also the
 *   fallback when a subscription account hits its limits.
 *
 * Policy verified 2026-07 (Anthropic Help Center): Agent SDK + third-party
 * apps authenticating with a Claude subscription draw from plan limits.
 */

import type { AgentRole } from "./session.js";
import { modelOverridesFromEnv } from "./models.js";

export type AgentCredential =
  | { mode: "subscription"; oauthToken: string }
  | { mode: "api-key"; apiKey: string };

export interface AccountLlmConfig {
  accountId: string; // "owner" or tenant id
  primary: AgentCredential;
  /** Optional fallback (e.g. api-key when subscription limits are hit). */
  fallback?: AgentCredential;
  /** Monthly budget cap in USD for api-key mode; enforced via Paperclip. */
  monthlyBudgetUsd?: number;
  /** Per-role model override; falls back to models.ts defaults when unset. */
  modelOverrides?: Partial<Record<AgentRole, string>>;
}

/** Env vars consumed by the Claude Agent SDK / headless Claude Code. */
export function credentialEnv(cred: AgentCredential): Record<string, string> {
  switch (cred.mode) {
    case "subscription":
      return { CLAUDE_CODE_OAUTH_TOKEN: cred.oauthToken };
    case "api-key":
      return { ANTHROPIC_API_KEY: cred.apiKey };
  }
}

/**
 * Vault paths: owner/llm or tenants/<id>/llm. Vault wiring lands with
 * apps/web account settings (phase 5). Until then: process-env fallback for
 * the owner account — CLAUDE_CODE_OAUTH_TOKEN (subscription) preferred,
 * ANTHROPIC_API_KEY as fallback.
 */
export async function loadCredential(accountId: string): Promise<AccountLlmConfig> {
  if (accountId !== "owner") {
    throw new Error(`TODO(phase-5): load LLM config for tenant ${accountId} from Vault`);
  }
  const oauth = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  const modelOverrides = modelOverridesFromEnv();
  if (oauth) {
    return {
      accountId,
      primary: { mode: "subscription", oauthToken: oauth },
      fallback: apiKey ? { mode: "api-key", apiKey } : undefined,
      modelOverrides,
    };
  }
  if (apiKey) return { accountId, primary: { mode: "api-key", apiKey }, modelOverrides };
  throw new Error(
    "No owner LLM credential: set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY",
  );
}
