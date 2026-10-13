import { test } from "node:test";
import assert from "node:assert/strict";
import { readStackLogs, STACK_LOG_TAIL } from "./logs.js";
import { createFakeSshRunner } from "./ssh.js";
import { FleetError } from "./errors.js";

// Spec 0214 step 2 — read-only stack logs, ADR-013-guarded.
// Same id discipline as inventory.test.ts: 100001 is the real sandbox host and
// 999999 is a SYNTHETIC id nobody can ever add to infra/fleet-sandbox.json, so an
// edit to that file cannot quietly turn the guard's own test green.
const SANDBOX_VPS_ID = 100001;
const UNLISTED_VPS_ID = 999999;

// Every assertion below is on what the runner ANSWERED, not on the call we made
// (verification rule #1) — the fake scripts a response and the test reads the
// returned StackLogs.

test("readStackLogs returns the lines the host actually emitted", async () => {
  const runner = createFakeSshRunner({
    respond: (command) =>
      command.includes("logs")
        ? {
            code: 0,
            // Trailing newline is what a real compose read ends with; it must not
            // become a phantom empty line in the panel.
            stdout:
              "odoo-1  | 2026-08-18T10:00:01.000000000Z INFO odoo running\n" +
              "db-1    | 2026-08-18T10:00:02.000000000Z LOG  database system is ready\n",
            stderr: "",
          }
        : undefined,
  });

  const logs = await readStackLogs(runner, SANDBOX_VPS_ID, "acme-prod");

  assert.deepEqual(logs, {
    project: "acme-prod",
    lines: [
      "odoo-1  | 2026-08-18T10:00:01.000000000Z INFO odoo running",
      "db-1    | 2026-08-18T10:00:02.000000000Z LOG  database system is ready",
    ],
    truncated: false,
  });
});

test("readStackLogs reads by project NAME, bounded, and never mutates", async () => {
  const runner = createFakeSshRunner();
  await readStackLogs(runner, SANDBOX_VPS_ID, "acme-prod");

  assert.deepEqual(runner.commands, [
    `docker compose -p acme-prod logs --tail=${STACK_LOG_TAIL} --timestamps --no-color`,
  ]);
  // `-p <NAME>`, never "inside the directory": compose takes the project name
  // from the DIRECTORY, which already served a blank Odoo once (rule #14).
  const [command] = runner.commands;
  assert.ok(command!.includes("-p acme-prod"));
  assert.ok(command!.includes("--tail"));
  assert.ok(!/\bdown\b/.test(command!), "read-only: never a `down`");
  assert.ok(!/\s-v\b/.test(command!), "read-only: never `-v`");
  assert.equal(runner.files.size, 0);
});

test("readStackLogs reports a failed command as an error, NOT as no logs", async () => {
  const runner = createFakeSshRunner({
    respond: (command) =>
      command.includes("logs")
        ? { code: 1, stdout: "", stderr: "no such service: nope\n" }
        : undefined,
  });

  await assert.rejects(
    () => readStackLogs(runner, SANDBOX_VPS_ID, "ghost"),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "docker");
      assert.equal(err.retryable, true);
      // The panel renders this summary; "the command failed" and "the stack
      // logged nothing" are different answers and must stay distinguishable.
      assert.match(err.message, /no such service: nope/);
      return true;
    },
  );
});

test("readStackLogs marks the read truncated when it hits the tail cap", async () => {
  const runner = createFakeSshRunner({
    respond: (command) =>
      command.includes("logs")
        ? {
            code: 0,
            stdout: Array.from({ length: STACK_LOG_TAIL }, (_, i) => `line ${i}`).join("\n"),
            stderr: "",
          }
        : undefined,
  });

  const logs = await readStackLogs(runner, SANDBOX_VPS_ID, "acme-prod");
  assert.equal(logs.lines.length, STACK_LOG_TAIL);
  assert.equal(logs.truncated, true);
});

test("readStackLogs refuses a non-allowlisted host WITHOUT SSHing it (ADR-013)", async () => {
  const runner = createFakeSshRunner();
  await assert.rejects(
    () => readStackLogs(runner, UNLISTED_VPS_ID, "acme-prod"),
    (err: unknown) => {
      assert.ok(err instanceof FleetError);
      assert.equal(err.kind, "sandbox");
      assert.equal(err.retryable, false);
      return true;
    },
  );
  // The guard runs BEFORE any command — a refused host is never SSH'd.
  assert.equal(runner.commands.length, 0);
  assert.equal(runner.files.size, 0);
});

test("readStackLogs refuses a project name it would have to interpolate unquoted", async () => {
  const runner = createFakeSshRunner();
  for (const bad of ["acme; rm -rf /", "acme prod", "$(id)", "", "../etc"]) {
    await assert.rejects(
      () => readStackLogs(runner, SANDBOX_VPS_ID, bad),
      (err: unknown) => {
        assert.ok(err instanceof FleetError);
        assert.equal(err.kind, "config");
        return true;
      },
      bad,
    );
  }
  assert.equal(runner.commands.length, 0);
});
