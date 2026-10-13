/**
 * Spec 0218 — `/new`'s navigation controls must carry the NATIVE `disabled`
 * attribute while a step or question transition is in flight.
 *
 * What this test can and cannot prove, said plainly (verification rule #1, and
 * the spec's own acceptance criterion 4): it is a SOURCE check, not a render.
 * `apps/web`'s test harness compiles `lib/**` only (`tsconfig.test.json`:
 * `rootDir: "lib"`, `include: ["lib"]`) to CommonJS and runs it under
 * `node --test` — there is no JSX transform and no DOM, so `app/new/NewProject.tsx`
 * cannot be imported, let alone clicked twice. Reading the source is the idiom
 * `lib/panel-loading-boundary.test.ts` and `lib/release-ui.test.ts` already use
 * for files under `app/`.
 *
 * So this pins the WIRING — that every navigation `Btn` is handed a `disabled`
 * prop rather than only `pointer-events-none`, which blocks the mouse and not the
 * keyboard. It says NOTHING about whether the prop is `true` at the right moment;
 * that is acceptance criterion 3, a `(human)` double-press before and after, and
 * it is the load-bearing check.
 *
 * The four `control:` tests feed `navControlFacts` known-bad and known-good
 * literals, so the checker is proven able to both fail and pass before anything
 * trusts it (rule #2). The assertion against the real `NewProject.tsx` landed
 * with the fix; it reported 5 of 5 controls missing `disabled` beforehand, and
 * removing any single `disabled={busy}` was confirmed to turn it red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// `import.meta.url` is unavailable under the CJS test build; `__dirname` is the
// idiom the sibling source-reading tests already use.
const WIZARD = path.join(__dirname, "..", "app", "new", "NewProject.tsx");

type NavFacts = {
  /** Navigation controls found (a `<Btn>` with an `onClick` that is not submit). */
  total: number;
  /** Their opening-tag text, for those missing a `disabled` prop. */
  missingDisabled: string[];
};

/**
 * The navigation controls of the wizard and whether each is handed `disabled`.
 *
 * A navigation control is a `<Btn>` with an `onClick` — that is every *Atrás* /
 * *Siguiente* / *Continuar* in the file. Two deliberate exclusions: `onClick={submit}`
 * (the Crear-proyecto button, which owns its own in-flight guard and is out of
 * scope) and the `Cancelar` button, which has no `onClick` because it is wrapped
 * in a `<Link>` and navigates away rather than transitioning.
 *
 * Pure function of the source text so the control tests below can feed it strings.
 * If a later change extracts the handlers into named functions, this still holds:
 * the marker is `onClick=`, not the body of the handler.
 */
function navControlFacts(source: string): NavFacts {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const segments = src.split("<Btn").slice(1).map((s) => {
    const end = s.indexOf("</Btn>");
    return end === -1 ? s : s.slice(0, end);
  });
  const nav = segments.filter((s) => s.includes("onClick=") && !s.includes("onClick={submit}"));
  return {
    total: nav.length,
    missingDisabled: nav.filter((s) => !s.includes("disabled=")).map((s) => s.slice(0, 80).trim()),
  };
}

test("every navigation control in /new is handed a native `disabled`", () => {
  const facts = navControlFacts(readFileSync(WIZARD, "utf8"));
  // The five controls of the two transition scopes, measured not assumed: the
  // question *Atrás* and *Siguiente/Continuar*, the review *Atrás*, and `Nav`'s
  // *Atrás* and *Continuar*. Before the fix this reported 5 of 5 missing.
  assert.equal(facts.total, 5, "expected five navigation controls in the wizard");
  assert.deepEqual(facts.missingDisabled, []);
});

test("control: a nav button with only pointer-events-none is reported as missing disabled", () => {
  const facts = navControlFacts(
    `<Btn variant="primary" onClick={onNext} className={nextDisabled ? "pointer-events-none" : ""}>Continuar</Btn>`,
  );
  assert.equal(facts.total, 1);
  assert.equal(facts.missingDisabled.length, 1);
});

test("control: a nav button with a native disabled prop is clean", () => {
  const facts = navControlFacts(
    `<Btn variant="primary" onClick={onNext} disabled={busy || nextDisabled}>Continuar</Btn>`,
  );
  assert.equal(facts.total, 1);
  assert.deepEqual(facts.missingDisabled, []);
});

test("control: the submit button and the Cancelar link are not navigation controls", () => {
  const facts = navControlFacts(
    `<Btn variant="ghost">Cancelar</Btn>
     <Btn variant="primary" onClick={submit}>Crear proyecto</Btn>`,
  );
  assert.equal(facts.total, 0);
  assert.deepEqual(facts.missingDisabled, []);
});

test("control: several nav buttons are counted independently", () => {
  const facts = navControlFacts(
    `<Btn variant="ghost" onClick={onBack} disabled={busy}>Atrás</Btn>
     <Btn variant="primary" onClick={onNext}>Siguiente</Btn>`,
  );
  assert.equal(facts.total, 2);
  assert.equal(facts.missingDisabled.length, 1);
});
