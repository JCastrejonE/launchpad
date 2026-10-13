// Spec inbox — spec 0002. Pipeline-state column + "start a change" form —
// spec 0005. Env validation + config-error panel + surfaced action errors —
// spec 0007. Restyled by spec 0024 (design system + shell).
import Link from "next/link";
import { listSpecs } from "../../../lib/specs";
import { SpecInboxTable } from "../../../components/SpecInboxTable";
import { SpecInboxPoller } from "../../../components/SpecInboxPoller";
import { ConfigErrorPanel } from "../../../components/ConfigErrorPanel";
import { Card } from "../../../components/ui";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { validateWebEnv } from "../../../lib/env";
import { formatPipelineLabel, getPipelineViewStateSafe } from "../../../lib/pipeline";

// Per-request rendering so the inbox reflects live pipeline state (spec 0024;
// matches the home hub).
export const dynamic = "force-dynamic";

// Spec 0101: `.page-h`/`.card`/`.btn primary`/`.icon` retired. These are <Link>s,
// not <button>s, so they carry `Btn variant="primary"`'s utilities inline rather
// than rendering the template's button primitive.
const PRIMARY_LINK =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-brand/50 bg-brand/15 " +
  "px-3.5 py-2 text-[13px] font-medium text-brand transition-colors hover:bg-brand/25";

function PlusIcon() {
  return (
    <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export default async function SpecInboxPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const envCheck = validateWebEnv();
  if (!envCheck.ok) {
    return <ConfigErrorPanel missing={envCheck.missing} />;
  }

  const { error } = await searchParams;
  const specs = await listSpecs();

  // One describePipeline call per row, each isolated: a Temporal outage (or
  // any other failure) on one row must not take down the whole inbox, so
  // getPipelineViewStateSafe swallows errors into `null` and
  // formatPipelineLabel renders that as a clear "Unknown" state per row.
  // `SpecInboxTable` (a client component) owns sort state and sorts these
  // already-fetched rows itself — no server-side sort here (spec 0032 item 1).
  // Formatted to a plain, serializable {label, unknown} pair here (not the
  // raw PipelineViewState) so the client bundle never pulls in `lib/pipeline`
  // — that module imports @temporalio/client, which is server-only (grpc's
  // Node net/tls/fs deps break webpack's client build).
  const pipelineViews = await Promise.all(
    specs.map((spec) => getPipelineViewStateSafe(spec.id, spec.status)),
  );
  const pipelineLabels = pipelineViews.map((view) => ({
    label: formatPipelineLabel(view),
    unknown: view === null,
  }));

  // #1 live-dot clock-synced negative animation-delay (DESIGN.md §4.2 note +
  // globals.css comment above `.pill.live .d`), same mechanism as the Hangar
  // fleet dashboard (spec 0040 Scope 3, app/page.tsx): computed once per
  // request from wall-clock time (not mount time), so every live status dot
  // on the page — and the same dot across a 3s poll re-render — stays
  // phase-locked instead of visibly restarting.
  const liveDelay = `-${(Date.now() % 2000) / 1000}s`;

  return (
    <>
      {/* §6 ban: no per-section eyebrow (was "Spec inbox") — plain hierarchy,
          the h1 carries it. */}
      <SpecInboxPoller />
      <div className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Specs</h1>
          <p className="mt-1.5 max-w-[60ch] text-sm text-muted">
            Every spec and its live pipeline state. Open one to drive its gates.
          </p>
        </div>
        <Link href="/forge" className={PRIMARY_LINK}>
          <PlusIcon />
          New change
        </Link>
      </div>

      <ErrorBanner message={error} />

      {specs.length === 0 ? (
        // Empty-inbox state that teaches (DESIGN.md §5): no specs is not a
        // dead end, it's "here's how to get one" — mirrors the empty-chat
        // hero's teaching tone (item 1) rather than a bare "nothing here".
        <Card>
          <div className="p-5 text-sm text-muted">
            <p className="mb-2 text-foreground">No specs yet.</p>
            <p className="mb-4 max-w-[55ch]">
              Every change starts as a spec — describe what you want built in the Forge chat and a
              draft lands here for gate 1 (spec approval). Nothing runs until you approve it.
            </p>
            <Link href="/forge" className={PRIMARY_LINK}>
              <PlusIcon />
              Start a change
            </Link>
          </div>
        </Card>
      ) : (
        <SpecInboxTable specs={specs} pipelineLabels={pipelineLabels} liveDelay={liveDelay} />
      )}
    </>
  );
}
