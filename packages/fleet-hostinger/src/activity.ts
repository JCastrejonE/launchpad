/**
 * Activity-shaped exposure of the VPS lifecycle (spec 0012).
 * `provisionClientVps` and `deployProductionStack` are the fleet's two
 * side-effecting operations; a future Temporal activity will call them with
 * retryable-step semantics. This module maps their typed failures
 * ({@link HostingerApiError} from 0011, {@link FleetError} from this spec) into
 * a transport-neutral descriptor so the eventual activity can raise a retryable
 * vs non-retryable `ApplicationFailure` — WITHOUT importing `@temporalio` here
 * (this package must load under plain `node --test`).
 *
 * NOT YET WIRED into the workflow: tenant targets in packages/pipeline remain
 * TODO(phase-3/4) — that's the ephemeral-env spec. This is the seam it will use.
 */
import { HostingerApiError, FleetError } from "./errors.js";

/** Transport-neutral failure descriptor the pipeline maps to ApplicationFailure. */
export interface ActivityFailureShape {
  /** Stable machine type, e.g. `"HostingerApiError:rate_limited"`. */
  type: string;
  message: string;
  /** Drives retryable vs non-retryable ApplicationFailure at the call site. */
  retryable: boolean;
}

/**
 * Maps any error thrown by the lifecycle functions to an
 * {@link ActivityFailureShape}. Known typed errors carry their own `retryable`;
 * an unknown/unexpected error is treated as fatal (non-retryable) so it surfaces
 * loudly rather than being retried blindly. Never includes secret material — the
 * source errors already guarantee that.
 */
export function toActivityFailure(err: unknown): ActivityFailureShape {
  if (err instanceof HostingerApiError) {
    return { type: `HostingerApiError:${err.kind}`, message: err.message, retryable: err.retryable };
  }
  if (err instanceof FleetError) {
    return { type: `FleetError:${err.kind}`, message: err.message, retryable: err.retryable };
  }
  // Unknown/unexpected shape: fatal (non-retryable) so it surfaces loudly rather
  // than retrying blindly. Only `.message` off a real Error is trusted — never
  // `.cause` or an arbitrary thrown value, since either could carry SSH stderr,
  // response bodies, or other content that isn't guaranteed secret-free the way
  // the two typed error classes above are.
  return {
    type: "Unknown",
    message: err instanceof Error ? err.message : "non-Error value thrown",
    retryable: false,
  };
}
