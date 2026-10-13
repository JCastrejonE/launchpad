/**
 * Read-only container logs for ONE deployed stack (spec 0214).
 *
 * Same shape and the same rules as {@link listTenantStacks} in `inventory.ts`,
 * deliberately — this is the second read of a host, not a new capability:
 *
 *  - **Guard FIRST.** A non-allowlisted / production VPS id is refused BEFORE
 *    `runner` is ever touched (ADR-013 — production hosts are never SSH'd, not
 *    even for a read). Spec 0214 adds no SSH authority; reading a customer VPS
 *    is an OWNER decision that spec defers.
 *  - **Strictly read-only.** `docker compose … logs` and nothing else. Never a
 *    `down`, never `-v`.
 *  - **By project NAME, never by directory.** `docker compose -p <NAME>`, with
 *    `<NAME>` taken from what `docker compose ls` reported (a `TenantStack`'s
 *    `tenant`). Running compose *inside* a stack directory takes the project
 *    name from the DIRECTORY and points at a different stack — CLAUDE.md
 *    verification rule #14, second corollary, which already cost a blank Odoo.
 *  - **Bounded.** `--tail` always, so a chatty stack cannot stream unbounded
 *    output through the web process; the caller shows the truncation.
 *
 * A non-zero exit throws a `FleetError` rather than returning no lines: "the
 * command failed" and "the stack logged nothing" are different answers, and the
 * panel renders them differently (spec 0214, criterion 2).
 */
import { FleetError } from "./errors.js";
import { isSandboxVps } from "./sandbox.js";
import type { SshRunner } from "./ssh.js";

/** Lines read per stack. Fixed, not a knob: the panel states this number. */
export const STACK_LOG_TAIL = 200;

/**
 * Compose project names we are willing to interpolate into a remote shell
 * command. Deliberately narrower than what docker accepts: the name reaches an
 * `ssh` command line, so anything outside `[a-z0-9_-]` is refused rather than
 * quoted. Every name the inventory reports (`docker compose ls`) is of this
 * shape, so the conservative pattern costs nothing real.
 */
const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** What one stack's log read returned. */
export interface StackLogs {
  /** The compose project name the lines were read from (as inventoried). */
  project: string;
  /** Log lines, oldest first, exactly as compose emitted them. */
  lines: string[];
  /** True when the read hit {@link STACK_LOG_TAIL} — older lines exist. */
  truncated: boolean;
}

/**
 * Reads the last {@link STACK_LOG_TAIL} log lines of the compose project
 * `composeProject` on an allowlisted sandbox host.
 *
 * Argument order mirrors {@link listTenantStacks} (`runner, vpsId, …`) so the two
 * host reads are called the same way.
 */
export async function readStackLogs(
  runner: SshRunner,
  vpsId: number,
  composeProject: string,
): Promise<StackLogs> {
  // Guard FIRST, before any `runner` use: a non-allowlisted / production host
  // is NEVER SSH'd, not even read-only (ADR-013). Spec 0214 adds no SSH
  // authority — reading a customer VPS is an OWNER decision it defers.
  if (!isSandboxVps(vpsId)) {
    throw new FleetError(
      "sandbox",
      `refusing read-only log read of VPS ${vpsId}: not on the fleet sandbox ` +
        `allowlist (infra/fleet-sandbox.json, ADR-013) — production hosts are ` +
        `never SSH'd, even for a read`,
      { retryable: false },
    );
  }

  if (!COMPOSE_PROJECT_PATTERN.test(composeProject)) {
    throw new FleetError(
      "config",
      `refusing to read logs for compose project ${JSON.stringify(composeProject)}: ` +
        `not a plain compose project name`,
      { retryable: false },
    );
  }

  // By project NAME, never by directory — see the rules above. Read-only.
  const result = await runner.exec(
    `docker compose -p ${composeProject} logs --tail=${STACK_LOG_TAIL} --timestamps --no-color`,
  );
  if (result.code !== 0) {
    throw new FleetError(
      "docker",
      `docker compose logs failed for ${composeProject} on VPS ${vpsId} ` +
        `(exit ${result.code}): ${result.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }

  const trimmed = result.stdout.replace(/\n+$/, "");
  const lines = trimmed.length > 0 ? trimmed.split("\n") : [];
  return {
    project: composeProject,
    lines,
    // `--tail` is PER SERVICE, so a multi-container stack can return more than
    // the cap; reaching it at all is what means "older lines exist".
    truncated: lines.length >= STACK_LOG_TAIL,
  };
}
