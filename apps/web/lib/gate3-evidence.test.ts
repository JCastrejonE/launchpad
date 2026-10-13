import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveGate3Evidence } from "./gate3-evidence.js";
import type { PipelineTarget } from "@launchpad/pipeline";

const PLATFORM: PipelineTarget = { kind: "self", repo: "/repo" };
const TENANT: PipelineTarget = {
  kind: "tenant", tenantId: "sandbox", repo: "/repo", odooVersion: 18, vpsId: 100001,
};
const CI_GREEN = { enabled: true, tone: "ok" as const, message: "CI local verde — listo para promover." };
const CI_RED = { enabled: false, tone: "danger" as const, message: "CI local falló — promoción bloqueada." };

test("blocked CI disables promote and surfaces the guard's own message verbatim", () => {
  // The guard already refuses inside runWorkspaceGateAction; the point of the panel
  // is that you learn WHY before clicking, not after.
  const e = deriveGate3Evidence({ promoteGate: CI_RED, target: PLATFORM });
  assert.equal(e.canPromote, false);
  assert.equal(e.tone, "danger");
  assert.equal(e.verdict, CI_RED.message); // delegated, never restated
});

test("green CI allows promote", () => {
  const e = deriveGate3Evidence({ promoteGate: CI_GREEN, target: PLATFORM });
  assert.equal(e.canPromote, true);
  assert.equal(e.tone, "ok");
});

test("a tenant run has NO PR, so absence of CI reads as absence of signal — not approval", () => {
  // This is the case that had no evidence on either surface before spec 0111.
  const e = deriveGate3Evidence({ promoteGate: null, target: TENANT, restorePoints: [] });
  assert.equal(e.canPromote, true, "no CI is not a blocker; gate 3 is the human's timing call");
  assert.equal(e.tone, "info", "must not read as green");
  assert.match(e.verdict, /no hay señal de CI/);
});

test("what-will-run is honest per target: platform executes nothing further", () => {
  // deployToProduction returns immediately for self — claiming a deploy would lie.
  const e = deriveGate3Evidence({ promoteGate: CI_GREEN, target: PLATFORM });
  assert.match(e.willRun, /la fusión ES el despliegue/);
  assert.doesNotMatch(e.willRun, /Despliega el tenant/);
});

test("what-will-run names the tenant, VPS and Odoo version — concrete, not reassuring", () => {
  const e = deriveGate3Evidence({ promoteGate: null, target: TENANT, restorePoints: [] });
  assert.match(e.willRun, /sandbox/);
  assert.match(e.willRun, /100001/);
  assert.match(e.willRun, /Odoo 18/);
});

test("an unknown target says so rather than guessing what promote does", () => {
  const e = deriveGate3Evidence({ promoteGate: CI_GREEN });
  assert.match(e.willRun, /Objetivo desconocido/);
});

test("reversibility: a tenant with restore points reports how many and the newest", () => {
  const e = deriveGate3Evidence({
    promoteGate: null, target: TENANT,
    restorePoints: ["20260730T022940Z", "20260730T022848Z"],
  });
  assert.match(e.reversibility, /2 puntos de restauración/);
  assert.match(e.reversibility, /20260730T022940Z/);
  assert.match(e.reversibility, /acción aparte y deliberada/);
});

test("reversibility: singular reads correctly (no '1 restore points')", () => {
  const e = deriveGate3Evidence({ promoteGate: null, target: TENANT, restorePoints: ["20260730T022848Z"] });
  assert.match(e.reversibility, /1 punto de restauración;/);
});

test("reversibility: a tenant with NO restore point says it cannot be undone", () => {
  const e = deriveGate3Evidence({ promoteGate: null, target: TENANT, restorePoints: [] });
  assert.match(e.reversibility, /no se puede deshacer/);
});

test("reversibility: unreadable restore points differ from 'none exist'", () => {
  // undefined = we could not look (no SSH / non-sandbox VPS). Reporting that as
  // "none exist" would understate what we know.
  const unreadable = deriveGate3Evidence({ promoteGate: null, target: TENANT });
  const none = deriveGate3Evidence({ promoteGate: null, target: TENANT, restorePoints: [] });
  assert.match(unreadable.reversibility, /No se pudieron leer/);
  assert.notEqual(unreadable.reversibility, none.reversibility);
});

test("reversibility: the platform target admits there is no rollback at all", () => {
  // Verified while writing spec 0105: no rollback machinery exists for self.
  const e = deriveGate3Evidence({ promoteGate: CI_GREEN, target: PLATFORM });
  assert.match(e.reversibility, /no hay rollback/);
});
