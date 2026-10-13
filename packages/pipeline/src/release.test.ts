/**
 * Spec 0170. Two families of case, and the second is the reason this file is
 * long: version arithmetic that is wrong only at double digits, and refusals
 * that must fire for the right reason rather than merely fire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideReleaseDeploy,
  isNewer,
  manifestVersion,
  nextVersion,
  parseVersion,
  releaseVersionFromManifests,
  usesOdooManifest,
} from "./release.js";

test("a project's first release is 1.0.0, not 0.1.0", () => {
  // The first thing shipped to a customer's production IS version one; there is
  // no pre-release phase in this model.
  assert.equal(nextVersion(null), "1.0.0");
  assert.equal(nextVersion(null, "major"), "1.0.0");
});

test("bumps reset the components below them", () => {
  assert.equal(nextVersion("1.4.2", "patch"), "1.4.3");
  assert.equal(nextVersion("1.4.2", "minor"), "1.5.0");
  assert.equal(nextVersion("1.4.2", "major"), "2.0.0");
  assert.equal(nextVersion("1.4.2"), "1.4.3", "automation defaults to patch");
});

test("version comparison is NUMERIC — the double-digit trap", () => {
  // "1.10.0" < "1.9.0" as text. Sorting versions lexically hands out a number
  // that already exists the first time a project reaches double digits.
  assert.equal(isNewer("1.10.0", "1.9.0"), true);
  assert.equal(isNewer("1.9.0", "1.10.0"), false);
  assert.equal(isNewer("2.0.0", "1.99.99"), true);
  assert.equal(isNewer("1.4.2", "1.4.2"), false, "equal is not newer");
});

test("a malformed version is refused, never guessed at", () => {
  assert.equal(parseVersion("18.0.1.4.2"), null, "that is a manifest version, not a release one");
  assert.equal(parseVersion("v1.2.3"), null);
  assert.equal(parseVersion("1.2"), null);
  assert.throws(() => nextVersion("not-a-version"), /major\.minor\.patch/);
});

/**
 * Odoo re-runs a module's migration scripts only when the manifest version
 * INCREASES. Getting this shape wrong means a deploy that ships code and skips
 * its migrations — green everywhere, schema not migrated.
 */
test("manifestVersion is <series>.0.<version>, with the series from the project", () => {
  assert.equal(manifestVersion("1.4.2", 18), "18.0.1.4.2");
  assert.equal(manifestVersion("1.0.0", 17), "17.0.1.0.0");
  assert.equal(manifestVersion("2.1.0", 19), "19.0.2.1.0");
  // Never a hard-coded 18: the series is a parameter, like everywhere else in
  // infra/tenant.
  assert.notEqual(manifestVersion("1.0.0", 17), manifestVersion("1.0.0", 18));
});

test("only Odoo kinds carry a manifest version", () => {
  assert.equal(usesOdooManifest("odoo"), true);
  assert.equal(usesOdooManifest("odoo_next"), true);
  assert.equal(usesOdooManifest("custom"), false);
  assert.equal(usesOdooManifest("platform"), false);
  assert.equal(usesOdooManifest(null), false);
});

// --- the deploy decision -----------------------------------------------------

const OK = { version: "1.4.2", productionKind: "fleet", onMain: true, staged: true } as const;

test("a clean release is allowed and says what is live", () => {
  const d = decideReleaseDeploy({ ...OK, liveVersion: "1.4.1" });
  assert.equal(d.blocked, false);
  assert.equal(d.tone, "ok");
  assert.match(d.message, /1\.4\.1/);
});

test("BLOCKS: the commit is no longer on main", () => {
  // History was rewritten under us. The deploy would succeed and the record
  // would be a lie.
  const d = decideReleaseDeploy({ ...OK, onMain: false });
  assert.equal(d.blocked, true);
  assert.match(d.message, /ya no está en main/);
});

test("BLOCKS: a deploy is already in flight, and names it", () => {
  const d = decideReleaseDeploy({ ...OK, deployInFlight: "1.4.1" });
  assert.equal(d.blocked, true);
  assert.match(d.message, /1\.4\.1/);
});

test("BLOCKS: odoo.sh is red", () => {
  const d = decideReleaseDeploy({ ...OK, productionKind: "odoosh", odooShBuild: "failure" });
  assert.equal(d.blocked, true);
});

test("BLOCKS: there is no production to deploy to", () => {
  assert.equal(decideReleaseDeploy({ ...OK, productionKind: "none" }).blocked, true);
  assert.equal(decideReleaseDeploy({ ...OK, productionKind: null }).blocked, true);
});

/**
 * Spec 0170 decision 3. Deploying an older version is allowed, warned in the
 * strongest terms, and NEVER called a rollback — Odoo's migrations are one-way,
 * so this runs old code against migrated data.
 */
test("deploying an OLDER version warns hard and is never called a rollback", () => {
  const d = decideReleaseDeploy({ ...OK, version: "1.4.0", liveVersion: "1.5.0" });
  assert.equal(d.blocked, false, "allowed — sometimes it is the right call");
  assert.equal(d.tone, "danger");
  assert.match(d.message, /NO deshace nada/);
  assert.match(d.message, /1\.5\.0/, "names what is actually live");
  assert.doesNotMatch(d.message, /rollback|revertir|revert/i);
});

test("no message anywhere promises an undo", () => {
  // The banned word, checked across every branch this function can take.
  const cases: Parameters<typeof decideReleaseDeploy>[0][] = [
    { ...OK },
    { ...OK, liveVersion: "1.5.0", version: "1.4.0" },
    { ...OK, liveVersion: "1.4.2" },
    { ...OK, onMain: false },
    { ...OK, onMain: undefined },
    { ...OK, staged: false },
    { ...OK, deployInFlight: "1.4.1" },
    { ...OK, productionKind: "none" },
    { ...OK, productionKind: "odoosh", odooShBuild: "failure" },
    { ...OK, productionKind: "odoosh", odooShBuild: "pending" },
  ];
  for (const c of cases) {
    assert.doesNotMatch(
      decideReleaseDeploy(c).message,
      /rollback|revertir|revert/i,
      `a message promised an undo: ${decideReleaseDeploy(c).message}`,
    );
  }
});

test("WARNS on absence, never blocking on what it merely does not know", () => {
  // git could not answer. That is not "no".
  const unknown = decideReleaseDeploy({ ...OK, onMain: undefined });
  assert.equal(unknown.blocked, false);
  assert.equal(unknown.tone, "warn");

  const unstaged = decideReleaseDeploy({ ...OK, staged: false });
  assert.equal(unstaged.blocked, false);
  assert.match(unstaged.message, /nunca se levantó/);

  const pending = decideReleaseDeploy({ ...OK, productionKind: "odoosh", odooShBuild: "pending" });
  assert.equal(pending.blocked, false);
});

test("a contradiction is reported before an absence", () => {
  // Both true at once: the ordering must surface the one that stops the deploy,
  // or the human reads "never staged" and misses that main lost the commit.
  const d = decideReleaseDeploy({ ...OK, onMain: false, staged: false });
  assert.equal(d.blocked, true);
  assert.match(d.message, /ya no está en main/);
});

test("redeploying the SAME version says so rather than pretending it is new", () => {
  const d = decideReleaseDeploy({ ...OK, liveVersion: "1.4.2" });
  assert.equal(d.blocked, false);
  assert.match(d.message, /ya está en producción/);
});

/**
 * Spec 0170 decision 1, REVISED after building it. Odoo migration scripts live
 * in `migrations/<manifest-version>/`, so the manifest version is the
 * developer's statement, not a counter we own. Automation picking a number the
 * developer did not write means their migration folder never runs — the bump
 * would cause the failure it was meant to prevent. So we read it.
 */
test("an Odoo project's version is READ from its manifests, series-aware", () => {
  assert.deepEqual(releaseVersionFromManifests(["18.0.1.4.2"], 18), { ok: true, version: "1.4.2" });
  assert.deepEqual(releaseVersionFromManifests(["17.0.2.0.0"], 17), { ok: true, version: "2.0.0" });
  // Every addon agreeing is the normal case.
  assert.deepEqual(releaseVersionFromManifests(["18.0.1.4.2", "18.0.1.4.2"], 18), {
    ok: true,
    version: "1.4.2",
  });
});

test("addons that disagree are refused, not silently resolved", () => {
  // Picking one would quietly decide whose migrations run.
  const r = releaseVersionFromManifests(["18.0.1.4.2", "18.0.1.5.0"], 18);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.problem : "", /versiones distintas/);
  assert.match(r.ok === false ? r.problem : "", /18\.0\.1\.5\.0/, "names both, so it is actionable");
});

test("a manifest on the wrong Odoo series is refused by name", () => {
  const r = releaseVersionFromManifests(["17.0.1.0.0"], 18);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.problem : "", /serie/);
});

test("no manifests, or a malformed one, is a stated problem rather than a guess", () => {
  assert.equal(releaseVersionFromManifests([], 18).ok, false);
  assert.equal(releaseVersionFromManifests(["18.0.beta"], 18).ok, false);
  assert.equal(releaseVersionFromManifests(["18.0.1.4"], 18).ok, false);
});
