import { test } from "node:test";
import assert from "node:assert/strict";
// Spec 0122: the archive writer touches real files, so these tests use a temp dir
// rather than a fake — the write is the behaviour under test.
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseStatus,
  countUnchecked,
  countChecked,
  countHumanPending,
  readTitle,
  intentGoal,
  completedProgressItems,
  lastHandoffEntry,
  firstUncheckedPlanItem,
  readUiOnly,
  readProduct,
  readArchived,
  setArchived,
} from "./store.js";

const md = `---
id: 0099
status: draft
---
## Plan
- [x] done thing
- [ ] pending thing
- [ ] another pending
`;

const mdWithHuman = `---
id: 0098
status: draft
---
## Plan
- [x] done thing
- [ ] pending thing
- [ ] (human) click the gate
`;

test("parseStatus reads frontmatter", () => {
  assert.equal(parseStatus(md), "draft");
});

test("countUnchecked counts open items only", () => {
  assert.equal(countUnchecked(md), 2);
});

test("countUnchecked excludes (human) items", () => {
  assert.equal(countUnchecked(mdWithHuman), 1);
});

test("countChecked counts done items only (spec 0008 stall seam)", () => {
  assert.equal(countChecked(md), 1);
  assert.equal(countChecked(mdWithHuman), 1);
});

test("countHumanPending counts (human) items", () => {
  assert.equal(countHumanPending(md), 0);
  assert.equal(countHumanPending(mdWithHuman), 1);
});

// Regression: spec 0007's initializer numbered its plan items
// ("- [ ] 10. (human) ..."), which the strict regex counted as normal work,
// looping coders until the maxIterations cap fired (2026-07-03).
const mdWithNumberedHuman = `---
id: 0097
status: draft
---
## Plan
- [x] 1. [code] done thing
- [ ] 9. [docs] pending thing
- [ ] 10. (human) verify by clicking the gate
- [ ] 11) (human) second human step
`;

test("countUnchecked excludes numbered (human) items", () => {
  assert.equal(countUnchecked(mdWithNumberedHuman), 1);
});

test("countHumanPending counts numbered (human) items", () => {
  assert.equal(countHumanPending(mdWithNumberedHuman), 2);
});

test("parseStatus throws without status", () => {
  assert.throws(() => parseStatus("# no frontmatter"));
});

const mdWithHandoffs = `---
id: 0097
status: draft
---
## Plan
- [ ] pending thing

## Handoff log
- **2026-07-01 / initializer:** Laid foundations.
  Continuation line still part of the same entry.
- **2026-07-02 / coder:** Implemented item 1.
  More continuation text here too.
`;

test("lastHandoffEntry returns the most recent entry, including wrapped lines", () => {
  assert.equal(
    lastHandoffEntry(mdWithHandoffs),
    "- **2026-07-02 / coder:** Implemented item 1.\n  More continuation text here too.",
  );
});

test("lastHandoffEntry returns empty string when there is no Handoff log section", () => {
  assert.equal(lastHandoffEntry(md), "");
});

// --- Per-item model routing (spec 0007, item 6) --------------------------
// Skipped until firstUncheckedPlanItem is implemented; the coder un-skips
// these when landing item 6.
const mdTagged = `---
id: 0096
status: approved
---
## Progress
- [x] [code] done implementation thing
- [ ] [docs] update the README
- [ ] [code] implement the parser
- [ ] (human) click the gate
`;

test("firstUncheckedPlanItem returns the first unchecked item with its tag", () => {
  assert.deepEqual(firstUncheckedPlanItem(mdTagged), {
    text: "update the README",
    tag: "docs",
  });
});

test("firstUncheckedPlanItem defaults an untagged item to 'code'", () => {
  const md0 = `## Progress\n- [ ] plain untagged item\n`;
  assert.deepEqual(firstUncheckedPlanItem(md0), { text: "plain untagged item", tag: "code" });
});

test("firstUncheckedPlanItem skips (human) items", () => {
  const md0 = `## Progress\n- [x] [code] done\n- [ ] (human) click gate\n`;
  assert.equal(firstUncheckedPlanItem(md0), null);
});

test("firstUncheckedPlanItem handles numbered items (tag + human skip)", () => {
  const md0 = `## Plan\n- [ ] 9. [docs] update README\n- [ ] 10. (human) click gate\n`;
  assert.deepEqual(firstUncheckedPlanItem(md0), { text: "update README", tag: "docs" });
  const md1 = `## Plan\n- [ ] 10. (human) click gate\n`;
  assert.equal(firstUncheckedPlanItem(md1), null);
});

// --- ui_only frontmatter flag (spec 0031) ---------------------------------

test("readUiOnly returns true when the flag is explicitly set", () => {
  const md0 = `---\nid: 0031\nstatus: approved\nui_only: true\n---\n## Plan\n`;
  assert.equal(readUiOnly(md0), true);
});

test("readUiOnly returns false when the flag is absent (today's behavior)", () => {
  assert.equal(readUiOnly(md), false);
});

test("readUiOnly returns false when the flag is explicitly false", () => {
  const md0 = `---\nid: 0031\nstatus: approved\nui_only: false\n---\n## Plan\n`;
  assert.equal(readUiOnly(md0), false);
});

test("readUiOnly ignores unrelated non-'true' values", () => {
  const md0 = `---\nid: 0031\nstatus: approved\nui_only: nope\n---\n## Plan\n`;
  assert.equal(readUiOnly(md0), false);
});

// --- product frontmatter facet (spec 0037 / ADR-019) ----------------------

test("readProduct returns 'hangar' when declared", () => {
  const md0 = `---\nid: 0037\nstatus: approved\nproduct: hangar\n---\n## Plan\n`;
  assert.equal(readProduct(md0), "hangar");
});

test("readProduct returns 'forge' when declared", () => {
  const md0 = `---\nid: 0037\nstatus: approved\nproduct: forge\n---\n## Plan\n`;
  assert.equal(readProduct(md0), "forge");
});

test("readProduct returns 'both' when declared", () => {
  const md0 = `---\nid: 0037\nstatus: approved\nproduct: both\n---\n## Plan\n`;
  assert.equal(readProduct(md0), "both");
});

test("readProduct returns undefined when the field is absent", () => {
  assert.equal(readProduct(md), undefined);
});

test("readProduct returns undefined for an unrecognized value", () => {
  const md0 = `---\nid: 0037\nstatus: approved\nproduct: nope\n---\n## Plan\n`;
  assert.equal(readProduct(md0), undefined);
});

test("readProduct returns undefined for a malformed line", () => {
  const md0 = `---\nid: 0037\nstatus: approved\nproduct hangar\n---\n## Plan\n`;
  assert.equal(readProduct(md0), undefined);
});

// --- PR-body md-parse helpers (spec 0042 item C) --------------------------

test("readTitle reads the frontmatter title value", () => {
  const md0 = `---\nid: 0042\nstatus: approved\ntitle: Some Spec Title\n---\n## Plan\n`;
  assert.equal(readTitle(md0), "Some Spec Title");
});

test("readTitle returns '' when the title field is absent", () => {
  assert.equal(readTitle(md), "");
});

const mdWithIntent = `---
id: 0042
status: approved
---
## Intent
First line of the goal paragraph
continues on a second line.

A second paragraph that must NOT be included.

## Scope
- something
`;

test("intentGoal returns the first ## Intent paragraph, byte-verbatim", () => {
  assert.equal(
    intentGoal(mdWithIntent),
    "First line of the goal paragraph\ncontinues on a second line.",
  );
});

test("intentGoal returns '' when there is no ## Intent section", () => {
  assert.equal(intentGoal(md), "");
});

test("intentGoal returns '' for an empty ## Intent section", () => {
  const md0 = `## Intent\n\n## Scope\n- x\n`;
  assert.equal(intentGoal(md0), "");
});

test("intentGoal takes the whole section when there is no blank-line break", () => {
  const md0 = `## Intent\nOnly paragraph, no trailing blank line before EOF.\n`;
  assert.equal(intentGoal(md0), "Only paragraph, no trailing blank line before EOF.");
});

const mdWithProgress = `---
id: 0042
status: approved
---
## Plan
- [x] a checked item OUTSIDE Progress must be ignored

## Progress
- [x] first completed item
- [ ] pending item, not completed
- [x] second completed item wraps onto
  a continuation line that should fold
  into one line
- [ ] (human) click the gate

## Handoff log
- [x] a checked-looking bullet in another section must be ignored
`;

test("completedProgressItems returns only checked items inside ## Progress", () => {
  assert.deepEqual(completedProgressItems(mdWithProgress), [
    "first completed item",
    "second completed item wraps onto a continuation line that should fold into one line",
  ]);
});

test("completedProgressItems returns [] when there is no ## Progress section", () => {
  assert.deepEqual(completedProgressItems(md), []);
});

test("completedProgressItems returns [] for a ## Progress section with nothing checked", () => {
  const md0 = `## Progress\n- [ ] pending only\n`;
  assert.deepEqual(completedProgressItems(md0), []);
});

// SPEC-ALIGNMENT §9.1: once a ## Progress checklist exists, only its boxes feed
// the coder-loop counters — stray checkboxes in ## Plan or the handoff log no
// longer inflate `remaining` (the dual-checklist drift that burned two no-op
// stall sessions per run). `mdWithProgress` has a `- [x]` in ## Plan and a
// `- [x]`-looking bullet in the handoff log, both outside the Progress scope.
test("countUnchecked scopes to ## Progress when it holds checkboxes (Plan/handoff boxes ignored)", () => {
  assert.equal(countUnchecked(mdWithProgress), 1); // only the one non-human unchecked Progress item
});

test("countChecked scopes to ## Progress when it holds checkboxes (Plan/handoff boxes ignored)", () => {
  assert.equal(countChecked(mdWithProgress), 2); // the two `- [x]` inside ## Progress only
});

test("counters fall back to whole-file when there is no ## Progress checklist (older Plan-only layout)", () => {
  assert.equal(countUnchecked(md), 2); // `md` has its checkboxes under ## Plan only
  assert.equal(countChecked(md), 1);
});

// ---------------------------------------------------------------------------
// Spec 0217 (criterion 2) — the prose is Spanish, the structure is English and
// byte-identical, because THESE counters parse it with literal regexes.
// ---------------------------------------------------------------------------

const mdSpanishProse = `---
id: 0217
title: Los specs se redactan en español
status: in_progress
---
## Intent
Fijar el idioma de la prosa y congelar la estructura.

## Progress
- [x] [code] la guarda estructural (3e0ffc1)
- [ ] [code] cablear la guarda en los dos consumidores
- [ ] [docs] actualizar la fila 166 de PENDING.md
- [ ] (human) verificar la entrega por ancestría git
- [ ] (humano) marcador traducido — sigue siendo trabajo del coder

## Handoff log
- **2026-08-19 / coder:** cableado.
`;

test("a Spanish-prose spec with an intact ## Progress counts correctly (spec 0217)", () => {
  // Three open items: the two real ones plus `(humano)` — only the LITERAL
  // `(human)` is excluded from the done condition, which is exactly why the
  // marker is frozen in English.
  assert.equal(countUnchecked(mdSpanishProse), 3);
  assert.equal(countChecked(mdSpanishProse), 1);
  assert.equal(countHumanPending(mdSpanishProse), 1);
  assert.equal(intentGoal(mdSpanishProse), "Fijar el idioma de la prosa y congelar la estructura.");
});

test("the mine spec 0217's guard exists for: a `## Progreso` list below a real ## Progress reads as done", () => {
  const mined = `## Progress
- [x] cimientos

## Progreso
- [ ] cablear la guarda
- [ ] actualizar PENDING.md
`;
  // `checklistScope` finds `## Progress`, it already holds a checkbox, so only
  // that section is counted: the real list under the translated heading is
  // invisible and the coder loop closes the spec green having implemented
  // nothing (PENDING.md row 166, nearly shipped in spec 0005). Not a bug to fix
  // here — the parser is byte-exact by design — which is why
  // `specStructureViolations` rejects such a draft before it can be committed.
  assert.equal(countUnchecked(mined), 0);
});

// ---------------------------------------------------------------------------
// Spec 0122 — archiving lives in frontmatter, so it diffs and reverts like
// anything else in git. The interesting cases are the two shapes of write:
// insert (the field does not exist yet, which is the normal case) and rewrite.
// ---------------------------------------------------------------------------

test("readArchived: only a literal true archives — a malformed value never hides a spec", () => {
  assert.equal(readArchived("---\nid: 0001\nstatus: draft\narchived: true\n---\n"), true);
  for (const md of [
    "---\nid: 0001\nstatus: draft\n---\n",
    "---\nid: 0001\nstatus: draft\narchived: false\n---\n",
    "---\nid: 0001\nstatus: draft\narchived: yes\n---\n",
    "---\nid: 0001\nstatus: draft\narchived:\n---\n",
  ]) {
    assert.equal(readArchived(md), false, JSON.stringify(md));
  }
});

test("setArchived: INSERTS the field when absent, right after status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "archive-insert-"));
  await mkdir(path.join(root, "specs"), { recursive: true });
  const file = path.join(root, "specs", "0122-thing.md");
  await writeFile(file, "---\nid: 0122\ntitle: Thing\nstatus: draft\ntrack: 1\n---\n\n## Intent\n");
  await setArchived(root, "0122", true);
  const md = await readFile(file, "utf8");
  assert.equal(readArchived(md), true);
  assert.match(md, /status: draft\narchived: true\ntrack: 1/, "inserted after status, order preserved");
  // The body is untouched.
  assert.match(md, /## Intent/);
});

test("setArchived: is idempotent — archiving twice rewrites, never appends a second key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "archive-idem-"));
  await mkdir(path.join(root, "specs"), { recursive: true });
  const file = path.join(root, "specs", "0122-thing.md");
  await writeFile(file, "---\nid: 0122\nstatus: draft\n---\n");
  await setArchived(root, "0122", true);
  await setArchived(root, "0122", true);
  const md = await readFile(file, "utf8");
  assert.equal((md.match(/^archived:/gm) ?? []).length, 1, `one key only:\n${md}`);
  assert.equal(readArchived(md), true);
});

test("setArchived: un-archives, so the button is reversible", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "archive-undo-"));
  await mkdir(path.join(root, "specs"), { recursive: true });
  const file = path.join(root, "specs", "0122-thing.md");
  await writeFile(file, "---\nid: 0122\nstatus: draft\n---\n");
  await setArchived(root, "0122", true);
  await setArchived(root, "0122", false);
  assert.equal(readArchived(await readFile(file, "utf8")), false);
});
