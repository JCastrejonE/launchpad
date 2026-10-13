/**
 * Temporal worker — run on the launchpad VPS (dev: `pnpm --filter
 * @launchpad/pipeline worker` after `pnpm dev:infra`).
 * Requires: TEMPORAL_ADDRESS, LAUNCHPAD_REPO_ROOT, owner LLM credential env.
 */
import { Worker, NativeConnection } from "@temporalio/worker";
import * as activities from "./activities.js";
import { TASK_QUEUE, temporalNamespace } from "./task-queue.js";
import { git } from "./git.js";

export { TASK_QUEUE, temporalNamespace } from "./task-queue.js";

/** Resolve the worker's build id from the repo's short HEAD sha (spec 0008
 * worker hygiene). Best-effort: falls back to `undefined` (logged as
 * "unknown") if `LAUNCHPAD_REPO_ROOT` isn't set or isn't a git checkout, so a
 * broken git lookup never blocks the worker from starting. NOTE: we
 * deliberately do NOT set `useVersioning: true` alongside this — that
 * requires calling `updateBuildIdCompatibility` against the Temporal server
 * (not wired up anywhere in this repo), and per the SDK's own docs a
 * worker opted into versioning without a matching server-side compatibility
 * set will pick up *no* tasks at all, silently. That failure mode is worse
 * than the mixed-version-worker problem this item is guarding against, so
 * for now `buildId` is set purely for identification/logging (visible in
 * `identity` and worker startup logs) until versioning is deliberately
 * wired up end-to-end. */
async function resolveBuildId(): Promise<string | undefined> {
  const repoRoot = process.env["LAUNCHPAD_REPO_ROOT"];
  if (!repoRoot) return undefined;
  try {
    return await git.shortHeadSha(repoRoot);
  } catch {
    return undefined;
  }
}

export async function runWorker(): Promise<void> {
  const buildId = await resolveBuildId();
  // Set by `preflight restart` (spec 0017) once it starts the worker FROM an
  // immutable snapshot at ~/.launchpad/worker-builds/<git-sha>/ instead of
  // packages/pipeline/dist in place — logging it here is the live proof that
  // a mid-run repo rebuild (runCi, manual tsc) cannot touch the code this
  // process is actually executing. Absent (undefined) for any worker started
  // outside that path (e.g. `pnpm --filter @launchpad/pipeline worker` during
  // plain dev), which still runs directly from the repo checkout as before.
  const snapshotDir = process.env["LAUNCHPAD_WORKER_SNAPSHOT"];
  const connection = await NativeConnection.connect({
    address: process.env["TEMPORAL_ADDRESS"] ?? "localhost:7233",
  });
  // Spec 0213 A: which namespace this worker serves. Absent -> "default", so
  // production is byte-identical to before. A staging worker sets
  // TEMPORAL_NAMESPACE and therefore CANNOT be handed a production task, which
  // is the whole safety argument for the second stack — see temporalNamespace().
  const namespace = temporalNamespace();
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: TASK_QUEUE,
    workflowsPath: new URL("./workflow.js", import.meta.url).pathname,
    activities,
    ...(buildId ? { buildId } : {}),
  });
  console.log(
    `[worker] ${TASK_QUEUE} up in namespace ${namespace} (repo: ${process.env["LAUNCHPAD_REPO_ROOT"]}, buildId: ${buildId ?? "unknown"}, snapshot: ${snapshotDir ?? "none (not started from a preflight-restart build snapshot)"})`,
  );
  await worker.run();
}

if (process.argv[1]?.endsWith("worker.js")) {
  runWorker().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
