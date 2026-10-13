import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRunRecap, RECAP_CAP } from "./run-recap.js";
import type { HandoffEntryParts } from "./specs.js";
import type { NextStep } from "./next-step.js";

const entry = (lead: string, fields: Record<string, string> = {}): HandoffEntryParts => ({
  lead, body: "", fields: Object.entries(fields).map(([key, value]) => ({ key, value })),
});
const GATE: NextStep = { kind: "gate", label: "Promover", actions: ["promote"] };
const DONE: NextStep = { kind: "none", label: "Nada que hacer" };

test("did/found/next are assembled from prose the agents already wrote", () => {
  const r = deriveRunRecap({
    entries: [
      entry("**2026-07-30 / coder:** wired the panel.", { Next: "screenshot it", Surprises: "the tab is client-side" }),
      entry("**2026-07-29 / initializer:** laid foundations.", { Surprises: "no rollback exists" }),
    ],
    nextStep: GATE,
  });
  assert.equal(r.did.length, 2);
  assert.match(r.did[0]!, /wired the panel/);
  assert.deepEqual(r.found, ["the tab is client-side", "no rollback exists"]);
  assert.equal(r.next, "screenshot it"); // newest entry's Next:, not an older one
  assert.equal(r.empty, false);
});

test("'needs you' comes from deriveNextStep, NEVER from the prose", () => {
  // The whole point: a `Next:` field records what an agent thought when it wrote
  // the entry; needsYou records what is outstanding NOW. Spec 0109 defect 1 was
  // exactly this failure — a stale actionable line is worse than none.
  const r = deriveRunRecap({
    entries: [entry("**x / coder:** did a thing.", { Next: "this is stale advice" })],
    nextStep: GATE,
  });
  assert.equal(r.needsYou, "Promover");
  assert.notEqual(r.needsYou, r.next);
  assert.equal(r.next, "this is stale advice", "the prose is still shown, just not AS the action");
});

test("a terminal next step surfaces no call to action (never manufacture work)", () => {
  const r = deriveRunRecap({ entries: [entry("**x / coder:** done.")], nextStep: DONE });
  assert.equal(r.needsYou, undefined);
});

test("an empty handoff log is an honest empty recap, not invented narrative", () => {
  const r = deriveRunRecap({ entries: [], nextStep: DONE });
  assert.equal(r.empty, true);
  assert.deepEqual(r.did, []);
  assert.deepEqual(r.found, []);
  assert.equal(r.next, undefined);
});

test("entries with no labelled fields still contribute their lead", () => {
  const r = deriveRunRecap({ entries: [entry("**x / coder:** just prose, no fields.")], nextStep: DONE });
  assert.equal(r.did.length, 1);
  assert.deepEqual(r.found, []);
  assert.equal(r.next, undefined);
});

test("both lists are capped — handoff entries run to paragraphs (spec 0109's lesson)", () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    entry(`**e${i} / coder:** thing ${i}.`, { Surprises: `surprise ${i}` }));
  const r = deriveRunRecap({ entries: many, nextStep: DONE });
  assert.equal(r.did.length, RECAP_CAP);
  assert.equal(r.found.length, RECAP_CAP);
  assert.match(r.did[0]!, /thing 0/, "newest first, not an arbitrary slice");
});

test("field lookup is case-insensitive — the convention is written by hand", () => {
  const r = deriveRunRecap({
    entries: [entry("**x / coder:** y.", { next: "lowercase", surprises: "also lowercase" })],
    nextStep: DONE,
  });
  assert.equal(r.next, "lowercase");
  assert.deepEqual(r.found, ["also lowercase"]);
});

test("a blank field value is treated as absent, not as an empty line", () => {
  const r = deriveRunRecap({ entries: [entry("**x / coder:** y.", { Next: "   " })], nextStep: DONE });
  assert.equal(r.next, undefined);
});

test("entries are sorted by DATE, not by document order (either direction)", () => {
  // The bug the first render showed: agents PREPEND (HANDOFF.md says "append"),
  // and hand-authored entries land anywhere, so spec 0105's log reads
  // 07-29, 07-30, 07-29 in file order. Neither that nor its reverse is newest-first.
  const r = deriveRunRecap({
    entries: [
      entry("**2026-07-29 / coder:** middle."),
      entry("**2026-07-30 / author:** newest."),
      entry("**2026-07-28 / initializer:** oldest."),
    ],
    nextStep: DONE,
  });
  assert.match(r.did[0]!, /newest/);
  assert.match(r.did[2]!, /oldest/);
});

test("undated entries keep their relative order rather than being dropped", () => {
  const r = deriveRunRecap({
    entries: [entry("no date here, first"), entry("**2026-07-30 / x:** dated."), entry("no date here, second")],
    nextStep: DONE,
  });
  assert.equal(r.did.length, 3);
  assert.match(r.did[0]!, /dated/, "dated entries sort above undated");
  assert.match(r.did[1]!, /first/);
  assert.match(r.did[2]!, /second/);
});
