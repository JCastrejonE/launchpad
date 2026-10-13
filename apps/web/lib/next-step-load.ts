/**
 * Server-side assembly for the DERIVED "Siguiente paso" (spec 0107): load the
 * run projection + open gate actions and join them to a project's spec list,
 * feeding each spec through the pure `deriveNextStep`.
 *
 * Lifted out of the project-workspace route in item 3 once a SECOND caller
 * appeared — the Launchpad home's cross-project "what needs a human" card. This
 * reads `specs/` off disk (`node:fs` via lib/specs.ts) and queries Temporal, so
 * it is SERVER-ONLY and must never be value-imported by a client component
 * (unlike the pure, client-safe lib/next-step.ts it builds on).
 */
import "server-only";
import { listAgentRuns, listUnresolvedPendingQuestions } from "@launchpad/db";
import { getDb } from "./db";
import { toAgentRunViews, type AgentRunView } from "./agent-run-view";
import { reconcileAgentRuns } from "./agent-runs-reconcile";
import {
  getPipelineViewStateSafe,
  specIdFromWorkflowId,
  mergeIsTheGate,
  suppressDuplicateApprove,
  getPromoteCiState,
  decidePromoteGate,
  type GateSignal,
} from "./pipeline";
import type { PipelineViewState } from "./pipeline";
import { parseHumanPendingItems, parseHandoffLog, parseHandoffEntry, readSpecFile, type SpecSummary } from "./specs";
import { deriveNextStep, type NextStepRow } from "./next-step";
import { deriveGate3Evidence, type Gate3Evidence } from "./gate3-evidence";
import { deriveStagingView, type StagingView } from "./staging-view";
import { deriveRunRecap, type RunRecap } from "./run-recap";
import { getTenantRestorePointsSafe } from "./fleet";
import { pendingQuestionThreadIds } from "./run-registry";

/** A run projection row plus its recovered `specId` and the gate action(s) open
 * for it right now — the shape both the Agentes tab and the Siguiente-paso join
 * consume. */
export type RunWithGate = AgentRunView & {
  specId: string;
  gateActions: GateSignal[];
  /** Spec 0111: gate-3 evidence, present ONLY when a promote gate is actually
   * open on this run — the panel has nothing to say otherwise. */
  gate3?: Gate3Evidence;
  /** Spec 0119: the run's staging environment, already reduced to what the panel
   * renders. Absent when there is nothing honest to show — a dogfood run, a run
   * short of gate 2, or a run predating the query handler. */
  staging?: StagingView;
  /** Spec 0207: the run projection says it is parked on a human, and Temporal
   * could not tell us which actions are open. True only for that combination.
   * The card says so rather than rendering as a run that needs nothing — the
   * silence that hid the missing-slug bug for the life of the project model. */
  gateUnreadable?: boolean;
};

/** Spec 0088 (Phase D): the run projection the pipeline writes. Empty on a DB
 * failure — an empty list is honest, a crashed page is not. */
export async function loadRuns(projectId: string): Promise<AgentRunView[]> {
  try {
    const db = getDb();
    // Spec 0092: reconcile any row still claiming to be live whose workflow has
    // actually closed — a TERMINATED workflow runs no code, so it never wrote
    // its own terminal row.
    const rows = await reconcileAgentRuns(db, await listAgentRuns(db, projectId));
    return toAgentRunViews(rows);
  } catch {
    return [];
  }
}

/** Spec 0095: which gate action(s), if any, are open right now for each run —
 * the same `getPipelineViewStateSafe` + `suppressDuplicateApprove` expression
 * the spec detail page uses, so no surface disagrees about what's on offer.
 * `specId` is recovered from the row's `workflowId` — its LAST segment (spec
 * 0156). Degrades to no actions, not a crash, when Temporal can't be reached.
 *
 * `projectSlug` is REQUIRED, not optional (spec 0207). It was the fifth,
 * optional parameter of `getPipelineViewStateSafe` and this call site never
 * passed it, so every project run looked up `spec-<id>` instead of
 * `spec-<slug>-<id>`, found nothing, and rendered with no gate button at all —
 * a run parked on a human that looked like a run parked on nothing. Required
 * here so a third caller cannot repeat it silently (VERIFICATION #12). */
export async function withGateActions(
  runs: AgentRunView[],
  projectSlug: string,
): Promise<RunWithGate[]> {
  return Promise.all(
    runs.map(async (run) => {
      // Spec 0156: the LAST segment, not what follows the prefix — stripping
      // `spec-` yields `<slug>-<id>` for every project run, which shipped as a
      // dead "Ver spec" link and a gate button that signalled a workflow id
      // that does not exist.
      const specId = specIdFromWorkflowId(run.workflow);
      // Spec 0207: the slug is what rebuilds `spec-<slug>-<id>`. Without it the
      // lookup asks for a workflow that does not exist and `…Safe` turns the
      // miss into `null`, which reads identically to "no gate is open".
      const view = await getPipelineViewStateSafe(specId, "", undefined, undefined, projectSlug);
      // Spec 0142: a BRANCH run's gate 2 is the in-app signal — it never polls
      // the PR — so the approve button must not be suppressed for it, or the
      // run waits at `awaiting_pr_approval` with no way to advance.
      const gateActions = view
        ? suppressDuplicateApprove(view.availableActions, view.pr, run.branch || undefined)
        : [];
      // Spec 0225 D: when the approve above was suppressed because GitHub is
      // gate 2, offer the act that DOES satisfy it. Same predicate, so the two
      // cannot disagree — hiding one without offering the other is what parked
      // every platform run until someone opened GitHub.
      const canMergeGatePr =
        !!view &&
        view.availableActions.includes("prApproved") &&
        mergeIsTheGate(view.pr, run.branch || undefined);
      // Spec 0119: reduced from THIS view, so no extra Temporal round trip. It
      // is not conditioned on a gate being open — the environment is worth
      // seeing while the run is still coding, and `deriveStagingView` returns
      // null whenever there is nothing real to show.
      const staging = deriveStagingView(view?.staging);
      return {
        ...run,
        specId,
        gateActions,
        ...(canMergeGatePr ? { canMergeGatePr: true as const } : {}),
        // Spec 0207: only when the row says a human is holding it AND the view
        // is unreadable. A finished run with no view is not a problem.
        ...(view === null && run.status === "waiting-approval" ? { gateUnreadable: true } : {}),
        ...(staging ? { staging } : {}),
        // Spec 0111: only build the evidence when promote is genuinely on offer.
        // It reuses THIS view (no second Temporal round trip) and, for a tenant
        // target, costs at most one SSH call at the one moment the answer matters.
        ...(gateActions.includes("promote") && view
          ? { gate3: await buildGate3Evidence(specId, view) }
          : {}),
      };
    }),
  );
}

/**
 * Spec 0107: the DERIVED "Siguiente paso" per spec — computed on read from state
 * already true (no stored `next_step`, SPEC §8). Joins the given specs to the
 * run projection + gate actions and each spec's pending `(human)` items, then
 * feeds the result through the pure `deriveNextStep`. Actionable rows float
 * above the done ("Nothing to do") ones so a cold open shows what needs a human
 * first.
 *
 * Takes the already-filtered `specs` (the caller runs `specsForProject`) rather
 * than a slug, so the Launchpad home can read `listSpecs()` ONCE and reuse it
 * across every project instead of once per project.
 *
 * No watcher events exist in this projection context (only `listAgentRuns` +
 * `getPipelineViewStateSafe`), so a specific `deriveRecoverOffer` reason isn't
 * derivable here; a reconciled `failed` run maps to the default
 * `watcher-died-silently` recover copy — the least-specific of the three, and
 * the closest to "the run stopped, recover to restore" (spec 0107 handoff).
 *
 * Degrades to `[]` on failure — an empty card is honest, a crashed page is not.
 */
export async function loadNextSteps(
  specs: SpecSummary[],
  runs: RunWithGate[],
): Promise<NextStepRow[]> {
  try {
    // Newest run per spec: listAgentRuns is startedAt-desc, so the first match wins.
    const runBySpec = new Map<string, RunWithGate>();
    for (const run of runs) if (!runBySpec.has(run.specId)) runBySpec.set(run.specId, run);

    const rows = await Promise.all(
      specs.map(async (spec): Promise<NextStepRow> => {
        const run = runBySpec.get(spec.id);
        let humanPending: string[] = [];
        try {
          humanPending = parseHumanPendingItems(await readSpecFile(spec.filename));
        } catch {
          // Unreadable spec file — treat as no human items rather than crash.
        }
        const step = deriveNextStep({
          status: spec.status,
          hasRun: run !== undefined,
          gateActions: run?.gateActions ?? [],
          recoverOffer: run?.status === "failed" ? "watcher-died-silently" : null,
          humanPending,
          // Spec 0109: without this, `Start run` was offered on hand-authored
          // Track-1 specs that are already merged (0104, 0106 were both showing it).
          track: spec.track,
        });
        return { specId: spec.id, filename: spec.filename, title: spec.title, step };
      }),
    );

    return rows.sort((a, b) => {
      const aDone = a.step.kind === "none" ? 1 : 0;
      const bDone = b.step.kind === "none" ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone; // actionable first
      return b.specId.localeCompare(a.specId); // then newest spec first
    });
  } catch {
    return [];
  }
}


/**
 * Assemble {@link Gate3Evidence} for a run parked at promote (spec 0111).
 *
 * Thin IO around the pure `deriveGate3Evidence`: it resolves the two things the
 * pure function cannot (the PR's CI verdict, and a tenant's restore points) and
 * hands them over. Every failure degrades to a missing input rather than throwing —
 * `deriveGate3Evidence` states "no CI signal" / "could not be read" honestly, which
 * is strictly better than a 500 on the gate you are trying to read.
 */
async function buildGate3Evidence(
  specId: string,
  view: PipelineViewState,
): Promise<Gate3Evidence> {
  const promoteGate = view.pr
    ? decidePromoteGate(await getPromoteCiState(view.pr, specId))
    : null;
  const restorePoints =
    view.target?.kind === "tenant"
      ? await getTenantRestorePointsSafe(view.target.tenantId, view.target.vpsId)
      : undefined;
  return deriveGate3Evidence({
    promoteGate,
    ...(view.target ? { target: view.target } : {}),
    ...(restorePoints ? { restorePoints } : {}),
  });
}


/**
 * Spec 0220: this project's ACTIONABLE pending question — an unresolved
 * `pending_questions` row whose thread is still live in THIS process's map.
 *
 * Both halves are required, and for the reason `/api/pending-questions` states:
 * the row survives a restart the run does not, so an unresolved row on its own
 * is exactly the stale "requiere tu atención" line spec 0122 deleted. Only the
 * summary crosses over — `deriveNextStep` is pure and needs nothing else.
 *
 * Null on any failure, like every other loader here: a missing line is honest,
 * a crashed panel is not.
 */
export async function loadPendingQuestion(projectId: string): Promise<{ summary: string } | null> {
  try {
    // The cheap half of the intersection, and empty almost always: no live
    // question means no query at all on a server-rendered panel.
    const live = new Set(pendingQuestionThreadIds());
    if (live.size === 0) return null;
    const rows = await listUnresolvedPendingQuestions(getDb());
    const row = rows.find((r) => r.projectId === projectId && live.has(r.threadId));
    return row ? { summary: row.summary } : null;
  } catch {
    return null;
  }
}

/**
 * Spec 0112: the recap for the most recently active run's spec — the cold-open
 * "what happened here" answer, assembled from the handoff prose the agents already
 * wrote plus the LIVE next step (never a stale `Next:` line).
 *
 * `runs` arrives newest-first from `loadRuns`, so the head is the most recent
 * activity. Returns `null` when there is no run or its spec is unreadable: an absent
 * card is honest, an invented one is not.
 */
export async function loadLatestRecap(
  runs: RunWithGate[],
  specs: SpecSummary[],
  pendingQuestion: { summary: string } | null,
): Promise<{ specId: string; title: string; recap: RunRecap } | null> {
  const run = runs[0];
  if (!run) return null;
  const spec = specs.find((s) => s.id === run.specId);
  if (!spec) return null;
  try {
    const md = await readSpecFile(spec.filename);
    // Document order — `deriveRunRecap` sorts by the entry date, because neither
    // document order nor its reverse is chronological (see sortNewestFirst).
    const entries = parseHandoffLog(md).map(parseHandoffEntry);
    const nextStep = deriveNextStep({
      status: spec.status,
      hasRun: true,
      gateActions: run.gateActions,
      recoverOffer: run.status === "failed" ? "watcher-died-silently" : null,
      humanPending: parseHumanPendingItems(md),
      // Spec 0220: REQUIRED, not optional — the one live `deriveNextStep` call
      // site, so a future second caller cannot omit it silently (rule #12).
      pendingQuestion,
      ...(spec.track ? { track: spec.track } : {}),
    });
    return { specId: spec.id, title: spec.title, recap: deriveRunRecap({ entries, nextStep }) };
  } catch {
    return null;
  }
}
