/**
 * AuditLog writes (spec 0075; SPEC §5/§13). Append-only: this module only
 * inserts. The pure normalization is split from the insert so call-site
 * hygiene (action grammar, no-garbage metadata) is unit-testable without a
 * database. Callers must never put secrets, passwords, prompts, or message
 * content in `metadata` — target/ids/flags only.
 */
import { auditLog } from "./schema.js";
import type { Db } from "./client.js";

export interface AuditEntry {
  /** Verified session email, attempted email (auth failures), or agent role. */
  actor: string;
  /** Dotted lower-case verb, e.g. "gate.promote", "pipeline.start". */
  action: string;
  /** What was acted on: spec id, tenant id, thread id, email. */
  target: string;
  /** Small, flat JSON context (ids/flags). NEVER content or secrets. */
  metadata?: Record<string, unknown>;
}

const ACTION_RE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

/** Validate + shape an entry for insert. Throws on malformed input — a bad
 * call site is a programming error we want loud in tests, while the runtime
 * fail-open lives in the caller's wrapper (apps/web lib/audit.ts). */
export function auditEntryValues(entry: AuditEntry): typeof auditLog.$inferInsert {
  const actor = entry.actor.trim();
  if (!actor) throw new Error("audit entry needs a non-empty actor");
  if (!ACTION_RE.test(entry.action)) {
    throw new Error(`audit action ${JSON.stringify(entry.action)} must be dotted lower-case (e.g. "gate.promote")`);
  }
  const target = entry.target.trim();
  if (!target) throw new Error("audit entry needs a non-empty target");
  const metadata = entry.metadata ?? {};
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error("audit metadata must be a plain object");
  }
  // Round-trip proves JSON-serializable (drizzle would otherwise fail deeper,
  // or worse, store something surprising for BigInt/undefined/cycles).
  let serialized: Record<string, unknown>;
  try {
    serialized = JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
  } catch {
    throw new Error("audit metadata must be JSON-serializable");
  }
  return { actor, action: entry.action, target, metadata: serialized };
}

export async function insertAuditLog(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values(auditEntryValues(entry));
}
