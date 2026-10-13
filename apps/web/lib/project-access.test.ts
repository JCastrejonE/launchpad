/**
 * Spec 0168: project membership is the boundary, not the global role.
 *
 * `isProjectMember` lives in `app/auth.ts`, which pulls in NextAuth and a real
 * session — there is no way to call it from a unit test. So this reads the
 * source, the same idiom `project-members.test.ts` already uses for the sibling
 * question ("membershipFor does NOT special-case the control-plane OWNER").
 *
 * A source test is weaker than a behavioural one and worth naming as such: it
 * pins that the short-circuit is absent, not that the DB lookup is right. The
 * behavioural half is the spec's live check — an OWNER who is not a member of
 * `client-b` gets `notFound` on its panels.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// apps/web's tests compile to CommonJS, so `import.meta.url` is unavailable;
// `__dirname` is the CJS equivalent and points at the compiled test's directory.
const authSrc = readFileSync(path.join(__dirname, "..", "app", "auth.ts"), "utf8");

function bodyOf(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  assert.notEqual(from, -1, `could not find ${start} — did it get renamed?`);
  const to = src.indexOf(end, from);
  assert.notEqual(to, -1, `could not find ${end} after ${start}`);
  return src.slice(from, to);
}

/**
 * The inversion this spec exists for. Restoring `if (role === "OWNER") return
 * true` turns this red — which is the point, because that line is exactly what
 * a future reader would add back as a convenience while v0 has five OWNERs and
 * every one of them would silently gain every project.
 */
test("isProjectMember does NOT grant access on the global OWNER role", () => {
  const fn = bodyOf(
    authSrc,
    "export async function isProjectMember",
    "export async function isPlatformMember",
  );
  assert.equal(
    /role === "OWNER"\s*\)?\s*return true/.test(fn),
    false,
    "the global role must not short-circuit a project membership check",
  );
  // …and it must still actually ask the database.
  assert.match(fn, /membershipFor/, "membership is answered by the membership table");
  assert.match(fn, /return false/, "fail closed on a missing session or a DB error");
});

/**
 * The other half: removing the short-circuit must not have removed the check.
 * A function that returns false for everyone would pass the test above and lock
 * the whole install out, which is a different way to be wrong.
 */
test("isProjectMember still resolves the caller before answering", () => {
  const fn = bodyOf(
    authSrc,
    "export async function isProjectMember",
    "export async function isPlatformMember",
  );
  assert.match(fn, /sessionEmail/, "it identifies the caller");
  assert.match(fn, /userIdsByEmail/, "it maps that identity to a user row");
  assert.match(fn, /!== null/, "a membership row is the positive answer");
});
