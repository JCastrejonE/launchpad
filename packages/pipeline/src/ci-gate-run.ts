/**
 * Real dependencies for the CI gate activity (spec 0228 B/C).
 *
 * The orchestration and the verdict logic live in `ci-gate-activity.ts` and are
 * unit-tested; this file is the part that touches the world, kept separate for
 * that reason.
 *
 * HOW THE CODE REACHES THE BOX. The container gets no credentials, so it cannot
 * pull a private repo; the worker holds the checkout and ships the code itself.
 *
 * It ships a git BUNDLE, not a tarball, and that distinction is load-bearing.
 * The first version used `git archive | tar -x`, which delivers the files and
 * no history — and our own gate is git-aware: `lint-specs` asks `git diff
 * origin/main...HEAD`, found no repository, and exited 0. A gate step passing
 * while inspecting nothing (registry rows 74, 55). A bundle costs 1.2 MB more
 * than the tarball for this repo's ENTIRE history, and a clone from it gives
 * `origin/main`, so the check works.
 *
 * WHY NOT A TOKEN, which is what GitHub Actions, GitLab and Buildkite all do —
 * they clone in the job with a short-lived, job-scoped credential. That is the
 * industry norm and it is a reasonable trade. Here a bundle buys the same
 * capability with NO credential on the CI box at all, which is the property
 * spec 0227 C exists to protect. TRIGGER to revisit: submodules, Git LFS, or a
 * repo big enough that shipping full history per run hurts — at which point a
 * GitHub App installation token (1 hour, repo-scoped) plus a shallow fetch is
 * the standard answer.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GithubClient } from "@launchpad/github";
import { buildRemoteGateCommand, parseGateOutcome } from "@launchpad/fleet-hostinger";
import {
  runCiGateActivity,
  type CiGateInput,
  type CiGateResult,
  type CiGateDeps,
} from "./ci-gate-activity.js";

const exec = promisify(execFile);

/** The box the gate runs on — the sandbox, never the control plane. */
export const CI_HOST_ENV = "LAUNCHPAD_CI_HOST";
export const CI_SSH_IDENTITY_ENV = "LAUNCHPAD_FLEET_SSH_IDENTITY";
export const CI_SSH_USER_ENV = "LAUNCHPAD_FLEET_SSH_USER";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — the CI gate has nowhere to run`);
  return v;
}

/**
 * Run a shell line and return ITS status, not a pipe's.
 *
 * `set -o pipefail` is not decoration: `git archive | ssh tar` exits with SSH's
 * status by default, so a failed archive would look like a successful ship.
 * That is docs/VERIFICATION.md #8, which this repo has paid for four times.
 */
async function sh(line: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout, stderr } = await exec("bash", ["-o", "pipefail", "-c", line], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout: stdout + stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: (e.stdout ?? "") + (e.stderr ?? ""), code: typeof e.code === "number" ? e.code : 1 };
  }
}

export function ciGateDeps(input: CiGateInput, token: string): CiGateDeps {
  const host = required(CI_HOST_ENV);
  const identity = required(CI_SSH_IDENTITY_ENV);
  const user = process.env[CI_SSH_USER_ENV] ?? "root";
  const repoRoot = required("LAUNCHPAD_REPO_ROOT");
  const ssh = `ssh -o BatchMode=yes -o ConnectTimeout=15 -i ${identity} ${user}@${host}`;
  const client = new GithubClient({ token, owner: input.owner, repo: input.repo });

  return {
    async shipTree(sha) {
      const dir = `/tmp/ci-${sha}`;
      const bundle = `${dir}.bundle`;
      // FETCH FIRST. The worker's checkout is a DEPLOY TARGET, not a mirror: it
      // holds whatever was last deployed and nothing newer. A webhook fires for
      // a commit that by definition has not been deployed yet, so bundling
      // straight from this repo asks for an object it does not have — which is
      // precisely how the first three real deliveries failed, with `git archive`
      // producing nothing and `tar` reporting the empty stream.
      //
      // CI testing only what has already shipped is backwards, so this is not a
      // retry-later condition; it is the normal case.
      const fetched = await sh(
        `git -C ${repoRoot} fetch --quiet origin ${sha} || git -C ${repoRoot} fetch --quiet origin`,
      );
      if (fetched.code !== 0) {
        throw new Error(`could not fetch ${sha} from origin: ${fetched.stdout.slice(0, 300)}`);
      }
      const have = await sh(`git -C ${repoRoot} cat-file -e ${sha}^{commit}`);
      if (have.code !== 0) {
        throw new Error(`${sha} is not reachable from origin after fetching — nothing to gate`);
      }
      // `main` rides along so the clone has an origin/main to diff against —
      // without it the bundle carries the commit and nothing to compare it to.
      const r = await sh(
        `git -C ${repoRoot} bundle create - ${sha} main | ${ssh} ` +
          `"rm -rf ${dir} ${bundle} && cat > ${bundle} && git clone -q ${bundle} ${dir} && ` +
          `git -C ${dir} checkout -q ${sha} && rm -f ${bundle}"`,
      );
      if (r.code !== 0) throw new Error(`could not ship ${sha} to the CI box: ${r.stdout.slice(0, 400)}`);
      return dir;
    },
    async runGate(workdir) {
      const r = await sh(`${ssh} ${JSON.stringify(buildRemoteGateCommand({ workdir }))}`);
      return { output: r.stdout, code: r.code };
    },
    readOutcome: parseGateOutcome,
    async publish(status) {
      await client.createCommitStatus(status);
    },
    async cleanup(workdir) {
      await sh(`${ssh} "rm -rf ${workdir} ${workdir}.bundle"`);
    },
  };
}

/** The activity the worker registers (re-exported from activities.ts). */
export async function runCiGate(input: CiGateInput): Promise<CiGateResult> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN is not set — the gate cannot publish its verdict");
  return await runCiGateActivity(input, ciGateDeps(input, token));
}
