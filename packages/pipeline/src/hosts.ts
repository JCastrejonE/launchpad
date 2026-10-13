/**
 * Where a project's hostnames live (spec 0182, revised by the owner 2026-08-12).
 *
 * ONE definition, used by provisioning AND by the release deploy. Two callers
 * deriving the same host from different inputs is the defect class that produced
 * spec 0175 (a release re-deployed Odoo on `prod.<slug>.<domain>`, killing the
 * name the customer used) and finding 1.16 (`ab-test-sandbox` recorded as
 * deployed at a hostname whose zone does not resolve). Both callers now import
 * from here, so agreement is structural rather than coincidental.
 *
 * ## Why the zone is OURS, not the project's
 *
 * The owner: *"the user will be able to put whatever DNS they like, but the right
 * records depend on them and their hosts. for now we can and should always
 * provide a example.com domain."*
 *
 * We can only write DNS in a zone we control. So every project always gets a
 * hostname in ours — created, certificated and verifiable on the day it is
 * provisioned. A customer's own domain is a different thing: recorded on the
 * project, pointed at us by them, and verified later by resolve tests
 * (spec 0185). It never drives the records we create, because we cannot create
 * them.
 *
 * That is also what makes the release smoke (spec 0177) meaningful: it checks a
 * hostname we are responsible for, so a red row is always our problem.
 */

/** Env override for the zone we provision into — the seam every other domain in
 * this repo has (`LAUNCHPAD_STAGING_DOMAIN`, `LAUNCHPAD_TENANT_DOMAIN`). */
export const PROVISION_ZONE_ENV = "LAUNCHPAD_PROVISION_ZONE";

/** The zone this launchpad creates records in. `example.com` unless the env says
 * otherwise — demonstrably ours, which is the whole requirement. */
export function provisionedZone(env: NodeJS.ProcessEnv = process.env): string {
  return env[PROVISION_ZONE_ENV]?.trim() || "example.com";
}

/** The project's front: `<slug>.<zone>`. */
export function frontHostFor(slug: string, env?: NodeJS.ProcessEnv): string {
  return `${slug}.${provisionedZone(env)}`;
}

/** The project's Odoo: `<slug>.odoo.<zone>`. */
export function odooHostFor(slug: string, env?: NodeJS.ProcessEnv): string {
  return `${slug}.odoo.${provisionedZone(env)}`;
}
