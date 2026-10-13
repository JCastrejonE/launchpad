import assert from "node:assert/strict";
import test from "node:test";

import { UNKNOWN, accentForSlug, fromUiKind, toProjectView, toProjectViews, toUiKind } from "./project-view.js";
import { validateProjectInput } from "./project-create.js";

type Row = Parameters<typeof toProjectView>[0];

function row(over: Partial<Row> = {}): Row {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "platform",
    name: "Launchpad — Hangar + Forge",
    kind: "platform",
    client: "Example Co",
    domain: null,
    health: "operational",
    description: "",
    accent: "",
    stack: [],
    region: "",
    version: "",
    vpsId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  } as Row;
}

test("real columns pass straight through; slug is the URL id, uuid kept separately", () => {
  const v = toProjectView(
    row({ domain: "example.com", description: "the control plane", stack: ["Next.js", "Odoo"], region: "MX", version: "v1.2" }),
  );

  assert.equal(v.id, "platform"); // slug — what /projects/[id] links use
  assert.equal(v.projectId, "11111111-1111-4111-8111-111111111111"); // uuid — thread scoping
  assert.equal(v.name, "Launchpad — Hangar + Forge");
  assert.equal(v.kind, "platform");
  assert.equal(v.client, "Example Co");
  // Spec 0178: the HOST, not the zone — this is what the header links to.
  assert.equal(v.domain, "example.com", "domain is the HOST, not a zone to compose");
  assert.equal(v.description, "the control plane");
  assert.deepEqual(v.stack, ["Next.js", "Odoo"]);
  assert.equal(v.region, "MX");
  assert.equal(v.version, "v1.2");
  assert.equal(v.health, "operational");
});

test("unobservable fields are empty or UNKNOWN — never invented", () => {
  const v = toProjectView(row());

  // The mockup shipped literals here (branch lists, metric tiles, "hace 4 min").
  // A real-data surface must not carry those forward.
  assert.deepEqual(v.branches, []);
  assert.deepEqual(v.metrics, []);
  assert.deepEqual(v.integrations, []);
  assert.deepEqual(v.chats, []);
  assert.deepEqual(v.specs, []);
  assert.equal(v.vps, undefined);
  assert.equal(v.lastDeploy, UNKNOWN);
  assert.notEqual(v.lastDeploy, "");
});

test("a null zone falls back to example.com, never a bare protocol", () => {
  // Spec 0178: this used to assert an empty string, and the header dutifully
  // rendered `href="https://"` on a project whose front was live.
  assert.equal(toProjectView(row({ domain: null })).domain, "platform.example.com");
  assert.doesNotMatch(toProjectView(row({ domain: null })).domain, /^\s*$/);
});

test("counts come from the caller; absent counts are 0, not guesses", () => {
  const withCounts = toProjectView(row(), { openChats: 3, activeAgents: 2 });
  assert.equal(withCounts.openChats, 3);
  assert.equal(withCounts.activeAgents, 2);

  const without = toProjectView(row());
  assert.equal(without.openChats, 0);
  assert.equal(without.activeAgents, 0);
});

test("accent: the column wins when set, otherwise a deterministic slug colour", () => {
  assert.equal(toProjectView(row({ accent: "#ff0000" })).accent, "#ff0000");

  // Stable across calls (no random / no Date) — the same card colour every render.
  assert.equal(accentForSlug("platform"), accentForSlug("platform"));
  assert.equal(toProjectView(row()).accent, accentForSlug("platform"));
  assert.match(toProjectView(row()).accent, /^var\(--color-/);
});

test("kind: the DB's odoo_next becomes the UI's odoo-next; others pass through", () => {
  assert.equal(toUiKind("odoo_next"), "odoo-next");
  assert.equal(toUiKind("odoo"), "odoo");
  assert.equal(toUiKind("custom"), "custom");
  assert.equal(toUiKind("platform"), "platform");
  assert.equal(toProjectView(row({ kind: "odoo_next" })).kind, "odoo-next");
});

test("toProjectViews maps counts to the right row by uuid", () => {
  const a = row({ id: "aaaaaaaa-1111-4111-8111-111111111111", slug: "acme" });
  const b = row({ id: "bbbbbbbb-1111-4111-8111-111111111111", slug: "sandbox" });
  const counts = new Map([["aaaaaaaa-1111-4111-8111-111111111111", { openChats: 5, activeAgents: 1 }]]);

  const [acme, sandbox] = toProjectViews([a, b], counts);

  assert.equal(acme?.openChats, 5);
  assert.equal(acme?.activeAgents, 1);
  assert.equal(sandbox?.openChats, 0);
  assert.equal(sandbox?.activeAgents, 0);
});

/**
 * Spec 0178. The header's globe rendered `href="https://"` on `sushi` — whose
 * front had been live at sushi.example.com for hours — because the view passed
 * the ZONE (empty for most projects) where the host belongs.
 */
test("the view exposes the host the project is served at, never a bare protocol", () => {
  assert.equal(toProjectView(row({ slug: "sushi", domain: "example.com" })).domain, "example.com");
  // The defect this replaces: a CONNECTED project's host is theirs, not ours glued
  // to theirs. `taqueria-sol-conectada` rendered as
  // `taqueria-sol-conectada.taqueria-sol.example.com`, which resolves to nothing.
  assert.equal(
    toProjectView(row({ slug: "taqueria-sol-conectada", domain: "taqueria-sol.example.com" })).domain,
    "taqueria-sol.example.com",
  );
  // Null still derives, which is correct for every fleet tenant we run.
  assert.equal(toProjectView(row({ slug: "sushi", domain: null })).domain, "sushi.example.com");
  // No zone recorded is the common case; provisioning puts every project in
  // example.com, so that is the honest default rather than an empty link.
  assert.equal(toProjectView(row({ slug: "sushi", domain: null })).domain, "sushi.example.com");
});

/**
 * The defect these pin, found by clicking through the deployed `/connect` as a
 * second user: the wizard sent the UI spelling `odoo-next` straight to
 * `validateProjectInput`, whose `KINDS` holds the DB spelling `odoo_next`, so
 * EVERY "Odoo + Front" connect was refused with "Tipo de proyecto no
 * reconocido." The translation existed only as an inline ternary inside `/new`.
 *
 * The second test is the one that would have caught it: it runs the real
 * validator and asserts its RESPONSE (docs/VERIFICATION.md #1), rather than
 * asserting that the wizard passed the argument we think it passes.
 */
test("fromUiKind is the inverse of toUiKind for every DB kind", () => {
  for (const db of ["odoo", "odoo_next", "custom", "platform"] as const) {
    assert.equal(fromUiKind(toUiKind(db)), db);
  }
});

test("every kind a wizard can offer survives the real validator", () => {
  for (const ui of ["odoo", "odoo-next", "custom"] as const) {
    const res = validateProjectInput({
      name: "Proyecto", slug: "proyecto", client: "Proyecto",
      kind: fromUiKind(ui), odooVersion: "19", productionKind: null,
    });
    // Deliberately narrow: another field may legitimately complain, and pinning
    // `ok` would make this test fail for reasons that are not the claim. The
    // claim is that the KIND is never what gets rejected.
    if (!res.ok) assert.notEqual(res.field, "kind", `kind rejected for UI kind ${ui}`);
  }
});

test("every production destination a wizard can offer survives the real validator", () => {
  // The third enum the wizards collect, checked because the first two both had
  // a defect of this shape. This one is CORRECT today — /new sends the literal,
  // /connect maps "none" to null, and the validator coerces null to "none". The
  // test exists so it stays that way.
  for (const pk of ["none", "odoosh", "fleet", null] as const) {
    const res = validateProjectInput({
      name: "Proyecto", slug: "proyecto", client: "Proyecto",
      kind: "odoo", odooVersion: "19", productionKind: pk,
    });
    if (!res.ok) assert.notEqual(res.field, "productionKind", `rejected ${String(pk)}`);
  }
});
