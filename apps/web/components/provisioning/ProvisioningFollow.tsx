"use client";

/**
 * ProvisioningFollow (spec 0161 F3b) — the progress view `/new` redirects to
 * after starting an odoo-next provisioning run. It polls the membership-gated
 * `GET /api/provisioning/[slug]` (the F3a reader) and renders the five work
 * phases via the pure `deriveProvisioningSteps` / `deriveProvisioningStepperNodes`
 * (lib/provisioning-run.ts) — the same `mc-step`/`mc-node`/`mc-bar` idiom the
 * spec-pipeline `RunFollowCard` uses, plus the one status that stepper lacks:
 * `failed`, rendered red + static (`mc-step-failed`/`mc-node-failed`) so a
 * mid-phase failure reads as THAT phase failed, not a pulsing spinner.
 *
 * The derivation is imported by VALUE (it is framework-free, `import type` only
 * from `@launchpad/pipeline`), so no `@temporalio` value reaches this bundle.
 * Reconnecting loses nothing — the state re-derives from the reader each tick.
 */
import { useEffect, useState } from "react";
import { Card } from "../ui";
import {
  deriveProvisioningSteps,
  deriveProvisioningStepperNodes,
} from "../../lib/provisioning-run";
import type { ProvisioningRunState } from "../../lib/provisioning-follow";
import { usePrefersReducedMotion } from "../../lib/use-prefers-reduced-motion";

/** ~5s poll cadence — the `RunFollowCard` cadence; a durable-ish state re-read,
 * not a held stream, so a refresh/reconnect is free. */
const POLL_MS = 5000;

export function ProvisioningFollow({ slug }: { slug: string }) {
  const [state, setState] = useState<ProvisioningRunState | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    let cancelled = false;

    // `first` runs even in a hidden tab. Skipping the MOUNT poll leaves a
    // background tab with no data at all — which is exactly what a person gets
    // when they submit `/new` and switch tabs during a twenty-minute
    // provisioning. Only the repeating poll respects visibility, which is what
    // the skip was for.
    async function poll(first = false) {
      if (document.hidden && !first) return;
      try {
        const res = await fetch(`/api/provisioning/${slug}`);
        if (!res.ok) throw new Error(`request failed (${res.status})`);
        const data = (await res.json()) as ProvisioningRunState;
        if (!cancelled) {
          setState(data);
          setFetchError(null);
        }
      } catch (err) {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : String(err));
      }
    }

    void poll(true);
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
  }, [slug]);

  // A `null` phase (not started / Temporal unreachable) derives to all-upcoming
  // — the run-follow posture: render the five phases pending, never an error.
  const steps = deriveProvisioningStepperNodes(
    deriveProvisioningSteps(state?.phase ?? undefined, state?.failedPhase),
  );
  const failed = state?.phase === "failed";
  const done = state?.phase === "completed";

  return (
    <Card className="max-w-md p-4">
      <h3 className="text-sm font-semibold leading-none text-foreground">
        Aprovisionando {slug}
      </h3>
      <p className="mt-1 text-[13px] text-muted">
        {done
          ? "Listo — las cinco fases terminaron."
          : failed
            ? "Una fase falló."
            : "En progreso — no cierres esta pestaña."}
      </p>

      <div className="mt-4 flex items-center overflow-x-auto pb-2">
        {steps.map((s, i) => {
          const cls =
            s.status === "done"
              ? "mc-step mc-step-done"
              : s.status === "current"
                ? "mc-step mc-step-cur"
                : s.status === "failed"
                  ? "mc-step mc-step-failed"
                  : "mc-step";
          const nodeCls =
            s.status === "failed"
              ? "mc-node mc-node-failed"
              : s.status === "current" && !reducedMotion
                ? "mc-node mc-node-pulse"
                : "mc-node";
          const prev = steps[i - 1];
          const barCls =
            s.status === "done"
              ? "mc-bar mc-bar-done"
              : prev?.status === "done"
                ? "mc-bar mc-bar-flow"
                : "mc-bar";
          const glyph = s.status === "done" ? "✓" : s.status === "failed" ? "✕" : i + 1;
          return (
            <div style={{ display: "contents" }} key={s.phase}>
              <div className={cls}>
                <span className={nodeCls}>{glyph}</span>
                <span className="mc-lbl">{s.label}</span>
              </div>
              {i < steps.length - 1 && <span className={barCls} />}
            </div>
          );
        })}
      </div>

      {/* The detail the header used to promise. Shown only when the run really
          failed and Temporal gave us a reason — an empty box under "una fase
          falló" is what this replaces. */}
      {state?.failureMessage && (
        <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3">
          <p className="mb-1 text-[11px] uppercase tracking-widest text-faint">Detalle</p>
          <p className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-foreground/85">
            {state.failureMessage}
          </p>
        </div>
      )}

      {fetchError && (
        <p className="mt-2 rounded-lg border border-rose/40 bg-rose/10 px-3 py-2 text-[13px] text-rose">
          {fetchError}
        </p>
      )}
    </Card>
  );
}
