import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_STATUSES, isKnownStatus, isLiveStatus } from "./spec-status";

test("every KNOWN_STATUSES entry is known", () => {
  for (const status of KNOWN_STATUSES) {
    assert.equal(isKnownStatus(status), true, status);
  }
});

test("an unrecognized status is not known", () => {
  assert.equal(isKnownStatus("made-up-status"), false);
});

test("only in_progress is a live status (DESIGN.md §4.2 #1 live-dot trigger)", () => {
  assert.equal(isLiveStatus("in_progress"), true);
  for (const status of KNOWN_STATUSES) {
    if (status === "in_progress") continue;
    assert.equal(isLiveStatus(status), false, status);
  }
});

test("an unrecognized status is not live either", () => {
  assert.equal(isLiveStatus("made-up-status"), false);
});
