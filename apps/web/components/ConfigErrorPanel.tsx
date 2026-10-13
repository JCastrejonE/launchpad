import type { RequiredWebEnvVar } from "../lib/env";
import { Card } from "./ui";

/**
 * Rendered instead of a page's normal content when required env
 * (LAUNCHPAD_REPO_ROOT / TEMPORAL_ADDRESS / AUTH_SECRET) is missing —
 * spec 0007. Returns content only (the app shell in layout.tsx supplies the
 * <main>/container — spec 0024), so it never nests a second <main>.
 * Spec 0101: restyled onto the Mission Control template.
 */
export function ConfigErrorPanel({ missing }: { missing: RequiredWebEnvVar[] }) {
  return (
    <div className="mx-auto max-w-[1400px] px-5 py-10">
      <p className="text-xs font-semibold text-faint">Configuration error</p>
      <h1 className="mt-1.5 mb-6 text-2xl font-semibold tracking-tight text-foreground">
        apps/web can&apos;t run
      </h1>
      <Card>
        <div className="p-5 text-sm text-muted">
          <p className="mb-3">Required environment variables are missing:</p>
          <div className="flex flex-col">
            {missing.map((name) => (
              <div
                key={name}
                className="flex items-center justify-between gap-3 border-b border-dashed border-border py-2 text-[13px] last:border-b-0"
              >
                <span className="text-foreground">{name}</span>
                <span className="inline-flex items-center gap-1.5 rounded-md border border-rose/40 bg-rose/10 px-2 py-1 text-[11px] text-rose">
                  <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                  missing
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3.5 text-[13px] text-muted">
            Set these in your{" "}
            <code className="rounded border border-border bg-surface px-1 py-px">.env</code> (see
            README.md) and restart the dev server.
          </p>
        </div>
      </Card>
    </div>
  );
}
