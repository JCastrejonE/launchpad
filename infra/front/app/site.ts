/**
 * This project's own facts (spec 0191).
 *
 * GENERATED at scaffold time from what the customer answered in the wizard —
 * `renderFrontScaffold` substitutes the placeholders below when the repo is
 * created. It is committed like any other file, so from that moment it is yours:
 * edit it, and the site changes.
 *
 * Data lives here; presentation lives in `app/components/`. That separation is
 * deliberate — a change to how the site LOOKS should touch a component, not this
 * file.
 */
export interface Site {
  /** The business, as it was named when the project was created. */
  nombre: string;
  /** What the business does, in the customer's own words. */
  giro: string;
  /** The processes they said they want to manage. */
  procesos: string[];
  /** Their note about colours, logo, tone. Free text — may be empty. */
  marca: string;
}

export const site: Site = {
  nombre: "__SITE_NOMBRE__",
  giro: "__SITE_GIRO__",
  procesos: __SITE_PROCESOS__,
  marca: "__SITE_MARCA__",
};
