/**
 * The **Versiones** panel (spec 0170).
 *
 * The list answers the question production state used to answer with folklore:
 * what is live, what is newer than it, and what happens if you press the button.
 *
 * The verdict beside the newest candidate is computed on the SERVER by the same
 * `releaseDeployDecision` the action re-runs, so the button and the refusal can
 * never disagree — the pattern spec 0166 established for promote.
 */
import {
  cutPlatformCandidateAction,
  deployReleaseAction,
  listReleasesAction,
  releaseDeployDecision,
} from "../release-actions";
import { CutVersionControl } from "./cut-version-control";
import { PLATFORM_PROJECT_SLUG } from "@/lib/spec-project";
import { capabilityDenial } from "../../../../lib/capabilities";
import { sessionRole } from "../../../auth";
import { DeployControl } from "./deploy-control";

function Row({
  version,
  status,
  sha,
  when,
  who,
  notes,
  live,
}: {
  version: string;
  status: string;
  sha: string;
  when: string;
  who: string;
  notes: string;
  live: boolean;
}) {
  const tone =
    status === "deployed"
      ? "text-brand"
      : status === "failed"
        ? "text-danger"
        : status === "superseded"
          ? "text-faint"
          : "text-foreground";
  return (
    <div className="flex items-baseline gap-4 border-t border-border py-3 first:border-t-0">
      <span className={`w-20 shrink-0 font-mono text-[13px] ${tone}`}>{version}</span>
      <span className="w-28 shrink-0 text-[11px] uppercase tracking-widest text-faint">
        {live ? "en producción" : status}
      </span>
      <span className="w-24 shrink-0 font-mono text-[11px] text-faint">{sha.slice(0, 9)}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{notes || "—"}</span>
      <span className="shrink-0 text-[11px] text-faint">
        {when}
        {who ? ` · ${who}` : ""}
      </span>
    </div>
  );
}

export async function ReleasesPanel({ slug }: { slug: string }) {
  const { releases, live } = await listReleasesAction(slug);
  // Spec 0213 C: the platform has no branch-promote, so nothing cuts its
  // candidates automatically. Without this control its panel is empty forever.
  const isPlatform = slug === PLATFORM_PROJECT_SLUG;

  if (releases.length === 0) {
    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-border bg-card p-6">
          <p className="text-sm text-muted">
            {isPlatform
              ? "Todavía no hay versiones. La plataforma no promueve ramas, así que se cortan aquí."
              : "Todavía no hay versiones. Se crea una automáticamente cada vez que main avanza — promoviendo una rama, por ejemplo."}
          </p>
        </div>
        {isPlatform ? <CutVersionControl slug={slug} action={cutPlatformCandidateAction} /> : null}
      </div>
    );
  }

  // The newest thing cut is what you would ship next; the decision is about it.
  const newest = releases[0]!;
  const decision = await releaseDeployDecision(slug, newest.version);
  const role = await sessionRole();
  const promoteDenial = capabilityDenial(role, "promote");

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="mb-1 text-[11px] uppercase tracking-widest text-faint">En producción</p>
        <p className="font-mono text-[15px]">
          {live ? `${live.version} · ${live.commitSha.slice(0, 9)}` : "nada desplegado todavía"}
        </p>
        {live?.deployedAt ? (
          <p className="mt-1 text-[11px] text-faint">
            desde {new Date(live.deployedAt).toLocaleString("es-MX")}
            {live.deployedBy ? ` · ${live.deployedBy}` : ""}
          </p>
        ) : null}
      </div>

      {isPlatform ? <CutVersionControl slug={slug} action={cutPlatformCandidateAction} /> : null}

      <DeployControl
        slug={slug}
        version={newest.version}
        decision={decision}
        denial={promoteDenial}
        alreadyLive={live?.version === newest.version}
        action={deployReleaseAction}
      />

      <div className="rounded-xl border border-border bg-card px-5 py-2">
        {releases.map((r) => (
          <Row
            key={r.id}
            version={r.version}
            status={r.status}
            sha={r.commitSha}
            when={new Date(r.createdAt).toLocaleDateString("es-MX")}
            who={r.deployedBy || r.createdBy}
            notes={r.notes}
            live={live?.id === r.id}
          />
        ))}
      </div>
    </div>
  );
}
