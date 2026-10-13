/**
 * Session gate for every route (spec 0125).
 *
 * The app already refused unauthorized *actions* (`actorFor(capability)`), but
 * nothing refused unauthorized *reads*: on a public IP, `/` served the
 * dashboard and `/forge/specs` listed every spec to anonymous visitors. This
 * closes that, in front of the whole app rather than page by page — a page-level
 * check protects only the pages someone remembered to annotate.
 *
 * The policy is `lib/route-access.ts` (pure, tested). This file supplies the
 * request and nothing else. Authorization still comes from the signed session
 * cookie alone: the Host header is not a trust boundary anywhere here (audit
 * finding #2), and neither is anything else the client sends.
 */
import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "./app/auth.config";
import { requiresSession, signInUrl } from "./lib/route-access";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname, search } = req.nextUrl;
  if (!requiresSession(pathname)) return NextResponse.next();
  if (req.auth) return NextResponse.next();

  // Anonymous on a private route: send them to sign in, remembering where they
  // were headed. A redirect (not a 404) because hiding the route's existence
  // buys nothing once /login is public anyway.
  //
  // The destination is built from the FORWARDED host, not `nextUrl.origin`,
  // which behind nginx is the internal origin (measured: localhost:3000). See
  // `signInUrl` — it is a tested pure function because this broke twice.
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol;
  return NextResponse.redirect(signInUrl({ pathname, search, proto, host }), 307);
});

export const config = {
  // Everything except Next's own asset pipeline and image optimiser. The
  // allowlist that matters is in lib/route-access.ts; this matcher only keeps
  // the middleware off paths that are never application routes.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
