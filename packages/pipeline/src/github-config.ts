/**
 * PR-mode resolution (spec 0015 / ADR-012). Gate 2 runs on real GitHub PRs
 * when — and only when — the launchpad is configured for it: a `GITHUB_TOKEN`
 * is present AND the checkout has a GitHub `origin` remote. Otherwise the
 * pipeline stays on the documented offline local-diff fallback (spec 0006), so
 * this is a per-config choice, never a hardcode.
 *
 * Pure and I/O-free (the caller passes in the token and the already-read origin
 * URL) so it is fully unit-testable — see github-config.test.ts.
 */
import type { GithubConfig } from "@launchpad/github";

/** Owner/repo parsed from a GitHub remote URL. */
export interface GithubOrigin {
  owner: string;
  repo: string;
}

/**
 * The resolved gate-2 mode. `github` carries a ready-to-use `GithubConfig`;
 * `local` is the offline local-diff fallback.
 */
export type PrMode =
  | { mode: "github"; config: GithubConfig }
  | { mode: "local" };

/**
 * Parse `owner`/`repo` from a GitHub remote URL — both the `https://github.com/
 * owner/repo(.git)` and `git@github.com:owner/repo(.git)` forms. Returns null
 * for a non-GitHub or unparseable remote (→ local-diff fallback).
 */
export function parseGithubOrigin(remoteUrl: string): GithubOrigin | null {
  // https://github.com/owner/repo(.git)
  const https = remoteUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (https) return { owner: https[1]!, repo: https[2]! };
  // git@github.com:owner/repo(.git)
  const ssh = remoteUrl.match(
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  return null;
}

/**
 * Decide gate-2 mode from the token and the checkout's origin URL. Returns
 * `github` only when a non-empty token AND a parseable GitHub origin are both
 * present; anything missing → `local`.
 */
export function resolvePrMode(input: {
  token?: string;
  originUrl?: string | null;
}): PrMode {
  if (!input.token || !input.originUrl) return { mode: "local" };
  const origin = parseGithubOrigin(input.originUrl);
  if (!origin) return { mode: "local" };
  return {
    mode: "github",
    config: { token: input.token, owner: origin.owner, repo: origin.repo },
  };
}
