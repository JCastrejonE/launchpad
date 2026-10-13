#!/usr/bin/env node
/**
 * List RUNNING specPipeline workflows (spec 0017 restart-safety).
 *
 * `preflight restart` must refuse to swap the worker mid-run unless `--force`
 * (mid-run worker swaps contributed to the 0015 TMPRL1100 crash). Bash can't
 * talk to Temporal, so preflight shells out to this helper: it connects with
 * @temporalio/client, lists open workflows of the spec-pipeline type on the
 * pipeline task queue, prints one workflowId per line (nothing when none), and
 * exits 0. Preflight treats any output as "a run is open" → refuse without
 * --force.
 *
 * `@temporalio/client` is a dependency of packages/pipeline, not of the repo
 * root, so it isn't resolvable via a plain bare import from this top-level
 * scripts/ file — same resolve-through-the-package trick as
 * warm-temporal-test-server.mjs. TASK_QUEUE/the specPipeline workflow type
 * name are pulled from the pipeline package's own built dist so this script
 * never hardcodes a value that could drift from packages/pipeline/src.
 *
 * Any connection failure (Temporal unreachable, etc.) is treated the same as
 * "no output" — printed to stderr and exit 0 — so a down/unreachable Temporal
 * never blocks `preflight restart` itself; step 2 of the normal preflight
 * flow is what's responsible for verifying Temporal is up.
 */
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/pipeline/package.json", import.meta.url));

async function main() {
  const { Connection, Client } = await import(require.resolve("@temporalio/client"));
  const { TASK_QUEUE } = await import(require.resolve("./dist/task-queue.js"));

  const connection = await Connection.connect({
    address: process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233",
  });
  try {
    const client = new Client({ connection });
    const query = `WorkflowType = 'specPipeline' AND TaskQueue = '${TASK_QUEUE}' AND ExecutionStatus = 'Running'`;
    for await (const execution of client.workflow.list({ query })) {
      console.log(execution.workflowId);
    }
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error(
    "open-pipeline-workflows: failed to query Temporal for open workflows —",
    err instanceof Error ? err.message : err,
  );
  process.exit(0);
});
