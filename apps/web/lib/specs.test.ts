import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isKnownStatus,
  isSafeSpecFilename,
  isSafeSpecId,
  listSpecs,
  parseFrontmatter,
  parseHandoffEntry,
  parseHandoffLog,
  parseHumanPendingItems,
  parsePlanProgress,
  parseSpecSummary,
  parseTenantDeployManifest,
  progressPercent,
  resolveSpecFilenameById,
  specsDir,
} from "./specs.js";

const md = `---
id: 0099
title: Example spec
status: draft
---

## Intent
Something.
`;

test("parseFrontmatter reads scalar fields", () => {
  assert.deepEqual(parseFrontmatter(md), {
    id: "0099",
    title: "Example spec",
    status: "draft",
  });
});

test("parseFrontmatter tolerates missing frontmatter", () => {
  assert.deepEqual(parseFrontmatter("# no frontmatter here"), {});
});

// --- Plan progress for the coding phase (spec 0007, item 4) --------------
const mdPlan = `## Progress
- [x] done one
- [x] done two
- [ ] pending one
- [ ] (human) click the gate
`;

test("parsePlanProgress counts checked/total, excluding (human) items", () => {
  assert.deepEqual(parsePlanProgress(mdPlan), { checked: 2, total: 3 });
});

// --- Coding completion % (spec 0032 item 4) ------------------------------
// progressPercent is a trivial guard-and-round; asserted live (not skipped) so
// the divide-by-zero guard is locked in from the foundations commit.
test("progressPercent rounds checked/total and guards total=0", () => {
  assert.equal(progressPercent({ checked: 2, total: 3 }), 67);
  assert.equal(progressPercent({ checked: 0, total: 4 }), 0);
  assert.equal(progressPercent({ checked: 4, total: 4 }), 100);
  assert.equal(progressPercent({ checked: 0, total: 0 }), 0);
});

// --- Collapsible handoff-entry rendering (spec 0032 item 2) ---------------
test("parseHandoffEntry splits lead, structured fields, and prose", () => {
  const entry =
    "**2026-07-11 / coder:** did the thing. target:{kind:tenant,vpsId:100001} Next: item 2.";
  const parts = parseHandoffEntry(entry);
  assert.match(parts.lead, /2026-07-11 \/ coder/);
  assert.ok(parts.lead.endsWith("did the thing."));
  assert.deepEqual(parts.fields, [
    { key: "target", value: "kind:tenant,vpsId:100001" },
    { key: "Next", value: "item 2." },
  ]);
  assert.equal(parts.body, "");
});

test("parseHandoffEntry degrades to plain prose when there are no structured fragments", () => {
  const entry = "**2026-07-03 / initializer:** Laid foundations for the thing. Nothing structured here.";
  const parts = parseHandoffEntry(entry);
  assert.match(parts.lead, /2026-07-03 \/ initializer/);
  assert.deepEqual(parts.fields, []);
  assert.equal(parts.body, "Nothing structured here.");
});

test("parseSpecSummary maps frontmatter to a summary", () => {
  assert.deepEqual(parseSpecSummary("0099-example.md", md), {
    id: "0099",
    title: "Example spec",
    status: "draft",
    filename: "0099-example.md",
    progress: { checked: 0, total: 0 },
  });
});

test("parseSpecSummary falls back to filename when fields are absent", () => {
  const summary = parseSpecSummary("0100-untitled.md", "no frontmatter");
  assert.equal(summary.id, "0100-untitled.md");
  assert.equal(summary.title, "0100-untitled.md");
  assert.equal(summary.status, "unknown");
});

// --- product facet badge (spec 0037) --------------------------------------
test("parseSpecSummary populates product for hangar/forge/both", () => {
  for (const product of ["hangar", "forge", "both"]) {
    const withProduct = md.replace("status: draft\n---", `status: draft\nproduct: ${product}\n---`);
    const summary = parseSpecSummary("0099-example.md", withProduct);
    assert.equal(summary.product, product);
  }
});

test("parseSpecSummary omits product when absent or unrecognized", () => {
  assert.equal(parseSpecSummary("0099-example.md", md).product, undefined);
  assert.ok(!("product" in parseSpecSummary("0099-example.md", md)));

  const bogus = md.replace("status: draft\n---", "status: draft\nproduct: nope\n---");
  assert.equal(parseSpecSummary("0099-example.md", bogus).product, undefined);
});

test("isKnownStatus recognizes the pipeline enum only", () => {
  assert.equal(isKnownStatus("approved"), true);
  assert.equal(isKnownStatus("promoted"), true);
  assert.equal(isKnownStatus("archived"), false);
  assert.equal(isKnownStatus(""), false);
});

test("isSafeSpecFilename rejects path traversal and non-md files", () => {
  assert.equal(isSafeSpecFilename("0002-spec-inbox-page.md"), true);
  assert.equal(isSafeSpecFilename("../../etc/passwd"), false);
  assert.equal(isSafeSpecFilename("secret.env"), false);
  assert.equal(isSafeSpecFilename("nested/0002-spec.md"), false);
});

test("parseHandoffLog returns nothing when the section is absent", () => {
  assert.deepEqual(parseHandoffLog(md), []);
});

test("parseHandoffLog returns nothing when the section has no entries yet", () => {
  const noEntries = `${md}\n## Handoff log\n`;
  assert.deepEqual(parseHandoffLog(noEntries), []);
});

test("parseHandoffLog folds wrapped continuation lines into one entry", () => {
  const withLog = `${md}
## Handoff log
- **2026-07-03 / initializer:** Laid foundations for the thing. Added
  a module and some tests. Surprises: none.
`;
  assert.deepEqual(parseHandoffLog(withLog), [
    "**2026-07-03 / initializer:** Laid foundations for the thing. Added a module and some tests. Surprises: none.",
  ]);
});

test("parseHandoffLog returns one entry per top-level bullet, oldest first", () => {
  const withLog = `${md}
## Handoff log
- **2026-07-01 / initializer:** First entry.
  Continuation of first.
- **2026-07-03 / coder:** Second entry.

## Progress notes below this should not be included
- not a handoff entry
`;
  assert.deepEqual(parseHandoffLog(withLog), [
    "**2026-07-01 / initializer:** First entry. Continuation of first.",
    "**2026-07-03 / coder:** Second entry.",
  ]);
});

test("parseHumanPendingItems returns nothing when there are no (human) items", () => {
  assert.deepEqual(parseHumanPendingItems(md), []);
});

test("parseHumanPendingItems strips the marker and ignores non-human unchecked items", () => {
  const withItems = `${md}
## Progress
- [ ] 1. a regular item the coder should pick up
- [ ] (human) Click gate 2
- [x] 2. done already
- [ ] (human) Confirm the kill-worker manual check
`;
  assert.deepEqual(parseHumanPendingItems(withItems), [
    "Click gate 2",
    "Confirm the kill-worker manual check",
  ]);
});

// --- Tenant deploy manifest detection for the gate copy (spec 0047 item C) ---

// Mirrors @launchpad/pipeline activities.ts#tenantDeployManifestContent's
// fixed body shape (spec 0047 item A) — same tenant/VPS/version fields
// activities.test.ts's tenantInput("0048", root, 100001) fixture produces.
const tenantManifestMd = `---
id: 0048
title: Tenant deploy: sandbox — vanilla Odoo 18
tenant: launchpad
status: draft
requested_by: owner@example.com
---

## Intent
Deterministic tenant vanilla deploy (spec 0047 item A) — no LLM draft, no
code changes. Deploys vanilla stock Odoo (no addons, no snapshot restore, no
neutralize) for tenant \`sandbox\` to VPS 100001.

## Scope
- Target tenant: \`sandbox\`
- VPS: 100001
- Odoo version: 18
- Vanilla stock Odoo (no addons, no snapshot restore, no neutralize).
- Requested by owner@example.com: "deploy vanilla Odoo 18 to sandbox"

## Plan
- [ ] (human) Review this manifest, then click Deploy at the promote gate.

## Progress
- [ ] (human) Review this manifest, then click Deploy at the promote gate.
`;

test("parseTenantDeployManifest reads tenant id, VPS id, and Odoo version", () => {
  assert.deepEqual(parseTenantDeployManifest(tenantManifestMd), {
    tenantId: "sandbox",
    vpsId: 100001,
    odooVersion: 18,
  });
});

test("parseTenantDeployManifest returns null for a self/code spec", () => {
  assert.equal(parseTenantDeployManifest(md), null);
});

test("parseTenantDeployManifest returns null when only some fields are present", () => {
  const partial = "## Scope\n- Target tenant: `sandbox`\n";
  assert.equal(parseTenantDeployManifest(partial), null);
});

// --- Bare spec-id resolution for the tenant-start redirect (spec 0027) ---

test("isSafeSpecId accepts plain ids and rejects traversal/slashes", () => {
  assert.equal(isSafeSpecId("0028"), true);
  assert.equal(isSafeSpecId("../../etc/passwd"), false);
  assert.equal(isSafeSpecId("../0028"), false);
  assert.equal(isSafeSpecId("0028/extra"), false);
});

test("resolveSpecFilenameById resolves a real spec id by prefix", async () => {
  const filename = await resolveSpecFilenameById("0073", specsDir());
  assert.equal(filename, "0073-nextauth-credentials-core.md");
});

test("resolveSpecFilenameById returns null for an unknown or unsafe id", async () => {
  assert.equal(await resolveSpecFilenameById("9999", specsDir()), null);
  assert.equal(await resolveSpecFilenameById("../../etc", specsDir()), null);
});

test("listSpecs discovers every real spec file", async () => {
  const specs = await listSpecs(specsDir());
  const ids = specs.map((s) => s.id);
  assert.ok(ids.includes("0001"), "expected 0001 to be listed");
  assert.ok(ids.includes("0229"), "expected 0229 to be listed");
  for (const spec of specs) {
    assert.ok(spec.title.length > 0);
    assert.ok(spec.filename.endsWith(".md"));
  }
});

// ---------------------------------------------------------------------------
// Spec 0122 — archived is read like the other optional facets, and only a literal
// `true` counts, so a malformed value can never hide a spec from its project.
// ---------------------------------------------------------------------------

test("parseSpecSummary: archived: true is carried through", () => {
  const summary = parseSpecSummary(
    "0122-thing.md",
    "---\nid: 0122\ntitle: Thing\nstatus: draft\narchived: true\n---\n",
  );
  assert.equal(summary.archived, true);
});

test("parseSpecSummary: anything other than true leaves the key absent entirely", () => {
  // Absent rather than `false`: an explicit undefined key would break the plain
  // deepEqual assertions this suite makes elsewhere, and a spec is only hidden when
  // it says so unambiguously.
  for (const line of ["", "archived: false\n", "archived: yes\n", "archived:\n"]) {
    const summary = parseSpecSummary(
      "0122-thing.md",
      `---\nid: 0122\ntitle: Thing\nstatus: draft\n${line}---\n`,
    );
    assert.equal("archived" in summary, false, JSON.stringify(line));
  }
});
