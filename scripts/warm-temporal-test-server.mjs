#!/usr/bin/env node
/**
 * Warm the Temporal test-server binary cache (spec 0010 item 4).
 *
 * `TestWorkflowEnvironment.createTimeSkipping()` downloads its own
 * time-skipping test-server binary on first use (no Docker required, but it
 * does need outbound network access on a cold cache — see the harness
 * comment in packages/pipeline/src/workflow.test.ts). `runCi` now runs that
 * harness on every pipeline CI run (spec 0010 item 1); this script lets
 * preflight front-load the download once, offline from `runCi`'s point of
 * view, so `runCi`'s first `TEMPORAL_TEST=1` execution never burns activity
 * time on a network fetch.
 *
 * Idempotent: with the binary already cached, `createTimeSkipping()` +
 * `teardown()` complete in well under a second with no network access — a
 * fast no-op, matching preflight's re-run-is-a-no-op contract (spec 0005).
 *
 * `@temporalio/testing` is a devDependency of packages/pipeline, not of the
 * repo root, so it isn't resolvable via a plain bare import from this
 * top-level scripts/ file. Resolve it through packages/pipeline's own
 * node_modules instead of adding a root-level dependency just for this
 * bootstrap.
 */
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../packages/pipeline/package.json", import.meta.url),
);

async function main() {
  const { TestWorkflowEnvironment } = await import(
    require.resolve("@temporalio/testing")
  );
  const startedAt = Date.now();
  const testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  await testEnv.teardown();
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `warm-temporal-test-server: test-server binary cached and verified (createTimeSkipping + teardown, ${elapsedMs}ms)`,
  );
}

main().catch((err) => {
  console.error(
    "warm-temporal-test-server: failed to warm the test-server binary cache —",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
