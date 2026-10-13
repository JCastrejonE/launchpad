import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  decryptSecret,
  encryptSecret,
  envSecretStore,
  loadSecretMasterKey,
  SECRET_MASTER_KEY_ENV,
  SecretConfigError,
} from "./secret-store.js";

const KEY = randomBytes(32);

test("encrypt → decrypt round-trips", () => {
  const parts = encryptSecret(KEY, "tenant/acme/db-password", "s3cret-value");
  assert.equal(decryptSecret(KEY, "tenant/acme/db-password", parts), "s3cret-value");
});

test("two encryptions of the same value differ (fresh IV each write)", () => {
  const a = encryptSecret(KEY, "n", "same");
  const b = encryptSecret(KEY, "n", "same");
  assert.notEqual(a.ciphertext + a.iv, b.ciphertext + b.iv);
});

test("wrong key refuses to decrypt", () => {
  const parts = encryptSecret(KEY, "n", "value");
  assert.throws(() => decryptSecret(randomBytes(32), "n", parts), /authenticated decryption/);
});

test("AAD binding: a ciphertext moved to a different name refuses to decrypt", () => {
  const parts = encryptSecret(KEY, "tenant/acme/db-password", "value");
  assert.throws(() => decryptSecret(KEY, "tenant/evil/db-password", parts), /authenticated decryption/);
});

test("tampered ciphertext and tampered tag both refuse", () => {
  const parts = encryptSecret(KEY, "n", "value");
  const flip = (b64: string): string => {
    const buf = Buffer.from(b64, "base64");
    buf[0] = (buf[0] ?? 0) ^ 0xff;
    return buf.toString("base64");
  };
  assert.throws(() => decryptSecret(KEY, "n", { ...parts, ciphertext: flip(parts.ciphertext) }));
  assert.throws(() => decryptSecret(KEY, "n", { ...parts, tag: flip(parts.tag) }));
});

test("decryption errors never leak plaintext or key material", () => {
  const parts = encryptSecret(KEY, "n", "super-secret-plaintext");
  try {
    decryptSecret(randomBytes(32), "n", parts);
    assert.fail("expected a throw");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert.ok(!message.includes("super-secret-plaintext"));
    assert.ok(!message.includes(KEY.toString("base64")));
  }
});

test("loadSecretMasterKey: missing, non-base64-decodable-to-32, and short keys are refused", () => {
  assert.throws(() => loadSecretMasterKey({}), SecretConfigError);
  assert.throws(() => loadSecretMasterKey({ [SECRET_MASTER_KEY_ENV]: "dG9vLXNob3J0" }), SecretConfigError);
  const key = loadSecretMasterKey({ [SECRET_MASTER_KEY_ENV]: randomBytes(32).toString("base64") });
  assert.equal(key.length, 32);
});

test("loadSecretMasterKey errors never echo the configured value", () => {
  const value = "dG9vLXNob3J0";
  try {
    loadSecretMasterKey({ [SECRET_MASTER_KEY_ENV]: value });
    assert.fail("expected a throw");
  } catch (err) {
    assert.ok(!(err instanceof Error && err.message.includes(value)));
  }
});

test("envSecretStore: import-safe, but first use without config throws SecretConfigError", async () => {
  const store = envSecretStore({});
  await assert.rejects(store.get("anything"), SecretConfigError);
  await assert.rejects(store.put("anything", "v"), SecretConfigError);
});

test("envSecretStore: master key present but DATABASE_URL missing is still a SecretConfigError", async () => {
  const store = envSecretStore({ [SECRET_MASTER_KEY_ENV]: randomBytes(32).toString("base64") });
  await assert.rejects(store.get("anything"), SecretConfigError);
});
