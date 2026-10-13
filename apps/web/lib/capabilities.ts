/**
 * Who may do what (spec 0117) — the one place role→permission policy lives.
 *
 * ## Why this exists
 *
 * Spec 0074 gave every mutating action the same gate: `ownerEmail()`, i.e.
 * **OWNER or nothing**. `MEMBER` and `VIEWER` existed in the JWT and in the
 * `users` table, and *nothing read them* — three roles, one of which worked.
 * v0 puts three people on one Launchpad, so "who may request work" has to split
 * from "who may promote it to production".
 *
 * ## The split
 *
 * Two capabilities, because two is the number of real distinctions:
 *
 *  - **`request`** — ask for work and steer it to *tested*: approve the spec,
 *    approve the change, reject, start a run. Reversible: every one of these
 *    acts on a branch/PR, never on production.
 *  - **`promote`** — the merge, which in this product *is* the production
 *    deploy (odoo.sh builds `main` on push). Irreversible in the way that
 *    matters: a customer sees the result. OWNER only, which is CLAUDE.md hard
 *    rule 7 ("production promotion is human-gated") tightened from "a human" to
 *    "the accountable human".
 *
 * ## What this deliberately does NOT widen
 *
 * The **supervisor console stays OWNER-only** (`checkSupervisorAccess`,
 * untouched). It is tempting to call chat a "request" capability — it is how a
 * spec gets drafted — but `supervisorBashDenial` says of itself: "a TARGETED
 * deny-list of the specific invariant-violating actions, not a general
 * sandbox… not [defended] against a determined adversary obfuscating a command".
 * A MEMBER holding that console holds a semi-trusted shell on the worker whose
 * workdir contains `.env`. Handing it out under the banner of "roles" would make
 * this split a facade. A MEMBER-safe drafting surface needs an allowlist-shaped
 * tool policy and a path filter on Read/Grep — its own security spec.
 *
 * **Tenant deploy stays OWNER-only** for the same family of reasons: it spends
 * money and creates live infrastructure.
 *
 * Pure and framework-free (no `next`, no `next-auth`, no DB) so it compiles
 * under tsconfig.test.json and every branch is unit-testable — the
 * lib-holds-the-logic split `auth-core.ts` and `supervisor-console.ts` use.
 * `app/auth.ts` is a thin wrapper that fetches the session and asks this file.
 */
import type { UserRole } from "./auth-core";
import type { GateSignal } from "./gate-actions";

/** The two things a session can be permitted to do. */
export type Capability = "request" | "promote";

/**
 * Role → capabilities. A `Record<UserRole, …>` on purpose: adding a role to
 * the enum without deciding its permissions is a compile error, not a silent
 * grant.
 *
 * VIEWER is deliberately empty rather than absent — "read everything, change
 * nothing" is a real answer for a stakeholder watching a run, and an empty
 * array states it.
 */
const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  OWNER: ["request", "promote"],
  MEMBER: ["request"],
  VIEWER: [],
};

/** Does this role hold this capability? `null` (signed out) never does. */
export function roleHasCapability(role: UserRole | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return ROLE_CAPABILITIES[role].includes(capability);
}

/**
 * Gate signal → the capability required to send it.
 *
 * A `Record<GateSignal, …>`, not a `signal === "promote" ? … : …` ternary, so a
 * NEW gate signal cannot be added without classifying it. The ternary version
 * fails **open** (an unclassified signal silently becomes `request`); this one
 * fails at `tsc`.
 *
 * `specRejected` is `request`, not `promote`: killing your own run is the
 * cheapest, most reversible action on the board, and a MEMBER who can start a
 * run must be able to stop it.
 */
export const SIGNAL_CAPABILITY: Record<GateSignal, Capability> = {
  specApproved: "request",
  prApproved: "request",
  specRejected: "request",
  promote: "promote",
};

export function capabilityForSignal(signal: GateSignal): Capability {
  return SIGNAL_CAPABILITY[signal];
}

/** What the user is told when a role isn't enough. Sentence-shaped because it
 * lands in an `?error=` panel; names the role held and the role needed, since
 * "forbidden" with no diagnosis is the worst kind of refusal. */
const CAPABILITY_REQUIREMENT: Record<Capability, string> = {
  request: "the MEMBER or OWNER role",
  promote: "the OWNER role (promoting merges to production)",
};

/**
 * The refusal reason, or `null` when allowed. Returning the reason rather than
 * a boolean keeps the message next to the policy that produced it, so the two
 * can't drift.
 */
export function capabilityDenial(role: UserRole | null | undefined, capability: Capability): string | null {
  if (roleHasCapability(role, capability)) return null;
  const need = CAPABILITY_REQUIREMENT[capability];
  return role
    ? `This needs ${need} — your session is ${role}.`
    : `Sign in with ${need} to do this.`;
}
