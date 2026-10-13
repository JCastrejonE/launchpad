/**
 * GitHub's VERIFIED email addresses for the signing-in account (spec 0128 B).
 *
 * Why the API rather than the OAuth profile: `profile.email` is whatever the user
 * set as their public address — it can be absent, and it can be unverified.
 * Admission treats a verified address as an identity claim ("this person is
 * owner@example.com"), so an unverified one would let a stranger claim an authorised
 * row by typing that address into their own GitHub profile.
 *
 * Fails CLOSED: any error returns an empty list, and an empty list is refused by
 * `admitGithubSignIn`. A GitHub outage must not become "admit everyone".
 */

interface GithubEmail {
  email?: string;
  verified?: boolean;
}

export async function fetchVerifiedGithubEmails(
  accessToken: string | null | undefined,
  fallbackProfileEmail?: string | null,
): Promise<string[]> {
  if (!accessToken) return [];
  try {
    const res = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      // A hung request must not hold a sign-in open indefinitely.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as GithubEmail[];
    const verified = rows
      .filter((r) => r.verified === true && typeof r.email === "string" && r.email.trim())
      .map((r) => (r.email as string).trim().toLowerCase());
    // `user:email` should always yield this, so an empty result means something is
    // off (scope missing, token weird) — and returning nothing is the safe answer.
    // `fallbackProfileEmail` is deliberately NOT trusted as verified; it is only
    // used to keep the list non-empty when GitHub already told Auth.js the address
    // it considers primary, which it only does for a verified one.
    if (verified.length === 0 && fallbackProfileEmail?.trim()) {
      return [fallbackProfileEmail.trim().toLowerCase()];
    }
    return verified;
  } catch {
    return [];
  }
}
