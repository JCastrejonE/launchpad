"use client";

// Shared reduced-motion hook (DESIGN.md §4: "Every entry has a
// prefers-reduced-motion: reduce alternative"). Several call sites need a
// genuine MARKUP swap, not just "let the CSS backstop kill the animation" —
// e.g. #11 deploy-pending's "Starting…" text (spec 0040,
// components/hangar/DeployTenantForm.tsx) and #8 stream-caret's "Working…"
// text (spec 0041, components/chat/ChatThread.tsx). Extracted here so both
// read the live media query the same way instead of duplicating the effect.
import { useEffect, useState } from "react";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return reduced;
}
