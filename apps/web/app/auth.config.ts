/**
 * Edge-safe half of the Auth.js config (spec 0125), for `middleware.ts` only.
 *
 * `app/auth.ts` cannot be imported from middleware: its Credentials
 * `authorize` reaches `@launchpad/db` (node-postgres), and the audit writer
 * reaches the DB too — neither runs in the middleware runtime. This is the
 * documented Auth.js v5 split: the edge config carries no providers and no DB,
 * because middleware only needs to VERIFY the session JWT, never to issue one.
 *
 * `secret` is read from AUTH_SECRET by Auth.js itself, so the same signature
 * that `app/auth.ts` produced is the one checked here.
 */
import type { NextAuthConfig } from "next-auth";
import { sharedSessionCookie } from "../lib/env";

/**
 * Spec 0213 B2. This MUST live here rather than only in `app/auth.ts`, and the
 * reason is a live bug: middleware builds its own NextAuth instance from this
 * object, so a cookie configured only in `auth.ts` is written under the new name
 * and then looked for by the middleware under Auth.js's DEFAULT name. The result
 * is a session the page can see and the route gate cannot — staging bounced `/`
 * to `/login`, and `/login` then said "Sesión iniciada como owner@example.com".
 *
 * `lib/env` is import-free and pure, which is what makes it safe here: this
 * module is loaded in the middleware runtime, where `@launchpad/db` is not.
 */
const sessionCookie = sharedSessionCookie();

export const authConfig = {
  session: { strategy: "jwt" },
  trustHost: true,
  pages: { signIn: "/login" },
  ...(sessionCookie ? { cookies: sessionCookie } : {}),
  providers: [],
} satisfies NextAuthConfig;
