/**
 * SSH execution seam for VPS bootstrap + stack deploy (spec 0012). Every step
 * that touches a VPS runs through an `SshRunner`, so unit tests inject a fake
 * and CI NEVER opens a real SSH connection (a hard requirement of this spec:
 * zero live SSH in `pnpm -r test`).
 *
 * Production uses {@link ExecSshRunner} (spawns the system `ssh`/`scp`); tests
 * use {@link createFakeSshRunner}, which records commands + written files and
 * lets a test script the response to each command.
 */
import { spawn } from "node:child_process";
import { FleetError } from "./errors.js";

/** Result of running a command on the remote host. */
export interface SshExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The injectable seam every VPS-touching step depends on. */
export interface SshRunner {
  /** Run a shell command on the remote host. */
  exec(command: string): Promise<SshExecResult>;
  /** Write `content` to `remotePath` on the host (scp/sftp-equivalent). */
  writeFile(remotePath: string, content: string): Promise<void>;
}

/** Connection details for {@link ExecSshRunner}. */
export interface SshTarget {
  host: string;
  user: string;
  /** Path to the private key used for auth. */
  identityFile: string;
  port?: number;
}

/**
 * Builds the argv passed to the system `ssh` binary for `target`, ending with
 * `remoteCommand` as the (single) command argument — ssh forwards it to the
 * remote shell verbatim. Pure + exported so a unit test can assert argv
 * construction (host/user/port/identity wiring) without spawning a process or
 * opening a connection.
 */
export function sshCommandArgs(target: SshTarget, remoteCommand: string): string[] {
  const args = ["-i", target.identityFile, "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes"];
  if (target.port !== undefined) {
    args.push("-p", String(target.port));
  }
  args.push(`${target.user}@${target.host}`, remoteCommand);
  return args;
}

/** Single-quotes `value` for safe embedding in a remote shell command. */
function quoteForRemoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Spawns `ssh` with `args`, optionally piping `stdin`, and collects the result. */
function runSsh(args: string[], stdin?: string): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      reject(
        new FleetError("ssh", `ssh spawn failed: ${err.message}`, { retryable: true, cause: err }),
      );
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

/**
 * Real SSH runner backed by the system `ssh` binary (writes go over the same
 * SSH transport via `cat > path`, avoiding a separate `scp`/`sftp` dependency).
 * Constructed by the fleet from a VPS's IP + the launchpad SSH key. NEVER
 * exercised in CI — the bootstrap/deploy tests inject
 * {@link createFakeSshRunner} instead.
 */
export class ExecSshRunner implements SshRunner {
  constructor(private readonly target: SshTarget) {}

  async exec(command: string): Promise<SshExecResult> {
    return runSsh(sshCommandArgs(this.target, command));
  }

  async writeFile(remotePath: string, content: string): Promise<void> {
    const remoteCommand = `cat > ${quoteForRemoteShell(remotePath)}`;
    const result = await runSsh(sshCommandArgs(this.target, remoteCommand), content);
    if (result.code !== 0) {
      // stderr here is shell/filesystem diagnostics (e.g. "No such file or
      // directory"), never the piped `content` — safe to include.
      throw new FleetError(
        "ssh",
        `writeFile to ${remotePath} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 500)}`,
        { retryable: true },
      );
    }
  }
}

/** A fake `SshRunner` for unit tests: records interactions, scriptable output. */
export interface FakeSshRunner extends SshRunner {
  /** Every command passed to `exec`, in order. */
  readonly commands: string[];
  /** Files written via `writeFile`: remotePath → content. */
  readonly files: Map<string, string>;
}

/**
 * Builds a {@link FakeSshRunner}. `respond(command)` returns an
 * {@link SshExecResult} to override the default (`{code:0, stdout:"", stderr:""}`)
 * for a matching command — return `undefined` to fall through to the default.
 * This lets a step test say "when the marker-read command runs, return the
 * existing marker" to exercise the idempotent no-op path.
 */
export function createFakeSshRunner(opts?: {
  respond?: (command: string) => SshExecResult | undefined;
}): FakeSshRunner {
  const commands: string[] = [];
  const files = new Map<string, string>();
  return {
    commands,
    files,
    async exec(command: string): Promise<SshExecResult> {
      commands.push(command);
      const scripted = opts?.respond?.(command);
      return scripted ?? { code: 0, stdout: "", stderr: "" };
    },
    async writeFile(remotePath: string, content: string): Promise<void> {
      files.set(remotePath, content);
    },
  };
}
