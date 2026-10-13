"use client";

/**
 * Create a branch, and drive its staging server (spec 0134 F). Client halves
 * of `BranchesPanel`, the `members-form.tsx` shape: errors verbatim from the
 * actions (they are written to be read), refresh via the action's
 * `revalidatePath` — no client-side copy of the rows.
 */
import { useState, useTransition } from "react";
import { Btn, Card } from "../../../components/ui";
import {
  createBranchAction,
  createBranchStagingAction,
  destroyBranchStagingAction,
  promoteBranchAction,
} from "./branch-actions";

const INPUT =
  "w-full rounded-lg border border-border bg-card px-3.5 py-2 text-[13px] text-foreground " +
  "placeholder:text-faint outline-none focus:border-brand/40";

export function CreateBranchForm({ slug }: { slug: string }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create() {
    setError(null);
    startTransition(async () => {
      const res = await createBranchAction(slug, name.trim());
      if (!res.ok) {
        setError(res.problem ?? "No se pudo crear la rama.");
        return;
      }
      setName("");
    });
  }

  return (
    <Card className="space-y-3 p-4">
      <p className="text-[11px] uppercase tracking-widest text-faint">Crear rama</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className={INPUT}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="tester/mi-feature"
          aria-label="Nombre de la rama"
        />
        <Btn
          variant="primary"
          onClick={create}
          className={pending || !name.trim() ? "pointer-events-none opacity-50" : ""}
        >
          {pending ? "…" : "Crear rama"}
        </Btn>
      </div>
      <p className="text-[11px] leading-relaxed text-faint">
        Se crea desde la punta de <code>main</code>. Minúsculas, dígitos y <code>./-_</code>.
      </p>
      {error ? <p className="text-[12px] text-red-500">{error}</p> : null}
    </Card>
  );
}

export function BranchRowActions({
  slug,
  branch,
  status,
  merged = false,
  promoteDenial,
}: {
  slug: string;
  branch: string;
  status: string;
  /** Spec 0187 B: the branch is already on main. Its staging server can still
   * be destroyed — that is the only action left, and the absence of it is what
   * let two promoted branches hold stacks until the box refused a deploy. */
  merged?: boolean;
  /** Spec 0166: why this session may not promote, or null when it may. Computed
   * on the SERVER with the same `capabilityDenial` the action gates on, so the
   * button and the refusal can never disagree. Presentation only —
   * `promoteBranchAction` re-checks on every call. */
  promoteDenial?: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  // Spec 0136: a warn-shaped guard outcome — promotable, but only on an
  // explicit second click. The message IS the confirmation prompt.
  const [warned, setWarned] = useState<string | null>(null);
  // Spec 0195 A: it worked, and here is what did not. Two A/B runs promoted
  // with a bookkeeping step silently failing behind them.
  const [notices, setNotices] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  function drive(op: "create" | "destroy") {
    setError(null);
    setWarned(null);
    startTransition(async () => {
      const res =
        op === "create"
          ? await createBranchStagingAction(slug, branch)
          : await destroyBranchStagingAction(slug, branch);
      if (!res.ok) setError(res.problem ?? "No se pudo.");
    });
  }

  function promote(acceptWarn: boolean) {
    setError(null);
    setNotices([]);
    if (!acceptWarn) setWarned(null);
    startTransition(async () => {
      const res = await promoteBranchAction(slug, branch, { acceptWarn });
      if (res.warned && !res.ok) {
        setWarned(res.warned);
        return;
      }
      setWarned(null);
      if (!res.ok) setError(res.problem ?? "No se pudo promover.");
      setNotices(res.notices ?? []);
    });
  }

  const busy = pending || status === "deploying" || status === "destroying";
  // A merged branch has nothing left to validate: no redeploy, no promote — but
  // its server is still occupying the box until someone removes it.
  if (merged) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        {status === "ready" || status === "failed" ? (
          <Btn
            variant="danger"
            onClick={() => drive("destroy")}
            className={busy ? "pointer-events-none opacity-50" : ""}
          >
            Destruir staging
          </Btn>
        ) : null}
        {error ? <span className="text-[11px] text-red-500">{error}</span> : null}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      {status === "ready" || status === "failed" ? (
        <>
          <Btn
            variant="ghost"
            onClick={() => drive("create")}
            className={busy ? "pointer-events-none opacity-50" : ""}
          >
            {status === "failed" ? "Reintentar staging" : "Redesplegar"}
          </Btn>
          <Btn
            variant="danger"
            onClick={() => drive("destroy")}
            className={busy ? "pointer-events-none opacity-50" : ""}
          >
            Destruir staging
          </Btn>
        </>
      ) : status === "none" ? (
        <Btn
          variant="ghost"
          onClick={() => drive("create")}
          className={busy ? "pointer-events-none opacity-50" : ""}
        >
          Crear staging
        </Btn>
      ) : null}
      {/* Spec 0166: merging a branch to main IS the production change, so it is
          OWNER-only. This surface offered it to any MEMBER — enabled, with the
          server honouring it — until a live check with a MEMBER session caught
          it. Disabled AND titled: a button that fails on click teaches nothing. */}
      <Btn
        variant="primary"
        onClick={() => promote(false)}
        disabled={Boolean(promoteDenial)}
        title={promoteDenial ?? undefined}
        className={busy || promoteDenial ? "pointer-events-none opacity-50" : ""}
      >
        Promote a main
      </Btn>
      {warned ? (
        <span className="flex items-center gap-2 text-[11px] text-amber-500">
          {warned}
          <Btn variant="ghost" onClick={() => promote(true)} className={busy ? "pointer-events-none opacity-50" : ""}>
            Promover igual
          </Btn>
        </span>
      ) : null}
      {error ? <span className="text-[11px] text-red-500">{error}</span> : null}
      {notices.length > 0 ? (
        <span className="basis-full text-[11px] text-amber-500">
          Promovida, pero:{" "}
          {notices.map((n, i) => (
            <span key={n}>
              {i > 0 ? " · " : ""}
              {n}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
