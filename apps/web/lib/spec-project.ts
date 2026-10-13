/**
 * Which project does a spec belong to? (spec 0104)
 *
 * A spec file's `tenant:` frontmatter is the discriminator, and this mirrors the
 * mapping `projectForTarget()` (spec 0079, `@launchpad/db`) already applies to
 * pipeline RUN targets — `self`/`launchpad` → the platform project, a tenant id →
 * that tenant's odoo project. Specs and runs therefore agree on ownership, which
 * is what lets a workspace show "my specs" and "my runs" side by side.
 *
 * Measured across the repo when this landed: 99 specs carry `tenant: launchpad`
 * and 3 carry `tenant: sandbox`, so the field genuinely discriminates. Note that
 * a spec about *building* the tenant-deploy feature still says
 * `tenant: launchpad` — correctly, since it is a change to the platform repo, not
 * a deploy of a tenant. Only the auto-generated tenant deploy manifests
 * (`writeTenantDeployManifest`) name a tenant.
 *
 * Deliberately pure and dependency-free: no DB, no fs. The caller feeds it
 * frontmatter it already parsed, so this is unit-testable and safe to import
 * from either side of the client boundary.
 *
 * NOT backed by the `spec_files` table. That table has no writer and this spec
 * deliberately did not add one — the `specs/` directory is local truth and
 * `listSpecs()` already reads it. See spec 0104 for the full reasoning and for
 * the one trigger that would reverse the decision (the web app being deployed
 * away from the repo checkout).
 */

/** Slug of the project every platform/repo-level spec belongs to (spec 0079's
 * `PLATFORM_PROJECT.slug`, restated here so this module stays dependency-free). */
export const PLATFORM_PROJECT_SLUG = "platform";

/**
 * Project slug owning a spec, from its `tenant:` frontmatter value.
 *
 * `launchpad` (and `self`, the pipeline's other name for the same thing — see
 * `isSelfTarget`) means "this repo", which is the platform project. Anything else
 * is taken as a tenant slug verbatim. Missing/blank frontmatter falls back to
 * platform rather than throwing: an unreadable `tenant:` should not hide a spec
 * from every workspace, and platform is where a repo spec belongs anyway.
 */
export function projectSlugForSpec(tenant: string | undefined): string {
  const value = (tenant ?? "").trim();
  if (!value || value === "launchpad" || value === "self") return PLATFORM_PROJECT_SLUG;
  return value;
}

/** Filter a list of parsed specs to the ones owned by `projectSlug`. */
export function specsForProject<T extends { tenant?: string }>(
  specs: readonly T[],
  projectSlug: string,
): T[] {
  return specs.filter((s) => projectSlugForSpec(s.tenant) === projectSlug);
}

