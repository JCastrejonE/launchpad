/**
 * Per-role model defaults (spec 0004). Model choice is an explicit,
 * per-role decision with sensible defaults, overridable per account (and
 * later per client, within their budget — Paperclip, phase 5).
 *
 * Rationale for the defaults:
 * - initializer: runs once per spec; its plan quality compounds downstream
 *   through every coder increment that follows. Pay the premium.
 * - coder: writes every increment, so spec 0103 puts it on the same premium
 *   model as the initializer/fixer at the owner's direction. This KNOWINGLY overrides
 *   the earlier rationale ("runs many times on small CI-verified increments —
 *   optimized for cost/quality at that grain"): the trade bought is fewer failed
 *   increments and fewer fixer rounds for roughly 5x the per-increment spend.
 *   Spec 0103 records the measured numbers from a real run.
 * - spec-drafter: the one drafting role (spec 0099 / G.1), on claude-fable-5 by
 *   the owner's choice (spec 0103). NOT a reversal of 0099: what §10.A called "theater"
 *   was the pin's JUSTIFICATION — the claim that pinning Fable is what made
 *   runArchitectSpawn's requested===echoed check meaningful. It never did, because
 *   that check reads the SDK's own `init` metadata and never the agent's prose.
 *   0099 turned the model into an overridable choice governing both drafting
 *   entry points; 0103 exercises that choice. The identity check still passes
 *   (the SDK echoes the requested alias verbatim — probed directly).
 *   This supersedes G.4's "drafting default mid-tier" suggestion in §10.E.
 * - fixer: runs once per trouble spot to diagnose + hotfix a failed/stalled
 *   coder attempt (spec 0018). Diagnosis quality — like the initializer's plan
 *   — compounds through the coder retry that follows, so it defaults to the
 *   initializer's premium model.
 *
 * Spec 0197: the four Opus roles move to `claude-opus-5`. Spec 0103's rule was
 * ONE Opus version across them and that rule is kept — the version it named had
 * fallen a generation behind, so every line the pipeline wrote was written by a
 * model older than the one the repo's own CLAUDE.md tells sessions to prefer.
 * Done BEFORE run 6: changing it between the two runs that decide the launch
 * would make them incomparable.
 */
import type { AgentRole } from "./session.js";

export const DEFAULT_MODEL_FOR_ROLE: Record<AgentRole, string> = {
  initializer: "claude-opus-5",
  // Spec 0103: the only code-writing role that was not already Opus.
  coder: "claude-opus-5",
  // Spec 0103 (the owner's choice), unchanged by 0197: the drafter is the one role the
  // repo deliberately does NOT put on Opus.
  "spec-drafter": "claude-fable-5",
  // Default = the initializer's model (spec 0018) — diagnosis compounds.
  fixer: "claude-opus-5",
  // The in-UI supervisor (spec 0049 / ADR-022) is the human's conversational
  // Opus co-pilot that spawns the drafting role (`spec-drafter` since spec 0099,
  // back on Fable as of 0103) — premium model, like the initializer/fixer,
  // since it steers the whole loop.
  supervisor: "claude-opus-5",
};

/** Dev-fallback env var read per role; see credentials.ts `loadCredential`. */
export const MODEL_ENV_VAR_FOR_ROLE: Record<AgentRole, string> = {
  initializer: "LAUNCHPAD_MODEL_INITIALIZER",
  coder: "LAUNCHPAD_MODEL_CODER",
  "spec-drafter": "LAUNCHPAD_MODEL_SPEC_DRAFTER",
  fixer: "LAUNCHPAD_MODEL_FIXER",
  supervisor: "LAUNCHPAD_MODEL_SUPERVISOR",
  // NOTE (spec 0099): `LAUNCHPAD_MODEL_ARCHITECT` is retired along with the
  // `architect` role — override the collapsed drafting role with
  // LAUNCHPAD_MODEL_SPEC_DRAFTER instead. It governs both entry points now.
  // NOTE (spec 0197): `LAUNCHPAD_MODEL_UIUX_CODER` is retired with the
  // `uiux-coder` role, which nothing could reach — no service, no cron, no
  // process — and which polished `apps/web`, not a customer's project.
};

/**
 * Resolve the model for a role: explicit account/env override wins, else the
 * documented default. `overrides` is `AccountLlmConfig.modelOverrides`.
 */
export function modelForRole(role: AgentRole, overrides?: Partial<Record<AgentRole, string>>): string {
  return overrides?.[role] ?? DEFAULT_MODEL_FOR_ROLE[role];
}

/**
 * Model for `[docs]`-tagged plan items (spec 0007). Pure-docs coder increments
 * (README notes, spec text, comments) don't need the coder default's reasoning
 * budget, so they run on a cheaper/faster model — session startup dominates
 * their wall-clock anyway. Spec 0103 left this alone on purpose: docs are not
 * code, and moving the coder to Opus makes routing them cheaply MORE valuable,
 * not less.
 */
export const DOCS_MODEL = "claude-haiku-4-5-20251001";

/**
 * Resolve the model for a single coder increment from its plan-item tag
 * (spec 0007): `[docs]` items run on DOCS_MODEL, everything else on the coder
 * default (honoring any account/env override for the coder role).
 */
export function modelForCoderItem(
  tag: "docs" | "code",
  overrides?: Partial<Record<AgentRole, string>>,
): string {
  return tag === "docs" ? DOCS_MODEL : modelForRole("coder", overrides);
}

/**
 * Build a modelOverrides map from `LAUNCHPAD_MODEL_*` env vars, for the dev
 * fallback path in `loadCredential`. Only roles with a set env var appear.
 */
export function modelOverridesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<Record<AgentRole, string>> {
  const overrides: Partial<Record<AgentRole, string>> = {};
  for (const role of Object.keys(MODEL_ENV_VAR_FOR_ROLE) as AgentRole[]) {
    const value = env[MODEL_ENV_VAR_FOR_ROLE[role]];
    if (value) overrides[role] = value;
  }
  return overrides;
}
