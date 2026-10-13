import assert from "node:assert/strict";
import { test } from "node:test";
import { auditEntryValues } from "./audit.js";

test("a well-formed entry normalizes (trim) and defaults metadata to {}", () => {
  const values = auditEntryValues({ actor: " owner@example.com ", action: "gate.promote", target: " 0042 " });
  assert.deepEqual(values, { actor: "owner@example.com", action: "gate.promote", target: "0042", metadata: {} });
});

test("actions must be dotted lower-case verbs", () => {
  for (const good of ["gate.prApproved".toLowerCase(), "pipeline.start", "console.resume-polished", "auth.signin_failed"]) {
    assert.doesNotThrow(() => auditEntryValues({ actor: "a@b.co", action: good, target: "t" }), good);
  }
  for (const bad of ["", "promote", "Gate.Promote", "gate..promote", ".start", "gate.promote!", "gate promote"]) {
    assert.throws(() => auditEntryValues({ actor: "a@b.co", action: bad, target: "t" }), new RegExp("dotted"), bad);
  }
});

test("empty actor or target throws", () => {
  assert.throws(() => auditEntryValues({ actor: "  ", action: "a.b", target: "t" }));
  assert.throws(() => auditEntryValues({ actor: "a@b.co", action: "a.b", target: "" }));
});

test("metadata must be a plain JSON-serializable object", () => {
  assert.throws(() => auditEntryValues({ actor: "a@b.co", action: "a.b", target: "t", metadata: [1] as unknown as Record<string, unknown> }));
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.throws(() => auditEntryValues({ actor: "a@b.co", action: "a.b", target: "t", metadata: cyclic }));
  const values = auditEntryValues({ actor: "a@b.co", action: "a.b", target: "t", metadata: { mode: "start", n: 2 } });
  assert.deepEqual(values.metadata, { mode: "start", n: 2 });
});

test("undefined metadata values are dropped by serialization, not stored", () => {
  const values = auditEntryValues({ actor: "a@b.co", action: "a.b", target: "t", metadata: { keep: 1, drop: undefined } });
  assert.deepEqual(values.metadata, { keep: 1 });
});
