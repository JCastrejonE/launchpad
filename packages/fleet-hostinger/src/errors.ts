/**
 * Typed failures for the Hostinger client (spec 0011). The `retryable` flag is
 * the contract future Temporal activities rely on to map a failure to a
 * retryable vs non-retryable ApplicationFailure — so classification lives here,
 * not at the call site.
 *
 * Rules (per spec 0011):
 *  - 429 and 5xx        → retryable (rate-limited / server)
 *  - network + timeout  → retryable
 *  - 401/403            → fatal (auth)
 *  - other 4xx / 404    → fatal (client / not_found)
 *
 * The token must NEVER appear in an error message — errors are logged.
 */

export type HostingerErrorKind =
  | "auth" // 401/403 — bad or missing token
  | "not_found" // 404
  | "rate_limited" // 429
  | "server" // 5xx
  | "network" // fetch rejected (DNS, connreset, …)
  | "timeout" // request exceeded the configured timeout
  | "client" // other 4xx
  | "conflict" // client-side refusal: a mutation would overwrite existing state (e.g. a DNS record pointing elsewhere) — never emitted by classifyHttpStatus, thrown by upsertDnsRecord (spec 0148 B, a live customer's DNS)
  | "unknown";

export class HostingerApiError extends Error {
  readonly kind: HostingerErrorKind;
  /** HTTP status when the failure came from a response; undefined for network/timeout. */
  readonly status?: number;
  /** Whether a Temporal activity should retry this failure. */
  readonly retryable: boolean;

  constructor(
    kind: HostingerErrorKind,
    message: string,
    opts: { status?: number; retryable: boolean; cause?: unknown },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "HostingerApiError";
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

/**
 * Fleet-side (SSH / bootstrap / deploy) failure taxonomy (spec 0012). The VPS
 * lifecycle work runs shell steps over SSH rather than the HTTP API, so it
 * needs its own typed error carrying the same `retryable` contract
 * `HostingerApiError` established — so `activity.ts` can map either into a
 * retryable vs non-retryable Temporal `ApplicationFailure` from one place.
 *
 * Rough guidance (coder refines per step in spec 0012):
 *  - transient SSH/connectivity, a not-yet-healthy container, a 5xx from Odoo
 *    during warm-up → retryable
 *  - a bad config/template, an unreachable-by-design host, a hard verify
 *    failure after the container is up → fatal
 *
 * As with the API token, no secret (SSH key material, generated DB password)
 * may ever appear in a `FleetError` message — these are logged.
 */
export type FleetErrorKind =
  | "ssh" // SSH transport / connectivity
  | "docker" // docker engine / compose operation failed
  | "deploy" // compose up / file copy failed
  | "verify" // post-deploy health / HTTP check failed
  | "sandbox" // mutating op refused: VPS not on the fleet sandbox allowlist (fatal)
  | "config"; // bad template, missing input, etc. (fatal)

export class FleetError extends Error {
  readonly kind: FleetErrorKind;
  readonly retryable: boolean;

  constructor(
    kind: FleetErrorKind,
    message: string,
    opts: { retryable: boolean; cause?: unknown },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "FleetError";
    this.kind = kind;
    this.retryable = opts.retryable;
  }
}

/**
 * Maps an HTTP status to its error kind + retryability, per the rules above.
 */
export function classifyHttpStatus(status: number): {
  kind: HostingerErrorKind;
  retryable: boolean;
} {
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status === 404) return { kind: "not_found", retryable: false };
  if (status === 429) return { kind: "rate_limited", retryable: true };
  if (status >= 500 && status <= 599) return { kind: "server", retryable: true };
  if (status >= 400 && status <= 499) return { kind: "client", retryable: false };
  return { kind: "unknown", retryable: false };
}
