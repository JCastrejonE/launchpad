/**
 * THE spec page — one route for every project, the platform included
 * (spec 0149).
 *
 * Before this, a spec had two different pages depending on whose it was:
 * `/forge/specs/<filename>` for the platform (stepper, gates, Start, Complete)
 * and a bare read-only view for every other project. The owner: *"launchpad is
 * treating specs differently than other projects, every project should use the
 * same layout/routes … add the gates progress … and don't omit any action
 * button we already have (merge both actions without repeating)."*
 *
 * So this page carries everything, and there is ONE set of actions: the
 * project-scoped ones in `../../actions`, which already check membership
 * (spec 0144 E). `/forge/specs/<filename>` redirects here — not a second copy.
 *
 * Keyed by spec ID, not filename: an id is unique WITHIN a project (0142),
 * which is exactly this route's scope, and every caller already holds one.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ArrowLeft, ExternalLink } from "lucide-react";
import {
  projectBySlug,
  recordedWorkflowIdForSpec,
  sessionRollup,
  specFileBySpecId,
} from "@launchpad/db";
import { getDb } from "../../../../../lib/db";
import { currentRole, isProjectMember } from "../../../../auth";
import { capabilityDenial } from "../../../../../lib/capabilities";
import { parseSpecSummary, parseHandoffLog, parseHumanPendingItems } from "../../../../../lib/specs";
import { temporalWorkflowUrl } from "../../../../../lib/env";
import {
  decidePromoteGate,
  getPipelineViewStateSafe,
  getPromoteCiState,
  suppressDuplicateApprove,
  workflowIdFor,
  GATE_ACTION_LABEL,
  PIPELINE_GATE_LABEL,
  PIPELINE_STATE_LABEL,
} from "../../../../../lib/pipeline";
import { decideUnresolvedSpecView } from "../../../../../lib/spec-drafting";
import { stagingFreshnessNotice } from "../../../../../lib/staging-freshness";
import { branchStagingFacts } from "../../../../../lib/branch-staging-facts";
import { activeStepForView, deriveSpecProgress } from "../../../../../lib/spec-progress";
import { specsDirForProject } from "../../../../../lib/spec-source";
import { Card, Label } from "../../../../../components/ui";
import PipelinePoller from "../../../../../components/PipelinePoller";
import { DraftingHeading } from "../../../../../components/DraftingHeading";
import {
  completeProjectSpecAction,
  signalGateAction,
  startSpecRunAction,
} from "../../actions";

/** The spec's markdown: file first (the working copy an agent just wrote), row
 * second (the durable record) — the same order `specs-tab.tsx` merges in. */
async function readSpec(
  slug: string,
  specId: string,
): Promise<{ filename: string; body: string } | null> {
  const dir = specsDirForProject(slug);
  if (dir) {
    try {
      const match = (await readdir(dir)).find(
        (f) => f.endsWith(".md") && f.startsWith(`${specId}-`),
      );
      if (match) return { filename: match, body: await readFile(path.join(dir, match), "utf8") };
    } catch {
      // Unreadable specs dir — fall through: a lost checkout must not lose the spec.
    }
  }
  try {
    const row = await specFileBySpecId(getDb(), specId, slug);
    if (row) return { filename: row.name, body: row.body };
  } catch {
    /* both sources gone */
  }
  return null;
}

export default async function SpecPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; specId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id: slug, specId } = await params;
  const { error } = await searchParams;
  const db = getDb();
  const project = await projectBySlug(db, slug).catch(() => null);
  if (!project) notFound();
  // Spec 0143/0144 E: membership gates every project surface, this one too.
  if (!(await isProjectMember(project.id))) notFound();

  const found = await readSpec(slug, specId);
  if (!found) {
    // Specs 0027/0028: a run started from the UI redirects here before its
    // async `draftSpec` has written the file. Ask Temporal rather than 404ing
    // — but only a genuinely live run reads as "drafting" (0031).
    const drafting = await getPipelineViewStateSafe(specId, "", undefined, undefined, slug);
    if (decideUnresolvedSpecView(drafting) !== "drafting") notFound();
    return (
      <main className="w-full max-w-4xl">
        <PipelinePoller active={true} />
        <DraftingHeading />
        <Card className="mt-4 p-4 text-[12px] text-muted">
          El spec-drafter está escribiendo esta spec — la página se actualizará sola.
        </Card>
      </main>
    );
  }
  const spec = parseSpecSummary(found.filename, found.body);

  // The live run, and the progress the page renders from it. Spec 0124: for a
  // Track-1 spec (which never has a run) and for a terminal status, the
  // frontmatter is the authority — Temporal only knows about RUNS.
  const view = await getPipelineViewStateSafe(specId, spec.status, undefined, undefined, slug);
  const progress = deriveSpecProgress({
    ...(spec.track ? { track: spec.track } : {}),
    status: spec.status,
    view,
    viewActiveStep: activeStepForView(view),
  });

  // Every gate action the run currently offers, with the same two guards the
  // forge page applied — role (0117) and the gate-3 CI check (0043 C).
  // Spec 0179: the third argument is the whole fix. A BRANCH run's gate 2 is the
  // in-app approval (no GitHub poll competes with it), so suppressing the button
  // left this page offering only Reject at the gate it names — and the promote
  // that would have satisfied gate 2 refuses while the run is active.
  const actions = view ? suppressDuplicateApprove(view.availableActions, view.pr, view.branch) : [];
  const promoteDenial = actions.includes("promote")
    ? capabilityDenial(await currentRole(), "promote")
    : null;
  const promoteCi =
    actions.includes("promote") && view?.pr
      ? await getPromoteCiState(view.pr, specId).catch(() => null)
      : null;
  const promoteGate = promoteCi ? decidePromoteGate(promoteCi) : null;
  const promoteCiLink =
    view?.pr && promoteCi?.available && promoteCi.conclusion !== "success"
      ? view.pr.url.replace(/\/pull\/\d+$/, "/actions")
      : null;

  // Spec 0142 C / 0145: the id a run RECORDED, so the link points at the
  // workflow that exists rather than one recomputed from today's formula.
  const workflowId =
    (await recordedWorkflowIdForSpec(db, specId, project.id).catch(() => null)) ??
    workflowIdFor(specId, slug);
  const temporalUrl = temporalWorkflowUrl(workflowId);
  // Spec 0194: what the run cost, by role. Tolerant — a page render must not
  // fail because telemetry is missing, and every run before migration 0015 has
  // none.
  const sessions = await sessionRollup(db, workflowId).catch(() => []);
  const tokensTotal = sessions.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
  const handoffs = parseHandoffLog(found.body);
  const humanPending =
    view?.state === "waiting_at_gate" && view.gate === "pr"
      ? parseHumanPendingItems(found.body)
      : [];

  // Spec 0187 A: gate 2 approves a change "validated on staging" — so when
  // staging does not hold this head, the page has to say it next to the button.
  // `autopartes` was offered Approve PR over a staging server that predated the
  // first commit, because the refresh had failed on a capacity guard and the run
  // continued (spec 0119, deliberately). The facts were in the branch row.
  const stagingNotice =
    view?.state === "waiting_at_gate" && view.gate === "pr" && view.branch
      ? stagingFreshnessNotice((await branchStagingFacts(slug, view.branch)) ?? {})
      : null;

  const phaseText =
    progress.phaseLabel ?? (view ? PIPELINE_STATE_LABEL[view.state] : "Sin corrida");
  const isLive =
    view?.state === "running" ||
    view?.state === "waiting_at_gate" ||
    view?.state === "unknown_legacy_run";

  return (
    <main className="w-full max-w-4xl">
      <PipelinePoller active={isLive} />

      <Link
        href={`/projects/${slug}/specs`}
        className="mb-4 inline-flex items-center gap-1 text-[12px] text-muted hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" /> {project.name}
      </Link>

      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-[18px] text-foreground">{spec.title || found.filename}</h1>
        <span className="rounded border border-border bg-surface px-2 py-0.5 text-[10px] text-muted">
          {phaseText}
        </span>
      </div>
      <p className="mb-4 text-[11px] text-faint">
        spec {spec.id} · {found.filename}
        {spec.track ? ` · track ${spec.track}` : ""}
        {view?.gate ? ` · ${PIPELINE_GATE_LABEL[view.gate]}` : ""}
        {spec.progress.total > 0 ? ` · ${spec.progress.checked}/${spec.progress.total} items` : ""}
      </p>

      {error ? (
        <Card className="mb-4 border-rose/40 bg-rose/10 p-3 text-[12px] text-rose">{error}</Card>
      ) : null}

      {/* Spec 0145: the workflow. ID always; a LINK only when a reachable
          Temporal UI is configured (0146 put it behind an OWNER session). */}
      <Card className="mb-4 flex flex-wrap items-center gap-2 p-3 text-[12px]">
        <Label>Workflow</Label>
        <code className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted">{workflowId}</code>
        {temporalUrl ? (
          <a
            href={temporalUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-brand hover:underline"
          >
            Ver en Temporal <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="ml-auto text-[11px] text-faint">Temporal UI no configurada</span>
        )}
      </Card>

      {/* Spec 0194: what this run actually cost. One line, read from
          `agent_sessions` — the rows that make "does the initializer/coder split
          earn its keep" a query instead of an argument. Absent for a run that
          predates the table, which is most of them. */}
      {sessions.length > 0 ? (
        <Card className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 p-3 text-[11px] text-muted">
          <Label>Sesiones</Label>
          {sessions.map((r) => (
            <span key={r.role}>
              <span className="text-foreground">{r.role}</span> ×{r.sessions} ·{" "}
              {Math.round(r.seconds / 60)} min · {r.turns} turnos
            </span>
          ))}
          <span className="ml-auto text-faint">
            {tokensTotal.toLocaleString("es-MX")} tokens
          </span>
        </Card>
      ) : null}

      {/* The gates progress — four steps for Track 2, two for Track 1 (0124). */}
      <Card className="mb-4 p-4">
        <div className="mb-4 flex items-center">
          {progress.steps.map((label, i) => {
            const n = i + 1;
            const done = n < progress.activeStep;
            const current = n === progress.activeStep;
            return (
              <div key={label} className="flex flex-1 items-center last:flex-none">
                <div className="flex flex-col items-center gap-1">
                  <span
                    className={`grid h-6 w-6 place-items-center rounded-full border text-[11px] ${
                      done
                        ? "border-brand bg-brand/20 text-brand"
                        : current
                          ? "border-brand text-brand"
                          : "border-border text-faint"
                    }`}
                  >
                    {n}
                  </span>
                  <span className={`text-[11px] ${current ? "text-foreground" : "text-faint"}`}>
                    {label}
                  </span>
                </div>
                {n < progress.steps.length ? (
                  <span
                    className={`mx-2 h-px flex-1 ${done ? "bg-brand/50" : "bg-border"}`}
                    aria-hidden="true"
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto text-[12px] text-muted">{phaseText}</span>

          {/* Start — a fresh run. */}
          {progress.showStart ? (
            <form
              action={startSpecRunAction.bind(
                null,
                project.id,
                slug,
                found.filename,
                spec.id,
                spec.title,
              )}
            >
              <button
                type="submit"
                className="rounded-md border border-brand/50 bg-brand/15 px-3 py-1 text-[12px] font-medium text-brand hover:bg-brand/25"
              >
                {view?.state === "failed" ? "Start new run" : "Start"}
              </button>
            </form>
          ) : null}

          {/* Spec 0124: Track-1 work has no run to finish it, so completion is
              a manual step — shown INSTEAD of Start, never alongside. */}
          {progress.showComplete ? (
            <form action={completeProjectSpecAction.bind(null, project.id, slug, spec.id)}>
              <button
                type="submit"
                className="rounded-md border border-border px-3 py-1 text-[12px] text-muted hover:text-foreground"
              >
                Complete
              </button>
            </form>
          ) : null}

          {/* Every open gate action, with the role + CI guards intact. */}
          {actions.map((action) => {
            const roleDenial = action === "promote" ? promoteDenial : null;
            const disabled =
              roleDenial !== null || (action === "promote" && promoteGate?.enabled === false);
            const danger = action === "specRejected";
            return (
              <form
                key={action}
                action={signalGateAction.bind(null, project.id, spec.id, action, slug)}
              >
                <button
                  type="submit"
                  disabled={disabled}
                  title={roleDenial ?? undefined}
                  className={`rounded-md border px-3 py-1 text-[12px] font-medium disabled:opacity-50 ${
                    danger
                      ? "border-rose/40 text-rose hover:bg-rose/10"
                      : "border-brand/50 bg-brand/15 text-brand hover:bg-brand/25"
                  }`}
                >
                  {GATE_ACTION_LABEL[action]}
                </button>
              </form>
            );
          })}

          {/* The PR itself, when the run has one — the review happens there. */}
          {view?.pr && view.pr.number > 0 ? (
            <a
              href={view.pr.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1 text-[12px] text-muted hover:text-foreground"
            >
              PR #{view.pr.number} <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </div>

        {/* The gate-3 CI note (spec 0043 C): pending/failure disables promote
            above and says why; unavailable stays enabled with the caveat. */}
        {promoteGate && promoteGate.tone !== "ok" ? (
          <p className="mt-3 border-t border-border pt-3 text-[11px] text-muted">
            {promoteGate.message}
            {promoteCiLink ? (
              <>
                {" "}
                <a href={promoteCiLink} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                  Ver Actions
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        {/* Spec 0187 A: what staging actually holds, when it is not this head.
            Amber, not a block — 0119's posture stands and the reviewer decides. */}
        {stagingNotice ? (
          <p className="mt-2 text-[11px] text-amber-500">{stagingNotice}</p>
        ) : null}
        {/* Spec 0117: why THIS session may not promote, when that is the reason. */}
        {promoteDenial ? <p className="mt-2 text-[11px] text-faint">{promoteDenial}</p> : null}
        {/* Spec 0147: a Track-1 spec has no run and no gates by design — say so
            rather than leaving a gap where the buttons would be. */}
        {(spec.track ?? 1) === 1 ? (
          <p className="mt-2 text-[11px] text-faint">
            Track 1 — trabajo directo, sin corrida ni gates. Cambia <code>track: 2</code> en el
            frontmatter para pasarla por el pipeline.
          </p>
        ) : null}
      </Card>

      {/* Parked at gate 2: the spec's own `(human)` items — the checks no
          suite can run, which are exactly what the reviewer is being asked
          about (CLAUDE.md verification discipline #1). */}
      {humanPending.length > 0 ? (
        <Card className="mb-4 p-4">
          <Label>Te toca a ti</Label>
          <ul className="mt-2 space-y-1">
            {humanPending.map((item, i) => (
              <li key={i} className="text-[12px] text-muted">
                {item}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="mb-4 p-4">
        <Label>Handoff log</Label>
        {handoffs.length === 0 ? (
          <p className="mt-2 text-[12px] text-faint">Sin handoffs todavía.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {handoffs.map((entry, i) => (
              <li key={i} className="whitespace-pre-wrap break-words text-[12px] text-muted">
                {entry}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <details>
        <summary className="cursor-pointer text-[12px] text-muted hover:text-foreground">
          Spec completo
        </summary>
        <Card className="mt-2 p-4">
          <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted">
            {found.body}
          </pre>
        </Card>
      </details>
    </main>
  );
}
