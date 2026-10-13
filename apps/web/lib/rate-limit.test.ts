import assert from "node:assert/strict";
import { test } from "node:test";
import { SlidingWindowLimiter } from "./rate-limit.js";

test("allows up to the limit inside a window, then refuses", () => {
  let t = 0;
  const limiter = new SlidingWindowLimiter(3, 1000, () => t);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
});

test("keys are independent", () => {
  const limiter = new SlidingWindowLimiter(1, 1000, () => 0);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("b"), true);
  assert.equal(limiter.allow("a"), false);
});

test("window slides: old hits expire", () => {
  let t = 0;
  const limiter = new SlidingWindowLimiter(2, 1000, () => t);
  limiter.allow("a");
  t = 500;
  limiter.allow("a");
  assert.equal(limiter.allow("a"), false);
  t = 1001; // first hit (t=0) is now outside the window
  assert.equal(limiter.allow("a"), true);
});

test("refused attempts do not extend the ban", () => {
  let t = 0;
  const limiter = new SlidingWindowLimiter(1, 1000, () => t);
  limiter.allow("a");
  for (t = 100; t < 1000; t += 100) assert.equal(limiter.allow("a"), false);
  t = 1001; // only the ORIGINAL allowed hit counts against the window
  assert.equal(limiter.allow("a"), true);
});
