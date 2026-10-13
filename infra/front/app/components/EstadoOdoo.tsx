import { fetchOdooVersion, odooUrl } from "../odoo";

/**
 * Proof that this page read its OWN Odoo, live.
 *
 * Deliberately kept when the scaffold became a landing page (spec 0191): it is
 * the acceptance evidence for "the front renders data it read from its own
 * Odoo" — stage 4 of the A/B protocol — and a page that only asserts it is
 * connected proves nothing. Demoted from the whole page to a footer strip; the
 * check it performs is unchanged.
 *
 * Unguarded on purpose. If Odoo cannot be reached this throws, Next serves a
 * 500, and the deploy's `curl -f` fails — which is what makes a green check mean
 * something.
 */
export async function EstadoOdoo() {
  const version = await fetchOdooVersion();

  return (
    <footer
      style={{
        borderTop: "1px solid #1d242d",
        marginTop: "2rem",
        padding: "1.25rem 0 3rem",
        color: "#7d8590",
        fontSize: "0.8rem",
        display: "flex",
        flexWrap: "wrap",
        gap: "0.4rem 1.5rem",
      }}
    >
      <span>Odoo {version.server_serie} en vivo</span>
      <span>{odooUrl()}</span>
      <span>versión {version.server_version}</span>
    </footer>
  );
}
