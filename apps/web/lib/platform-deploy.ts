/**
 * Deploying the control plane itself (spec 0213 D).
 *
 * Every other project is deployed by a Temporal workflow. The platform cannot be:
 * the deploy restarts `launchpad-worker`, so an activity doing it would be killed
 * mid-flight and retried after the restart — a deploy loop. It also restarts
 * `launchpad-web`, so the request that triggered it dies before it can answer,
 * and the user sees a network error for a deploy that succeeded.
 *
 * The answer to both is the same: the deploy must OUTLIVE both units.
 *
 * A detached child is NOT enough, and this was measured rather than reasoned:
 * the first real press built and restarted correctly, then vanished at
 * "== Restarting" without verifying or recording anything. Detaching gives a
 * child its own SESSION, not its own CGROUP — the script was still inside
 * launchpad-web.service, and restarting a unit tears its whole cgroup down. The
 * deploy killed itself at the exact moment it succeeded.
 *
 * So it is handed to its own transient unit, which lives outside every service
 * cgroup and survives both restarts.
 */
import "server-only";
import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { claimDeployRequest, DEPLOY_REQUEST_PATH } from "./deploy-claim";

/** Re-exported so callers of the deploy module do not need to know the claim
 * lives in its own file (spec 0219 B — it was split out to be race-testable). */
export { DEPLOY_REQUEST_PATH };

/** Where a deploy's output goes. Named by release so two attempts never share a
 * file — and so the panel can point at the one it started. */
export function deployLogPath(version: string): string {
  return `/tmp/launchpad-deploy-${version.replace(/[^0-9A-Za-z.-]/g, "_")}.log`;
}

/**
 * Start the deploy and return. Resolves when the process has been SPAWNED, which
 * is deliberately not when it has finished — nothing can await a deploy that
 * kills the awaiting process.
 *
 * `detached` + `unref` + redirecting stdio to a file is what survives the
 * restart. Without them the child is in the web process's group and dies with it,
 * halfway through a build, leaving a tree that is neither the old version nor the
 * new one.
 */
/** Where the deploy's parameters are handed over. */

/** The exact, argument-free command that starts the deploy in its own transient
 * unit. It must match the host grant character for character. */
const LAUNCH_DEPLOY_CMD = [
  "/usr/bin/sudo",
  "-n",
  "/usr/bin/systemd-run",
  "--unit=launchpad-deploy",
  "--collect",
  "--uid=launchpad",
  "--property=EnvironmentFile=/etc/launchpad/launchpad.env",
  "/srv/launchpad/repo/scripts/deploy-here.sh",
] as const;

/** What a deploy attempt did. `ok` means the transient unit is running; a
 * refusal names WHY, because the failure this replaces was silent (spec 0219 A:
 * the second press returned ok, wrote an audit row, and did nothing). */
export type DeployStartResult =
  | { ok: true; logPath: string }
  | { ok: false; problem: string };

/**
 * Is a platform deploy already running, and whose is it? (spec 0219 A.)
 *
 * `systemd-run --unit=launchpad-deploy` was ALREADY mutual exclusion — a second
 * one fails because the unit exists. What it was not is OBSERVABLE: the spawn
 * was detached, its status never read, and the action answered `ok` before the
 * failure happened. So this asks the same question the kernel is already
 * answering, before the answer has been given to a person.
 *
 * `systemctl is-active` is a read — no sudo, no privilege. The claim file names
 * the holder; if it is unreadable we still refuse, because "a deploy is running
 * and I cannot say whose" is a refusal, not a green light.
 */
export function deployInFlight(): { running: boolean; holder?: string } {
  const active = spawnSync("/usr/bin/systemctl", ["is-active", "launchpad-deploy"], {
    encoding: "utf8",
  });
  if (active.stdout?.trim() !== "active") return { running: false };
  // Unclaimed request first: between systemd-run returning and the script's
  // rename, the CURRENT deploy's parameters are still at the un-suffixed path
  // while `.inflight` still holds the PREVIOUS deploy's. Reading the wrong one
  // there would name the wrong person, which is worse than naming nobody.
  for (const p of [DEPLOY_REQUEST_PATH, `${DEPLOY_REQUEST_PATH}.inflight`]) {
    try {
      const [, , version, actor] = readFileSync(p, "utf8").trim().split(/\s+/);
      if (version && actor) return { running: true, holder: `${actor} · ${version}` };
    } catch {
      // Not there or unreadable — try the other, then give up.
    }
  }
  return { running: true };
}

export function startPlatformDeploy(input: {
  repoRoot: string;
  commitSha: string;
  version: string;
  /** Who pressed it. Passed through so the OUTCOME row names a person. */
  actor: string;
  slug: string;
}): DeployStartResult {
  // Spec 0219 A. Asked first so the common case — a deploy plainly running —
  // is refused with a name rather than an EEXIST.
  const busy = (): DeployStartResult => {
    const f = deployInFlight();
    return {
      ok: false,
      problem: f.holder
        ? `Ya hay un despliegue en curso (${f.holder}). Espera a que termine.`
        : "Ya hay un despliegue en curso. Espera a que termine.",
    };
  };
  if (deployInFlight().running) return busy();

  const logPath = deployLogPath(input.version);
  // The parameters travel through a file because the grant that launches the
  // deploy names an EXACT command with no arguments — a wildcard there would
  // let arbitrary arguments through. The file carries no authority of its own:
  // deploy-here.sh re-validates the commit against origin/main before it acts.
  const payload = `${input.commitSha} ${input.slug} ${input.version} ${input.actor}\n`;

  if (!claimDeployRequest(payload)) {
    // Someone holds the path. Either a deploy is genuinely running — refuse and
    // name them — or a previous attempt died between claiming and spawning and
    // left this behind, in which case the file is garbage and blocking every
    // future deploy on it would be a self-inflicted outage.
    if (deployInFlight().running) return busy();
    try {
      unlinkSync(DEPLOY_REQUEST_PATH);
    } catch {
      // Already gone — the other writer finished. Fall through and retry.
    }
    if (!claimDeployRequest(payload)) return busy();
  }

  // Spec 0219 A: systemd-run returns as soon as the unit is STARTED, so its exit
  // status is available immediately and is worth reading. Not reading it is the
  // whole defect: `ok` was returned for a deploy that never ran.
  const started = spawnSync(LAUNCH_DEPLOY_CMD[0]!, LAUNCH_DEPLOY_CMD.slice(1), {
    cwd: input.repoRoot,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (started.status !== 0) {
    // Release the claim we took. Holding it would block every later deploy on
    // an attempt that never started.
    try {
      unlinkSync(DEPLOY_REQUEST_PATH);
    } catch {
      // The script claimed it first (renamed to `.inflight`) — so it IS running
      // and this status is a lie about a unit that started. Leave it alone.
    }
    const why = (started.stderr || started.stdout || "").trim().split("\n").slice(-2).join(" ");
    return { ok: false, problem: `No pude iniciar el despliegue: ${why || `salida ${started.status}`}` };
  }
  return { ok: true, logPath };
}
