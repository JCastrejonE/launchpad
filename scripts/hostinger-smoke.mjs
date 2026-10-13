#!/usr/bin/env node
/**
 * READ-ONLY live smoke for the Hostinger VPS client (spec 0011). Human-gated:
 * runs ONLY with `HOSTINGER_LIVE=1` AND `HOSTINGER_API_TOKEN` set. Calls only
 * `listVps` + `getVps` on the first result — NEVER a mutating call. This script
 * is NEVER wired into any test script or CI path; the owner runs it once by hand to
 * validate the checked-in fixtures against reality.
 *
 * Usage:
 *   HOSTINGER_LIVE=1 HOSTINGER_API_TOKEN=… node scripts/hostinger-smoke.mjs
 */

if (process.env.HOSTINGER_LIVE !== "1") {
  console.error("refusing: set HOSTINGER_LIVE=1 to run the live read-only smoke");
  process.exit(1);
}
const token = process.env.HOSTINGER_API_TOKEN;
if (!token || token.trim() === "") {
  console.error("refusing: HOSTINGER_API_TOKEN is not set");
  process.exit(1);
}

const { HostingerClient } = await import(
  "../packages/fleet-hostinger/dist/client.js"
);

// READ-ONLY: only listVps + getVps below. Never call
// createVps/restartVps/createSnapshot from this script. Never log the token
// or a full response body that might echo it back — only a hand-picked
// token-free summary of each instance.
const client = new HostingerClient({ apiToken: token });

function summarize(vps) {
  return { id: vps.id, hostname: vps.hostname, state: vps.state };
}

const list = await client.listVps();
console.log(`listVps: ${list.length} instance(s)`);
for (const vps of list) {
  console.log(" -", JSON.stringify(summarize(vps)));
}

if (list.length > 0) {
  const first = await client.getVps(list[0].id);
  console.log("getVps(first):", JSON.stringify(summarize(first)));
} else {
  console.log("getVps: skipped (no instances to fetch)");
}
