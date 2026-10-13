/**
 * The addons the company owns and ships into tenants (spec 0206).
 *
 * `docs/ODOO-ADDONS.md` is the prose registry — who wrote each addon, what it
 * does, what it costs. This is the same knowledge as DATA, narrowed to the four
 * facts a machine needs to fetch one: where it lives, at which commit, what
 * directory it must land as, and which Odoo series it targets.
 *
 * Pure: no I/O, no git, no network. `vendor-fetch.ts` does the fetching.
 *
 * WHY A COMMIT AND NOT A BRANCH. A branch pin means a tenant provisioned in
 * March and one provisioned in June get different code from the same registry
 * row, and nothing anywhere records which. Bumping a row is then a visible,
 * reviewable diff instead of a silent drift.
 */
import type { OdooVersion } from "./spec.js";

export interface VendoredAddon {
  /**
   * The addon's technical name — which is also, and non-negotiably, the
   * DIRECTORY name it must land as under `/mnt/extra-addons`. Odoo resolves
   * asset paths by this name.
   */
  module: string;
  /** Repository under `example-org`. Often NOT the module name. */
  repo: string;
  /** Path to the addon inside the repo; `""` when its manifest is at the root. */
  subpath: string;
  /** A full commit SHA. See the file header for why this is not a branch. */
  commit: string;
  /** The Odoo series the manifest targets. Vendoring across series is refused. */
  series: OdooVersion;
  /** Recorded because one of these is not free software and that has consequences. */
  licence: string;
}

/** The CFDI addon's technical name, shared with `procesos-modules.ts` so the
 *  proceso map and this registry cannot disagree about what CFDI installs. */
export const CFDI_MODULE = "cdfi_invoice";

/**
 * The registry. Commits read from GitHub on 2026-08-15.
 *
 * `app_menu_enterprise` is the row to be careful with: its repository is called
 * `odoo19enterprisemenu`, its manifest sits at the repo ROOT, and its asset
 * paths hardcode `app_menu_enterprise/static/src/...`. Vendored under any other
 * directory name it installs cleanly and does visibly nothing.
 */
const VENDORED: readonly VendoredAddon[] = [
  {
    module: "web_responsive",
    repo: "client-i-odoo",
    subpath: "addons-ext/web_responsive",
    commit: "af9c183aea0770fecc135164fbc91763052f9316",
    series: 19,
    licence: "LGPL-3",
  },
  {
    module: "app_menu_enterprise",
    repo: "odoo19enterprisemenu",
    subpath: "",
    commit: "3c96326d891434c1feb42d427058dcb5252da9c5",
    series: 19,
    licence: "LGPL-3",
  },
  {
    // Canonical copy: `client-h-addons` tracks `main`, while the identical-version
    // copy in `client-d-erp` tracks `beta`. OPL-1: using it with clients needs a
    // licence from its vendor.
    module: CFDI_MODULE,
    repo: "client-h-addons",
    subpath: "addons/cdfi_invoice",
    commit: "97f7e2ad101f514546fcd3248036f7a2c9ce4db6",
    series: 19,
    licence: "OPL-1",
  },
];

/** The two that make Community look like Enterprise. Installed on every tenant
 *  we provision (spec 0206 decision 1) — both LGPL-3, and the alternative was a
 *  per-project flag nobody asked for. */
const HOUSE_STYLE: readonly string[] = ["web_responsive", "app_menu_enterprise"];

/**
 * What to vendor into a tenant on this Odoo series.
 *
 * A series no row targets gets an EMPTY list, never another series' rows: every
 * manifest here reads `19.0.x`, and putting one in an 18 tenant is the
 * silent-wrong-default that spec 0205 was written to stop. The nine tenants on
 * 18 therefore get nothing, which is the truth.
 */
export function vendoredAddonsFor(
  version: OdooVersion,
  opts: { cfdi: boolean },
): VendoredAddon[] {
  return VENDORED.filter(
    (a) =>
      a.series === version &&
      (HOUSE_STYLE.includes(a.module) || (a.module === CFDI_MODULE && opts.cfdi)),
  );
}

/** Whether CFDI can be delivered at all on this series — i.e. whether the
 *  registry has a `cdfi_invoice` row for it. `procesos-modules.ts` asks this
 *  before promising the customer an install. */
export function cfdiVendoredFor(version: OdooVersion): boolean {
  return VENDORED.some((a) => a.module === CFDI_MODULE && a.series === version);
}
