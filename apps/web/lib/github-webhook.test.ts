import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyGithubSignature, webhookTarget } from "./github-webhook.js";

// Spec 0228 D. This is the only thing between the open internet and "start a CI
// workflow", so the negative cases matter more than the positive one.

const SECRET = "s3cret";
const sign = (body: string, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");

test("a correct signature verifies", () => {
  const body = JSON.stringify({ hello: "world" });
  assert.deepEqual(verifyGithubSignature(SECRET, body, sign(body)), { ok: true });
});

test("a signature made with a DIFFERENT secret is rejected", () => {
  const body = JSON.stringify({ hello: "world" });
  const v = verifyGithubSignature(SECRET, body, sign(body, "wrong"));
  assert.deepEqual(v, { ok: false, reason: "mismatch" });
});

test("a body altered after signing is rejected", () => {
  // The realistic attack: a valid delivery replayed with a different sha.
  const original = JSON.stringify({ after: "aaa" });
  const tampered = JSON.stringify({ after: "bbb" });
  assert.deepEqual(verifyGithubSignature(SECRET, tampered, sign(original)), {
    ok: false,
    reason: "mismatch",
  });
});

test("no secret configured is a REFUSAL, never an allow", () => {
  // A deployment that forgot the secret would otherwise accept anything — the
  // shape of every "the check could not fire" row in the registry.
  const body = "{}";
  assert.deepEqual(verifyGithubSignature(undefined, body, sign(body)), {
    ok: false,
    reason: "no-secret",
  });
  assert.deepEqual(verifyGithubSignature("", body, sign(body)), { ok: false, reason: "no-secret" });
});

test("missing or malformed headers are rejected without throwing", () => {
  // timingSafeEqual throws on a length mismatch, so a short signature must be
  // caught before it reaches the comparison.
  const body = "{}";
  assert.equal(verifyGithubSignature(SECRET, body, null).ok, false);
  assert.equal(verifyGithubSignature(SECRET, body, "").ok, false);
  assert.equal(verifyGithubSignature(SECRET, body, "sha1=deadbeef").ok, false);
  assert.equal(verifyGithubSignature(SECRET, body, "sha256=short").ok, false);
  assert.equal(verifyGithubSignature(SECRET, body, "sha256=" + "z".repeat(64)).ok, false);
});

// --- which deliveries are worth a gate ------------------------------------

const repo = { repository: { name: "launchpad", owner: { login: "example-org" } } };

test("a push names the commit it landed", () => {
  assert.deepEqual(webhookTarget("push", { ...repo, after: "abc123" }), {
    owner: "example-org",
    repo: "launchpad",
    sha: "abc123",
    event: "push",
  });
});

test("a branch DELETION is not a target", () => {
  // The all-zero sha. Gating it would post a status on a commit that is gone.
  assert.equal(webhookTarget("push", { ...repo, after: "0".repeat(40), deleted: true }), null);
  assert.equal(webhookTarget("push", { ...repo, after: "0".repeat(40) }), null);
});

test("a PR is gated on open, synchronize and reopen — not on chatter", () => {
  const pr = { ...repo, pull_request: { head: { sha: "deadbee" } } };
  for (const action of ["opened", "synchronize", "reopened"]) {
    assert.equal(webhookTarget("pull_request", { ...pr, action })?.sha, "deadbee", action);
  }
  for (const action of ["labeled", "edited", "closed", "assigned"]) {
    assert.equal(webhookTarget("pull_request", { ...pr, action }), null, action);
  }
});

test("events we do not gate produce no target", () => {
  assert.equal(webhookTarget("issue_comment", repo), null);
  assert.equal(webhookTarget("ping", repo), null);
  assert.equal(webhookTarget("push", { after: "abc" }), null); // no repository
});
