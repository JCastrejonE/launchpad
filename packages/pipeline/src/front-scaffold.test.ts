/**
 * Spec 0169. The failure this guards is specific and was observed live: a
 * freshly provisioned repo with no Dockerfile, so `docker compose up --build`
 * died with `open Dockerfile: no such file or directory` after three phases had
 * already created a repo, two DNS records and a running Odoo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadFrontScaffold,
  renderFrontScaffold,
  siteFromIntake,
  FRONT_SCAFFOLD_DIR,
} from "./front-scaffold.js";

test("the SHIPPED scaffold carries what a build needs", async () => {
  // Reads infra/front/ for real: a scaffold that is fine in a fixture and broken
  // on disk is the only version that matters.
  const files = await loadFrontScaffold();
  const paths = files.map((f) => f.path);
  for (const required of [
    "Dockerfile",
    "package.json",
    "next.config.mjs",
    "app/page.tsx",
    // Spec 0196: the convention file every session in this repo will read.
    // Without it the project preamble is empty and each coder re-derives the
    // rules from the code — including "mount the component", which run 4 got
    // wrong.
    "AGENTS.md",
  ]) {
    assert.ok(paths.includes(required), `scaffold is missing ${required} (has: ${paths.join(", ")})`);
  }
  // Nested files keep their directory, or `app/page.tsx` lands as `page.tsx`.
  assert.ok(paths.some((p) => p.startsWith("app/")), "nested paths must survive");
  // Our own README documents the launchpad, not the customer's project.
  assert.ok(!paths.includes("README.md"), "the scaffold README must stay in this repo");
});

test("the shipped scaffold pins its dependencies exactly", async () => {
  // No lockfile exists in a scaffolded repo, so a caret range would mean two
  // tenants provisioned a week apart get different builds.
  const files = await loadFrontScaffold();
  const pkg = files.find((f) => f.path === "package.json");
  assert.ok(pkg);
  const parsed = JSON.parse(Buffer.from(pkg.contentBase64, "base64").toString("utf8"));
  for (const [name, range] of Object.entries(parsed.dependencies as Record<string, string>)) {
    assert.match(range, /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly, got ${range}`);
  }
});

test("the shipped scaffold contains no template placeholders", async () => {
  // Spec 0161 lost a run to a placeholder substituted inside a comment. This
  // scaffold is copied verbatim, so a `${...}` in it would reach the customer's
  // repo as literal text.
  const files = await loadFrontScaffold();
  for (const f of files) {
    const text = Buffer.from(f.contentBase64, "base64").toString("utf8");
    assert.doesNotMatch(text, /\$\{[A-Z_]{3,}\}/, `${f.path} carries a template placeholder`);
  }
});

test("a scaffold without a Dockerfile is refused, by name", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "scaffold-"));
  mkdirSync(path.join(dir, "app"), { recursive: true });
  writeFileSync(path.join(dir, "app", "page.tsx"), "export default () => null");
  await assert.rejects(() => loadFrontScaffold(dir), /no Dockerfile/);
});

test("FRONT_SCAFFOLD_DIR resolves to infra/front", () => {
  assert.match(FRONT_SCAFFOLD_DIR.replace(/\\/g, "/"), /\/infra\/front$/);
});

// --- spec 0191: the scaffold is THIS business's landing page ----------------

test("renderFrontScaffold fills site.ts with the project's own facts", async () => {
  const files = await loadFrontScaffold();
  const rendered = renderFrontScaffold(files, {
    nombre: "Panadería del Centro",
    giro: "Pan dulce y salado, hecho cada mañana.",
    procesos: ["Ventas / CRM", "Punto de venta (POS)"],
    marca: "Café y crema.",
  });
  const site = rendered.find((f) => f.path === "app/site.ts");
  assert.ok(site, "the scaffold must carry app/site.ts");
  const text = Buffer.from(site.contentBase64, "base64").toString("utf8");
  assert.match(text, /nombre: "Panadería del Centro"/);
  assert.match(text, /giro: "Pan dulce y salado, hecho cada mañana\."/);
  assert.match(text, /procesos: \["Ventas \/ CRM","Punto de venta \(POS\)"\]/);
  assert.doesNotMatch(text, /__SITE_/, "no placeholder may reach a customer's repo");
});

// The reason every value goes through JSON.stringify. `marca` and `giro` are
// free text somebody typed into a form; a quote or a backslash pasted raw into a
// TypeScript literal is a first commit that does not compile — in a repo we just
// handed to a customer.
test("renderFrontScaffold escapes quotes, backslashes and newlines", async () => {
  const rendered = renderFrontScaffold(await loadFrontScaffold(), {
    nombre: 'La "Esquina"',
    giro: "Ruta 66 \\ centro",
    procesos: [],
    marca: "línea uno\nlínea dos",
  });
  const text = Buffer.from(
    rendered.find((f) => f.path === "app/site.ts")!.contentBase64,
    "base64",
  ).toString("utf8");
  assert.match(text, /nombre: "La \\"Esquina\\""/);
  assert.match(text, /giro: "Ruta 66 \\\\ centro"/);
  assert.match(text, /marca: "línea uno\\nlínea dos"/);
  assert.doesNotMatch(text, /marca: "línea uno$/m, "a raw newline would break the literal");
});

// --- spec 0192 D: parsed from what /new actually STORED -----------------------
//
// The 0191 test above hands `renderFrontScaffold` an already-split array, so it
// proves the substitution and never the source. These start from the intake row
// `gaming-tech` really has in the control-plane DB, copied verbatim:
//
//   {"cfdi": "Sí, es indispensable", "giro": "Venta de equipo gamer: …",
//    "marca": "Morado neon sobre negro, tipografia tecnica.",
//    "procesos": "Ventas / CRM|Inventario / Almacén|Punto de venta (POS)|Facturación electrónica (CFDI)",
//    "empleados": "6–20"}
const GAMING_TECH_INTAKE = {
  cfdi: "Sí, es indispensable",
  giro: "Venta de equipo gamer: PCs armadas a la medida, consolas, perifericos y servicio de reparacion.",
  marca: "Morado neon sobre negro, tipografia tecnica.",
  procesos: "Ventas / CRM|Inventario / Almacén|Punto de venta (POS)|Facturación electrónica (CFDI)",
  empleados: "6–20",
};

test("siteFromIntake splits the processes the wizard STORED — four answers, four processes", () => {
  const site = siteFromIntake("Gaming Tech", GAMING_TECH_INTAKE);
  assert.deepEqual(site.procesos, [
    "Ventas / CRM",
    "Inventario / Almacén",
    "Punto de venta (POS)",
    "Facturación electrónica (CFDI)",
  ]);
  assert.equal(site.nombre, "Gaming Tech");
  assert.equal(site.giro, GAMING_TECH_INTAKE.giro);
  assert.equal(site.marca, GAMING_TECH_INTAKE.marca);
});

test("a stored intake reaches site.ts as one card per process", async () => {
  const rendered = renderFrontScaffold(
    await loadFrontScaffold(),
    siteFromIntake("Gaming Tech", GAMING_TECH_INTAKE),
  );
  const text = Buffer.from(
    rendered.find((f) => f.path === "app/site.ts")!.contentBase64,
    "base64",
  ).toString("utf8");
  assert.match(text, /procesos: \["Ventas \/ CRM","Inventario \/ Almacén",/);
  assert.doesNotMatch(text, /Ventas \/ CRM\|/, "the separator must never survive into the page");
});

test("no intake at all is an empty page, not a crash", () => {
  assert.deepEqual(siteFromIntake("Sin datos", null), {
    nombre: "Sin datos",
    giro: "",
    procesos: [],
    marca: "",
  });
});

test("a file with no placeholder comes back byte-identical", async () => {
  const files = await loadFrontScaffold();
  const rendered = renderFrontScaffold(files, {
    nombre: "x",
    giro: "y",
    procesos: [],
    marca: "",
  });
  const before = files.find((f) => f.path === "Dockerfile");
  const after = rendered.find((f) => f.path === "Dockerfile");
  assert.equal(after?.contentBase64, before?.contentBase64);
});

test("the brand note is data, never page copy (spec 0204)", async () => {
  // Finding 8.3: Hero.tsx rendered `site.marca`, so the customer's own note about
  // how the site should LOOK — "verde olivo #4A5D3A, tipografía serif" — was
  // printed as body text on their public page. It shipped to two live tenants.
  // A distinctive marker so a leak is unmistakable rather than inferred.
  const marker = "MARCA_LEAK_CANARY_4A5D3A";
  const rendered = renderFrontScaffold(await loadFrontScaffold(), {
    nombre: "Barbería Norte",
    giro: "Barbería en Guadalupe",
    procesos: ["Ventas / CRM"],
    marca: marker,
  });
  const text = (f: { contentBase64: string }) =>
    Buffer.from(f.contentBase64, "base64").toString("utf8");
  const find = (p: string) => {
    const f = rendered.find((x) => x.path === p);
    assert.ok(f, `${p} missing from the rendered scaffold`);
    return text(f);
  };

  // The field survives — it is real data and the brand work will consume it.
  assert.match(find("app/site.ts"), new RegExp(marker), "site.ts must still carry marca");

  // No rendered component may put it on the page. Checked across every component
  // rather than Hero alone, so moving the paragraph elsewhere still fails.
  for (const f of rendered.filter((x) => x.path.startsWith("app/") && x.path !== "app/site.ts")) {
    assert.doesNotMatch(
      text(f),
      /\{\s*site\.marca/,
      `${f.path} renders site.marca — the customer's brand note must not appear on their page`,
    );
  }
});
