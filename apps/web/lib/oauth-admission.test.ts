import test from "node:test";
import assert from "node:assert/strict";
import { admitGithubSignIn, type AdmissibleUser } from "./oauth-admission";

const authorized = (over: Partial<AdmissibleUser> = {}): AdmissibleUser => ({
  email: "owner@example.com",
  githubLogin: null,
  ...over,
});
const lookupOf = (users: AdmissibleUser[]) => (email: string) =>
  users.find((u) => u.email === email) ?? null;

test("a pre-authorised, verified email is admitted", () => {
  const res = admitGithubSignIn({
    login: "owner-gh",
    verifiedEmails: ["owner@example.com"],
    lookup: lookupOf([authorized()]),
  });
  assert.deepEqual(res, { ok: true, email: "owner@example.com" });
});

// THE test for this file. Without callbacks.signIn, this person would get a
// session on launchpad.example.com.
test("a stranger with a perfectly valid GitHub account is REFUSED", () => {
  const res = admitGithubSignIn({
    login: "random-person",
    verifiedEmails: ["random@example.com"],
    lookup: lookupOf([authorized()]),
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.reason, /no está autorizada/);
});

test("default is DENY — an empty users table admits nobody", () => {
  const res = admitGithubSignIn({
    login: "anyone",
    verifiedEmails: ["a@b.c"],
    lookup: () => null,
  });
  assert.equal(res.ok, false);
});

// GitHub lets anyone type any address into their profile, so trusting an
// unverified one would let a stranger claim owner@example.com's row — and with it,
// whatever that account may promote.
test("an UNVERIFIED email cannot claim an authorised row", () => {
  const res = admitGithubSignIn({
    login: "impostor",
    verifiedEmails: [], // GitHub reported none as verified
    lookup: lookupOf([authorized()]),
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.reason, /verificado/);
});

test("a row already linked to another GitHub account is not transferable", () => {
  const res = admitGithubSignIn({
    login: "impostor",
    verifiedEmails: ["owner@example.com"],
    lookup: lookupOf([authorized({ githubLogin: "owner-gh" })]),
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.reason, /ya está vinculado/);
  assert.match(res.reason, /owner-gh/);
});

test("the same account signing in again is fine (login matches, case-insensitively)", () => {
  for (const login of ["owner-gh", "Owner-GH"]) {
    const res = admitGithubSignIn({
      login,
      verifiedEmails: ["owner@example.com"],
      lookup: lookupOf([authorized({ githubLogin: "owner-gh" })]),
    });
    assert.equal(res.ok, true, login);
  }
});

test("emails are matched normalised, and any verified address may claim the row", () => {
  const res = admitGithubSignIn({
    login: "owner-gh",
    verifiedEmails: ["noise@users.noreply.github.com", "  OWNER@Example.COM  "],
    lookup: lookupOf([authorized()]),
  });
  assert.deepEqual(res, { ok: true, email: "owner@example.com" });
});

test("no GitHub login at all is refused", () => {
  for (const login of [null, undefined, "  "]) {
    assert.equal(
      admitGithubSignIn({ login, verifiedEmails: ["owner@example.com"], lookup: lookupOf([authorized()]) }).ok,
      false,
      String(login),
    );
  }
});

// A refusal must not reveal whether an address is authorised — that would make
// sign-in an oracle for "who works here".
test("the refusal message does not disclose whether the email exists", () => {
  const stranger = admitGithubSignIn({
    login: "x",
    verifiedEmails: ["unknown@example.com"],
    lookup: lookupOf([authorized()]),
  });
  assert.equal(stranger.ok, false);
  if (stranger.ok) return;
  assert.equal(stranger.reason.includes("unknown@example.com"), false);
  assert.equal(stranger.reason.includes("owner@example.com"), false);
});
