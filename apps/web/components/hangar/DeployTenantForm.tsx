"use client";

// Deploy-tenant form, extracted to a client component so it can reflect submit
// state (spec 0040 Scope 4 / DESIGN.md #11 deploy-pending + §5 states). On
// submit: the primary button becomes `.btn.loading` (inline spinner) and the
// form controls disable until the server action's redirect lands. `useFormStatus`
// only sees the state of an ANCESTOR <form>, not the component that renders the
// <form> itself — so `SubmitButton`/`Fields` are separate components nested
// inside the <form> below, each reading `useFormStatus()` independently.
//
// Reduced-motion (DESIGN.md #11 RM): a markup swap, not CSS-only (globals.css
// comment above `@keyframes deploy-pending`) — `usePrefersReducedMotion` reads
// the live media query so the button drops the spinner class and shows static
// "Starting…" text instead of an inert spinning ring. Shared with
// components/chat/ChatThread.tsx (spec 0041 #8 stream-caret's own markup
// swap) via lib/use-prefers-reduced-motion.ts.
import { useFormStatus } from "react-dom";
import type { FleetVps } from "../../lib/fleet";
import { usePrefersReducedMotion } from "../../lib/use-prefers-reduced-motion";

// Spec 0085 (C.4b) restyled this onto the mockup design system when the fleet
// moved into the platform workspace — the legacy `.field`/`.input`/`.btn`
// classes would have clashed with the terminal-styled tab. BEHAVIOUR IS
// UNCHANGED: same field names, same per-host ids, same pending/disabled
// handling, same reduced-motion markup swap.
const INPUT_CLASS =
  "w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] text-foreground " +
  "outline-none placeholder:text-faint focus:border-brand/40 disabled:opacity-60";

const LABEL_CLASS = "mb-1 block text-[10px] uppercase tracking-widest text-faint";

function SubmitButton() {
  const { pending } = useFormStatus();
  const reducedMotion = usePrefersReducedMotion();
  const showSpinner = pending && !reducedMotion;
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className="inline-flex items-center gap-2 rounded-lg border border-brand/50 bg-brand/15 px-3 py-1.5 text-[12px] font-medium text-brand transition-colors hover:bg-brand/25 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {showSpinner && (
        <span
          aria-hidden="true"
          className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {pending && reducedMotion ? "Starting…" : "Deploy tenant"}
    </button>
  );
}

function Fields({ vpsId }: { vpsId: number }) {
  const { pending } = useFormStatus();
  return (
    <>
      <div className="w-40">
        <label className={LABEL_CLASS} htmlFor={`tenantId-${vpsId}`}>
          Tenant id
        </label>
        <input
          id={`tenantId-${vpsId}`}
          name="tenantId"
          className={INPUT_CLASS}
          placeholder="acme"
          required
          disabled={pending}
        />
      </div>
      <div className="w-28">
        <label className={LABEL_CLASS} htmlFor={`odooVersion-${vpsId}`}>
          Odoo version
        </label>
        <select
          id={`odooVersion-${vpsId}`}
          name="odooVersion"
          className={INPUT_CLASS}
          defaultValue="18"
          disabled={pending}
        >
          <option value="17">17</option>
          <option value="18">18</option>
          <option value="19">19</option>
        </select>
      </div>
    </>
  );
}

export function DeployTenantForm({
  vps,
  action,
}: {
  vps: FleetVps;
  action: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <form
      action={action}
      className="mt-3 flex flex-wrap items-end gap-3 border-t border-dashed border-border pt-3"
    >
      <input type="hidden" name="vpsId" value={vps.id} />
      <Fields vpsId={vps.id} />
      <SubmitButton />
    </form>
  );
}
