/**
 * Spec 0226 A/B. The fake asserts what the BOUNDARY answers, not what we asked
 * it (VERIFICATION #1): every case here is driven by what `psql` reads back, and
 * the exit code of the neutralize command is deliberately not enough on its own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertNeutralized, neutralizeRestoredDb, readsAsNeutralized } from "./neutralize.js";
import type { SshRunner, SshExecResult } from "./ssh.js";

const ok = (stdout = ""): SshExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom"): SshExecResult => ({ code: 1, stdout: "", stderr });

/** Records commands, answers by matching them. */
function fakeSsh(answer: (cmd: string) => SshExecResult): { ssh: SshRunner; cmds: string[] } {
  const cmds: string[] = [];
  return {
    cmds,
    ssh: {
      exec: async (command: string) => { cmds.push(command); return answer(command); },
      writeFile: async () => {},
    },
  };
}

const base = { project: "br-x-prod", composePath: "/opt/x/compose.yml", dbName: "x_branch" };

test("spec 0226: psql's 't' and 'true' both read as neutralized; anything else does not", () => {
  for (const yes of ["t", "true", " T \n", "TRUE"]) assert.equal(readsAsNeutralized(yes), true, yes);
  for (const no of ["", "f", "false", "0", "null"]) assert.equal(readsAsNeutralized(no), false, no);
});

test("spec 0226: a neutralize that exits 0 but does NOT set the marker is REFUSED", async () => {
  // The whole point of #8: the exit code travelled through docker compose and
  // proves nothing. The database is the end state.
  const { ssh } = fakeSsh((cmd) => (cmd.includes("psql") ? ok("") : ok()));
  await assert.rejects(
    () => neutralizeRestoredDb({ ssh, ...base }),
    (e: Error) => {
      assert.match(e.message, /did not read back as true/);
      assert.match(e.message, /never be reachable/);
      return true;
    },
  );
});

test("spec 0226: the marker reading true is what makes it pass", async () => {
  const { ssh, cmds } = fakeSsh((cmd) => (cmd.includes("psql") ? ok("t") : ok()));
  await neutralizeRestoredDb({ ssh, ...base });
  assert.equal(cmds.length, 2, "one neutralize, one read-back");
  assert.match(cmds[0]!, /run --rm --no-deps odoo neutralize -d x_branch/);
  assert.match(cmds[1]!, /is_neutralized/);
});

test("spec 0226: it is a ONE-OFF container, never the serving one", async () => {
  const { ssh, cmds } = fakeSsh((cmd) => (cmd.includes("psql") ? ok("t") : ok()));
  await neutralizeRestoredDb({ ssh, ...base });
  // `run --rm` overrides the service's pinned command and exits; `exec` would
  // attach to the long-running server, which must not exist yet.
  assert.match(cmds[0]!, /run --rm/);
  assert.doesNotMatch(cmds[0]!, /compose exec .*odoo/);
});

test("spec 0226: the compose project name is ALWAYS explicit (CLAUDE.md #14)", async () => {
  const { ssh, cmds } = fakeSsh((cmd) => (cmd.includes("psql") ? ok("t") : ok()));
  await neutralizeRestoredDb({ ssh, ...base });
  for (const c of cmds) assert.match(c, /docker compose -p br-x-prod /);
});

test("spec 0226: a failed neutralize is retryable; an unproven marker is NOT", async () => {
  const f1 = fakeSsh(() => fail("odoo exploded"));
  await assert.rejects(
    () => neutralizeRestoredDb({ ssh: f1.ssh, ...base }),
    (e: Error & { retryable?: boolean }) => {
      assert.equal(e.retryable, true, "neutralization is idempotent, so retry is safe");
      return true;
    },
  );
  const f2 = fakeSsh((cmd) => (cmd.includes("psql") ? ok("f") : ok()));
  await assert.rejects(
    () => neutralizeRestoredDb({ ssh: f2.ssh, ...base }),
    (e: Error & { retryable?: boolean }) => {
      assert.equal(e.retryable, false, "a copy that is provably NOT neutralized must be destroyed");
      return true;
    },
  );
});

test("spec 0226: assertNeutralized can be re-run later — a stack outlives its run", async () => {
  const { ssh, cmds } = fakeSsh(() => ok("t"));
  await assertNeutralized({ ssh, ...base });
  assert.equal(cmds.length, 1, "read-back only, no neutralize");
});
