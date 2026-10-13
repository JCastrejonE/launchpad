/**
 * The CI gate as an activity: ship the tree, run the gate in the isolated
 * container, publish the verdict as a commit status (spec 0228 B/C).
 *
 * Every side effect lives here because a workflow may hold none. The pure parts
 * it leans on are `buildRemoteGateCommand` and `parseGateOutcome`
 * (fleet-hostinger/ci-gate.ts).
 *
 * ORDER MATTERS, and it is the contract:
 *   1. publish `pending` BEFORE running, so a gate that takes minutes reads as
 *      running rather than as absent. Absence is indistinguishable from "no CI
 *      exists", which is the confusion spec 0227 was built under.
 *   2. run the gate.
 *   3. publish the verdict, naming the failing step.
 *
 * If step 3 fails, this THROWS. A run that leaves `pending` behind forever is
 * worse than one that never posted: the promote rule treats pending as "in
 * flight" and would wait on something already finished.
 */
import type { GateOutcome } from "@launchpad/fleet-hostinger";

export interface CiGateInput {
  /** The commit under test. Also names the working directory on the box. */
  sha: string;
  owner: string;
  repo: string;
}

export interface CiGateResult extends GateOutcome {
  sha: string;
}

/** Everything that touches the world, injected so the ORDER can be tested
 *  without a box, a container or GitHub. */
export interface CiGateDeps {
  /** Put the tree for `sha` on the box and return the directory it landed in. */
  shipTree(sha: string): Promise<string>;
  /** Run the gate command remotely; returns its combined output and status. */
  runGate(workdir: string): Promise<{ output: string; code: number }>;
  /** Read the verdict out of that output. */
  readOutcome(output: string): GateOutcome;
  /** Publish a commit status. */
  publish(status: {
    sha: string;
    state: "success" | "failure" | "pending";
    context: string;
    description?: string;
  }): Promise<void>;
  /** Remove the working directory, best effort. */
  cleanup(workdir: string): Promise<void>;
}

export const CI_STATUS_CONTEXT = "ci/launchpad";

export async function runCiGateActivity(
  input: CiGateInput,
  deps: CiGateDeps,
): Promise<CiGateResult> {
  await deps.publish({
    sha: input.sha,
    state: "pending",
    context: CI_STATUS_CONTEXT,
    description: "gate running on the sandbox box",
  });

  let workdir: string | null = null;
  try {
    workdir = await deps.shipTree(input.sha);
    const { output, code } = await deps.runGate(workdir);
    const outcome = deps.readOutcome(output);

    // The exit code and the markers are two independent readings, and a
    // DISAGREEMENT is itself the finding (docs/VERIFICATION.md #8): output that
    // travelled over SSH cannot be trusted alone, and neither can a status that
    // travelled through a pipe. When they disagree, refuse to call it green.
    const green = outcome.green && code === 0;
    const disagreed = outcome.green !== (code === 0);
    const step = disagreed
      ? `gate output and exit code disagree (exit ${code})`
      : outcome.failedStep;

    await deps.publish({
      sha: input.sha,
      state: green ? "success" : "failure",
      context: CI_STATUS_CONTEXT,
      ...(green ? {} : { description: step ?? "gate failed" }),
    });
    return { sha: input.sha, green, failedStep: green ? null : (step ?? "gate failed") };
  } catch (err) {
    // Anything thrown between `pending` and the verdict — the tree would not
    // ship, SSH died, docker refused — must still resolve the status. The first
    // real deliveries proved why: `git archive` failed, the activity threw, and
    // three commits sat at `pending` forever. This file's own header said a
    // stranded pending is worse than never posting, and then only guarded the
    // PUBLISH failing rather than the gate failing.
    const why = err instanceof Error ? err.message : String(err);
    await deps
      .publish({
        sha: input.sha,
        state: "failure",
        context: CI_STATUS_CONTEXT,
        description: `the gate could not run: ${why}`,
      })
      // Swallowed deliberately: the ORIGINAL error is the useful one, and a
      // failure to publish must not replace it.
      .catch(() => undefined);
    throw err;
  } finally {
    if (workdir) await deps.cleanup(workdir).catch(() => undefined);
  }
}
