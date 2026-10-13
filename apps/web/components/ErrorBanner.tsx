/**
 * Surfaces a server action failure back on the page it was submitted from
 * (spec 0007) — actions redirect to `?error=<message>` on failure instead of
 * throwing into Next's generic error page, so a "Start a change"/gate
 * submission is never lost silently. Spec 0101 restyled it from the retired
 * `.alert` component class to the template's own danger-chip idiom.
 */
export function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mb-4 rounded-lg border border-rose/40 bg-rose/10 px-3.5 py-2.5 text-[13px] text-rose"
    >
      {message}
    </p>
  );
}
