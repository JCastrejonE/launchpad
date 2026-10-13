/**
 * Fail-open audit writer for apps/web (spec 0075). Every effectful web
 * action calls `recordAudit` AFTER its mutation succeeds; a failed audit
 * write (Postgres down, DATABASE_URL unset) is logged server-side and NEVER
 * blocks or fails the action — deliberate for the single-owner control
 * plane (see the spec's write-semantics note; flip a call site to await +
 * throw if an action ever must be fail-closed).
 *
 * Injectable deps (the ChatToolDeps pattern) so tests prove fail-open
 * without a database.
 */
import { insertAuditLog, type AuditEntry, type Db } from "@launchpad/db";
import { getDb } from "./db";

export interface AuditDeps {
  insert: (db: Db, entry: AuditEntry) => Promise<void>;
  db: () => Db;
  logError: (message: string, err: unknown) => void;
}

export const defaultAuditDeps: AuditDeps = {
  insert: insertAuditLog,
  db: getDb,
  logError: (message, err) => console.error(message, err),
};

/** Append one audit row; resolves no matter what (fail-open). */
export async function recordAudit(entry: AuditEntry, deps: AuditDeps = defaultAuditDeps): Promise<void> {
  try {
    await deps.insert(deps.db(), entry);
  } catch (err) {
    // The entry's action/target are safe to log (never content/secrets).
    deps.logError(`audit write failed for ${entry.action} on ${entry.target}`, err);
  }
}

/** Gate-signal → audit action ("specApproved" → "gate.spec-approved"), so
 * the camelCase workflow signal names fit the dotted lower-case audit
 * grammar without a hand-kept map. */
export function gateAuditAction(signal: string): string {
  return `gate.${signal.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}
