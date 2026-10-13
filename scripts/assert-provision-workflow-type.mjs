#!/usr/bin/env node
/**
 * VERIFICATION #10 for the odoo-next provisioning START action (spec 0161 F2).
 *
 * `startProvisioningAction` must pass the workflow TYPE as the string constant
 * `PROVISION_PROJECT_WORKFLOW` ("provisionProject"), never `provisionProject`
 * the function — a production minifier renames a function reference, and
 * `apps/web`'s bundle IS minified, so a reference would become `"P"` (or worse)
 * and Temporal would look up a workflow type no worker serves. That was a
 * nine-hour production retry loop once (`SPEC_PIPELINE_WORKFLOW_TYPE`).
 *
 * Nothing minifies a test, so this asserts against the REAL production build:
 * after `pnpm --filter @launchpad/web build`, the minified server bundle must
 * still contain the literal string `provisionProject`. If someone "fixed" the
 * call to pass the function, the string constant would be tree-shaken away and
 * the reference minified — the literal would vanish and this exits non-zero.
 *
 * Run AFTER a fresh `next build` (a stale `.next` is a false green —
 * VERIFICATION #7). No pipes: the exit code is this script's own, asserted on
 * the end state, not a status that travelled through `tail`/`grep`
 * (VERIFICATION #8).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_TYPE = "provisionProject";
// The QUOTED string literal as minified code emits it (`"provisionProject"` /
// `'provisionProject'`), not a bare substring — so an unrelated identifier like
// `provisionProjectWorkflow` in some other module can never give a false green
// (VERIFICATION #2). A comment is already stripped by the minifier.
const WORKFLOW_TYPE_RE = /["']provisionProject["']/;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(repoRoot, "apps", "web", ".next", "server");

function jsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = jsFiles(serverDir);
if (files.length === 0) {
  console.error(
    `[assert-provision-workflow-type] no built server bundle at ${serverDir} — ` +
      `run \`pnpm --filter @launchpad/web build\` first.`,
  );
  process.exit(2);
}

const match = files.find((f) => WORKFLOW_TYPE_RE.test(readFileSync(f, "utf8")));
if (!match) {
  console.error(
    `[assert-provision-workflow-type] FAIL: the literal "${WORKFLOW_TYPE}" is not in the ` +
      `minified server bundle (${files.length} files scanned). The START action is likely ` +
      `passing the function reference, not PROVISION_PROJECT_WORKFLOW.`,
  );
  process.exit(1);
}

console.log(
  `[assert-provision-workflow-type] OK: workflow type "${WORKFLOW_TYPE}" survives minification ` +
    `(found in ${match.slice(repoRoot.length + 1)}).`,
);
