#!/usr/bin/env node
/**
 * Find (and optionally remove) staging stacks whose run is over — spec 0119.
 *
 * The workflow tears its stack down on every exit, so in the normal case this
 * finds nothing. It exists for the cases the workflow cannot cover:
 *
 *  - the teardown activity exhausted its retries (the workflow logs and moves on
 *    deliberately — a teardown error must not become the outcome of a run that
 *    promoted, spec 0018's lesson),
 *  - a run was terminated rather than cancelled, so no `finally` ever ran,
 *  - a stack created by a hand-driven live check (like this spec's own).
 *
 * It is also the compensating control for the capacity guard being fail-open: a
 * box whose `find` failed permits creates, and this is what notices.
 *
 * ## How an orphan is identified
 *
 * A staging stack is named `spec-NNNN`, and `workflowIdFor(specId)` is the same
 * string — both derive from the four-digit spec id. So "is this stack's run still
 * going?" is a set membership test against the RUNNING specPipeline workflow ids,
 * with no extra bookkeeping and nothing to drift.
 *
 * ## Default is REPORT
 *
 * Destroying an Odoo stack deletes its database volume. That is irreversible, so
 * it needs an explicit `--destroy`, and even then only on VPS ids in
 * `infra/fleet-sandbox.json` — `destroyStagingStack` refuses anything else at the
 * lowest layer (ADR-013), and refuses any stack that is not `spec-NNNN`, so no
 * argument to this script can reach a production stack.
 *
 *   node scripts/staging-sweep.mjs              # report
 *   node scripts/staging-sweep.mjs --destroy    # report, then remove the orphans
 *
 * Resolves packages through their own package.json (same reason as
 * open-pipeline-workflows.mjs: these deps belong to the workspace packages, not
 * the repo root).
 */
import { createRequire } from "node:module";

const pipelineRequire = createRequire(new URL("../packages/pipeline/package.json", import.meta.url));
const fleetRequire = createRequire(new URL("../packages/fleet-hostinger/package.json", import.meta.url));
const dbRequire = createRequire(new URL("../packages/db/package.json", import.meta.url));

const DESTROY = process.argv.includes("--destroy");

const FLEET_SSH_IDENTITY_ENV = "LAUNCHPAD_FLEET_SSH_IDENTITY";
const FLEET_SSH_USER_ENV = "LAUNCHPAD_FLEET_SSH_USER";

async function runningSpecStackNames() {
  const { Connection, Client } = await import(pipelineRequire.resolve("@temporalio/client"));
  const { TASK_QUEUE } = await import(pipelineRequire.resolve("./dist/task-queue.js"));
  const connection = await Connection.connect({
    address: process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233",
  });
  try {
    const client = new Client({ connection });
    const query = `WorkflowType = 'specPipeline' AND TaskQueue = '${TASK_QUEUE}' AND ExecutionStatus = 'Running'`;
    const ids = new Set();
    for await (const execution of client.workflow.list({ query })) {
      ids.add(execution.workflowId);
    }
    return ids;
  } finally {
    await connection.close();
  }
}

/**
 * Branch stacks (spec 0134): a `br-*` stack is an orphan iff NO
 * `project_branches` row claims its name. Returns null when the DB is
 * unreachable — and null means "cannot prove an orphan", so branch stacks are
 * then reported as unknown and NEVER destroyed. Failing open toward
 * destruction would delete a database volume on a hunch.
 */
async function claimedBranchStacks() {
  if (!process.env["DATABASE_URL"]) return null;
  try {
    const { createPool } = await import(dbRequire.resolve("./dist/index.js"));
    const pool = createPool();
    try {
      const res = await pool.query(
        `SELECT staging_stack FROM project_branches WHERE staging_stack IS NOT NULL`,
      );
      return new Set(res.rows.map((r) => r.staging_stack));
    } finally {
      await pool.end();
    }
  } catch (err) {
    console.error(`staging-sweep: could not read project_branches (${err?.message ?? err})`);
    return null;
  }
}

async function main() {
  const fleet = await import(fleetRequire.resolve("./dist/index.js"));
  const {
    loadSandboxAllowlist,
    HostingerClient,
    ExecSshRunner,
    SHARED_TOKEN_ENV,
    listStagingStackRefs,
    destroyStagingStack,
    destroyBranchStack,
    claimingBranchStack,
  } = fleet;

  // The fleet-wide token, not `resolveHostingerToken(tenantId)`: this sweep is a
  // property of the BOX and spans every tenant on it, so there is no one tenant
  // whose token would be the right one to reach for.
  const token = process.env[SHARED_TOKEN_ENV];
  if (!token) {
    console.error(`staging-sweep: set ${SHARED_TOKEN_ENV} (needed to resolve each VPS's address)`);
    process.exit(1);
  }

  const identityFile = process.env[FLEET_SSH_IDENTITY_ENV];
  if (!identityFile) {
    console.error(`staging-sweep: set ${FLEET_SSH_IDENTITY_ENV} (SSH private key path)`);
    process.exit(1);
  }
  const user = process.env[FLEET_SSH_USER_ENV] ?? "root";

  // A run that is still going owns its stack; everything else is an orphan.
  // Fetched BEFORE listing stacks: if a run ends in between, its stack is
  // reported as an orphan and simply re-reported next sweep — whereas the other
  // order could see a stack as owned by a run that had already finished.
  const running = await runningSpecStackNames();
  console.log(`staging-sweep: ${running.size} run(s) currently open`);
  const claimed = await claimedBranchStacks();
  if (claimed === null) {
    console.log("staging-sweep: branch-stack claims UNKNOWN (no DB) — br-* stacks are report-only");
  }

  /** Orphanhood per family (spec 0134): a spec stack belongs to its RUNNING
   * workflow; a branch stack belongs to its project_branches row. */
  const classify = (ref) => {
    if (ref.family === "branch") {
      if (claimed === null) return "unknown";
      // Spec 0172: a branch's Next front is `<branch-stack>-front`, and the
      // `project_branches` row records only the Odoo stack — so ask which stack
      // CLAIMS this one. Without the strip, the first sweep calls every branch
      // front an orphan and `--destroy` takes down live staging.
      return claimed.has(claimingBranchStack(ref.stack)) ? "claimed" : "ORPHAN";
    }
    return running.has(ref.stack) ? "in use" : "ORPHAN";
  };

  const vpsIds = loadSandboxAllowlist();
  let orphanTotal = 0;
  let destroyedTotal = 0;

  for (const vpsId of vpsIds) {
    const client = new HostingerClient({ apiToken: token });
    const vps = await client.getVps(vpsId);
    const ipv4 = vps.ipv4?.[0]?.address;
    if (!ipv4) {
      console.error(`staging-sweep: VPS ${vpsId} has no IPv4 address — skipped`);
      continue;
    }
    const ssh = new ExecSshRunner({ host: ipv4, user, identityFile });
    const refs = await listStagingStackRefs(ssh);
    const orphans = refs.filter((r) => classify(r) === "ORPHAN");

    console.log(
      `staging-sweep: VPS ${vpsId} — ${refs.length} staging stack(s), ${orphans.length} orphaned`,
    );
    for (const ref of refs) {
      console.log(`  ${ref.tenantId}/${ref.stack}  ${classify(ref)}`);
    }
    orphanTotal += orphans.length;

    if (!DESTROY) continue;
    for (const ref of orphans) {
      try {
        const result =
          ref.family === "branch"
            ? await destroyBranchStack({ tenantId: ref.tenantId, stack: ref.stack, vpsId, ssh })
            : await destroyStagingStack({ tenantId: ref.tenantId, specId: ref.specId, vpsId, ssh });
        destroyedTotal += result.existed ? 1 : 0;
        console.log(`  destroyed ${ref.tenantId}/${ref.stack} (existed: ${result.existed})`);
      } catch (err) {
        // Keep going: one stack that refuses to come down must not strand the
        // rest of the sweep.
        console.error(`  FAILED to destroy ${ref.tenantId}/${ref.stack}: ${err?.message ?? err}`);
      }
    }
  }

  if (orphanTotal === 0) {
    console.log("staging-sweep: nothing to clean up");
  } else if (DESTROY) {
    console.log(`staging-sweep: destroyed ${destroyedTotal}/${orphanTotal} orphan(s)`);
  } else {
    console.log(
      `staging-sweep: ${orphanTotal} orphan(s) left in place — re-run with --destroy to remove them`,
    );
  }
}

main().catch((err) => {
  console.error(`staging-sweep: ${err?.message ?? err}`);
  process.exit(1);
});
