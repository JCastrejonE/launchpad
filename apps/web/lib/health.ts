/**
 * apps/web self-check (spec 0018 item 6). preflight polls `/api/health` to
 * decide when the dev server is ready and to warn on a degraded Temporal
 * connection (item 7); web-smoke (spec 0020) hits it too. Two independent
 * checks, ONE of which can fail the HTTP status:
 *
 *  - env: required web env (lib/env.ts) is present. A misconfigured server
 *    silently 500s on real pages (spec 0007) — this check makes that loud
 *    and fast: 503 so web-smoke and preflight can't miss it.
 *  - temporal: whether the pipeline's Temporal server currently answers.
 *    This is informational only — a Temporal-less sandbox is a normal,
 *    supported state (spec 0020's Handoff log), so it's reported in the
 *    body and NEVER changes the HTTP status code.
 *
 * Pure — the Temporal probe is injected — so this is unit-testable without a
 * real Temporal connection. `app/api/health/route.ts` supplies the real
 * probe (an actual `Connection.connect` with a short timeout).
 */

import { validateWebEnv } from "./env";

export interface HealthChecks {
  env: boolean;
  temporal: boolean;
}

export interface HealthResult {
  ok: boolean;
  checks: HealthChecks;
}

/**
 * Compute the health body. `env` defaults to `process.env`; `probeTemporal`
 * defaults to reporting "unreachable" (route.ts overrides it with a real
 * probe). `ok` mirrors the env check only — Temporal reachability never
 * affects `ok` (or, via `healthStatus`, the HTTP status code).
 */
export async function computeHealth(
  env: Record<string, string | undefined> = process.env,
  probeTemporal: () => Promise<boolean> = async () => false,
): Promise<HealthResult> {
  const envOk = validateWebEnv(env).ok;
  const temporalOk = await probeTemporal();
  return { ok: envOk, checks: { env: envOk, temporal: temporalOk } };
}

/**
 * HTTP status the route should respond with for a given health result — 503
 * ONLY on env failure; Temporal reachability never changes it (see module
 * doc / spec 0018 item 6 acceptance criteria).
 */
export function healthStatus(result: HealthResult): number {
  return result.checks.env ? 200 : 503;
}
