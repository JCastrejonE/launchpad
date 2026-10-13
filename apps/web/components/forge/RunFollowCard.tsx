"use client";

/**
 * RunFollowCard (spec 0052 / ADR-022 §6, item E) — the interactive run-follow
 * component the supervisor console renders when a `{type:"watch_run",specId}`
 * event arrives (the agent's third marker only CAUSES this card to render; it
 * spawns/signals nothing). The human's Follow-button click here is the only
 * thing that spawns the follow-only watcher, exactly as a gate-button click is
 * the only thing that signals a gate — this component never fetches POST
 * `/api/supervisor/run/<specId>` except inside `handleFollow`, which only ever
 * runs from the Follow button's `onClick`.
 *
 * Renders (all derived via the pure `lib/run-follow-card.ts`, unit-tested
 * there since this repo's test harness has no DOM/React renderer):
 *  - a STEPPER over the lifecycle phases (`deriveStepperNodes` over the GET
 *    route's `steps`; the current step animated per emil-design-eng, honoring
 *    `usePrefersReducedMotion`);
 *  - a current-activity line (`deriveCurrentActivityLine` — running activity
 *    names, or the parked gate; the NAMED CUT if the loop strains, see spec
 *    0052 Plan) and plan progress (checked/total) during `coding`
 *    (`shouldShowPlanProgress`);
 *  - a gate cue card when parked at a gate (`deriveGateCueModel`): the
 *    EXISTING `GateActionButtons` wired to the EXISTING `signalGateAction`
 *    (nothing new fires a signal — the filename it needs comes from the
 *    EXISTING `resolveSupervisorGateCard` server action, the same lookup the
 *    console's own gate card already uses), plus the PR link + the watcher's
 *    latest gate-2 mechanical-review note;
 *  - a context row (`deriveRunContextLinks`, spec 0059 phase 4d — "Hangar
 *    deep-links") rendered above the stepper: a Spec link
 *    (`/forge/specs/<specId>`, always), the PR link (deduped against the
 *    gate-cue's own PR link — shown only once past a gate park), and EXACTLY
 *    ONE Hangar link — the tenant host card (`/#vps-<vpsId>`) for a tenant
 *    run, or the app root ("Open Hangar") for a self/code run. Links only:
 *    every href is a plain anchor the human clicks, never an automatic
 *    navigation, and rendering the row sends nothing;
 *  - a watcher chip (`deriveWatcherChip`: not following / following · pid /
 *    exited) with a Start run/Follow/Re-attach footer button
 *    (`derivePrimaryAction`, spec 0056 phase 4c) that POSTs the spawn
 *    (disabled while already following) — `handleStart` is the SOLE call
 *    site of the `{mode:"start"}` POST, exactly as `handleFollow` is the sole
 *    call site of the bodiless follow POST; rendering the card, even with
 *    `canStart` true, sends nothing — and exception/polish/close-out/done
 *    cards from the events tail (`deriveOutcomeCards`);
 *  - an exception card additionally renders the deterministic PLAYBOOK
 *    (`deriveExceptionGuidance`: title/meaning/ordered steps) plus a
 *    **Diagnose in console** button (spec 0054 phase 4a) — rendered only when
 *    the optional `onDiagnose` prop is present, disabled while the console is
 *    `busy`. Its onClick is the SOLE call site of `onDiagnose(
 *    buildDiagnosisPrompt(...))` — the card itself sends nothing; only the
 *    human's click hands the composed prompt into the EXISTING console
 *    session as a visible user turn;
 *  - a Recover remediation strip (`deriveRecoverOffer`, spec 0057 phase 4b)
 *    whenever no watcher is running and the run needs the ADR-023 reconnect
 *    (a recoverable exception, a silently-died watcher, or Temporal itself
 *    unreachable) — `handleRecover` is the SOLE `{mode:"recover"}` POST call
 *    site, and a "Recovering…" pill (`state.recovering`) shows beside the
 *    watcher chip while it runs; and the polish outcome card upgrades to a
 *    real card with a **Resume (polished)** button (`deriveResumePolishedOffer`)
 *    once the hands-on polish work is done — `handleResumePolished` is the
 *    SOLE `{mode:"resume-polished"}` POST call site. Both derivations are
 *    PURE (no fetch, no spawn): rendering either offer, even both true,
 *    sends nothing — only the human's click POSTs.
 *
 * Polls `GET /api/supervisor/run/<specId>` (~5s) while mounted, pausing when
 * `document.hidden` (and catching up immediately on becoming visible again).
 * Reconnecting loses nothing — state re-derives from Temporal + the events
 * file, never a held stream (ADR-023).
 *
 * Impeccable + apps/web/DESIGN.md; both themes. Spec-0020 gate applies (apps/web
 * UI changed): `next build` + `detect.mjs --json apps/web` clean +
 * `scripts/web-smoke.sh` green (with `SUPERVISOR_CONSOLE_ENABLED`), recorded in
 * the Handoff log before promote.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
// Spec 0101: shadcn Card/Button retired in favour of the template's primitives.
import { Card, Btn } from "../ui";
import { GateActionButtons } from "../chat/GateActionButtons";
import { resolveSupervisorGateCard, type SupervisorGateCard } from "../../app/forge/actions";
import {
  buildDiagnosisPrompt,
  deriveCurrentActivityLine,
  deriveExceptionGuidance,
  deriveGateCueModel,
  deriveOutcomeCards,
  derivePrimaryAction,
  deriveRecoverOffer,
  deriveResumePolishedOffer,
  deriveStepperNodes,
  deriveWatcherChip,
  shouldShowPlanProgress,
  RECOVER_OFFER_COPY,
} from "../../lib/run-follow-card";
import { deriveRunContextLinks } from "../../lib/run-links";
import type { RunFollowState } from "../../lib/supervisor-run";
import { usePrefersReducedMotion } from "../../lib/use-prefers-reduced-motion";

export interface RunFollowCardProps {
  specId: string;
  /**
   * The project whose run this is (spec 0224). `null` only on the platform
   * console. Without it the server resolves `0001` to the platform's own spec:
   * a MEMBER is refused from their own run, an OWNER sees the wrong one.
   */
  projectSlug?: string | null;
  /** Composes and sends the Diagnose-in-console prompt into the EXISTING
   * console session (spec 0054 phase 4a) — the caller is `SupervisorConsole`'s
   * `sendPrompt`, the SAME function the composer submit uses. Omitted, the
   * exception card renders its playbook with no Diagnose button (e.g. any
   * future standalone use of this component). */
  onDiagnose?: (prompt: string) => void;
  /** Disables the Diagnose button while a console turn is in flight — passed
   * through from `SupervisorConsole`'s `busy` state, the same guard the
   * composer's own Send control uses. */
  busy?: boolean;
}

/** ~5s poll cadence (spec 0052 D/E) — a durable-ish state re-read, not a held
 * stream, so a refresh/reconnect is free. */
const POLL_MS = 5000;

// Spec 0101: shared class strings for this card, so the same restyled idiom is
// stated once instead of repeated at a dozen call sites. `SECTION` reproduces the
// old `.bd` + inline border-top; `HINT` the old `.hint`; `ALERT` the old `.alert`.
const SECTION = "border-t border-border px-0 pt-4 text-left";
const HINT = "text-xs whitespace-pre-wrap text-faint";
const ALERT = "rounded-lg border border-rose/40 bg-rose/10 px-3 py-2 text-[13px] text-rose";
const KV = "flex justify-between gap-3 border-b border-dashed border-border py-2 text-[13px] last:border-b-0";
const K = "text-faint";
const V = "tabular-nums text-foreground";
const PENDING_SKELETON = "mc-skeleton block h-[13px] w-28";
const SM_BTN = "h-8 px-3 text-xs disabled:pointer-events-none disabled:opacity-50";
const CHIP = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-[11px]";
const CHIP_NEUTRAL = `${CHIP} border-border bg-surface text-faint`;
const CHIP_WARN = `${CHIP} border-amber/40 bg-amber/10 text-amber`;

/** The card's title row — the shadcn CardHeader/CardTitle pair collapsed into the
 * template's single-div Card shape (spec 0101). */
function CardHead({ specId }: { specId: string }) {
  return (
    <div className="flex flex-col gap-1 p-4">
      <h3 className="text-sm font-semibold leading-none text-foreground">Follow run: spec {specId}</h3>
    </div>
  );
}

export function RunFollowCard({ specId, projectSlug, onDiagnose, busy }: RunFollowCardProps) {
  // Spec 0224: one place builds the URL, so the poll and the POST cannot drift.
  const runUrl = `/api/supervisor/run/${specId}${projectSlug ? `?project=${encodeURIComponent(projectSlug)}` : ""}`;
  const [state, setState] = useState<RunFollowState | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [spawning, setSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [gateCard, setGateCard] = useState<SupervisorGateCard | null | undefined>(undefined);
  const reducedMotion = usePrefersReducedMotion();

  // Poll the GET route while mounted; paused (skipped, not torn down) when
  // the tab is hidden, and caught up immediately on becoming visible again.
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (document.hidden) return;
      try {
        const res = await fetch(runUrl);
        if (!res.ok) throw new Error(`request failed (${res.status})`);
        const data = (await res.json()) as RunFollowState;
        if (!cancelled) {
          setState(data);
          setFetchError(null);
        }
      } catch (err) {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : String(err));
      }
    }

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [runUrl]);

  // Resolve the gate card's filename (for GateActionButtons) only while
  // actually parked at a gate — the EXISTING resolver, read-only, never
  // signals anything itself.
  const gate = state?.view?.gate;
  useEffect(() => {
    if (!gate) {
      setGateCard(undefined);
      return;
    }
    let cancelled = false;
    setGateCard(undefined);
    void resolveSupervisorGateCard(specId).then((card) => {
      if (!cancelled) setGateCard(card);
    });
    return () => {
      cancelled = true;
    };
  }, [specId, gate]);

  /** The ONLY places this component ever POSTs — fired exclusively by a
   * button's onClick below, never automatically. `handleFollow` sends a
   * bodiless (default `follow`-mode) request, byte-identical to phase 3;
   * `handleStart` is the SOLE call site of the `{mode:"start"}` POST (spec
   * 0056 phase 4c); `handleRecover` is the SOLE `{mode:"recover"}` call site
   * and `handleResumePolished` the SOLE `{mode:"resume-polished"}` call site
   * (spec 0057 phase 4b) — every one of these is a human button click, never
   * anything automatic. */
  async function handlePost(body?: { mode: "start" | "recover" | "resume-polished" }) {
    setSpawning(true);
    setSpawnError(null);
    try {
      const res = await fetch(runUrl, {
        method: "POST",
        ...(body
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
          : {}),
      });
      const result = (await res.json()) as { ok: boolean; reason?: string };
      if (!result.ok) setSpawnError(result.reason ?? "spawn refused");
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : String(err));
    } finally {
      setSpawning(false);
    }
  }

  const handleFollow = () => handlePost();
  const handleStart = () => handlePost({ mode: "start" });
  const handleRecover = () => handlePost({ mode: "recover" });
  const handleResumePolished = () => handlePost({ mode: "resume-polished" });

  // spec 0059 phase 4d — derived per poll tick so the context row degrades
  // gracefully: `state`/`state.view` absent (still loading, or Temporal
  // unreachable) still yields the spec link + the self Hangar link, never
  // an error. Links only — rendering this sends nothing.
  const contextLinks = deriveRunContextLinks({
    specId,
    pr: state?.view?.pr,
    gate: state?.view?.gate,
    target: state?.view?.target,
  });
  const contextRow = (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      {contextLinks.map((l) =>
        l.external ? (
          <a key={l.key} href={l.href} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">
            {l.label} ↗
          </a>
        ) : (
          <Link key={l.key} href={l.href} className="text-xs text-brand hover:underline">
            {l.label}
          </Link>
        ),
      )}
    </div>
  );

  if (!state) {
    return (
      <Card className="max-w-md">
        <CardHead specId={specId} />
        <div className="flex flex-col gap-2 px-4 pb-4 text-sm text-muted">
          {contextRow}
          {fetchError ? (
            <p className={ALERT}>{fetchError}</p>
          ) : (
            <p className="m-0" role="status" aria-live="polite">
              <span className="sr-only">Loading run state for spec {specId}…</span>
              <span className={PENDING_SKELETON} aria-hidden="true" />
            </p>
          )}
        </div>
      </Card>
    );
  }

  const chip = deriveWatcherChip(state.watcher, state.events);
  const primaryAction = derivePrimaryAction(state.view ?? null, state.watcher, state.events);
  const steps = deriveStepperNodes(state.steps);
  const activityLine = deriveCurrentActivityLine(state.view?.currentActivities, state.view?.gate);
  const showPlan = shouldShowPlanProgress(state.view?.phase, state.view?.planProgress);
  const gateCue = deriveGateCueModel(
    { gate: state.view?.gate, availableActions: state.view?.availableActions ?? [], pr: state.view?.pr },
    state.events,
  );
  const outcomeCards = deriveOutcomeCards(state.events);
  const recoverView = state.view ? { gate: state.view.gate, phase: state.view.phase } : null;
  const recoverOffer = deriveRecoverOffer(recoverView, state.watcher, state.events, state.recovering);
  const resumePolishedOffer = deriveResumePolishedOffer(
    state.view ? { gate: state.view.gate } : null,
    state.watcher,
    state.events,
    state.recovering,
  );

  return (
    <Card className="max-w-md">
      <CardHead specId={specId} />
      <div className="flex flex-col gap-2 px-4 pb-4 text-sm text-muted">
        {contextRow}
        {fetchError && <p className={ALERT}>{fetchError}</p>}

        {steps.length > 0 && (
          <div className="flex items-center overflow-x-auto pb-4">
            {steps.map((s, i) => {
              const cls =
                s.status === "done"
                  ? "mc-step mc-step-done"
                  : s.status === "current"
                    ? "mc-step mc-step-cur"
                    : "mc-step";
              const nodeCls =
                s.status === "current" && !reducedMotion ? "mc-node mc-node-pulse" : "mc-node";
              const prev = steps[i - 1];
              const barCls =
                s.status === "done"
                  ? "mc-bar mc-bar-done"
                  : prev?.status === "done"
                    ? "mc-bar mc-bar-flow"
                    : "mc-bar";
              return (
                <div style={{ display: "contents" }} key={s.phase}>
                  <div className={cls}>
                    <span className={nodeCls}>{s.status === "done" ? "✓" : i + 1}</span>
                    <span className="mc-lbl">{s.label}</span>
                  </div>
                  {i < steps.length - 1 && <span className={barCls} />}
                </div>
              );
            })}
          </div>
        )}

        {activityLine && (
          <div className={KV}>
            <span className={K}>Activity</span>
            <span className={V}>{activityLine}</span>
          </div>
        )}

        {showPlan && state.view?.planProgress && (
          <div className={KV}>
            <span className={K}>Plan progress</span>
            <span className={V}>
              {state.view.planProgress.checked}/{state.view.planProgress.total}
            </span>
          </div>
        )}

        {gateCue && (
          <div className={SECTION}>
            {gateCue.pr && gateCue.pr.number > 0 && (
              <div className={KV}>
                <span className={K}>Pull request</span>
                <span className={V}>
                  <a href={gateCue.pr.url} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                    #{gateCue.pr.number} ↗
                  </a>
                </span>
              </div>
            )}
            {gateCue.reviewLines && <p className={`${HINT} mt-0`}>{gateCue.reviewLines.join("\n")}</p>}
            {gateCard === undefined ? (
              <p className="m-0" role="status" aria-live="polite">
                <span className="sr-only">Resolving gate actions for spec {specId}…</span>
                <span className={PENDING_SKELETON} aria-hidden="true" />
              </p>
            ) : gateCard ? (
              <GateActionButtons filename={gateCard.filename} specId={specId} actions={gateCue.actions} />
            ) : (
              <p className={HINT}>No gate action available right now.</p>
            )}
          </div>
        )}

        {outcomeCards.map((c, i) => {
          if (c.kind === "polish") {
            // spec 0057 phase 4b: the polish outcome card upgrades from a
            // bare <p> to a real card carrying the Resume (polished) button
            // whenever `deriveResumePolishedOffer` is true (still parked at
            // gate 3, no watcher running, not recovering).
            return (
              <div key={`${c.kind}-${c.ts}-${i}`} className={SECTION}>
                <p className={`${HINT} mt-0`}>
                  {c.ts} — {c.message}
                </p>
                {resumePolishedOffer && (
                  <Btn variant="primary" className={SM_BTN} disabled={spawning} onClick={() => void handleResumePolished()}>
                    {spawning ? "Resuming…" : "Resume (polished)"}
                  </Btn>
                )}
              </div>
            );
          }
          if (c.kind !== "exception") {
            return (
              <p key={`${c.kind}-${c.ts}-${i}`} className={`${HINT} text-left`}>
                {c.kind}: {c.message}
              </p>
            );
          }
          const guidance = deriveExceptionGuidance(c);
          return (
            <div key={`${c.kind}-${c.ts}-${i}`} className={SECTION}>
              <p className={`${ALERT} mt-0`}>
                {guidance.title} (exit {c.code})
              </p>
              <p className={HINT}>{guidance.meaning}</p>
              <ol className="mt-0 mb-3 list-decimal pl-5 text-[13px] text-muted">
                {guidance.steps.map((step, si) => (
                  <li key={si} className="mb-1">
                    {step}
                  </li>
                ))}
              </ol>
              <p className={HINT}>
                {c.ts} — verbatim: {c.message}
              </p>
              {onDiagnose && (
                <Btn
                  className={SM_BTN}
                  disabled={!!busy}
                  onClick={() =>
                    onDiagnose(
                      buildDiagnosisPrompt({
                        specId,
                        code: c.code ?? -1,
                        msg: c.message,
                        phase: state.view?.phase,
                      }),
                    )
                  }
                >
                  Diagnose in console
                </Btn>
              )}
            </div>
          );
        })}

        {recoverOffer && (
          // spec 0057 phase 4b: one render site for all three Recover
          // reasons — when the reason is exception-recoverable, this sits
          // directly under the exception card above (the outcomeCards.map
          // just rendered its playbook), automating that card's "run
          // --recover" step into a click.
          <div className={SECTION}>
            <p className={`${HINT} mt-0`}>{RECOVER_OFFER_COPY[recoverOffer]}</p>
            <Btn className={SM_BTN} disabled={spawning} onClick={() => void handleRecover()}>
              {spawning ? "Recovering…" : "Recover"}
            </Btn>
          </div>
        )}
      </div>
      <div className="flex flex-col items-start gap-2 px-4 pb-4">
        <div className="flex items-center gap-2">
          <span className={CHIP_NEUTRAL}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
            {chip.label}
          </span>
          {state.recovering && (
            // spec 0057 phase 4b §5/§7 — existing pill primitives only (`.pill
            // .live` already carries the reduced-motion-respecting dot
            // animation via the blanket `prefers-reduced-motion` backstop; no
            // new animation is introduced here).
            <span className={CHIP_WARN}>
              <span className="mc-live-dot h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
              Recovering…
            </span>
          )}
          <Btn
            variant={chip.state === "following" ? "default" : "primary"}
            className={SM_BTN}
            disabled={spawning || chip.state === "following"}
            onClick={() => void (primaryAction === "start" ? handleStart() : handleFollow())}
          >
            {spawning
              ? "Starting…"
              : primaryAction === "start"
                ? "Start run"
                : primaryAction === "reattach"
                  ? "Re-attach"
                  : "Follow"}
          </Btn>
        </div>
        {spawnError && <p className={ALERT}>{spawnError}</p>}
      </div>
    </Card>
  );
}
