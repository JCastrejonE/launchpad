/**
 * Skip-proofing the workflow harness (spec 0010 item 2).
 *
 * workflow.test.ts skips every case unless `TEMPORAL_TEST=1`. Once `runCi`
 * sets that (item 1) the harness becomes a real merge gate — but a future
 * accidental re-gating (the whole suite silently skipping again) would still
 * look green. To make that impossible: each harness case records an execution
 * here; the suite writes the running count to the file named by
 * HARNESS_COUNT_ENV on process exit; and `runCi` asserts (via
 * `harnessSkipProofError`) that a `TEMPORAL_TEST=1` run reported >0 executed
 * cases, turning CI red otherwise.
 *
 * The decision logic is pure so it's unit-tested (harness-exec.test.ts)
 * without a real test run; the counter/exit-writer are the thin IO shims the
 * suite and `runCi` wire together.
 */

import { writeFileSync } from "node:fs";

/** Env var naming the file the harness writes its executed-case count to. */
export const HARNESS_COUNT_ENV = "HARNESS_EXEC_COUNT_FILE";

let executed = 0;

/** Called at the top of every non-skipped harness case (workflow.test.ts). */
export function recordHarnessCase(): void {
  executed += 1;
}

/** Executed (non-skipped) harness cases recorded so far this process. */
export function harnessExecutedCount(): number {
  return executed;
}

/** Test-only reset so unit tests start from a known count. */
export function resetHarnessCount(): void {
  executed = 0;
}

let installed = false;

/**
 * Installs a process-exit hook that writes `harnessExecutedCount()` to the
 * file named by HARNESS_COUNT_ENV, so `runCi` can read how many cases actually
 * ran. A no-op when the env var is unset (plain `pnpm -r test`). Idempotent —
 * safe to call more than once (e.g. from a shared `before()` hook); only the
 * first call installs the listener.
 */
export function writeHarnessCountOnExit(): void {
  const file = process.env[HARNESS_COUNT_ENV];
  if (!file || installed) return;
  installed = true;
  // `process.on("exit", ...)` handlers must be synchronous — this is the one
  // place a sync fs write is the right tool, not a smell.
  process.on("exit", () => {
    try {
      writeFileSync(file, String(harnessExecutedCount()), "utf8");
    } catch {
      // Best-effort: a failed write here must never mask the real test
      // outcome (exit is already underway) — `runCi` treats a missing/
      // unreadable count file as `executed: null`, which is itself a
      // skip-proof failure, so this isn't a silent hole.
    }
  });
}

export interface HarnessSkipProofInput {
  /** Was `TEMPORAL_TEST=1` set for this CI run? */
  temporalTest: boolean;
  /** Executed-case count read back from HARNESS_COUNT_ENV's file, or `null`
   * when the file was missing/unreadable. */
  executed: number | null;
}

/**
 * The skip-proof decision (pure): returns an error message when a
 * `TEMPORAL_TEST=1` run reported zero (or no) executed harness cases — the
 * accidental-re-gating signal that must fail CI — otherwise `null`.
 */
export function harnessSkipProofError(input: HarnessSkipProofInput): string | null {
  if (!input.temporalTest) return null;
  if (input.executed !== null && input.executed > 0) return null;
  return (
    `harness skip-proof failed: TEMPORAL_TEST=1 but the workflow harness reported ` +
    `${input.executed === null ? "no readable" : "0"} executed cases — the suite may have ` +
    `silently re-gated to skipping instead of running.`
  );
}
