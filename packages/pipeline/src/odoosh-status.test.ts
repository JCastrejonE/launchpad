/**
 * Spec 0115. The assertions that matter are about the state a naive reader gets
 * wrong: **absent**. odoo.sh not having reported is a different fact from a build
 * running, and folding them together either invents a build that does not exist or
 * lets a promote through on no evidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ODOO_SH_STATUS_CONTEXT,
  interpretOdooShStatus,
  isOdooShBuildInFlight,
  describeOdooShBuild,
} from "./odoosh-status.js";
import type { CommitStatus } from "@launchpad/github";

function status(state: CommitStatus["state"], overrides: Partial<CommitStatus> = {}): CommitStatus {
  return {
    state,
    context: ODOO_SH_STATUS_CONTEXT,
    description: "Build 1234",
    targetUrl: "https://acme.odoo.com/paas#/build/1234",
    ...overrides,
  };
}

test("the context is odoo.sh's own — a mismatch would read as 'no build ever ran'", () => {
  assert.equal(ODOO_SH_STATUS_CONTEXT, "ci/odoo.sh");
});

test("no status at all is ABSENT — never 'building', never green", () => {
  // The whole point. `null` is what latestStatusForContext returns when odoo.sh has
  // not reported: repo not connected, build not created, or a branch it ignores.
  const build = interpretOdooShStatus(null);
  assert.deepEqual(build, { status: "absent" });
  assert.equal(isOdooShBuildInFlight(build), false, "absent is not a build in flight");
});

test("pending is the ONLY state that means wait", () => {
  const build = interpretOdooShStatus(status("pending"));
  assert.equal(build.status, "building");
  assert.equal(isOdooShBuildInFlight(build), true);
});

test("success carries the build link through, and is not in flight", () => {
  const build = interpretOdooShStatus(status("success"));
  assert.equal(build.status, "success");
  assert.equal(isOdooShBuildInFlight(build), false);
  assert.equal(
    build.status === "success" ? build.url : null,
    "https://acme.odoo.com/paas#/build/1234",
  );
});

test("failure and error both mean failed, and the raw state is kept for an operator", () => {
  for (const state of ["failure", "error"] as const) {
    const build = interpretOdooShStatus(status(state));
    assert.equal(build.status, "failed");
    assert.equal(build.status === "failed" ? build.githubState : null, state);
    // Per spec 0115, promoting over a failed build is safe — odoo.sh falls back to
    // the last good build rather than leaving production down — so a failed build
    // must NOT read as still in flight.
    assert.equal(isOdooShBuildInFlight(build), false);
  }
});

test("an unrecognised state reads as building, not as success", () => {
  // If GitHub adds a fifth state, the safe reading of "we do not understand this"
  // is "do not act yet". Same instinct as aggregateChecks treating an empty run
  // list as pending rather than a vacuous success (spec 0043).
  const build = interpretOdooShStatus(status("something_new" as CommitStatus["state"]));
  assert.equal(build.status, "building");
  assert.equal(isOdooShBuildInFlight(build), true);
});

test("a missing description or url stays null rather than becoming a placeholder", () => {
  const build = interpretOdooShStatus(status("success", { description: null, targetUrl: null }));
  assert.equal(build.status === "success" ? build.description : "x", null);
  assert.equal(build.status === "success" ? build.url : "x", null);
});

test("every state describes itself distinctly — including absent", () => {
  const lines = [
    describeOdooShBuild(interpretOdooShStatus(null)),
    describeOdooShBuild(interpretOdooShStatus(status("pending"))),
    describeOdooShBuild(interpretOdooShStatus(status("success"))),
    describeOdooShBuild(interpretOdooShStatus(status("failure"))),
  ];
  assert.equal(new Set(lines).size, 4, `descriptions must differ: ${lines.join(" | ")}`);
  assert.match(lines[0]!, /no ha reportado/);
});
