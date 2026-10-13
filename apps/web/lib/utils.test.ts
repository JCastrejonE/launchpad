import { test } from "node:test";
import assert from "node:assert/strict";
import { cn } from "./utils.js";

test("cn joins truthy class values", () => {
  assert.equal(cn("a", false && "b", undefined, "c"), "a c");
});

test("cn de-dupes conflicting tailwind utilities, keeping the last", () => {
  assert.equal(cn("p-2", "p-4"), "p-4");
});
