import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePolishAction } from "./polish-decision.js";

test("decidePolishAction: non-web run skips regardless of other flags", () => {
  assert.equal(decidePolishAction({ touchesWeb: false, polished: false, autoPolish: false }), "skip");
  assert.equal(decidePolishAction({ touchesWeb: false, polished: false, autoPolish: true }), "skip");
});

test("decidePolishAction: already-polished web run skips (no re-polish)", () => {
  assert.equal(decidePolishAction({ touchesWeb: true, polished: true, autoPolish: false }), "skip");
});

test("decidePolishAction: web run, not polished, --auto-polish set → auto-spawn (opt-in)", () => {
  assert.equal(decidePolishAction({ touchesWeb: true, polished: false, autoPolish: true }), "auto-spawn");
});

// Spec 0108: THE DEFAULT IS NOW A HUMAN PAUSE. An unattended agent must not
// commit to main and push without review.
test("decidePolishAction: web run, not polished, default → manual-pause (NOT auto-spawn)", () => {
  assert.equal(decidePolishAction({ touchesWeb: true, polished: false, autoPolish: false }), "manual-pause");
});
