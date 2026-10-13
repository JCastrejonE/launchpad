import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRemoteGateCommand, parseGateOutcome } from "./ci-gate.js";
import { FleetError } from "./errors.js";

// Spec 0228 B.

test("the job is pinned to the isolated network and given no credentials", () => {
  const cmd = buildRemoteGateCommand({ workdir: "/tmp/ci-abc123" });
  assert.match(cmd, /--network ci-isolated/);
  assert.match(cmd, /-v \/tmp\/ci-abc123:\/w/);
  assert.match(cmd, /--rm/);
  // The properties that make this safe to run branch code with. A regression
  // here is not a style change: it is the isolation of spec 0227 C.
  assert.doesNotMatch(cmd, /-e |--env|--privileged|GITHUB_TOKEN|DATABASE_URL/);
});

test("a path a shell would interpret is refused, not escaped", () => {
  assert.throws(
    () => buildRemoteGateCommand({ workdir: "/tmp/x; rm -rf /" }),
    (e: unknown) => e instanceof FleetError,
  );
  assert.throws(
    () => buildRemoteGateCommand({ workdir: "/tmp/$(id)" }),
    (e: unknown) => e instanceof FleetError,
  );
});

test("green is green", () => {
  assert.deepEqual(parseGateOutcome("== build\n   ok build\n\nGATE GREEN\n"), {
    green: true,
    failedStep: null,
  });
});

test("red names the step, so the status description can say what broke", () => {
  const out = parseGateOutcome("   FAIL test (exit 1)\n\nGATE RED: test\n");
  assert.equal(out.green, false);
  assert.equal(out.failedStep, "test");
});

test("no marker at all is NOT green", () => {
  // The gate never ran: install died, wrong image, docker refused. Calling that
  // a pass is how a CI system comes to certify nothing (rows 74, 55).
  const out = parseGateOutcome("docker: Error response from daemon: pull access denied\n");
  assert.equal(out.green, false);
  assert.equal(out.failedStep, "the gate did not run");
});

test("the step list is stripped of the colour gate.sh prints around it", () => {
  // The exact bytes gate.sh emits: printf '\n\033[31mGATE RED: %s\033[0m\n'.
  // The fixtures above were hand-written and clean, so they proved the parser
  // against output no gate ever produces (VERIFICATION #1). The first real red
  // verdict published the step list with the reset code still attached, into a
  // GitHub description that a person reads.
  const real = "\n\u001b[31mGATE RED: build, typecheck, test, web build\u001b[0m\n";
  const out = parseGateOutcome(real);
  assert.equal(out.green, false);
  assert.equal(out.failedStep, "build, typecheck, test, web build");
});
