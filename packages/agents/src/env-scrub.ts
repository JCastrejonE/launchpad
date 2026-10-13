/**
 * Agent-session env hygiene (spec 0011; hardened to an allowlist in spec 0069 /
 * SPEC-ALIGNMENT §3 A.1). `runAgentSession` and the supervisor/architect session
 * builders compose the spawned Claude Agent SDK subprocess's env as
 * `{ ...scrubAgentEnv(), ...credentialEnv(cred) }`. This module builds that base
 * env.
 *
 * It is an ALLOWLIST, not a denylist. Only known infra-neutral variables are
 * passed through; everything else — every current AND future secret
 * (`DATABASE_URL`, `LAUNCHPAD_FLEET_SSH_IDENTITY`, `AWS_SECRET_ACCESS_KEY`, …) —
 * is dropped by default. The previous denylist was structurally backwards: it
 * leaked every secret nobody had remembered to add to it (audit finding #1,
 * CRITICAL — the LLM, or prompt-injected repo content, is one `env` away from
 * the host's secrets).
 *
 * The two LLM credential vars (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`)
 * are DELIBERATELY NOT allowlisted: the ONE selected credential is overlaid
 * afterwards by `credentialEnv(cred)`, so a session carries only the credential
 * it was given — the non-selected host credential no longer rides along (the
 * cross-credential leak). The agent never needs infra tokens (`GITHUB_TOKEN`,
 * `HOSTINGER_API_TOKEN`, …): pushes, PRs, and fleet calls all happen in worker
 * ACTIVITIES, not inside the session.
 *
 * Why the allowlist is generous: the SDK's `options.env` REPLACES the subprocess
 * environment, so the list must cover what a Node CLI and its Bash tool need to
 * run (`PATH`/`HOME`/locale/tmp/proxy/TLS). If a specific deployment needs
 * another NON-SECRET var (e.g. a custom `ANTHROPIC_BASE_URL`), add its exact
 * name below — a one-line, reviewable change. Completeness for a given host is
 * confirmed by a live agent-session smoke test; it can't be unit-tested here.
 */

/**
 * Exact variable names passed through to an agent session — infra-neutral, none
 * a secret. Extend with additional NON-SECRET names a deployment needs.
 */
export const AGENT_ENV_ALLOWLIST: readonly string[] = [
  // Process basics the CLI + git + pnpm need to run at all.
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  // Locale / timezone.
  "LANG",
  "LANGUAGE",
  "TZ",
  // Terminal (the Bash tool spawns a shell).
  "TERM",
  "TERM_PROGRAM",
  "COLORTERM",
  // Temp dirs.
  "TMPDIR",
  "TMP",
  "TEMP",
  // TLS / corporate CA + egress proxy — required for the SDK to reach the API on
  // locked-down networks. A proxy URL can embed credentials, but it is the
  // operator's OWN egress proxy and the session needs it to connect at all.
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Non-secret Anthropic SDK routing config. The API KEY / OAuth TOKEN are
  // supplied by credentialEnv, NEVER here.
  "ANTHROPIC_BASE_URL",
];

/** Name prefixes passed through: locale (`LC_*`) and XDG base dirs (`XDG_*`). */
export const AGENT_ENV_ALLOWLIST_PREFIXES: readonly string[] = ["LC_", "XDG_"];

/** True when `key` is allowlisted for an agent session (exact name or prefix). */
export function isAgentEnvAllowed(key: string): boolean {
  if (AGENT_ENV_ALLOWLIST.includes(key)) return true;
  return AGENT_ENV_ALLOWLIST_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Build the base env for an agent session from {@link AGENT_ENV_ALLOWLIST}
 * (dropping everything else, and any undefined value). The caller overlays the
 * ONE selected credential with `credentialEnv(cred)` — see the module doc.
 */
export function scrubAgentEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!isAgentEnvAllowed(key)) continue;
    out[key] = value;
  }
  return out;
}
