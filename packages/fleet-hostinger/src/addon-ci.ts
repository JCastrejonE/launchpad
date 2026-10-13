/**
 * Run an Odoo addons repo's OWN tests, on our own sandbox VPS (spec 0167).
 *
 * The owner: *"I no longer have credits for running CI on github, we need to run
 * against our own staging vps."* So CI is not a GitHub Actions job: the worker
 * ships the addons to the sandbox box over the fleet's existing SSH path and
 * runs Odoo's own test runner there, in throwaway containers.
 *
 * This costs nothing per run beyond the box we already pay for, needs no GitHub
 * permission (the `workflow` scope a PAT lacks blocks committing a workflow file
 * at all), and — unlike an Actions job, which can only run after a PR exists —
 * it reports inside the coder loop, where a failing test can still be fixed.
 *
 * ## Two flags carry the design, both measured rather than assumed
 *
 * - `--test-tags /<module>`: without it, `--test-enable` runs the tests of every
 *   module being installed, INCLUDING dependencies. Measured on the real addon:
 *   that pulled in `odoo.addons.account.tests.*`, hundreds of upstream cases,
 *   still running after ten minutes. Scoped, the same work is install ~78s,
 *   tests ~9s.
 * - `--stop-after-init`: run and exit rather than serve. Odoo exits non-zero
 *   when a test fails or errors, which is the only reason any of this can fail.
 *
 * ## Why the result is a printed marker and not an exit code
 *
 * The remote script always exits 0 and prints `LPCI_EXIT=<code>`. An exit code
 * that has travelled through ssh, a shell and a trap is not a check you can
 * trust (VERIFICATION #8 — this repo has been burned by exactly that, in both
 * directions). The marker is written by the one line that knows the answer, so
 * a MISSING marker means the script itself died and is reported as an
 * infrastructure error, never as "your tests passed".
 */
import { createHash } from "node:crypto";
import { FleetError } from "./errors.js";
import { assertSandboxVps } from "./sandbox.js";
import type { SshRunner } from "./ssh.js";
import { addonModuleName, discoverAddons, packAddonsWithTar, type PackAddons } from "./staging.js";
import type { OdooVersion } from "./stack.js";

export interface AddonCiOptions {
  /** Hard-refused unless allowlisted in `infra/fleet-sandbox.json` (ADR-013). */
  vpsId: number;
  ssh: SshRunner;
  /** Working tree holding the addons — the run's worktree. */
  repoRoot: string;
  odooVersion: OdooVersion;
  /**
   * Names this run's containers. Anything unique per concurrent run; sanitised
   * and hashed here, so a caller may pass a slug/spec id straight through.
   */
  runKey: string;
  /** Test seams. */
  addonPaths?: readonly string[];
  pack?: PackAddons;
}

export interface AddonCiResult {
  /** False when the repo holds no Odoo addons — there was nothing to test. */
  ran: boolean;
  green: boolean;
  modules: string[];
  /** One line for the PR body / run log. */
  summary: string;
  /** Odoo's own test-result lines, for a human diagnosing a red run. */
  log: string;
}

/** Docker object names: `lpci-` is disjoint from `br-` (branch stacks) and
 * `spec-` (spec stacks), so no sweep or teardown can ever confuse a CI
 * container for a staging stack. The hash keeps distinct keys distinct after
 * sanitisation, the same collision fix `branchStackName` uses. */
export function ciObjectName(runKey: string): string {
  const slug = runKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const hash = createHash("sha256").update(runKey).digest("hex").slice(0, 6);
  return `lpci-${slug}-${hash}`;
}

/** The `--test-tags` value selecting exactly these modules' tests. */
export function testTagsFor(modules: readonly string[]): string {
  return modules.map((m) => `/${m}`).join(",");
}

/**
 * Parse the remote script's output.
 *
 * Exported for its tests: this function alone decides green vs red, and it must
 * treat a missing marker as "no answer" rather than as success — an absent
 * result is the one thing that must never read as a pass.
 */
export function parseCiOutput(stdout: string): { exitCode: number; stage: string } | null {
  const exit = [...stdout.matchAll(/^LPCI_EXIT=(\d+)$/gm)].at(-1);
  if (!exit) return null;
  const stage = [...stdout.matchAll(/^LPCI_STAGE=(\w+)$/gm)].at(-1);
  return { exitCode: Number(exit[1]), stage: stage?.[1] ?? "unknown" };
}

/**
 * Runs the addon's tests that Odoo's own runner will NOT run.
 *
 * Measured, and it is the reason this exists: `--test-tags /<module>` selects
 * tests tagged with the module, and only Odoo's own `BaseCase` descendants get
 * tagged. A plain `unittest.TestCase` in `tests/` is silently skipped — on the
 * real addon, Odoo started 4 tests and ignored 4 others, while CI reported
 * green. A spec whose whole content was two new pure tests passed without ever
 * executing them. That is the exact shape of a check that cannot fail.
 *
 * The split rule is deterministic, not a guess at an error message: a test file
 * that imports `odoo`, or uses a relative import (so it belongs to the addon
 * package), is an Odoo test and is left to Odoo. Anything else is standalone and
 * is run here.
 */
function standaloneDriver(): string {
  return `"""Run the addon tests Odoo's tag filter excludes (spec 0167)."""
import ast
import importlib.util
import pathlib
import sys
import unittest


def is_odoo_test(path):
    """True when Odoo's runner owns this file, so we must NOT run it here."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(a.name.split(".")[0] == "odoo" for a in node.names):
                return True
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # relative import => part of the addon package
                return True
            if node.module and node.module.split(".")[0] == "odoo":
                return True
    return False


root = pathlib.Path(sys.argv[1])
suite = unittest.TestSuite()
ran, left_to_odoo, unreadable = [], [], []
for f in sorted(root.glob("*/tests/test_*.py")):
    try:
        odoo_owned = is_odoo_test(f)
    except SyntaxError as exc:
        # A file we cannot parse is a failure, never a silent skip.
        unreadable.append("%s (%s)" % (f.name, exc))
        continue
    if odoo_owned:
        left_to_odoo.append(f.name)
        continue
    spec = importlib.util.spec_from_file_location(f.stem, f)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
    ran.append(f.name)

result = unittest.TextTestRunner(verbosity=2).run(suite)
print("LPCI_STANDALONE_FILES=%d" % len(ran))
print("LPCI_STANDALONE_TESTS=%d" % result.testsRun)
print("LPCI_STANDALONE_ODOO_OWNED=%s" % ",".join(left_to_odoo))
if unreadable:
    print("LPCI_STANDALONE_UNREADABLE=%s" % "; ".join(unreadable))
sys.exit(0 if result.wasSuccessful() and not unreadable else 1)
`;
}

/**
 * The script that runs on the sandbox box. Built here (not in the shell) so the
 * module list is computed by Node and the remote side stays simple.
 */
function remoteScript(opts: {
  name: string;
  dir: string;
  archivePath: string;
  driverPath: string;
  image: string;
  modules: string;
  tags: string;
}): string {
  const { name, dir, archivePath, driverPath, image, modules, tags } = opts;
  return `#!/usr/bin/env bash
set -u
NET=${name}-net
PG=${name}-db
DIR=${dir}

cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$DIR"
}
trap cleanup EXIT

# A previous attempt may have died before its trap ran.
docker rm -f "$PG" >/dev/null 2>&1
docker network rm "$NET" >/dev/null 2>&1
rm -rf "$DIR"; mkdir -p "$DIR/addons"
base64 -d < ${archivePath} | tar -xzf - --no-same-owner -C "$DIR/addons"
rm -f ${archivePath}
mv ${driverPath} "$DIR/standalone_tests.py"

docker network create "$NET" >/dev/null 2>&1
docker run -d --name "$PG" --network "$NET" \\
  -e POSTGRES_USER=odoo -e POSTGRES_PASSWORD=odoo -e POSTGRES_DB=postgres \\
  postgres:16 >/dev/null 2>&1

# NOT pg_isready: the postgres entrypoint runs a TEMPORARY server for initdb and
# then stops it, so the probe passes against a server that is about to vanish —
# measured, it did exactly that here. Assert a real authenticated query, twice.
ok=0
for _ in $(seq 1 90); do
  if docker exec "$PG" psql -U odoo -d postgres -tAc "select 1" >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 2 ] && break
  else
    ok=0
  fi
  sleep 1
done
if [ "$ok" -lt 2 ]; then
  echo "LPCI_STAGE=postgres"
  echo "postgres never accepted a connection on the CI box"
  echo "LPCI_EXIT=90"
  exit 0
fi

run_odoo() {
  local log="$1"; shift
  docker run --rm --network "$NET" -v "$DIR/addons:/mnt/extra-addons:ro" \\
    -e HOST="$PG" -e USER=odoo -e PASSWORD=odoo ${image} \\
    -d lpci --stop-after-init --log-level=test "$@" > "$log" 2>&1
  return $?
}

# Installing dependencies is the slow part and is not what is under test;
# separating it means a red result points at the addon, not at install noise.
run_odoo "$DIR/install.log" -i ${modules}
INSTALL_RC=$?
if [ $INSTALL_RC -ne 0 ]; then
  echo "LPCI_STAGE=install"
  grep -aE "ERROR|CRITICAL|Traceback|ParseError" "$DIR/install.log" | tail -25
  echo "LPCI_EXIT=$INSTALL_RC"
  exit 0
fi

run_odoo "$DIR/test.log" -u ${modules} --test-enable --test-tags ${tags}
TEST_RC=$?
echo "LPCI_STAGE=test"
grep -aE "tests\\.stats|tests\\.result|FAIL:|ERROR:|Traceback" "$DIR/test.log" | tail -25
if [ $TEST_RC -ne 0 ]; then
  echo "LPCI_EXIT=$TEST_RC"
  exit 0
fi

# Odoo's tag filter runs ONLY its own test classes. A plain unittest.TestCase in
# tests/ is skipped in silence — measured on this very addon, where 4 pure tests
# never ran while CI said green. Run them, or CI is green about code it never
# executed.
docker run --rm -v "$DIR:/work:ro" ${image} \\
  python3 /work/standalone_tests.py /work/addons > "$DIR/standalone.log" 2>&1
STANDALONE_RC=$?
echo "LPCI_STAGE=standalone"
grep -aE "LPCI_STANDALONE_|^FAILED|^OK|^Ran |^FAIL:|^ERROR:" "$DIR/standalone.log" | tail -20
echo "LPCI_EXIT=$STANDALONE_RC"
exit 0
`;
}

/**
 * Install this repo's addons into a throwaway Odoo on the sandbox VPS and run
 * their tests.
 *
 * Returns `{ ran: false }` when the repo has no addons — the caller decides what
 * to say about that; this function never invents a pass. Throws `FleetError`
 * for infrastructure trouble (ssh failed, no result marker) so the caller can
 * distinguish "the tests failed" from "CI could not run", which are different
 * facts and must not share a colour.
 */
export async function runAddonTestsOnSandbox(opts: AddonCiOptions): Promise<AddonCiResult> {
  assertSandboxVps(opts.vpsId, "runAddonTestsOnSandbox");

  const addonPaths = opts.addonPaths ?? discoverAddons(opts.repoRoot);
  if (addonPaths.length === 0) {
    return { ran: false, green: true, modules: [], summary: "", log: "" };
  }
  const modules = addonPaths.map(addonModuleName);

  const name = ciObjectName(opts.runKey);
  const dir = `/tmp/${name}`;
  const archivePath = `${dir}.tar.gz.b64`;

  const pack = opts.pack ?? packAddonsWithTar;
  const archive = await pack(opts.repoRoot, addonPaths);

  await opts.ssh.writeFile(archivePath, archive);
  const driverPath = `${dir}.standalone.py`;
  await opts.ssh.writeFile(driverPath, standaloneDriver());
  const scriptPath = `${dir}.sh`;
  await opts.ssh.writeFile(
    scriptPath,
    remoteScript({
      name,
      dir,
      archivePath,
      driverPath,
      image: `odoo:${opts.odooVersion}`,
      modules: modules.join(","),
      tags: testTagsFor(modules),
    }),
  );

  const res = await opts.ssh.exec(`bash ${scriptPath}; rm -f ${scriptPath}`);
  if (res.code !== 0) {
    throw new FleetError(
      "deploy",
      `addon CI: the sandbox box did not run the script (exit ${res.code}): ` +
        `${res.stderr.trim().slice(0, 500)}`,
      { retryable: true },
    );
  }

  const parsed = parseCiOutput(res.stdout);
  if (!parsed) {
    // No marker: the script died before reaching the line that knows the answer.
    // That is an infrastructure failure, and reporting it as a pass is the one
    // outcome this function must never produce.
    throw new FleetError(
      "deploy",
      `addon CI: no result marker in the sandbox output — the run did not complete. ` +
        `Last output: ${res.stdout.trim().slice(-500)}`,
      { retryable: true },
    );
  }

  const green = parsed.exitCode === 0;
  const where =
    parsed.stage === "install"
      ? "instalando los addons"
      : parsed.stage === "standalone"
        ? "corriendo las pruebas sueltas"
        : "corriendo las pruebas de Odoo";
  // Report what RAN, not just the colour. Odoo's runner silently ignores plain
  // unittest classes, so "en verde" without counts is the sentence that hid a
  // spec's two new tests never executing.
  const odooRan = res.stdout.match(/of (\d+) tests when loading database/)?.[1];
  const standaloneRan = res.stdout.match(/^LPCI_STANDALONE_TESTS=(\d+)$/m)?.[1];
  const counts = [
    odooRan ? `${odooRan} de Odoo` : null,
    standaloneRan ? `${standaloneRan} sueltas` : null,
  ]
    .filter(Boolean)
    .join(" + ");
  return {
    ran: true,
    green,
    modules,
    summary: green
      ? `CI en el staging propio: ${modules.join(", ")} — en verde` +
        (counts ? ` (${counts} pruebas).` : ".")
      : `CI en el staging propio: falló ${where} (${modules.join(", ")}).`,
    log: res.stdout.trim().slice(-4000),
  };
}
