/**
 * apps/web required-env validation (spec 0007). A dev server started without
 * .env was found live to return bare 500s and silently lose a "Start a
 * change" submission. This module names the env the web layer needs and lets
 * pages/actions render an explicit configuration-error panel instead of a
 * generic server exception.
 *
 * Pure — takes an env record, returns the list of missing vars — so it's
 * unit-testable without touching process.env. The panel/wiring lives in the
 * pages and server actions (spec 0007 item 5).
 */

/** Env vars apps/web needs to drive the pipeline. LAUNCHPAD_REPO_ROOT +
 * TEMPORAL_ADDRESS reach the worker/Temporal; AUTH_SECRET signs the Auth.js
 * session JWT (spec 0073) — missing it must surface as this config panel,
 * not a runtime 500 on first auth(). GATE_ACTOR_EMAIL is GONE (spec 0074):
 * every web actor is now the verified session email. */
export const REQUIRED_WEB_ENV = [
  "LAUNCHPAD_REPO_ROOT",
  "TEMPORAL_ADDRESS",
  "AUTH_SECRET",
] as const;

export type RequiredWebEnvVar = (typeof REQUIRED_WEB_ENV)[number];

export interface WebEnvValidation {
  ok: boolean;
  /** Names of required vars that are missing or blank. */
  missing: RequiredWebEnvVar[];
}

/**
 * Report which required web env vars are missing/blank.
 */
export function validateWebEnv(
  env: Record<string, string | undefined> = process.env,
): WebEnvValidation {
  const missing = REQUIRED_WEB_ENV.filter((name) => !env[name]?.trim());
  return { ok: missing.length === 0, missing };
}

/** Env var(s) apps/web needs ONLY when a spec's gate 2 is a real GitHub PR
 * (spec 0015 item 8) — it builds its own `GithubClient` (same PAT as the
 * pipeline worker) to fetch live check/review state for the PR link. Kept
 * out of `REQUIRED_WEB_ENV`/`validateWebEnv` on purpose: most specs may still
 * be running local-diff (no GitHub origin configured yet), and gating the
 * *entire* app on a var that's only needed per-spec, once PR mode is active,
 * would block pages that never touch GitHub at all. */
export const PR_MODE_WEB_ENV = ["GITHUB_TOKEN"] as const;

export type PrModeWebEnvVar = (typeof PR_MODE_WEB_ENV)[number];

export interface PrModeEnvValidation {
  ok: boolean;
  /** Names of PR-mode-only vars that are missing/blank. */
  missing: PrModeWebEnvVar[];
}

/**
 * Report which PR-mode-only env vars are missing/blank. Callers check this
 * only once they already know a spec's gate 2 is a real GitHub PR
 * (`pr.number > 0`) — never unconditionally at page load.
 */
export function validatePrModeEnv(
  env: Record<string, string | undefined> = process.env,
): PrModeEnvValidation {
  const missing = PR_MODE_WEB_ENV.filter((name) => !env[name]?.trim());
  return { ok: missing.length === 0, missing };
}

/**
 * Feature flag for the phase-1 supervisor console (spec 0049 / ADR-022).
 * DELIBERATELY NOT in `REQUIRED_WEB_ENV`: the rest of the app must not gate on
 * it, and the supervisor console — a browser→Bash host session — is a security
 * hazard that stays OFF by default until auth lands (phase 5). The route/page
 * pairs this flag with a localhost/single-user check (see
 * lib/supervisor-console.ts); the flag alone never exposes the surface.
 */
export const SUPERVISOR_CONSOLE_ENV = "SUPERVISOR_CONSOLE_ENABLED" as const;
/** True only when `SUPERVISOR_CONSOLE_ENABLED` is explicitly on ("1"/"true").
 * Defaults OFF for any other value or when unset. */
export function isSupervisorConsoleEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[SUPERVISOR_CONSOLE_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Spec 0145: base URL of a reachable Temporal Web UI, e.g.
 * `https://temporal.internal.example` or `http://localhost:8080` when the
 * operator has an SSH tunnel open.
 *
 * UNSET BY DEFAULT and unset in production today, deliberately: the UI on the
 * app host binds `127.0.0.1:8080` and has no authentication of its own — it
 * can terminate a running workflow — so exposing it is a decision with a real
 * blast radius, not a default. While it is unset the product shows the
 * workflow ID (which is what you paste into the CLI) and no link, because a
 * link that cannot resolve is worse than no link.
 */
export const TEMPORAL_UI_URL_ENV = "TEMPORAL_UI_URL" as const;

/** The Temporal UI URL for one workflow, or null when no UI is configured. */
export function temporalWorkflowUrl(
  workflowId: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const base = env[TEMPORAL_UI_URL_ENV]?.trim();
  if (!base || !workflowId.trim()) return null;
  const namespace = env["TEMPORAL_NAMESPACE"]?.trim() || "default";
  return `${base.replace(/\/+$/, "")}/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflowId)}`;
}

/**
 * Scope the session cookie to a parent domain, so ONE sign-in serves both the
 * production console and its staging twin (spec 0213 B2).
 *
 * Unset — the default, and what local dev and every existing deployment get —
 * returns `undefined`, which leaves Auth.js's own cookie defaults completely
 * untouched. This is deliberate: the sign-in path is the single door to the
 * whole console, so the new behaviour has to be opt-in by an env var that is
 * only ever set on the two hosts that need it.
 */
export const AUTH_COOKIE_DOMAIN_ENV = "AUTH_COOKIE_DOMAIN" as const;

/**
 * The cookie NAME used when a domain is configured.
 *
 * Renamed rather than reusing Auth.js's `__Secure-authjs.session-token`, and the
 * reason is a real trap: adding a `Domain` attribute to a name the browser
 * already holds host-only produces TWO cookies with the same name and different
 * scopes. Browsers send both, the server picks one arbitrarily, and you get
 * intermittent signed-out states that survive every obvious fix. A distinct name
 * means the old cookie is simply ignored — everyone signs in once, and there is
 * never an ambiguous pair.
 *
 * Keeps the `__Secure-` prefix (requires HTTPS) and NOT `__Host-`, because
 * `__Host-` forbids a `Domain` attribute outright — which is the one thing this
 * feature needs.
 */
export const SHARED_SESSION_COOKIE_NAME = "__Secure-launchpad.session" as const;

/** Shape Auth.js expects for `cookies.sessionToken`. Declared locally so this
 * module stays importable without pulling next-auth in. */
export interface SessionCookieConfig {
  name: string;
  options: {
    httpOnly: true;
    sameSite: "lax";
    path: "/";
    secure: true;
    domain: string;
  };
}

/**
 * The `cookies.sessionToken` override, or `undefined` to leave Auth.js alone.
 *
 * A leading dot is accepted and normalised away: `.example.com` and `example.com`
 * mean the same thing to every browser since RFC 6265, but only one of them
 * compares equal to the other in a test or a log line.
 */
export function sharedSessionCookie(
  env: Record<string, string | undefined> = process.env,
): { sessionToken: SessionCookieConfig } | undefined {
  const domain = env[AUTH_COOKIE_DOMAIN_ENV]?.trim().replace(/^\./, "");
  if (!domain) return undefined;
  return {
    sessionToken: {
      name: SHARED_SESSION_COOKIE_NAME,
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: true, domain },
    },
  };
}

/**
 * Which control plane is this (spec 0213 D)?
 *
 * The staging twin is a byte-identical build of the same app, so nothing in the
 * UI distinguishes them and nothing in the code did either. That matters for
 * exactly one action: the platform deploy button restarts `launchpad-web` and
 * `launchpad-worker` — the PRODUCTION units — so a press on staging would
 * restart production while building the staging tree. Neither environment nor
 * user would be told.
 *
 * Absent means production, so the existing deployment keeps working untouched
 * and the staging env file is the only place that has to say anything.
 */
export const LAUNCHPAD_ENVIRONMENT_ENV = "LAUNCHPAD_ENVIRONMENT" as const;

export function isStagingControlPlane(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[LAUNCHPAD_ENVIRONMENT_ENV]?.trim().toLowerCase() === "staging";
}
