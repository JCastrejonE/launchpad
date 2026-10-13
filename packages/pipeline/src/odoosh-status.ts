/**
 * Reading odoo.sh's build state for a commit (spec 0115).
 *
 * odoo.sh watches the connected GitHub repo, builds on push, and reports back as a
 * **commit status** with the context below. There is no odoo.sh API in this path,
 * by design (spec 0115: *"No odoo.sh API is used anywhere. That is not a
 * workaround; it is how odoo.sh is integrated"*), so this status is the only signal
 * we get — which makes reading it precisely rather than optimistically the whole
 * job.
 *
 * PURE and `@temporalio`-free: the activity fetches, this decides, so every branch
 * is testable without a GitHub token.
 *
 * ## Why `absent` is its own state
 *
 * Four GitHub states map onto three outcomes, and the fourth outcome is the one a
 * naive reader gets wrong: **no status at all**. Absent means odoo.sh has not
 * reported on this commit — the repo may not be connected, the build may not have
 * been created yet, or the commit may be on a branch odoo.sh does not track. That
 * is NOT "building", and it is NOT "green". A reader that folds absent into
 * pending claims a build exists when none does; one that folds it into success
 * lets a promote through on no evidence. Spec 0084's rule, applied to a build
 * state: never present what we cannot observe.
 */
import type { CommitStatus } from "@launchpad/github";

/**
 * The context odoo.sh publishes under. Fixed by odoo.sh, not by us — a mismatch
 * here reads as "no build ever ran", so it is a constant with one definition
 * rather than a string repeated at call sites.
 */
export const ODOO_SH_STATUS_CONTEXT = "ci/odoo.sh";

export type OdooShBuild =
  /** odoo.sh has not reported on this commit. Not an error; not a build. */
  | { status: "absent" }
  /** A build is in flight. The only state that means "wait". */
  | { status: "building"; description: string | null; url: string | null }
  | { status: "success"; description: string | null; url: string | null }
  /** GitHub's `failure` and `error` both land here: the build did not succeed, and
   * the distinction between "the build failed" and "the reporter errored" changes
   * nothing a caller can act on. `githubState` is kept so an operator can still
   * see which one it was. */
  | {
      status: "failed";
      description: string | null;
      url: string | null;
      githubState: "failure" | "error";
    };

/**
 * Maps the current `ci/odoo.sh` status onto a build state.
 *
 * `null` in means absent — the caller passes what `latestStatusForContext`
 * returned, so "no entry for this context" flows through as a fact rather than
 * being invented here.
 *
 * An UNRECOGNISED state is treated as `building`, deliberately: the safe reading
 * of "we do not understand what odoo.sh said" is "do not act yet", because the
 * alternative is promoting over an unknown. It is the same instinct as
 * `aggregateChecks` reading an empty run list as pending rather than a vacuous
 * success (spec 0043).
 */
export function interpretOdooShStatus(status: CommitStatus | null): OdooShBuild {
  if (!status) return { status: "absent" };
  const { description, targetUrl: url } = status;
  switch (status.state) {
    case "success":
      return { status: "success", description, url };
    case "failure":
    case "error":
      return { status: "failed", description, url, githubState: status.state };
    case "pending":
      return { status: "building", description, url };
    default:
      return { status: "building", description, url };
  }
}

/**
 * Whether a build is still running — the precise question spec 0115's promote
 * guard clause 4 asks ("production idle: the status on `main`'s HEAD must be
 * terminal, never `pending`").
 *
 * Deliberately narrow: only `building` is in flight. It does NOT answer whether
 * `absent` should block a promote, because that is a policy call the guard should
 * make and state in its own refusal message — folding it in here would bury a
 * decision inside a predicate. A failed build is explicitly not in flight: per the
 * spec, promoting over one is safe because odoo.sh falls back to the last good
 * build rather than leaving production down.
 */
export function isOdooShBuildInFlight(build: OdooShBuild): boolean {
  return build.status === "building";
}

/** One line for a human: what odoo.sh says about this commit. */
export function describeOdooShBuild(build: OdooShBuild): string {
  switch (build.status) {
    case "absent":
      return "odoo.sh no ha reportado nada para este commit todavía.";
    case "building":
      return `odoo.sh está construyendo${build.description ? `: ${build.description}` : ""}.`;
    case "success":
      return `odoo.sh construyó correctamente${build.description ? `: ${build.description}` : ""}.`;
    case "failed":
      return `odoo.sh falló (${build.githubState})${build.description ? `: ${build.description}` : ""}.`;
  }
}
