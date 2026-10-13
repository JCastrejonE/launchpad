/**
 * Spec 0155. The digest's whole job is to be EQUAL when nothing a user can see
 * has changed, and DIFFERENT when something has — so every test here is a pair:
 * an unchanged case that must match, and the one field that must not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { branchesDigest, isLivePanel, runsDigest, specsDigest } from "./panel-digest";

const SPEC = { id: "0003", status: "draft", archived: false, progress: { checked: 1, total: 4 } };

test("specsDigest is stable across reordering and unrelated fields", () => {
  const a = specsDigest([SPEC, { ...SPEC, id: "0001" }], new Set());
  const b = specsDigest([{ ...SPEC, id: "0001" }, SPEC], new Set());
  assert.equal(a, b);
});

test("specsDigest moves on status, archived, progress and run state", () => {
  const base = specsDigest([SPEC], new Set());
  assert.notEqual(specsDigest([{ ...SPEC, status: "staged" }], new Set()), base);
  assert.notEqual(specsDigest([{ ...SPEC, archived: true }], new Set()), base);
  assert.notEqual(
    specsDigest([{ ...SPEC, progress: { checked: 2, total: 4 } }], new Set()),
    base,
  );
  // Spec 0153's Iniciar ⇄ En curso swap: same spec, different row.
  assert.notEqual(specsDigest([SPEC], new Set(["0003"])), base);
});

test("runsDigest moves on status, step and phase", () => {
  const run = { workflow: "spec-0147", status: "running", step: 2, phase: "coding" };
  const base = runsDigest([run]);
  assert.equal(runsDigest([run]), base);
  assert.notEqual(runsDigest([{ ...run, status: "failed" }]), base);
  assert.notEqual(runsDigest([{ ...run, step: 3 }]), base);
  assert.notEqual(runsDigest([{ ...run, phase: "awaiting_pr_approval" }]), base);
});

test("branchesDigest moves on staging, PR and merge", () => {
  const branch = {
    name: "owner/x",
    stagingStatus: "ready",
    stagingHost: "br-x.example",
    prNumber: 2,
    mergedAt: null as Date | null,
  };
  const base = branchesDigest([branch]);
  assert.equal(branchesDigest([branch]), base);
  assert.notEqual(branchesDigest([{ ...branch, stagingStatus: "deploying" }]), base);
  assert.notEqual(branchesDigest([{ ...branch, prNumber: 3 }]), base);
  assert.notEqual(branchesDigest([{ ...branch, mergedAt: new Date(1) }]), base);
});

test("only the four data-bearing panels poll", () => {
  for (const p of ["overview", "agentes", "specs", "ramas"]) assert.ok(isLivePanel(p));
  // A static panel must not poll — and a typo must not silently become one.
  for (const p of ["repo", "ajustes", "terminal", "chats", "logs", "conexiones", "spec"]) {
    assert.equal(isLivePanel(p), false);
  }
});
