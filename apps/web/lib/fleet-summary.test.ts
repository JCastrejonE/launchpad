import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeFleet } from "./fleet-summary";

test("summarizeFleet counts running hosts against the total", () => {
  const s = summarizeFleet(
    [{ state: "running" }, { state: "stopped" }, { state: "running" }],
    new Map(),
  );
  assert.equal(s.hostsUp, 2);
  assert.equal(s.hostsTotal, 3);
});

test("summarizeFleet flattens deploying spec ids into one active-deploy count", () => {
  const s = summarizeFleet(
    [{ state: "running" }],
    new Map([
      [101, ["0038", "0039"]],
      [102, ["0040"]],
    ]),
  );
  assert.equal(s.activeDeploys, 3);
});

test("summarizeFleet defaults tenantsRunning to null until live inventory resolves", () => {
  assert.equal(summarizeFleet([], new Map()).tenantsRunning, null);
  assert.equal(summarizeFleet([], new Map(), 4).tenantsRunning, 4);
});
