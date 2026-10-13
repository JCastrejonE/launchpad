import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSessionTiming } from "./session-timing.js";

test("formatSessionTiming renders a stable greppable line", () => {
  assert.equal(
    formatSessionTiming({
      role: "coder",
      spec: "0018",
      model: "claude-sonnet-5",
      seconds: 42,
      turns: 7,
      costUsd: 0.03,
    }),
    "[session] role=coder spec=0018 model=claude-sonnet-5 seconds=42 turns=7 costUsd=0.03",
  );
});

test("formatSessionTiming omits absent optional fields", () => {
  assert.equal(
    formatSessionTiming({ role: "initializer", seconds: 300 }),
    "[session] role=initializer seconds=300",
  );
});

test("formatSessionTiming emits spec=NNNN when present, omits it when absent", () => {
  assert.equal(
    formatSessionTiming({ role: "fixer", spec: "0018", seconds: 12 }),
    "[session] role=fixer spec=0018 seconds=12",
  );
});
