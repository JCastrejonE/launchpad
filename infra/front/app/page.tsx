import { Hero } from "./components/Hero";
import { Servicios } from "./components/Servicios";
import { EstadoOdoo } from "./components/EstadoOdoo";

// Never prerendered and never cached: `EstadoOdoo` reports the state of a live
// Odoo, and a cached answer would keep saying "connected" after the backend went
// away.
export const dynamic = "force-dynamic";

/**
 * The project's landing page (spec 0191).
 *
 * Composition only — every piece of presentation lives in `app/components/`, and
 * the business's own facts live in `app/site.ts`. Change how it looks by editing
 * a component; change what it says by editing the data.
 */
export default function Home() {
  return (
    <main style={{ padding: "0 1.5rem", maxWidth: "48rem", margin: "0 auto" }}>
      <Hero />
      <Servicios />
      {/* @ts-expect-error — async Server Component (Next 15 types this fine at
          runtime; the annotation keeps `tsc` honest for the scaffold's own
          simpler config). */}
      <EstadoOdoo />
    </main>
  );
}
