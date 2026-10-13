import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "./password.js";

test("hash → verify round-trips", () => {
  const hash = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("correct horse battery staple", hash), true);
});

test("wrong password verifies false", () => {
  const hash = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("Tr0ub4dor&3", hash), false);
});

test("two hashes of the same password differ (random salt)", () => {
  assert.notEqual(hashPassword("same input"), hashPassword("same input"));
});

test("stored format is self-describing scrypt", () => {
  const hash = hashPassword("x".repeat(12));
  const parts = hash.split("$");
  assert.equal(parts.length, 6);
  assert.equal(parts[0], "scrypt");
  assert.equal(Number(parts[1]), 2 ** 17);
});

test("verify fails closed on malformed stored values (never throws)", () => {
  for (const stored of [
    "",
    "plaintext-password",
    "scrypt$not$numbers$here$AAAA$BBBB",
    "scrypt$131072$8$1$$",
    "scrypt$131072$8$1$c2FsdA==$", // empty key
    "bcrypt$2b$10$abcdefghijklmnopqrstuv",
    "scrypt$131072$8$1$c2FsdA==", // missing field
  ]) {
    assert.equal(verifyPassword("anything", stored), false, `expected false for ${JSON.stringify(stored)}`);
  }
});

test("verify rejects memory-DoS / weak parameters in stored values", () => {
  const hash = hashPassword("a real password");
  const parts = hash.split("$");
  const forged = (n: string, r: string, p: string) =>
    ["scrypt", n, r, p, parts[4], parts[5]].join("$");
  assert.equal(verifyPassword("a real password", forged("2097152", "8", "1")), false, "N too large");
  assert.equal(verifyPassword("a real password", forged("1024", "8", "1")), false, "N too small");
  assert.equal(verifyPassword("a real password", forged("131072", "64", "1")), false, "r too large");
  assert.equal(verifyPassword("a real password", forged("131072", "8", "9")), false, "p too large");
});
