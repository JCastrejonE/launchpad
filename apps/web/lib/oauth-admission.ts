/**
 * Who may sign in with GitHub (spec 0128 B, decision 3a).
 *
 * **This is the file that keeps the control plane private.** Until now the door
 * was closed by construction: the Credentials provider's `authorize` returned a
 * user only if the email matched a `users` row with the right password, so a
 * stranger could never obtain a session. An OAuth provider has no such property —
 * anyone on the internet with a GitHub account can complete the flow — so the
 * refusal has to be written explicitly, in `callbacks.signIn`.
 *
 * Note what is NOT a gate: `events.signIn` (it writes an audit row and cannot
 * reject) and the provider config itself. A missing `callbacks.signIn` here would
 * make `launchpad.example.com` a public sign-up page.
 *
 * Pure. The caller supplies the account lookup, so every rule is testable without
 * a database or an OAuth round-trip.
 */

/** The subset of a `users` row admission depends on. */
export interface AdmissibleUser {
  email: string;
  githubLogin?: string | null;
}

export type Admission =
  | { ok: true; email: string }
  | { ok: false; reason: string };

/**
 * Decide whether a GitHub identity may sign in.
 *
 * The rule is **pre-authorisation, not self-registration** (decision 3b): a
 * `users` row is the allowlist, created by `seed-user` or "Agregar Miembro". A
 * GitHub identity claims a row; it never creates one.
 *
 * `verifiedEmails` is the set GitHub reports as verified for that account. An
 * unverified email is not usable as an identity claim: GitHub lets anyone type
 * any address into their profile, so accepting one would let a stranger claim
 * `owner@example.com`'s row by putting that address on their own account. Only the
 * verified set is trusted, which is also why decision 3c records
 * `github_login` explicitly instead of relying on email matching forever.
 */
export function admitGithubSignIn(input: {
  login: string | null | undefined;
  verifiedEmails: readonly string[];
  /** The pre-authorised row matching one of the verified emails, if any. */
  lookup: (email: string) => AdmissibleUser | null;
}): Admission {
  const login = input.login?.trim();
  if (!login) {
    return { ok: false, reason: "GitHub no devolvió una cuenta identificable." };
  }
  if (input.verifiedEmails.length === 0) {
    return {
      ok: false,
      reason:
        "Tu cuenta de GitHub no tiene ningún correo verificado, así que no podemos vincularla a un usuario autorizado.",
    };
  }

  for (const email of input.verifiedEmails) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) continue;
    const user = input.lookup(normalized);
    if (!user) continue;

    // The row is already claimed by a DIFFERENT GitHub account. Letting a second
    // account claim it would silently transfer an authorised identity — and with
    // it, whatever that person may promote.
    const claimed = user.githubLogin?.trim();
    if (claimed && claimed.toLowerCase() !== login.toLowerCase()) {
      return {
        ok: false,
        reason: `Ese usuario ya está vinculado a la cuenta de GitHub "${claimed}".`,
      };
    }
    return { ok: true, email: normalized };
  }

  // Default DENY, and the message deliberately does not say whether the address
  // exists in our users table — that would turn sign-in into an account oracle.
  return {
    ok: false,
    reason: "Esta cuenta de GitHub no está autorizada. Pide a un administrador que te dé acceso.",
  };
}
