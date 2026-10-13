/**
 * Run the gate on the sandbox box, in a container, and read its verdict
 * (spec 0228 B).
 *
 * WHY REMOTELY AND IN A CONTAINER. Spec 0227 C built an isolated docker network
 * on the sandbox box (ci-isolated), which a DOCKER-USER rule blocks from
 * reaching the control plane, precisely so branch code can run without standing
 * next to the database, the secrets file and the deploy keys.
 *
 * THE CONSTRAINT THAT SHAPES THIS: the container gets NO credentials, so it
 * cannot clone a private repository. The code arrives as a tree the CALLER
 * already unpacked (the worker holds the checkout) and the container only ever
 * sees a working directory. Same division deploy-control-plane.sh uses, and it
 * is what lets the gate stay hermetic (spec 0229): a gate needing a token could
 * not run here at all.
 *
 * Both halves are PURE, because that is where the bugs live. The activity that
 * runs them is a thin wrapper over SshRunner.exec.
 */
import { FleetError } from "./errors.js";

/** Same posture as prod-copy.ts: anything interpolated into a shell string is
 *  made inert first. The sha and the path come from a webhook payload. */
const SHELL_SAFE = /^[A-Za-z0-9._/-]+$/;

function inert(label: string, value: string): string {
  if (!SHELL_SAFE.test(value)) {
    throw new FleetError(
      "config",
      `refusing to build a CI command: ${label} ${JSON.stringify(value)} contains characters a ` +
        `shell would interpret. Only letters, digits, dot, underscore, slash and hyphen.`,
      { retryable: false },
    );
  }
  return value;
}

/** Image references legitimately contain `:` (the tag) and `@` (a digest). */
const IMAGE_SAFE = /^[A-Za-z0-9._/:@-]+$/;

function inertImage(value: string): string {
  if (!IMAGE_SAFE.test(value)) {
    throw new FleetError(
      "config",
      `refusing to build a CI command: image ${JSON.stringify(value)} is not a plain image ` +
        `reference.`,
      { retryable: false },
    );
  }
  return value;
}

export interface RemoteGateOptions {
  /** Where the caller already unpacked the tree on the box. */
  workdir: string;
  /** Defaults to the network spec 0227 C created. */
  network?: string;
  /** Node 22 is what the repo's `engines` declares. */
  image?: string;
}

/**
 * The command, as one string, so a caller can log exactly what ran.
 *
 * `--rm` because a job leaving containers behind fills the box that also hosts
 * every tenant. No named volume, no --privileged, no env: the container's whole
 * world is the mounted working copy.
 */
export function buildRemoteGateCommand(opts: RemoteGateOptions): string {
  const workdir = inert("workdir", opts.workdir);
  const network = inert("network", opts.network ?? "ci-isolated");
  // An image reference carries a tag, so it needs the colon that a PATH must not
  // have. Found by the test: the guard rejected this function's own default,
  // which is the guard being right and the charset being too narrow. A colon is
  // not a shell metacharacter — it cannot substitute, separate or redirect — so
  // permitting it here costs nothing, and keeping it out of `workdir` still
  // does work.
  const image = inertImage(opts.image ?? "node:22-bookworm");
  return (
    `docker run --rm --network ${network} -v ${workdir}:/w -w /w ${image} ` +
    `bash -lc 'corepack enable && pnpm install --frozen-lockfile && scripts/gate.sh'`
  );
}

export interface GateOutcome {
  green: boolean;
  /** The step gate.sh named, when it went red. */
  failedStep: string | null;
}

/**
 * Read the verdict out of the gate's own output.
 *
 * Keyed on the markers gate.sh prints, NOT on an exit code: this output arrives
 * over SSH, and a status that travelled through a pipe is not a check that can
 * fail (docs/VERIFICATION.md #8). The caller should assert the exit code too,
 * and a disagreement between the two IS the finding.
 *
 * Absence of BOTH markers is not green. It means the gate never ran, and
 * reporting that as a pass is how a CI system comes to certify nothing
 * (registry rows 74 and 55).
 */
export function parseGateOutcome(output: string): GateOutcome {
  const red = /GATE RED:\s*([^\n]+)/.exec(output);
  // Strip ANSI before publishing. gate.sh prints the step list wrapped in colour
  // (`\033[31mGATE RED: %s\033[0m`), the capture runs to end-of-line, and the
  // first real red verdict published `build, typecheck, test, web build\x1b[0m`
  // to GitHub — escape codes and all, in a description a person reads.
  if (red) return { green: false, failedStep: stripAnsi(red[1]!).trim() };
  if (/GATE GREEN/.test(output)) return { green: true, failedStep: null };
  return { green: false, failedStep: "the gate did not run" };
}

/** Remove SGR escape sequences. The gate's output is coloured for a terminal; a
 * commit status is not one. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
