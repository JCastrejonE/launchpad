import test from "node:test";
import assert from "node:assert/strict";
import { createStderrTail } from "./stderr-tail.js";
import { SessionStalledError } from "./session.js";

test("spec 0219 E: keeps the last lines, drops the older ones", () => {
  const tail = createStderrTail(3);
  tail.capture("one\ntwo\n");
  tail.capture("three\nfour\n");
  assert.equal(tail.tail(), "two\nthree\nfour");
});

test("spec 0219 E: blank lines are not evidence", () => {
  const tail = createStderrTail();
  tail.capture("\n\n  \nreal line\n");
  assert.equal(tail.tail(), "real line");
});

test("spec 0219 E: silence is a fact, and the error says so", () => {
  const tail = createStderrTail();
  assert.equal(tail.tail(), "");
  const err = new SessionStalledError("coder", 300_000, "system", tail.tail());
  assert.match(err.message, /nothing at all/);
  assert.equal(err.subprocessStderr, "");
});

test("spec 0219 E: a stall carries the subprocess's own words, not just our timeout", () => {
  const err = new SessionStalledError("initializer", 300_000, "system", "429 rate limited, retrying");
  assert.match(err.message, /429 rate limited, retrying/);
  assert.match(err.message, /300000ms/); // ours is still there
  assert.equal(err.subprocessStderr, "429 rate limited, retrying");
});
