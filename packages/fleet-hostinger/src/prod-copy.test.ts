/**
 * Spec 0226 A (restore half). The property under test is not "it copies" — it is
 * that PRODUCTION IS ONLY EVER READ, and that a copy which did not land is
 * refused rather than served.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertRestored, decideProductionCopy, dumpProduction, productionCommand, restoreIntoBranch,
} from "./prod-copy.js";
import type { SshRunner, SshExecResult } from "./ssh.js";

const ok = (stdout = ""): SshExecResult => ({ code: 0, stdout, stderr: "" });

function fakeSsh(answer: (cmd: string) => SshExecResult) {
  const cmds: string[] = [];
  const ssh: SshRunner = {
    exec: async (command) => { cmds.push(command); return answer(command); },
    writeFile: async () => {},
  };
  return { ssh, cmds };
}

const base = {
  prodProject: "sushi-prod", prodComposePath: "/opt/sushi/prod/compose.yml", prodDbName: "sushi_prod",
  branchProject: "br-x", branchComposePath: "/opt/x/compose.yml", branchDbName: "x_branch",
  prodFilestoreVolume: "sushi-prod_odoo-filestore", branchFilestoreVolume: "br-x_odoo-filestore",
};

/**
 * Every command that can possibly reach production, enumerated. There are two,
 * because `productionCommand`'s input is a closed union — so this list is
 * exhaustive by the type system, not by my diligence.
 */
const DUMP_PATH = "/tmp/d.dump";

function everyProductionCommand(): string[] {
  return [
    productionCommand(base, { kind: "dump", dbName: base.prodDbName, toPath: DUMP_PATH }),
    productionCommand(base, { kind: "copyFilestore", toVolume: base.branchFilestoreVolume }),
  ];
}

test("spec 0226: every command that CAN reach production is a read", () => {
  // Not "matches no write verbs" — that was a denylist, incomplete by
  // construction, and its first version flagged our own read-only copy. This is
  // the closed set, and each member is checked for what it IS.
  const [dump, copy] = everyProductionCommand();
  assert.match(dump!, /\bpg_dump\b/);
  assert.doesNotMatch(dump!, /\bpsql\b/, "psql could carry any statement; pg_dump cannot");
  assert.match(copy!, new RegExp(`${base.prodFilestoreVolume}:/from:ro`));
});

test("spec 0226: nothing touching production is issued that did not come from productionCommand", async () => {
  const { ssh, cmds } = fakeSsh((c) => (c.includes("ir_module_module") ? ok("312") : ok()));
  const dump = await dumpProduction({ ssh, ...base, dumpPath: DUMP_PATH });
  await restoreIntoBranch({ ssh, ...base }, dump);

  const allowed = new Set(everyProductionCommand());
  const touchingProd = cmds.filter(
    (c) => c.includes(base.prodProject) || c.includes(base.prodFilestoreVolume),
  );
  assert.ok(touchingProd.length > 0, "the test would prove nothing if prod were never touched");
  for (const c of touchingProd) {
    assert.ok(allowed.has(c), `command reached production without being built by productionCommand:\n${c}`);
  }
});

test("spec 0226: the production filestore is mounted READ-ONLY", async () => {
  const { ssh, cmds } = fakeSsh((c) => (c.includes("ir_module_module") ? ok("312") : ok()));
  await restoreIntoBranch({ ssh, ...base }, "/tmp/d.dump");
  const copy = cmds.find((c) => c.includes("docker run --rm"))!;
  assert.match(copy, new RegExp(`${base.prodFilestoreVolume}:/from:ro`));
  assert.doesNotMatch(copy, new RegExp(`${base.prodFilestoreVolume}:/from(?!:ro)`));
});

test("spec 0226: a restore that lands in an EMPTY database is refused", async () => {
  // The failure that looks fine: neutralizing nothing succeeds, and the branch
  // then serves a clean Odoo that passes every other check.
  const { ssh } = fakeSsh((c) => (c.includes("ir_module_module") ? ok("0") : ok()));
  await assert.rejects(
    () => restoreIntoBranch({ ssh, ...base }, "/tmp/d.dump"),
    (e: Error & { retryable?: boolean }) => {
      assert.match(e.message, /did not land/);
      assert.equal(e.retryable, false);
      return true;
    },
  );
});

test("spec 0226: a database that did land passes", async () => {
  const { ssh } = fakeSsh((c) => (c.includes("ir_module_module") ? ok("312") : ok()));
  await assertRestored({ ssh, ...base });
});

test("spec 0226: unreadable count is refused, not read as zero or as fine", async () => {
  for (const bad of ["", "ERROR:  relation does not exist", "null"]) {
    const { ssh } = fakeSsh(() => ok(bad));
    await assert.rejects(() => assertRestored({ ssh, ...base }), /did not land/);
  }
});

test("spec 0226: both compose calls name their project explicitly (CLAUDE.md #14)", async () => {
  const { ssh, cmds } = fakeSsh((c) => (c.includes("ir_module_module") ? ok("312") : ok()));
  const dump = await dumpProduction({ ssh, ...base });
  await restoreIntoBranch({ ssh, ...base }, dump);
  for (const c of cmds.filter((x) => x.startsWith("docker compose"))) {
    assert.match(c, /docker compose -p \S+ -f /);
  }
});

// --- Spec 0226 C: copy ONCE, at creation (odoo.sh's rule) -------------------

test("spec 0226 C: an existing stack is NEVER re-copied — that would wipe the tester's data", () => {
  const d = decideProductionCopy({ stackExists: true, wantsCopy: true, hasProduction: true });
  assert.equal(d.copy, false);
  assert.match(d.reason, /borraría/);
});

test("spec 0226 C: an existing stack wins over every other input", () => {
  // Written after the first version of this test proved nothing: I had asserted
  // that the redeploy rule must be checked BEFORE the flag, and reordering the
  // two changed no decision at all — only which reason came back. The property
  // that IS real is this one, and deleting the `stackExists` branch turns it red.
  for (const wantsCopy of [true, false])
    for (const hasProduction of [true, false])
      assert.equal(
        decideProductionCopy({ stackExists: true, wantsCopy, hasProduction }).copy,
        false,
        `a redeploy must never copy (wantsCopy=${wantsCopy}, hasProduction=${hasProduction})`,
      );
});

test("spec 0226 C: a first deploy that asked for a copy gets one", () => {
  const d = decideProductionCopy({ stackExists: false, wantsCopy: true, hasProduction: true });
  assert.equal(d.copy, true);
  assert.match(d.reason, /primer despliegue/);
});

test("spec 0226 C: no production to copy from is a stated reason, not a silent clean Odoo", () => {
  const d = decideProductionCopy({ stackExists: false, wantsCopy: true, hasProduction: false });
  assert.equal(d.copy, false);
  assert.match(d.reason, /no hay producción/);
});

test("spec 0226 C: today's behaviour is the default — a clean Odoo unless asked", () => {
  const d = decideProductionCopy({ stackExists: false, wantsCopy: false, hasProduction: true });
  assert.equal(d.copy, false);
  assert.match(d.reason, /Odoo limpio/);
});

test("spec 0226 C: every outcome carries a reason — the two silences look identical otherwise", () => {
  for (const stackExists of [true, false])
    for (const wantsCopy of [true, false])
      for (const hasProduction of [true, false]) {
        const d = decideProductionCopy({ stackExists, wantsCopy, hasProduction });
        assert.ok(d.reason.length > 20, JSON.stringify({ stackExists, wantsCopy, hasProduction }));
      }
});

test("spec 0226: a FAILING filestore copy is caught — the check must be reachable", async () => {
  // Written after the first draft appended `|| true` to the copy, which made
  // this branch unreachable: the command always exited 0, so a filestore that
  // never copied looked identical to one that did.
  const { ssh } = fakeSsh((c) =>
    c.includes("docker run --rm") ? { code: 1, stdout: "", stderr: "no space left on device" }
                                  : ok("312"));
  await assert.rejects(
    () => restoreIntoBranch({ ssh, ...base }, "/tmp/d.dump"),
    (e: Error) => {
      assert.match(e.message, /filestore copy failed/);
      assert.match(e.message, /no space left/, "the real stderr must reach the message");
      return true;
    },
  );
});

test("spec 0226: the copy command swallows neither errors nor stderr", async () => {
  const { ssh, cmds } = fakeSsh((c) => (c.includes("ir_module_module") ? ok("312") : ok()));
  await restoreIntoBranch({ ssh, ...base }, "/tmp/d.dump");
  const copy = cmds.find((c) => c.includes("docker run --rm"))!;
  assert.doesNotMatch(copy, /\|\| *true/, "|| true would make the exit-code check unreachable");
  assert.doesNotMatch(copy, /2>\/dev\/null/, "the stderr is quoted in the failure message");
});

test("spec 0226: a value a shell would interpret is REFUSED, not interpolated", () => {
  // The premise is that production cannot be changed by this module. An
  // interpolated `>` target is one semicolon away from breaking that, so the
  // builder refuses rather than trusting its callers to stay well-behaved.
  for (const evil of ["/tmp/x; psql -c 'drop table res_users'", "x$(whoami)", "a`id`b", "x|y", "a b"]) {
    assert.throws(
      () => productionCommand(base, { kind: "dump", dbName: base.prodDbName, toPath: evil }),
      /characters that a shell would interpret/,
      `should refuse ${JSON.stringify(evil)}`,
    );
  }
  // And the ordinary values still build.
  assert.ok(productionCommand(base, { kind: "dump", dbName: "sushi_prod", toPath: "/tmp/a.dump" }));
  assert.ok(productionCommand(base, { kind: "copyFilestore", toVolume: "br-x_odoo-filestore" }));
});
