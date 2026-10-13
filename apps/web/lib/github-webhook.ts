/**
 * Verify a GitHub webhook signature (spec 0228 D).
 *
 * This is the only thing standing between the open internet and "start a CI
 * workflow", so it is a pure function with its own tests, written before the
 * route that uses it.
 *
 * GitHub signs the RAW request body with HMAC-SHA256 and sends
 * `X-Hub-Signature-256: sha256=<hex>`. The body must be the bytes as received:
 * parsing to JSON and re-serialising changes whitespace and key order, and the
 * signature stops matching for reasons that look like an attack.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "mismatch" | "no-secret" };

/**
 * Constant-time where it counts.
 *
 * `timingSafeEqual` THROWS when the buffers differ in length, so length is
 * compared first — which leaks nothing here, since a SHA-256 hex digest is
 * always 64 characters and a wrong length means malformed, not "close".
 */
export function verifyGithubSignature(
  secret: string | undefined,
  rawBody: string,
  header: string | null | undefined,
): SignatureVerdict {
  // An unset secret must never mean "allow". A deployment that forgot to
  // configure one would otherwise accept anything, which is the shape of every
  // "the check could not fire" row in the compliance registry.
  if (!secret) return { ok: false, reason: "no-secret" };
  if (!header) return { ok: false, reason: "missing" };
  if (!header.startsWith("sha256=")) return { ok: false, reason: "malformed" };

  const provided = header.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(provided)) return { ok: false, reason: "malformed" };

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided.toLowerCase(), "utf8");
  if (a.length !== b.length) return { ok: false, reason: "malformed" };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export interface WebhookTarget {
  owner: string;
  repo: string;
  sha: string;
  /** What produced it, for the log — not for a decision. */
  event: "push" | "pull_request";
}

/**
 * The commit a delivery is about, or null when it is an event we do not gate.
 *
 * Deliberately narrow: a push to a branch and a PR opened/synchronised. GitHub
 * sends dozens of event types and most say nothing about a commit worth
 * testing; treating an unknown one as "no target" is what keeps this from
 * starting workflows for label changes and comments.
 */
export function webhookTarget(event: string, payload: unknown): WebhookTarget | null {
  const p = payload as Record<string, unknown>;
  const repo = p?.["repository"] as { name?: string; owner?: { login?: string } } | undefined;
  const owner = repo?.owner?.login;
  const name = repo?.name;
  if (!owner || !name) return null;

  if (event === "push") {
    const after = p["after"];
    const deleted = p["deleted"] === true;
    // A branch deletion sends the all-zero sha. Gating it would post a status
    // on a commit that is not there.
    if (deleted || typeof after !== "string" || /^0+$/.test(after)) return null;
    return { owner, repo: name, sha: after, event: "push" };
  }

  if (event === "pull_request") {
    const action = p["action"];
    if (action !== "opened" && action !== "synchronize" && action !== "reopened") return null;
    const pr = p["pull_request"] as { head?: { sha?: string } } | undefined;
    const sha = pr?.head?.sha;
    if (typeof sha !== "string" || !sha) return null;
    return { owner, repo: name, sha, event: "pull_request" };
  }

  return null;
}
