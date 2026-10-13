/**
 * Which routes may be served WITHOUT a session (spec 0125).
 *
 * Until this file existed, Auth.js gated *actions* — `actorFor(capability)` on
 * every effectful handler — but nothing gated *reads*. On localhost that was
 * invisible. The moment the console was exposed on a public IP, `/` rendered
 * the dashboard (greeting and project list) and `/forge/specs` listed every
 * spec title to anonymous visitors. Verified live before this fix: 200 and
 * 17 985 bytes with no cookie.
 *
 * Same shape as `lib/capabilities.ts` and for the same reason: the policy is a
 * pure function so it can be tested exhaustively, and `middleware.ts` only
 * supplies the request. Default DENY — a new route is private until someone
 * adds it here deliberately.
 */

/**
 * Prefixes served without a session, each for a reason that survives review:
 *  - `/login`             the sign-in page itself; gating it is a redirect loop.
 *  - `/api/auth`          Auth.js's own handlers (csrf, callback, session).
 *                         Blocking these breaks sign-in.
 *  - `/api/health`        liveness. `scripts/preflight.sh` and any uptime check
 *                         poll it unauthenticated, and it reports only
 *                         {ok, checks:{env, temporal}} — no tenant data.
 *  - `/api/github/webhook` GitHub calls it, and GitHub has no session. Its
 *                         authentication is the HMAC-SHA256 signature over the
 *                         raw body (spec 0228 D), verified before the payload is
 *                         parsed and before anything is started. An unset secret
 *                         REFUSES rather than allows. Session-gating it would not
 *                         make it safer; it would make it dead.
 */
const PUBLIC_PREFIXES = ["/login", "/api/auth", "/api/health", "/api/github/webhook"] as const;

/**
 * Framework and asset paths that are not application routes. `/_next`
 * carries the build's own JS/CSS; the rest are conventional root files.
 * These are matched exactly or by prefix and never carry tenant data.
 */
const PUBLIC_ASSETS = ["/_next/", "/favicon.ico", "/robots.txt", "/sitemap.xml"] as const;

/**
 * True when the request must carry a valid session.
 *
 * Prefix matching is anchored at a segment boundary: `/loginable` is NOT
 * public just because `/login` is. That is the whole reason this is a function
 * and not a `startsWith` in the middleware.
 */
export function requiresSession(pathname: string): boolean {
  for (const asset of PUBLIC_ASSETS) {
    if (pathname === asset || pathname.startsWith(asset)) return false;
  }
  for (const prefix of PUBLIC_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return false;
  }
  return true;
}

/**
 * Absolute `/login` URL to send an anonymous visitor to, preserving where they
 * were headed.
 *
 * This is a pure function because the two-line version of it broke twice in one
 * deploy, each time only visible on a real proxied request:
 *  1. built from `nextUrl.origin`, it produced `https://localhost:3000/login` —
 *     the origin the app was reached on *internally*, which would bounce a
 *     browser to port 3000 on the visitor's own machine;
 *  2. rewritten as a relative `Location`, Next rejected it outright with
 *     `ERR_INVALID_URL` (middleware parses Location as a URL), 500ing every
 *     private route.
 *
 * So it takes the forwarded proto/host explicitly and returns an absolute URL.
 * Those headers shape a URL here and nothing else — authorization is the signed
 * session cookie alone (audit finding #2), so a forged `X-Forwarded-Host` can
 * only redirect the forger.
 */
export function signInUrl(opts: {
  pathname: string;
  search: string;
  proto: string;
  host: string;
}): string {
  const proto = opts.proto.replace(/:$/, "") || "https";
  const url = new URL(`${proto}://${opts.host}/login`);
  url.searchParams.set("callbackUrl", `${opts.pathname}${opts.search}`);
  return url.toString();
}
