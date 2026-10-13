"use client";

/**
 * The ship button (spec 0170).
 *
 * Three things it must not do, each one a lesson already paid for:
 *
 * - **Never fail on click without saying why** (spec 0166): a blocked deploy or a
 *   missing capability disables the button AND states the reason next to it.
 * - **Never ship an older version on one click.** That is the `danger` tone, and
 *   it needs a second, explicit confirmation — the message says plainly that it
 *   does not undo anything.
 * - **Never call any of this a rollback.** Odoo migrations are one-way; the word
 *   would promise an undo that does not exist.
 */
import { useState, useTransition } from "react";

interface Decision {
  blocked: boolean;
  tone: "ok" | "warn" | "danger";
  message: string;
}

export function DeployControl({
  slug,
  version,
  decision,
  denial,
  alreadyLive,
  action,
}: {
  slug: string;
  version: string;
  decision: Decision;
  denial: string | null;
  alreadyLive: boolean;
  action: (slug: string, version: string, opts?: { acceptWarn?: boolean }) => Promise<{ ok: boolean; problem?: string }>;
}) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const disabled = decision.blocked || denial !== null || pending;
  const border =
    decision.tone === "danger"
      ? "border-danger/40"
      : decision.tone === "warn"
        ? "border-amber/40"
        : "border-border";

  function run(acceptWarn: boolean) {
    setProblem(null);
    start(async () => {
      const res = await action(slug, version, acceptWarn ? { acceptWarn: true } : {});
      if (!res.ok) setProblem(res.problem ?? "No se pudo desplegar.");
      setConfirming(false);
    });
  }

  return (
    <div className={`rounded-xl border ${border} bg-card p-5`}>
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="mb-1 text-[11px] uppercase tracking-widest text-faint">
            {alreadyLive ? "Última versión" : "Siguiente a desplegar"}
          </p>
          <p className="font-mono text-[15px]">{version}</p>
          <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-muted">{decision.message}</p>
          {denial ? <p className="mt-2 text-[12px] text-faint">{denial}</p> : null}
          {problem ? <p className="mt-2 text-[12px] text-danger">{problem}</p> : null}
        </div>

        <div className="shrink-0">
          {confirming ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-lg border border-border px-3 py-2 text-[13px] text-muted"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => run(true)}
                className="rounded-lg bg-danger px-3.5 py-2 text-[13px] text-white disabled:opacity-50"
              >
                {pending ? "Desplegando…" : "Sí, desplegar de todos modos"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={disabled}
              title={denial ?? (decision.blocked ? decision.message : undefined)}
              onClick={() => (decision.tone === "danger" ? setConfirming(true) : run(false))}
              className="rounded-lg bg-brand px-3.5 py-2 text-[13px] text-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? "Desplegando…" : `Desplegar ${version} a producción`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
