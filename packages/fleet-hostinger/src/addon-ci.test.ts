/**
 * Spec 0167. The cases that matter here are the ones where a wrong answer is
 * expensive: an absent result read as a pass, a non-sandbox box touched, or the
 * unscoped `--test-enable` that made a ten-minute CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ciObjectName,
  parseCiOutput,
  runAddonTestsOnSandbox,
  testTagsFor,
} from "./addon-ci.js";
import { FleetError } from "./errors.js";
import type { SshRunner } from "./ssh.js";

const SANDBOX_VPS = 100001;

/** Records what was sent and replays a canned result. */
function fakeSsh(stdout: string, code = 0) {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const ssh: SshRunner = {
    exec: async (command) => {
      commands.push(command);
      return { code, stdout, stderr: "" };
    },
    writeFile: async (remotePath, content) => {
      files.set(remotePath, content);
    },
  };
  return { ssh, files, commands };
}

function repoWithAddons(names: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), "addon-ci-"));
  for (const n of names) {
    mkdirSync(path.join(root, n), { recursive: true });
    writeFileSync(path.join(root, n, "__manifest__.py"), "{'name': 'x'}");
  }
  return root;
}

test("a missing result marker is an ERROR, never a pass", async () => {
  // The one outcome that must be impossible: the script died, and CI says green.
  const { ssh } = fakeSsh("some output\nbut no marker\n");
  await assert.rejects(
    () =>
      runAddonTestsOnSandbox({
        vpsId: SANDBOX_VPS,
        ssh,
        repoRoot: repoWithAddons(["mod_a"]),
        odooVersion: 18,
        runKey: "proj-0001",
        pack: async () => "BASE64",
      }),
    (err: unknown) => err instanceof FleetError && /no result marker/.test((err as Error).message),
  );
});

test("the marker decides green, not the ssh exit code", async () => {
  const root = repoWithAddons(["mod_a"]);
  // ssh exits 0 (it always does — the script ends `exit 0`) while the TESTS failed.
  const red = fakeSsh("LPCI_STAGE=test\n0 failed, 1 error(s)\nLPCI_EXIT=1\n", 0);
  const redResult = await runAddonTestsOnSandbox({
    vpsId: SANDBOX_VPS,
    ssh: red.ssh,
    repoRoot: root,
    odooVersion: 18,
    runKey: "proj-0001",
    pack: async () => "BASE64",
  });
  assert.equal(redResult.ran, true);
  assert.equal(redResult.green, false, "exit 0 from ssh must not make a failed test suite green");

  const green = fakeSsh("LPCI_STAGE=test\nl10n: 6 tests\nLPCI_EXIT=0\n", 0);
  const greenResult = await runAddonTestsOnSandbox({
    vpsId: SANDBOX_VPS,
    ssh: green.ssh,
    repoRoot: root,
    odooVersion: 18,
    runKey: "proj-0001",
    pack: async () => "BASE64",
  });
  assert.equal(greenResult.green, true);
});

test("an ssh transport failure throws (retryable) instead of reporting red tests", async () => {
  // "CI could not run" and "your tests failed" are different facts. Reporting
  // the first as the second makes a coder agent burn repair rounds on fine code.
  const { ssh } = fakeSsh("", 255);
  await assert.rejects(
    () =>
      runAddonTestsOnSandbox({
        vpsId: SANDBOX_VPS,
        ssh,
        repoRoot: repoWithAddons(["mod_a"]),
        odooVersion: 18,
        runKey: "proj-0001",
        pack: async () => "BASE64",
      }),
    (err: unknown) => err instanceof FleetError && (err as FleetError).retryable === true,
  );
});

test("a repo with no addons reports ran:false — never a fabricated pass", async () => {
  const { ssh, commands } = fakeSsh("");
  const result = await runAddonTestsOnSandbox({
    vpsId: SANDBOX_VPS,
    ssh,
    repoRoot: mkdtempSync(path.join(tmpdir(), "addon-ci-empty-")),
    odooVersion: 18,
    runKey: "proj-0001",
  });
  assert.equal(result.ran, false);
  assert.deepEqual(result.modules, []);
  assert.equal(commands.length, 0, "nothing should be run on the box");
});

test("refuses a VPS that is not on the sandbox allowlist (ADR-013)", async () => {
  const { ssh, commands } = fakeSsh("LPCI_EXIT=0\n");
  await assert.rejects(
    () =>
      runAddonTestsOnSandbox({
        vpsId: 100002, // the live-customer box spec 0125 nearly wiped
        ssh,
        repoRoot: repoWithAddons(["mod_a"]),
        odooVersion: 18,
        runKey: "proj-0001",
        pack: async () => "BASE64",
      }),
    (err: unknown) => err instanceof FleetError && (err as FleetError).kind === "sandbox",
  );
  assert.equal(commands.length, 0, "the refusal must happen BEFORE anything is sent");
});

/**
 * The measured mistake: `--test-enable` alone runs every dependency's tests
 * (odoo.addons.account.tests.*, hundreds of cases, ten minutes and counting).
 * The scoping flag is the difference between a usable CI and an unusable one,
 * so it is asserted rather than trusted to survive an edit.
 */
test("the remote script scopes tests to this repo's modules and stops after init", async () => {
  const { ssh, files } = fakeSsh("LPCI_STAGE=test\nLPCI_EXIT=0\n");
  await runAddonTestsOnSandbox({
    vpsId: SANDBOX_VPS,
    ssh,
    repoRoot: repoWithAddons(["mod_a", "mod_b"]),
    odooVersion: 18,
    runKey: "proj-0001",
    pack: async () => "BASE64",
  });
  const script = [...files.values()].find((c) => c.includes("run_odoo"));
  assert.ok(script, "a script should have been written");
  assert.match(script, /--test-tags \/mod_a,\/mod_b/);
  assert.match(script, /--test-enable/);
  assert.match(script, /--stop-after-init/);
  assert.match(script, /odoo:18/);
  // Readiness is a real authenticated query, not `pg_isready` — which passes
  // against the temporary server the postgres entrypoint runs for initdb and
  // then stops. (The script NAMES pg_isready in a comment explaining why; the
  // assertion is about what it RUNS.)
  assert.match(script, /psql -U odoo -d postgres -tAc "select 1"/);
  assert.doesNotMatch(script, /docker exec "\$PG" pg_isready/);
});

/**
 * The false green this phase exists to kill: Odoo's `--test-tags` runs only its
 * own test classes, so a plain `unittest.TestCase` in `tests/` is skipped in
 * silence. Measured on the real addon — Odoo started 4 tests and ignored 4
 * others while CI reported green, and a spec whose entire content was two new
 * pure tests passed without ever running them.
 */
test("the standalone phase runs the tests Odoo's tag filter excludes", async () => {
  const { ssh, files } = fakeSsh("LPCI_STAGE=standalone\nLPCI_STANDALONE_TESTS=4\nLPCI_EXIT=0\n");
  await runAddonTestsOnSandbox({
    vpsId: SANDBOX_VPS,
    ssh,
    repoRoot: repoWithAddons(["mod_a"]),
    odooVersion: 18,
    runKey: "proj-0001",
    pack: async () => "BASE64",
  });
  const driver = [...files.values()].find((c) => c.includes("is_odoo_test"));
  assert.ok(driver, "the standalone driver should be shipped");
  // The split is decided by imports, deterministically — NOT by matching an
  // error message, which is the fragile version of this.
  assert.match(driver, /ast\.ImportFrom/);
  assert.match(driver, /node\.level/); // a relative import means Odoo owns it
  assert.match(driver, /LPCI_STANDALONE_TESTS/);
  const script = [...files.values()].find((c) => c.includes("run_odoo"));
  assert.ok(script, "the run script should be shipped");
  assert.match(script, /standalone_tests\.py/, "the script must actually invoke the driver");
});

test("a standalone-phase failure makes the whole run red", async () => {
  // Odoo's phase passed; the pure tests did not. Green here would be the exact
  // bug this phase was added to remove.
  const { ssh } = fakeSsh("LPCI_STAGE=standalone\nFAILED (failures=1)\nLPCI_EXIT=1\n");
  const result = await runAddonTestsOnSandbox({
    vpsId: SANDBOX_VPS,
    ssh,
    repoRoot: repoWithAddons(["mod_a"]),
    odooVersion: 18,
    runKey: "proj-0001",
    pack: async () => "BASE64",
  });
  assert.equal(result.green, false);
  assert.match(result.summary, /sueltas/);
});

test("the summary reports how many tests RAN, not just the colour", async () => {
  // "en verde" with no counts is the sentence that hid two tests never running.
  const { ssh } = fakeSsh(
    "LPCI_STAGE=test\n0 failed, 0 error(s) of 4 tests when loading database 'lpci'\n" +
      "LPCI_STAGE=standalone\nLPCI_STANDALONE_TESTS=4\nLPCI_EXIT=0\n",
  );
  const result = await runAddonTestsOnSandbox({
    vpsId: SANDBOX_VPS,
    ssh,
    repoRoot: repoWithAddons(["mod_a"]),
    odooVersion: 18,
    runKey: "proj-0001",
    pack: async () => "BASE64",
  });
  assert.equal(result.green, true);
  assert.match(result.summary, /4 de Odoo/);
  assert.match(result.summary, /4 sueltas/);
});

test("container names are unique per key and disjoint from staging stacks", () => {
  const a = ciObjectName("proj-0001");
  const b = ciObjectName("proj-0002");
  assert.notEqual(a, b);
  assert.match(a, /^lpci-/);
  // Sanitisation alone would collide these; the hash is what keeps them apart.
  assert.notEqual(ciObjectName("a/b"), ciObjectName("a_b"));
  // `br-` (branch stacks) and `spec-` (spec stacks) must never be produced.
  assert.doesNotMatch(a, /^(br|spec)-/);
});

test("parseCiOutput takes the LAST marker and requires one", () => {
  assert.equal(parseCiOutput("LPCI_EXIT=1\nLPCI_EXIT=0\n")?.exitCode, 0);
  assert.equal(parseCiOutput("nothing here"), null);
  assert.equal(parseCiOutput("LPCI_STAGE=install\nLPCI_EXIT=2\n")?.stage, "install");
});

test("testTagsFor builds Odoo's module-scoped tag syntax", () => {
  assert.equal(testTagsFor(["a", "b"]), "/a,/b");
  assert.equal(testTagsFor(["only"]), "/only");
});
