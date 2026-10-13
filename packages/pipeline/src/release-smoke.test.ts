/**
 * Spec 0177. Every case below is a fact observed on the live fleet today, not
 * an invented scenario — the point of this file is that these exact states used
 * to pass every check we had.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseSmokeProblems, type ReleaseSmokeFacts } from "./release-smoke.js";

/** `sushi` as it stands right now: everything correct. */
const GREEN: ReleaseSmokeFacts = {
  slug: "sushi",
  odooHost: "sushi.odoo.example.com",
  frontHost: "sushi.example.com",
  odooStatus: 200,
  frontStatus: 200,
  releaseVersion: "1.0.0",
  // The candidate was cut at promote; the deploy came later.
  releaseCreatedAt: new Date("2026-08-12T12:10:00Z"),
  odooSeries: 18,
  expectedModules: ["sushi_menu"],
  hasFront: true,
  modules: [{ name: "sushi_menu", state: "installed", version: "18.0.1.0.0" }],
  frontStartedAt: new Date("2026-08-12T12:37:00Z"),
  restartPolicies: [
    { container: "sushi-prod-odoo-1", policy: "unless-stopped" },
    { container: "sushi-prod-db-1", policy: "unless-stopped" },
    { container: "sushi-front-front-1", policy: "unless-stopped" },
  ],
};

test("a healthy production is silent", () => {
  assert.deepEqual(releaseSmokeProblems(GREEN), []);
});

test("spec 0175: the backend answering 404 while the release says deployed", () => {
  // Measured: deployToFleet re-rendered the compose as Host(prod.sushi.example.com),
  // so the customer's hostname lost its router.
  const problems = releaseSmokeProblems({ ...GREEN, odooStatus: 404 });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.code, "odoo-unreachable");
  assert.match(problems[0]?.detail ?? "", /sushi\.odoo\.example\.com/);
  assert.match(problems[0]?.detail ?? "", /1\.0\.0/, "names the release that claims to be live");
});

test("spec 0176: the addon on disk that the database never heard of", () => {
  // Measured: sushi_menu in /mnt/extra-addons, absent from 705 module rows.
  const problems = releaseSmokeProblems({ ...GREEN, modules: [] });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.code, "module-not-installed");
  assert.match(problems[0]?.detail ?? "", /no aparece en ir_module_module/);
  // The sentence that matters, because it is the exact confusion of the day.
  assert.match(problems[0]?.detail ?? "", /en disco: eso no es estar instalado/);
});

test("a module stuck at `uninstalled` is not installed either", () => {
  const problems = releaseSmokeProblems({
    ...GREEN,
    modules: [{ name: "sushi_menu", state: "uninstalled", version: "18.0.1.0.0" }],
  });
  assert.equal(problems[0]?.code, "module-not-installed");
  assert.match(problems[0]?.detail ?? "", /estado uninstalled/);
});

test("an installed module at the WRONG version is caught, and says why it matters", () => {
  // The silent-skipped-migration failure: Odoo re-runs migrations only when the
  // manifest version increases, so a stale version is a schema that never moved.
  const problems = releaseSmokeProblems({
    ...GREEN,
    releaseVersion: "1.1.0",
    modules: [{ name: "sushi_menu", state: "installed", version: "18.0.1.0.0" }],
  });
  assert.equal(problems[0]?.code, "module-wrong-version");
  assert.match(problems[0]?.detail ?? "", /18\.0\.1\.1\.0/, "names what the release implies");
  assert.match(problems[0]?.detail ?? "", /migraciones/);
});

test("the series comes from the project, never a hard-coded 18", () => {
  const problems = releaseSmokeProblems({
    ...GREEN,
    odooSeries: 17,
    modules: [{ name: "sushi_menu", state: "installed", version: "18.0.1.0.0" }],
  });
  assert.equal(problems[0]?.code, "module-wrong-version");
  assert.match(problems[0]?.detail ?? "", /17\.0\.1\.0\.0/);
});

test("a front older than its release's CODE is serving previous code", () => {
  // Finding 1.13 is this defect in the staging path; the check exists so we
  // learn about it in production from a script rather than from a customer.
  const problems = releaseSmokeProblems({
    ...GREEN,
    frontStartedAt: new Date("2026-08-12T05:24:58Z"),
  });
  assert.equal(problems[0]?.code, "front-older-than-release");
  assert.match(problems[0]?.detail ?? "", /sirviendo código anterior/);
});

/**
 * The first live run reported this as a failure on a perfectly healthy sushi:
 * the front is deployed BEFORE the release row is marked deployed, so a check
 * anchored to `deployedAt` calls every good deploy stale by a few seconds.
 * Anchored to when the CODE existed, it is quiet.
 */
test("a front started seconds before the row was marked deployed is FINE", () => {
  assert.deepEqual(
    releaseSmokeProblems({ ...GREEN, frontStartedAt: new Date("2026-08-12T12:37:22.935Z") }),
    [],
  );
});

/**
 * Also from the first live run: `ab-test-sandbox` is a plain `odoo` tenant with
 * no front at all, and the check invented one for it at a hostname nobody ever
 * created. A check that reports a project for lacking something it never had
 * teaches people to ignore it.
 */
test("a project with no front is not judged on one", () => {
  assert.deepEqual(
    releaseSmokeProblems({
      ...GREEN,
      hasFront: false,
      frontStatus: null,
      frontStartedAt: null,
    }),
    [],
  );
});

test("a project with nothing deployed makes no claim, so it raises nothing", () => {
  assert.deepEqual(
    releaseSmokeProblems({ ...GREEN, releaseVersion: null, odooStatus: 404, modules: [] }),
    [],
  );
});

test("an unmeasurable host is a problem, never a pass", () => {
  // `null` means the check could not run. Treating that as fine is how a smoke
  // becomes decoration (VERIFICATION #2).
  const problems = releaseSmokeProblems({ ...GREEN, odooStatus: null, frontStatus: null });
  assert.deepEqual(problems.map((p) => p.code), ["odoo-unreachable", "front-unreachable"]);
});

/**
 * Spec 0215, the state of the fleet on 2026-08-14: the daemon restarted, the
 * `-front` containers came back (`unless-stopped`) and the six `-prod` ones did
 * not, because `odoo-stack.tmpl.yml` declared no policy and Docker fixes it at
 * container-create time. The tenants were down ~12 hours.
 */
test("a container with no restart policy is reported, `db` included", () => {
  const problems = releaseSmokeProblems({
    ...GREEN,
    restartPolicies: [
      { container: "sushi-prod-odoo-1", policy: "no" },
      { container: "sushi-prod-db-1", policy: "no" },
      { container: "sushi-front-front-1", policy: "unless-stopped" },
    ],
  });
  assert.deepEqual(problems.map((p) => p.code), [
    "restart-policy-wrong",
    "restart-policy-wrong",
  ]);
  assert.match(problems[0]?.detail ?? "", /sushi-prod-odoo-1 tiene restart policy no/);
  assert.match(problems[1]?.detail ?? "", /sushi-prod-db-1/, "db counts as much as odoo");
  assert.match(problems[0]?.detail ?? "", /unless-stopped/, "names what it should be");
});

test("a restart policy that could not be measured is a problem, never a pass", () => {
  // Same rule as `odooStatus: null` above: an inspect that did not answer says
  // nothing about the container, and nothing is not a green (VERIFICATION #2).
  const problems = releaseSmokeProblems({
    ...GREEN,
    restartPolicies: [{ container: "sushi-prod-odoo-1", policy: null }],
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.code, "restart-policy-wrong");
  assert.match(problems[0]?.detail ?? "", /sin medir/);
});

test("several failures are reported together, hostnames first", () => {
  // A smoke that stops at the first problem turns one investigation into three.
  const problems = releaseSmokeProblems({
    ...GREEN,
    odooStatus: 404,
    frontStatus: 500,
    modules: [],
    frontStartedAt: new Date("2026-08-12T05:24:58Z"),
  });
  assert.deepEqual(problems.map((p) => p.code), [
    "odoo-unreachable",
    "front-unreachable",
    "module-not-installed",
    "front-older-than-release",
  ]);
});
