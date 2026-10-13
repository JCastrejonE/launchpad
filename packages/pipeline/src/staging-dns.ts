/**
 * Where a staging host lives in DNS, and whether it can hold a certificate
 * (spec 0189).
 *
 * Both answers come from the staging domain alone, and both used to be assumed:
 * the name was `203.0.113.20.sslip.io` — a public wildcard resolver nobody
 * writes records in — and no staging deploy ever asked for a certificate, so
 * every reviewer met `CN=TRAEFIK DEFAULT CERT` on the link gate 2 depends on.
 */

/** Traefik's ACME resolver name, as configured on the fleet's Traefik. */
export const ACME_RESOLVER = "letsencrypt";

/**
 * `letsencrypt` when this domain is one we can pass an ACME challenge for, and
 * `undefined` when it is not.
 *
 * The exclusion that matters is `sslip.io` (and its siblings): they are not on
 * the Public Suffix List, so Let's Encrypt counts every user of that domain
 * against ONE rate limit — asking for a certificate there fails, slowly, and
 * spends attempts that belong to somebody else. An IP literal cannot be
 * validated at all.
 *
 * Deriving this rather than hard-coding `"letsencrypt"` means rolling
 * `LAUNCHPAD_STAGING_DOMAIN` back to sslip.io degrades to exactly today's
 * behaviour instead of turning every staging deploy into a failing ACME order.
 */
export function stagingCertResolver(domain: string): string | undefined {
  const d = domain.trim().toLowerCase();
  if (!d) return undefined;
  if (/(^|\.)sslip\.io$/.test(d) || /(^|\.)nip\.io$/.test(d)) return undefined;
  // An IP literal (or a name ending in one, which is how the sslip.io form is
  // written) is not a domain anyone issues for.
  if (/(^|\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(d)) return undefined;
  if (!d.includes(".")) return undefined;
  return ACME_RESOLVER;
}

/**
 * The `{ domain, name }` pair `upsertDnsRecord` wants for a staging host, or
 * `null` when the host is not inside the zone we manage — in which case there is
 * no record for us to write and saying so is better than writing it somewhere
 * wrong.
 *
 * `br-x.panaderia.staging.example.com` in zone `example.com` is
 * `{ domain: "example.com", name: "br-x.panaderia.staging" }`.
 */
export function stagingDnsTarget(
  host: string,
  zone: string,
): { domain: string; name: string } | null {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  const z = zone.trim().toLowerCase().replace(/\.$/, "");
  if (!h || !z || h === z) return null;
  if (!h.endsWith(`.${z}`)) return null;
  const name = h.slice(0, -(z.length + 1));
  return name ? { domain: z, name } : null;
}
