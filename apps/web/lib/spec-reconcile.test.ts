/**
 * Spec 0165. The cases that matter are the ones that already happened: four specs
 * in one day said `draft`/`approved` while their code was on main. And the case
 * that must NOT happen: marking something shipped on weak evidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { allNonHumanItemsChecked, decideSpecStatusRepair } from "./spec-reconcile";
import { progressSection } from "./spec-reconcile-run";

test("track 2: a merged branch promotes — the 0147/0162 debris", () => {
  assert.equal(decideSpecStatusRepair({ track: 2, status: "approved", merged: true }), "promoted");
  assert.equal(decideSpecStatusRepair({ track: 2, status: "draft", merged: true }), "promoted");
});

test("track 2: NOT merged, or unknowable, changes nothing", () => {
  assert.equal(decideSpecStatusRepair({ track: 2, status: "approved", merged: false }), null);
  // git could not answer. Treating that as "not merged" is right; treating it as
  // merged would mark unshipped code as shipped.
  assert.equal(decideSpecStatusRepair({ track: 2, status: "approved" }), null);
});

test("track 1: all machine work done completes it (the owner's call to auto-repair)", () => {
  assert.equal(decideSpecStatusRepair({ track: 1, status: "draft", allWorkDone: true }), "completed");
  // Absent track is track 1, matching deriveSpecProgress.
  assert.equal(decideSpecStatusRepair({ status: "draft", allWorkDone: true }), "completed");
  assert.equal(decideSpecStatusRepair({ track: 1, status: "draft", allWorkDone: false }), null);
});

test("a terminal status is never re-decided", () => {
  for (const status of ["promoted", "completed", "rejected"]) {
    assert.equal(decideSpecStatusRepair({ track: 2, status, merged: true }), null);
    assert.equal(decideSpecStatusRepair({ track: 1, status, allWorkDone: true }), null);
  }
});

test("track 2 is never completed by its checklist, and track 1 is never promoted", () => {
  // A track-2 spec with every box ticked but no merge is still not shipped.
  assert.equal(decideSpecStatusRepair({ track: 2, status: "draft", allWorkDone: true }), null);
  // A track-1 spec has no branch to merge, so `merged` cannot promote it.
  assert.equal(decideSpecStatusRepair({ track: 1, status: "draft", merged: true }), null);
});

test("allNonHumanItemsChecked ignores (human) items but requires real work", () => {
  assert.equal(
    allNonHumanItemsChecked("- [x] [code] a thing\n- [ ] (human) a pixel check\n"),
    true,
    "a finished spec waiting only on a human check IS done for the machine",
  );
  assert.equal(allNonHumanItemsChecked("- [x] [code] a thing\n- [ ] [test] another\n"), false);
  // Numbered `(human)` items — the 2026-07-03 form that once looped the coder.
  assert.equal(allNonHumanItemsChecked("- [x] [code] a\n- [ ] 10. (human) b\n"), true);
  // Never "done" on an empty set: no checklist, or only human items.
  assert.equal(allNonHumanItemsChecked(""), false);
  assert.equal(allNonHumanItemsChecked("- [ ] (human) only this\n"), false);
});

/**
 * Spec 0165: `progressSection` decides what the Track-1 rule even reads. If it
 * grabbed the whole document, unchecked boxes in `## Plan` or a handoff entry
 * would keep a finished spec from ever completing — the same dual-checklist drift
 * that once made the coder loop burn two no-op sessions per run.
 */
test("progressSection reads ONLY the Progress block", () => {
  const body = [
    "## Plan",
    "- [ ] prose with a stray box",
    "",
    "## Progress",
    "- [x] [code] the real work",
    "",
    "## Handoff log",
    "- [ ] a box in a handoff note",
  ].join("\n");
  const section = progressSection(body);
  assert.match(section, /the real work/);
  assert.doesNotMatch(section, /stray box/);
  assert.doesNotMatch(section, /handoff note/);
  // …and the whole point: the spec reads as done despite two unchecked boxes
  // elsewhere in the file.
  assert.equal(allNonHumanItemsChecked(section), true);
});

test("progressSection is empty when there is no Progress section", () => {
  assert.equal(progressSection("# Title\n\nsome prose\n"), "");
  assert.equal(allNonHumanItemsChecked(""), false);
});
