import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_STATUSES } from "./specs";
import { getStatusBadgeStyle } from "./status-badge";

test("every known status has a border of 'none' (fallback is the only one with a border)", () => {
  for (const status of KNOWN_STATUSES) {
    assert.equal(getStatusBadgeStyle(status).border, "none");
  }
});

test("known statuses map to pairwise-distinct background colors", () => {
  const backgrounds = KNOWN_STATUSES.map((status) => getStatusBadgeStyle(status).background);
  assert.equal(new Set(backgrounds).size, backgrounds.length);
});

test("an unknown status gets a visibly distinct fallback style (dashed border)", () => {
  const fallback = getStatusBadgeStyle("made-up-status");
  assert.notEqual(fallback.border, "none");
  assert.match(fallback.border, /dashed/);
  const knownBackgrounds = new Set(KNOWN_STATUSES.map((s) => getStatusBadgeStyle(s).background));
  assert.ok(
    !knownBackgrounds.has(fallback.background) || fallback.border !== "none",
    "fallback must differ from every known style in at least color or border",
  );
});
