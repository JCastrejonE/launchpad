"use client";

// DESIGN.md §4.2 #12 drafting-ellipsis (spec 0041 item 4): the "Drafting
// spec…" placeholder's mono ellipsis cycle. RM is a genuine markup swap back
// to the static "Drafting spec…" text — not just the animation frozen —
// same pattern as #8 stream-caret's "Thinking…" → "Working…" swap
// (components/chat/ChatThread.tsx, item 1) and #11 deploy-pending's
// "Starting…" text (components/hangar/DeployTenantForm.tsx, 0040): reusing
// the shared usePrefersReducedMotion hook rather than a fourth local copy.
import { usePrefersReducedMotion } from "../lib/use-prefers-reduced-motion";

export function DraftingHeading() {
  const reducedMotion = usePrefersReducedMotion();
  // Spec 0101: `.drafting-ellipsis` → the template-convention `.mc-ellipsis`
  // (globals.css extras block — a ::after content cycle, not expressible as a
  // utility). The reduced-motion branch is a real markup swap, not a frozen
  // animation, so it is unchanged.
  if (reducedMotion) {
    return <h1 className="text-xl font-semibold text-foreground">Drafting spec…</h1>;
  }
  return (
    <h1 className="text-xl font-semibold text-foreground">
      Drafting spec
      <span className="mc-ellipsis" aria-hidden="true" />
    </h1>
  );
}
