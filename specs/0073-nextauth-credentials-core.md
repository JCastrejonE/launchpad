---
id: 0073
title: Auth.js credentials core — sessions, roles, /login (no gating yet)
tenant: launchpad
product: both
status: completed
track: 1
requested_by: owner@example.com
approved_by:
ui_only: false
---

## Intent

Phase A item A.2's foundation (SPEC §13, SPEC-ALIGNMENT §3.1): a real,
server-verified session to replace the spoofable header-derived "localhost"
guard (audit #2) and to gate `/api/chat` + `signalGateAction` (audit #3).
This spec lands ONLY the auth core — NextAuth (Auth.js v5) with a
**Credentials provider** (the owner's choice: works offline/local, no OAuth-app or
third-party dependency to sign in to your own control plane), scrypt-verified
against `users.password_hash` (`@launchpad/db`, spec 0072), JWT sessions
carrying the SPEC §13 role, and a `/login` page. Nothing is gated yet —
enforcement across every mutating surface is spec 0074, so this change is
additive and separately reviewable.

Track 1 (direct authorship + human review): security foundation per the §8
triage rule.

## Scope

- `apps/web` gains deps: `next-auth@beta` (v5, the App-Router line),
  `@launchpad/db` (workspace).
- `lib/auth-core.ts` (pure, framework-free — the `supervisor-console.ts`
  pattern, unit-testable under `node --test`):
  - `authorizeUser(email, password, deps)` — normalizes email, looks up the
    user, scrypt-verifies; returns `{id,email,name,role}` or `null`.
    Fail-closed on: unknown email, row without a hash, wrong password,
    non-string input. Verifies against a static dummy hash when the user is
    missing so response timing doesn't enumerate accounts.
  - `tokenWithUser` / `sessionRoleFromToken` — pure JWT/session shapers;
    a token with no role yields `VIEWER` (least privilege), never `OWNER`.
- `lib/db.ts` — lazy shared `Db` singleton over `@launchpad/db` factories
  (no module-load throw when `DATABASE_URL` is unset).
- `app/auth.ts` — the one `NextAuth()` binding (app/, NOT lib/: `next-auth`
  is ESM-only and lib must also compile as CJS for `node --test`):
  Credentials provider → `authorizeUser` with real deps, `session.strategy
  "jwt"`, jwt/session callbacks → the pure shapers, `pages.signIn "/login"`,
  `trustHost: true` (self-hosted; the host header is NOT a trust boundary
  anywhere — auth comes from the signed session cookie).
- `app/api/auth/[...nextauth]/route.ts` — re-export the v5 handlers.
- `app/login/page.tsx` + `app/login/actions.ts` — minimal email+password
  form (server action → `signIn("credentials")`), `?error=` display,
  signed-in state with a sign-out button.
- `app/next-auth.d.ts` — module augmentation: `session.user.role`.
- `lib/env.ts` — add `AUTH_SECRET` to `REQUIRED_WEB_ENV` (the spec-0007
  strict check; a missing secret must surface as the config panel, not a
  runtime 500 on first `auth()` call). `.env.example` documents it with a
  generation command.

Non-goals: no route/action gating (0074); no RBAC beyond the role claim
(F.4); no login rate limiting (scrypt ~100 ms/attempt is the interim
throttle; revisit with 0074's rate limit); no OAuth/passkeys (add-on
providers later); no session DB table (JWT strategy; Credentials cannot use
DB sessions anyway).

## Acceptance criteria

- `authorizeUser`: correct credentials → user object with role; unknown
  email / missing hash / wrong password / non-string input → `null` (and the
  dummy-hash timing path is exercised).
- Session shaping: role round-trips through jwt→session; a roleless token
  degrades to `VIEWER`, never `OWNER`.
- `validateWebEnv` reports a missing `AUTH_SECRET`.
- `pnpm -r typecheck && pnpm -r test` green.
- (human) `next dev` live check: seed owner (0072 CLI), sign in at `/login`
  with wrong-then-right password, confirm session cookie + role via
  `/api/auth/session`, sign out.

## Plan

Direct outline (Track 1): pure core in lib + tests, NextAuth binding in
app/, login page, env plumbing, green gate, one commit.

## Progress

- [x] [code] add next-auth@beta + @launchpad/db deps to apps/web
- [x] [code] lib/auth-core.ts (authorize + shapers) + tests
- [x] [code] lib/db.ts lazy Db singleton
- [x] [code] app/auth.ts NextAuth binding + [...nextauth] route + d.ts
- [x] [code] /login page + actions (sign-in, sign-out, error display)
- [x] [code] AUTH_SECRET in REQUIRED_WEB_ENV + env tests + .env.example
- [x] [code] full `pnpm -r typecheck && pnpm -r test` green
- [x] (human) live login/logout round-trip against seeded owner — VERIFIED 2026-07-22 on `127.0.0.1:3001`: wrong password → "wrong email or password" refusal; correct password → signed in, `/login` shows OWNER; `/api/auth/session` role confirmed via the audited signin. (Sign-out button wired but not separately clicked.)

## Handoff log
- **2026-07-22 / (Track-1 direct):** Landed the auth core. Pure logic in
  `lib/auth-core.ts` (authorizeUser with fail-closed nulls + a static
  TIMING_EQUALIZER_HASH so unknown-email costs the same as wrong-password;
  tokenWithUser/sessionRoleFromToken shapers, unknown role → VIEWER);
  `app/auth.ts` holds the one NextAuth binding (next-auth 5.0.0-beta.32,
  Credentials + JWT, trustHost with a comment making explicit that Host is
  not a trust boundary) plus `currentRole`/`isOwnerSession` accessors for
  0074. Added `findUserByEmail` to @launchpad/db (drizzle stays confined to
  the package). /login page + actions in house styles; AUTH_SECRET joined
  REQUIRED_WEB_ENV (env/health test fixtures updated). Two integration
  gotchas fixed en route: (1) TS2742 non-portable inferred types from
  next-auth under pnpm — apps/web tsconfig sets `declaration: false` (it
  already never emits); (2) `next build` failed on @launchpad/db's
  migrate.ts `new URL("../drizzle", import.meta.url)` — webpack treats it as
  an asset; the package root no longer re-exports ./migrate.js (CLI-only
  import), documented in packages/db/src/index.ts. Verified:
  `pnpm -r typecheck` green; `pnpm -r test` 842 pass / 0 fail; `next build`
  green (/login route present). NEXT: 0074 gates every mutating surface on
  `isOwnerSession` and deletes the header guard.
