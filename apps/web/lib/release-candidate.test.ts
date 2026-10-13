/**
 * Spec 0170 decision 1, revised. The two pure halves of reading a version out of
 * a repo: which files count as an addon manifest, and what version one declares.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { manifestPathsIn, manifestVersionIn, versionForCandidate } from "./release-candidate";

test("manifest paths use the same depth rule as everything else", () => {
  const paths = [
    "l10n_mx_cfdi/__manifest__.py",
    "addons/sale_custom/__manifest__.py",
    "deep/nested/mod/__manifest__.py",
    "README.md",
    "l10n_mx_cfdi/models/account_move.py",
  ];
  assert.deepEqual(manifestPathsIn(paths), [
    "addons/sale_custom/__manifest__.py",
    "l10n_mx_cfdi/__manifest__.py",
  ]);
});

test("reads the declared version, single or double quoted", () => {
  assert.equal(manifestVersionIn('{\n  "version": "18.0.1.4.2",\n}'), "18.0.1.4.2");
  assert.equal(manifestVersionIn("{\n  'version': '17.0.2.0.0'\n}"), "17.0.2.0.0");
  // A manifest that declares none is a real shape — null, not a guess.
  assert.equal(manifestVersionIn('{\n  "name": "x",\n}'), null);
});

test("the version key is not confused with a version mentioned elsewhere", () => {
  // `depends` and prose both contain the word; only the key matters.
  const src = '{\n  "summary": "requires version 17",\n  "version": "18.0.1.0.0",\n}';
  assert.equal(manifestVersionIn(src), "18.0.1.0.0");
});

// --- spec 0193 A: a website change is a release too --------------------------
//
// Run 5's silent failure: `veterinaria` promoted a front-only commit and the
// candidate threw `no se pudo leer la versión del manifiesto`, so its Versiones
// tab stays empty forever. Its repo has no `__manifest__.py` anywhere — which is
// not a failure to READ a version, it is a commit with no Odoo addon in it.
//
// `versionForCandidate` is the whole rule with the IO taken out, so these assert
// the version it DECIDES. The shipped version could only be exercised against a
// live GitHub tree, which is exactly why the case that mattered was uncovered.

test("no manifest in the tree allocates a patch version — run 5's commit", () => {
  assert.equal(
    versionForCandidate({ manifestCount: 0, declared: [], series: 18, highest: "1.2.3" }),
    "1.2.4",
  );
});

test("the first release of a front-only project is 1.0.0, like everyone else's", () => {
  assert.equal(
    versionForCandidate({ manifestCount: 0, declared: [], series: 18, highest: null }),
    "1.0.0",
  );
});

test("a manifest present still decides the version — 0170 untouched", () => {
  assert.equal(
    versionForCandidate({
      manifestCount: 1,
      declared: ["18.0.1.4.2"],
      series: 18,
      highest: "9.9.9",
    }),
    "1.4.2",
  );
});

test("manifests that DISAGREE still refuse — a contradiction is not guessed", () => {
  assert.throws(
    () =>
      versionForCandidate({
        manifestCount: 2,
        declared: ["18.0.1.0.0", "18.0.2.0.0"],
        series: 18,
        highest: "1.0.0",
      }),
    /versiones distintas/,
  );
});

test("an addon whose manifest declares NO version still refuses", () => {
  // manifestCount 1, declared empty: the addon exists and says nothing. That is
  // a repo to fix, not a version to invent.
  assert.throws(
    () => versionForCandidate({ manifestCount: 1, declared: [], series: 18, highest: "1.0.0" }),
    /no se encontró ningún __manifest__\.py con versión/,
  );
});
