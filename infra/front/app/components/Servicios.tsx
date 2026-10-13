import { site } from "../site";

/**
 * One card per process the customer chose in the wizard.
 *
 * Renders nothing when they chose none — an empty section with a heading is
 * worse than no section, and this page belongs to a real business.
 */
export function Servicios() {
  if (site.procesos.length === 0) return null;

  return (
    <section style={{ padding: "1rem 0 3rem" }}>
      <h2 style={{ fontSize: "0.75rem", letterSpacing: "0.14em", color: "#7d8590", textTransform: "uppercase" }}>
        Lo que administramos
      </h2>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: "1rem 0 0",
          display: "grid",
          gap: "0.75rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))",
        }}
      >
        {site.procesos.map((proceso) => (
          <li
            key={proceso}
            style={{
              background: "#11161d",
              border: "1px solid #1d242d",
              borderRadius: "0.5rem",
              padding: "1rem 1.25rem",
            }}
          >
            {proceso}
          </li>
        ))}
      </ul>
    </section>
  );
}
