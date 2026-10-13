import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEntry, Db } from "@launchpad/db";
import { auditEntryValues } from "@launchpad/db";
import { gateAuditAction, recordAudit, type AuditDeps } from "./audit.js";

function fakeDeps(insert: AuditDeps["insert"]): AuditDeps & { logged: string[] } {
  const logged: string[] = [];
  return {
    insert,
    db: () => ({}) as Db,
    logError: (message) => logged.push(message),
    logged,
  };
}

test("recordAudit passes the entry through to the insert", async () => {
  const inserted: AuditEntry[] = [];
  const deps = fakeDeps(async (_db, entry) => {
    inserted.push(entry);
  });
  await recordAudit({ actor: "owner@example.com", action: "gate.promote", target: "0042" }, deps);
  assert.deepEqual(inserted, [{ actor: "owner@example.com", action: "gate.promote", target: "0042" }]);
  assert.deepEqual(deps.logged, []);
});

test("recordAudit is fail-open: a rejecting insert resolves and logs", async () => {
  const deps = fakeDeps(async () => {
    throw new Error("postgres is down");
  });
  await assert.doesNotReject(recordAudit({ actor: "a@b.co", action: "tenant.start", target: "acme" }, deps));
  assert.equal(deps.logged.length, 1);
  assert.match(deps.logged[0] ?? "", /tenant\.start/);
});

test("gateAuditAction maps every workflow signal into the audit grammar", () => {
  const expected: Record<string, string> = {
    specApproved: "gate.spec-approved",
    prApproved: "gate.pr-approved",
    promote: "gate.promote",
    specRejected: "gate.spec-rejected",
  };
  for (const [signal, action] of Object.entries(expected)) {
    assert.equal(gateAuditAction(signal), action);
    // ...and each result passes the package's strict action validation.
    assert.doesNotThrow(() => auditEntryValues({ actor: "a@b.co", action, target: "0042" }));
  }
});

test("recordAudit is fail-open even when db() itself throws (DATABASE_URL unset)", async () => {
  const deps: AuditDeps & { logged: string[] } = {
    ...fakeDeps(async () => {}),
    db: () => {
      throw new Error("DATABASE_URL is not set");
    },
  };
  await assert.doesNotReject(recordAudit({ actor: "a@b.co", action: "auth.signin", target: "a@b.co" }, deps));
  assert.equal(deps.logged.length, 1);
});
