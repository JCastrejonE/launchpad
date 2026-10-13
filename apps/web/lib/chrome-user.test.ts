import assert from "node:assert/strict";
import test from "node:test";

import { chromeDisplayName, chromeInitials, type ChromeUser } from "./chrome-user.js";

function user(over: Partial<ChromeUser> = {}): ChromeUser {
  return { name: "Ana Bel", email: "ana@example.com", role: "MEMBER", ...over };
}

test("the greeting name is the profile name when the provider supplied one", () => {
  assert.equal(chromeDisplayName(user()), "Ana Bel");
});

test("the greeting name falls back to the email when there is no profile name", () => {
  assert.equal(chromeDisplayName(user({ name: null })), "ana@example.com");
  assert.equal(chromeDisplayName(user({ name: "   " })), "ana@example.com");
});

test("signed out has no greeting name — never a placeholder person", () => {
  assert.equal(chromeDisplayName(null), null);
});

test("initials take the first letter of up to two name words", () => {
  assert.equal(chromeInitials(user()), "AB");
  assert.equal(chromeInitials(user({ name: "Ana" })), "A");
  assert.equal(chromeInitials(user({ name: "ana bel de la cruz" })), "AB");
});

test("initials fall back to the email's first letter, uppercased", () => {
  assert.equal(chromeInitials(user({ name: null })), "A");
  assert.equal(chromeInitials(user({ name: "  ", email: "zoe@example.com" })), "Z");
});

test("signed out yields no initials, so the caller renders the neutral glyph", () => {
  assert.equal(chromeInitials(null), null);
});
