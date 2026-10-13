import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_ACTIVITY_OPTIONS,
  ACTIVITY_OPTIONS,
  PR_APPROVAL_ACTIVITY_OPTIONS,
} from "./activity-options.js";

// Acceptance criterion (spec 0006): the agent-session activity proxy options
// declare a heartbeatTimeout so a killed worker is detected within ~2× it,
// rather than stalling for the full startToCloseTimeout.
test("agent-session activities declare a heartbeatTimeout", () => {
  assert.ok(
    "heartbeatTimeout" in AGENT_ACTIVITY_OPTIONS &&
      AGENT_ACTIVITY_OPTIONS.heartbeatTimeout,
    "AGENT_ACTIVITY_OPTIONS must set heartbeatTimeout",
  );
});

test("default (non-agent) activities have no heartbeatTimeout", () => {
  assert.ok(!("heartbeatTimeout" in ACTIVITY_OPTIONS));
});

// Acceptance criterion (spec 0015): the gate-2 approval poll heartbeats (like
// the agent-session activities) but needs a startToCloseTimeout long enough
// to survive a multi-day human review, well past the 30-minute default.
test("PR-approval poll declares a heartbeatTimeout and a multi-day startToCloseTimeout", () => {
  assert.ok(
    "heartbeatTimeout" in PR_APPROVAL_ACTIVITY_OPTIONS &&
      PR_APPROVAL_ACTIVITY_OPTIONS.heartbeatTimeout,
    "PR_APPROVAL_ACTIVITY_OPTIONS must set heartbeatTimeout",
  );
  assert.match(PR_APPROVAL_ACTIVITY_OPTIONS.startToCloseTimeout, /day/);
});
