import test from "node:test";
import assert from "node:assert/strict";
import { branchStartRefusal, type BranchStartFacts } from "./branch-start";

// Table-driven over the ladder (spec 0133 decision 7). Each case flips exactly
// one fact, so a reordered or deleted rung reddens exactly one row.

const ok: BranchStartFacts = {
  branch: "feature/pos",
  validName: true,
  project: { slug: "abtest", kind: "odoo" },
  row: { mergedAt: null },
  inFlightSpecId: null,
};

test("a valid, existing, unmerged, idle branch on a real project may start", () => {
  assert.equal(branchStartRefusal(ok), null);
});

test("each rung refuses with ITS message, first actionable problem wins", () => {
  const cases: Array<[Partial<BranchStartFacts>, RegExp]> = [
    [{ validName: false }, /rama inválida/],
    [{ project: null }, /requiere un proyecto vinculado/],
    [{ project: { slug: "platform", kind: "platform" } }, /flujo por spec/],
    [{ row: null }, /créala primero en Ramas & builds/],
    [{ row: { mergedAt: new Date() } }, /ya fue promovida a main/],
    [{ inFlightSpecId: "0142" }, /run en curso \(spec 0142\)/],
  ];
  for (const [override, expected] of cases) {
    const message = branchStartRefusal({ ...ok, ...override });
    assert.ok(message && expected.test(message), `${JSON.stringify(override)} → ${message}`);
  }
});

// Spec 0186 D: run 2's blocker was not only the wrong branch — it was a refusal
// that told a member to create sushi's branch inside their own project, and a
// chat that believed it and reported a setting that does not exist. A branch
// nobody asked for must be refused by naming where the name came from.
test("a MISSING branch nobody asked for names the chat, not the branch list", () => {
  const message = branchStartRefusal({ ...ok, row: null, derived: true });
  assert.match(message ?? "", /el chat de este spec apunta a la rama "feature\/pos"/);
  assert.doesNotMatch(message ?? "", /créala primero/);
});

test("a MISSING branch the caller asked for still says how to create it", () => {
  const message = branchStartRefusal({ ...ok, row: null, derived: false });
  assert.match(message ?? "", /créala primero en Ramas & builds/);
});

test("`derived` changes only the missing-branch rung", () => {
  // The other rungs are about the branch itself, and read the same whoever
  // named it — so a stray `derived` must not reword them.
  for (const override of [
    { validName: false },
    { row: { mergedAt: new Date() } },
    { inFlightSpecId: "0142" },
  ] as Array<Partial<BranchStartFacts>>) {
    assert.equal(
      branchStartRefusal({ ...ok, ...override, derived: true }),
      branchStartRefusal({ ...ok, ...override }),
    );
  }
});

test("the ladder reports the FIRST problem when several hold", () => {
  // Invalid name AND no project: the name is what the person can fix in place.
  const message = branchStartRefusal({ ...ok, validName: false, project: null });
  assert.match(message ?? "", /rama inválida/);
});
