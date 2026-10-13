/**
 * A user's GitHub OAuth token, encrypted at rest (spec 0128 decision 4 + F).
 *
 * This is the most sensitive value the app stores, so where it does NOT go is the
 * point: not in a column, and never in the session JWT — a JWT is handed to the
 * browser, so a token in it is a credential given away. It lives in the
 * AES-256-GCM `secrets` table (spec 0076), keyed per user, decrypted only in the
 * process that is about to use it.
 *
 * What it is FOR is narrow (decision 5): performing a **promotion** as that
 * person, because a promotion is the production deploy and GitHub enforcing it is
 * stronger than us checking a role. Pushes and PR-opens keep using the server
 * token, and the "may this person write here?" question is answered with the
 * server token too (see packages/github/src/collaborator.ts), precisely so this
 * token can stay narrow.
 *
 * Fails soft on read: a missing or undecryptable token returns null, and callers
 * must treat null as "cannot promote as this person" — never as a reason to fall
 * back to the server token, which would silently re-create the unattributable
 * merge this design exists to remove.
 */
import { getSecret, loadSecretMasterKey, putSecret } from "@launchpad/db";
import { getDb } from "./db";

/** Secret name for a user's GitHub token. Email-keyed because that is the stable
 * identity in `users`; a GitHub login can be renamed. */
export function githubTokenSecretName(email: string): string {
  return `user-github-token:${email.trim().toLowerCase()}`;
}

/** Store (or replace) the token obtained at sign-in. */
export async function storeUserGithubToken(email: string, token: string): Promise<void> {
  if (!email.trim() || !token.trim()) return;
  const key = loadSecretMasterKey();
  await putSecret(getDb(), key, githubTokenSecretName(email), token);
}

/**
 * The stored token, or null.
 *
 * Null is a normal outcome — the user signed in before this existed, or the
 * master key changed — and it must never be answered by using someone else's
 * credential.
 */
export async function readUserGithubToken(email: string): Promise<string | null> {
  if (!email.trim()) return null;
  try {
    const key = loadSecretMasterKey();
    return await getSecret(getDb(), key, githubTokenSecretName(email));
  } catch {
    return null;
  }
}
