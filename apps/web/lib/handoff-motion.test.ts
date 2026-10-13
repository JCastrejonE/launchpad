import { test } from "node:test";
import assert from "node:assert/strict";
import { pickNewEntryKeys } from "./handoff-motion";

test("nothing is new when every current key was already seen", () => {
  assert.deepEqual(pickNewEntryKeys(new Set(["a", "b"]), ["a", "b"]), []);
});

test("a prepended key is picked up as new (DESIGN.md §4.2 #6 trigger)", () => {
  assert.deepEqual(pickNewEntryKeys(new Set(["b", "c"]), ["a", "b", "c"]), ["a"]);
});

test("multiple simultaneous new keys are all picked up", () => {
  assert.deepEqual(pickNewEntryKeys(new Set(["c"]), ["a", "b", "c"]), ["a", "b"]);
});

test("an empty current list never reports anything new", () => {
  assert.deepEqual(pickNewEntryKeys(new Set(["a"]), []), []);
});

test("an empty seen set treats every current key as new", () => {
  assert.deepEqual(pickNewEntryKeys(new Set(), ["a", "b"]), ["a", "b"]);
});
