import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHealth, healthStatus } from "./health.js";

const full = {
  LAUNCHPAD_REPO_ROOT: "/repo",
  TEMPORAL_ADDRESS: "localhost:7233",
  AUTH_SECRET: "test-secret",
};

const reachable = async () => true;
const unreachable = async () => false;

test("computeHealth: full env + temporal reachable -> ok, 200", async () => {
  const result = await computeHealth(full, reachable);
  assert.deepEqual(result, { ok: true, checks: { env: true, temporal: true } });
  assert.equal(healthStatus(result), 200);
});

test("computeHealth: missing env -> ok:false, checks.env:false, 503", async () => {
  const result = await computeHealth({ LAUNCHPAD_REPO_ROOT: "/repo" }, reachable);
  assert.deepEqual(result, { ok: false, checks: { env: false, temporal: true } });
  assert.equal(healthStatus(result), 503);
});

test("computeHealth: env ok but temporal unreachable -> ok stays true, 200", async () => {
  const result = await computeHealth(full, unreachable);
  assert.deepEqual(result, { ok: true, checks: { env: true, temporal: false } });
  assert.equal(healthStatus(result), 200);
});

test("computeHealth: env missing AND temporal unreachable -> still 503 (env drives status)", async () => {
  const result = await computeHealth({}, unreachable);
  assert.deepEqual(result, { ok: false, checks: { env: false, temporal: false } });
  assert.equal(healthStatus(result), 503);
});

test("computeHealth: defaults to process.env and an unreachable probe when omitted", async () => {
  const result = await computeHealth();
  assert.equal(result.checks.temporal, false);
});

test("healthStatus: temporal:false never changes the status code when env is ok", () => {
  assert.equal(healthStatus({ ok: true, checks: { env: true, temporal: false } }), 200);
  assert.equal(healthStatus({ ok: true, checks: { env: true, temporal: true } }), 200);
});
