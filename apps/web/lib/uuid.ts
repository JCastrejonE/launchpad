/**
 * UUID shape check (spec 0081, C.2). Lives in `lib/` rather than beside its
 * caller because a Next.js Route Handler may only export route fields (GET,
 * POST, runtime, …) — exporting a helper from `route.ts` fails `next build`
 * with "not a valid Route export field". `lib/` is also what
 * `tsconfig.test.json` compiles, so it can be unit-tested.
 *
 * Used to reject a malformed `projectId` with 400 before it reaches the
 * `forge_threads.project_id` foreign key.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
