import { test } from "node:test";
import assert from "node:assert/strict";
import type { Gate2PollState } from "@launchpad/pipeline";
import { deriveGate2PollBadge, GATE2_POLL_FAILED_MESSAGE } from "./gate2-poll";

// Contract tests — pass against the stub AND the final implementation.

test("undefined poll (query unavailable / pre-0016 run) renders no badge", () => {
  assert.equal(deriveGate2PollBadge(undefined), null);
});

test("healthy poll states render no badge", () => {
  for (const status of ["idle", "polling", "settled"] as const) {
    const poll: Gate2PollState = { status, error: null };
    assert.equal(deriveGate2PollBadge(poll), null, `status=${status} must not badge`);
  }
});

test("a failed poll renders the loud badge with the shared copy", () => {
  const poll: Gate2PollState = { status: "failed", error: "getPrState 500" };
  const badge = deriveGate2PollBadge(poll);
  assert.ok(badge, "failed poll must produce a badge");
  assert.equal(badge?.message, GATE2_POLL_FAILED_MESSAGE);
});
