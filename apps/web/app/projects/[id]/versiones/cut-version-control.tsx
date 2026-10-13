"use client";

/**
 * "Cortar versión" for the platform project (spec 0213 C).
 *
 * Only the platform needs it. Every other project cuts its candidate
 * automatically at branch-promote; the platform runs the per-spec model and
 * never promotes a branch, so without this its Versiones panel stays empty
 * forever and nothing can be deployed.
 *
 * Same shape as DeployControl on purpose — never fail on click without saying
 * why (spec 0166).
 */
import { useState, useTransition } from "react";

export function CutVersionControl({
  slug,
  action,
}: {
  slug: string;
  action: (slug: string) => Promise<{ ok: boolean; problem?: string }>;
}) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="mb-1 text-[11px] uppercase tracking-widest text-faint">Cortar versión</p>
          <p className="max-w-2xl text-[12px] leading-relaxed text-muted">
            Toma el commit actual de <span className="font-mono">origin/main</span> y le asigna el
            siguiente número. Cortar no despliega nada.
          </p>
          {problem ? <p className="mt-2 text-[12px] text-danger">{problem}</p> : null}
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setProblem(null);
            start(async () => {
              const res = await action(slug);
              if (!res.ok) setProblem(res.problem ?? "No se pudo cortar la versión.");
            });
          }}
          className="shrink-0 rounded-lg border border-border bg-surface px-4 py-2 text-[12px] hover:border-brand disabled:opacity-50"
        >
          {pending ? "Cortando…" : "Cortar versión"}
        </button>
      </div>
    </div>
  );
}
