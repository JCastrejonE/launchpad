import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSshRunner, sshCommandArgs } from "./ssh.js";

// Spec 0012 — the SSH seam. The fake is real test infrastructure (used by the
// bootstrap + deploy tests), so it's asserted here directly. `ExecSshRunner`
// (live) is deliberately never exercised in CI — only its pure argv builder,
// `sshCommandArgs`, is testable without spawning a process or opening a
// connection.

test("sshCommandArgs wires identity, host/user, and the remote command", () => {
  const args = sshCommandArgs(
    { host: "203.0.113.5", user: "launchpad", identityFile: "/keys/launchpad_ed25519" },
    "docker --version",
  );
  assert.deepEqual(args, [
    "-i",
    "/keys/launchpad_ed25519",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
    "launchpad@203.0.113.5",
    "docker --version",
  ]);
});

test("sshCommandArgs adds -p only when a non-default port is given", () => {
  const withoutPort = sshCommandArgs(
    { host: "h", user: "u", identityFile: "/k" },
    "true",
  );
  assert.equal(withoutPort.includes("-p"), false);

  const withPort = sshCommandArgs(
    { host: "h", user: "u", identityFile: "/k", port: 2222 },
    "true",
  );
  const pIndex = withPort.indexOf("-p");
  assert.notEqual(pIndex, -1);
  assert.equal(withPort[pIndex + 1], "2222");
});

test("fake runner records commands and returns the default success result", async () => {
  const ssh = createFakeSshRunner();
  const r = await ssh.exec("docker --version");
  assert.deepEqual(r, { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(ssh.commands, ["docker --version"]);
});

test("fake runner lets a test script a per-command response", async () => {
  const ssh = createFakeSshRunner({
    respond: (cmd) => (cmd.includes("cat") ? { code: 1, stdout: "", stderr: "no file" } : undefined),
  });
  assert.equal((await ssh.exec("cat /etc/launchpad/bootstrap.json")).code, 1);
  assert.equal((await ssh.exec("true")).code, 0);
});

test("fake runner records written files by remote path", async () => {
  const ssh = createFakeSshRunner();
  await ssh.writeFile("/tmp/x", "hello");
  assert.equal(ssh.files.get("/tmp/x"), "hello");
});
