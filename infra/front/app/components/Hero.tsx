import { site } from "../site";

/**
 * The first thing a visitor reads: whose site this is and what they do.
 *
 * `giro` is the customer's own sentence from the wizard. It is shown as written
 * — no truncation, no rewriting — because the point of asking was to use it.
 *
 * `site.marca` is deliberately NOT rendered (spec 0204). It is the customer's
 * note about how the site should LOOK — "verde olivo #4A5D3A, tipografía serif"
 * — written for us, not for their visitors. Printing the instruction instead of
 * following it put internal intake text on two live customer sites. The field
 * stays in `site.ts` because it is real data and the brand work will consume it;
 * it just does not belong in the page body. Do not restore this paragraph.
 */
export function Hero() {
  return (
    <header style={{ padding: "4rem 0 2.5rem" }}>
      <p
        style={{
          color: "#7d8590",
          letterSpacing: "0.14em",
          fontSize: "0.7rem",
          textTransform: "uppercase",
        }}
      >
        {site.nombre}
      </p>
      <h1 style={{ fontSize: "2.25rem", lineHeight: 1.15, margin: "0.75rem 0 0" }}>
        {site.giro || "Bienvenido"}
      </h1>
    </header>
  );
}
