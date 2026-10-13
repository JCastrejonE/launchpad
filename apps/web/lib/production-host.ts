/**
 * Which production host a newly-created project row gets.
 *
 * `createProjectAction` is shared by BOTH wizards, and they need opposite
 * answers. It defaulted to deriving, so `/connect` recorded
 * `taqueria-sol-conectada.odoo.example.com` for a tenant that actually lives at
 * `taqueria-sol.odoo.example.com` — a name that will never resolve. Fixing it in
 * `connect/actions.ts` did nothing, because the derivation is in the shared
 * action one hop further along (docs/VERIFICATION.md #9: the function with the
 * matching name is not the one in the path).
 *
 * So the policy is a REQUIRED argument and a closed union, not an optional
 * boolean: a third caller has to state its intent before it will compile.
 * VERIFICATION #12 — an optional parameter is silent at exactly the call site
 * that is wrong — has now been paid for six times in this repo.
 */
import { odooHostFor } from "@launchpad/pipeline";

export type FleetHostPolicy =
  /** We are CREATING the tenant: provisioning makes exactly
   *  `<slug>.odoo.example.com` and writes its DNS, so deriving is what keeps the
   *  row and the DNS from disagreeing (spec 0225 E). */
  | "derive"
  /** The tenant ALREADY EXISTS and we have not looked at it. Migration 0005:
   *  for the fleet the address is the `vps_id`. A guess is worse than null. */
  | "none";

export function productionHostFor(
  policy: FleetHostPolicy,
  input: { productionKind: string | null; productionHost: string | null; slug: string },
): string | null {
  // An explicitly supplied host always wins — that is the odoo.sh case, and the
  // validator has already refused a supplied host for any other kind.
  if (input.productionHost) return input.productionHost;
  if (policy === "derive" && input.productionKind === "fleet") return odooHostFor(input.slug);
  return null;
}
