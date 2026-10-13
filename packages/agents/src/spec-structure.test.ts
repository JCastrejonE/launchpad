import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { REQUIRED_HEADINGS, specStructureViolations } from "./spec-structure.js";

// Repo root, computed the way architect-session.test.ts does: the compiled test
// runs from packages/agents/dist, so three levels up reaches the checkout root.
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The shape a drafting session actually produces (spec 0217 item 1): Spanish
 * prose, English byte-identical structure, and NO `## Plan` / `## Progress` —
 * `agents/spec-drafter.md` tells the drafter to leave those to the initializer.
 * Every rejection case below is this fixture with ONE thing broken, so the
 * "accepts" test is the one that goes red when the guard over-reaches.
 */
const GOOD_DRAFT = `---
id: 0218
title: El formulario de contacto envía el correo al dueño del proyecto
tenant: launchpad
status: draft
track: 2
requested_by: owner@example.com
approved_by:
product: forge
---

## Intent

El dueño quiere que el formulario de contacto llegue a su bandeja. Hoy se pierde: el
handler escribe en el log y devuelve 200, así que el usuario ve "enviado" y
nadie lee nada.

## Scope

Cambia el handler del formulario. No cambia el diseño de la página.

## Acceptance criteria

1. Un envío válido produce un correo con el cuerpo del formulario.
2. Un envío sin campo obligatorio devuelve 400 y no envía nada.

## Out of scope / deferred

- **Plantillas HTML del correo.** Disparador: que alguien pida marca.

## Handoff log
`;

test("accepts a Spanish-prose draft with the structure intact and no Plan/Progress (spec 0217 item 1)", () => {
  assert.deepEqual(specStructureViolations(GOOD_DRAFT), []);
  // The premise of this fixture, asserted so it cannot rot into a spec that
  // happens to carry the sections the guard must NOT demand.
  assert.ok(!GOOD_DRAFT.includes("## Plan"), "fixture must not carry ## Plan");
  assert.ok(!GOOD_DRAFT.includes("## Progress"), "fixture must not carry ## Progress");
});

test("rejects a translated required heading (## Intención) (spec 0217 criterion 1)", () => {
  // The deliberate break of the good fixture, encoded permanently: this is the
  // mutation CLAUDE.md rule #2 asks for, kept in the suite instead of run once
  // by hand and forgotten.
  const violations = specStructureViolations(GOOD_DRAFT.replace("## Intent", "## Intención"));
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /## Intent/);
});

test("rejects every translated required heading, one violation each (spec 0217 closed list)", () => {
  for (const [english, spanish] of [
    ["## Scope", "## Alcance"],
    ["## Acceptance criteria", "## Criterios de aceptación"],
    ["## Out of scope / deferred", "## Fuera de alcance / diferido"],
    ["## Handoff log", "## Bitácora de entrega"],
  ]) {
    const violations = specStructureViolations(
      GOOD_DRAFT.replace(english as string, spanish as string),
    );
    assert.deepEqual(
      violations,
      [`missing required heading, byte-exact English: "${english}"`],
      `translating ${english} must be rejected by name`,
    );
  }
});

test("rejects checkbox items under a translated ## Progreso (spec 0217 criterion 1, PENDING row 166)", () => {
  const draft = `${GOOD_DRAFT}
## Progreso

- [ ] [code] Implementar el handler
- [ ] [code] Probar el caso 400
`;
  const violations = specStructureViolations(draft);
  // One per offending line — noisy rejection, never silent.
  assert.equal(violations.length, 2);
  for (const v of violations) assert.match(v, /outside "## Progress".*## Progreso/);
});

test("accepts checkbox items under a real ## Progress (spec 0217: the guard is additive)", () => {
  // The other side of the rule: once the initializer has written `## Progress`,
  // its checkboxes are exactly where the loop's fuel gauge reads them, so the
  // guard must stay quiet. Without this the rule could be "reject all
  // checkboxes" and every test above would still pass.
  const draft = `${GOOD_DRAFT}
## Progress

- [ ] [code] Implementar el handler
- [x] [code] Cablear la ruta (a1b2c3d)
- [ ] (human) Probar el envío real y revisar la bandeja
`;
  assert.deepEqual(specStructureViolations(draft), []);
});

test("the drafter prompt asks for exactly the headings the guard requires (spec 0217 item 2)", async () => {
  // The hard coupling, made a control instead of a comment: until this item the
  // prompt said `## Acceptance` while the guard requires `## Acceptance criteria`,
  // which would have rejected EVERY draft that followed the prompt. Reading
  // REQUIRED_HEADINGS rather than re-listing it is the point — a duplicated list
  // is the drift this test exists to catch.
  const roleMd = await readFile(path.join(REPO_ROOT, "agents/spec-drafter.md"), "utf8");
  for (const heading of REQUIRED_HEADINGS) {
    assert.ok(
      roleMd.includes(`\`${heading}\``),
      `agents/spec-drafter.md must name ${heading} byte-exact, or the guard rejects every draft`,
    );
  }
  // Naming the heading somewhere is too weak on its own: the closed list added
  // by this item names all five, so the check above stayed green when the format
  // instruction was reverted to `## Acceptance` on purpose. These are the two
  // historical truncations (21 specs use `## Acceptance`, 31 `## Out of scope`);
  // either one back in the prompt is the drift that rejects every draft.
  for (const retired of ["## Acceptance", "## Out of scope"]) {
    assert.ok(
      !roleMd.includes(`\`${retired}\``),
      `agents/spec-drafter.md must not ask for the retired \`${retired}\` heading`,
    );
  }
  // Spanish prose is the other half of the rule, and it lives only in prose —
  // assert the instruction is there at all so it cannot be dropped silently.
  assert.match(roleMd, /Spanish/, "the role file must fix the prose language");
});
