/**
 * Minimal encrypted secret store (spec 0076; SPEC §13). AES-256-GCM over the
 * `secrets` table: one master key from LAUNCHPAD_SECRET_MASTER_KEY (the env
 * holds ONE key instead of many secrets; agents never see it — it is not on
 * the 0069 env-scrub allowlist), the secret's NAME as AAD so a ciphertext
 * moved to another row refuses to decrypt, fresh random IV per write.
 * Values are NEVER logged and never appear in error messages.
 *
 * Rotation seam, not rotation tooling: rows carry key_id "v1"; decrypting a
 * row with an unknown key_id throws instead of silently trying the wrong
 * key. A future "v2" adds a key map + re-encrypt sweep.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { secrets } from "./schema.js";

export const SECRET_MASTER_KEY_ENV = "LAUNCHPAD_SECRET_MASTER_KEY";
export const DEFAULT_KEY_ID = "v1";

const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Config-class failure (missing/malformed master key, missing DATABASE_URL
 * in the env-backed store) — callers map this to their nonRetryable error
 * taxonomy. Never carries key material. */
export class SecretConfigError extends Error {}

export function loadSecretMasterKey(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  const raw = env[SECRET_MASTER_KEY_ENV];
  if (!raw) {
    throw new SecretConfigError(
      `${SECRET_MASTER_KEY_ENV} is not set (base64 of 32 random bytes; generate: openssl rand -base64 32)`,
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new SecretConfigError(`${SECRET_MASTER_KEY_ENV} is not valid base64`);
  }
  if (key.length !== KEY_BYTES) {
    throw new SecretConfigError(
      `${SECRET_MASTER_KEY_ENV} must decode to exactly ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}

/** The three base64 cipher parts matching the 0072 `secrets` columns. */
export interface SecretCipherParts {
  iv: string;
  ciphertext: string;
  tag: string;
}

export function encryptSecret(key: Buffer, name: string, value: string): SecretCipherParts {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** Throws on any tamper/mismatch (wrong key, altered ciphertext or tag, or a
 * different `name` than the one encrypted under — the AAD binding). The error
 * never includes plaintext or key material. */
export function decryptSecret(key: Buffer, name: string, parts: SecretCipherParts): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts.iv, "base64"));
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(Buffer.from(parts.tag, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(parts.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(`secret ${JSON.stringify(name)} failed authenticated decryption (tampered, moved, or wrong key)`);
  }
}

/** Upsert (encrypt-then-write); bumps updated_at on overwrite. */
export async function putSecret(db: Db, key: Buffer, name: string, value: string): Promise<void> {
  const parts = encryptSecret(key, name, value);
  await db
    .insert(secrets)
    .values({ name, keyId: DEFAULT_KEY_ID, ...parts })
    .onConflictDoUpdate({
      target: secrets.name,
      set: { keyId: DEFAULT_KEY_ID, ...parts, updatedAt: new Date() },
    });
}

/** null when the secret doesn't exist; throws on tamper or unknown key_id. */
export async function getSecret(db: Db, key: Buffer, name: string): Promise<string | null> {
  const rows = await db.select().from(secrets).where(eq(secrets.name, name)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.keyId !== DEFAULT_KEY_ID) {
    throw new Error(`secret ${JSON.stringify(name)} was encrypted under unknown key_id ${JSON.stringify(row.keyId)}`);
  }
  return decryptSecret(key, name, { iv: row.iv, ciphertext: row.ciphertext, tag: row.tag });
}

/** Narrow consumer-facing facade — what fleet-hostinger injects in tests. */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  put(name: string, value: string): Promise<void>;
}

export function dbSecretStore(db: Db, key: Buffer): SecretStore {
  return {
    get: (name) => getSecret(db, key, name),
    put: (name, value) => putSecret(db, key, name, value),
  };
}

/**
 * Env-backed store for worker/CLI callers: pool + master key are resolved
 * LAZILY on first use (importing this module never throws), and init
 * failures — missing DATABASE_URL or master key — surface as
 * `SecretConfigError` so callers can classify them nonRetryable.
 */
export function envSecretStore(env: Record<string, string | undefined> = process.env): SecretStore {
  let inner: SecretStore | null = null;
  const init = async (): Promise<SecretStore> => {
    if (inner) return inner;
    const { createDb, createPool } = await import("./client.js");
    let key: Buffer;
    let db: Db;
    try {
      key = loadSecretMasterKey(env);
      db = createDb(createPool(env));
    } catch (err) {
      if (err instanceof SecretConfigError) throw err;
      throw new SecretConfigError(err instanceof Error ? err.message : String(err));
    }
    inner = dbSecretStore(db, key);
    return inner;
  };
  return {
    get: async (name) => (await init()).get(name),
    put: async (name, value) => (await init()).put(name, value),
  };
}
