/**
 * Spec 0219 B, acceptance: "A's deploy must be unable to read B's parameters —
 * that is the acceptance test, and it is written as a RACE, not as a unit test
 * that calls one function."
 *
 * So this forks real processes that call the real `claimDeployRequest` at the
 * same moment, and asserts that the file the deploy script would read contains
 * exactly one writer's parameters — the one that was told it won.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { claimDeployRequest } from "./deploy-claim.js";

const exec = promisify(execFile);
const RACERS = 12;

test("spec 0219 B: twelve concurrent deploys, exactly one owns the parameters", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-claim-"));
  const requestPath = path.join(dir, "request");
  // Each racer requires the SHIPPING module — not a copy of the mechanism.
  const claimModule = path.join(__dirname, "deploy-claim.js");
  const racer = path.join(dir, "racer.js");
  writeFileSync(
    racer,
    `const { claimDeployRequest } = require(${JSON.stringify(claimModule)});
     const who = process.argv[2];
     process.stdout.write(claimDeployRequest("sha " + who + " 1.0.0 " + who + "\\n",
       ${JSON.stringify(requestPath)}) ? "WON " + who : "LOST " + who);`,
  );

  try {
    const results = await Promise.all(
      Array.from({ length: RACERS }, (_, i) =>
        exec(process.execPath, [racer, `actor${i}`]).then((r) => r.stdout),
      ),
    );

    const winners = results.filter((r) => r.startsWith("WON"));
    assert.equal(winners.length, 1, `expected one winner, got ${winners.join(", ")}`);

    // The decisive assertion: the parameters on disk belong to the process that
    // was told it won. A losing writer clobbering the file is the defect — a
    // deploy running someone else's commit under its own release row.
    const onDisk = readFileSync(requestPath, "utf8");
    const winner = winners[0]!.replace("WON ", "");
    assert.equal(onDisk, `sha ${winner} 1.0.0 ${winner}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec 0219 B: a claim on a free path succeeds and is readable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-claim-"));
  const requestPath = path.join(dir, "request");
  try {
    assert.equal(claimDeployRequest("payload\n", requestPath), true);
    assert.equal(readFileSync(requestPath, "utf8"), "payload\n");
    assert.equal(claimDeployRequest("other\n", requestPath), false);
    assert.equal(readFileSync(requestPath, "utf8"), "payload\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
