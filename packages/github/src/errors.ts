/**
 * Typed failures for the GitHub client (spec 0015), mirroring
 * fleet-hostinger/errors.ts so activities can map either client's failures to
 * a retryable vs non-retryable Temporal `ApplicationFailure` the same way.
 *
 * Rules (same as the Hostinger client):
 *  - 429 and 5xx        → retryable (rate-limited / server)
 *  - network + timeout  → retryable
 *  - 401/403            → fatal (auth)
 *  - other 4xx / 404    → fatal (client / not_found)
 *
 * `GITHUB_TOKEN` must NEVER appear in an error message — errors are logged.
 */

export type GithubErrorKind =
  | "auth" // 401/403 — bad or missing token
  | "not_found" // 404
  | "rate_limited" // 429
  | "server" // 5xx
  | "network" // fetch rejected (DNS, connreset, …)
  | "timeout" // request exceeded the configured timeout
  | "client" // other 4xx
  | "name_taken" // 422 whose errors[] says a repo of that name already exists (spec 0148 A)
  | "unknown";

export class GithubApiError extends Error {
  readonly kind: GithubErrorKind;
  /** HTTP status when the failure came from a response; undefined for network/timeout. */
  readonly status?: number;
  /** Whether a Temporal activity should retry this failure. */
  readonly retryable: boolean;
  /**
   * The parsed response body, when the failure came from a non-OK response.
   * Carried so a caller can inspect GitHub's `errors[]` detail — a 422's
   * top-level `message` is generic ("Repository creation failed."), the
   * distinguishing field/message lives in `errors[]` (spec 0148 A).
   */
  readonly body?: unknown;

  constructor(
    kind: GithubErrorKind,
    message: string,
    opts: { status?: number; retryable: boolean; cause?: unknown; body?: unknown },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "GithubApiError";
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.body = opts.body;
  }
}

/** Maps an HTTP status to its error kind + retryability, per the rules above. */
export function classifyHttpStatus(status: number): {
  kind: GithubErrorKind;
  retryable: boolean;
} {
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status === 404) return { kind: "not_found", retryable: false };
  if (status === 429) return { kind: "rate_limited", retryable: true };
  if (status >= 500 && status <= 599) return { kind: "server", retryable: true };
  if (status >= 400 && status <= 499) return { kind: "client", retryable: false };
  return { kind: "unknown", retryable: false };
}
