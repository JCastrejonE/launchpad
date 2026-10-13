/**
 * The project's Specs tab (spec 0122) — server-rendered, passed into the client
 * workspace as a slot.
 *
 * A slot, like `specsSlot`/`fleetSlot`, because it reads `specs/` off disk with Node
 * `fs`. Server-only also means the archive control can be a plain `<form>` action
 * and the archived section a `<details>` element, so this whole tab needs no client
 * state and no JS to work.
 *
 * Only THIS project's specs: `specsForProject` (spec 0104) maps each spec's
 * `tenant:` frontmatter through the same rule `projectForTarget()` applies to run
 * targets, so specs and runs agree on ownership rather than each guessing.
 */
import Link from "next/link";
import { FileText, ExternalLink, Archive, ArchiveRestore, Play, Activity } from "lucide-react";
import { listSpecs, parseSpecSummary, type SpecSummary } from "@/lib/specs";
import { specsForProject, PLATFORM_PROJECT_SLUG } from "@/lib/spec-project";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { listSpecFilesForProject } from "@launchpad/db";
import { projectSpecsDir } from "@launchpad/pipeline";
import { getDb } from "@/lib/db";
import { Card, Label } from "@/components/ui";
import { setSpecArchivedAction, startSpecRunAction } from "./actions";
import { reconcileSpecStatuses } from "@/lib/spec-reconcile-run";
import { specsDirForProject } from "@/lib/spec-source";
import { listRunningSpecIds } from "@/lib/pipeline";

/**
 * Spec 0129 A: where a project's specs are listed FROM.
 *
 * The platform keeps the directory walk — its specs are committed in this repo and
 * `listSpecs()` reads exactly them. Every other project's specs live in ITS checkout,
 * excluded from its history, so walking our `specs/` would find nothing: the durable
 * record is `spec_files`, and that is what gets listed.
 *
 * `parseSpecSummary` is reused on the stored `body`, so a row and a file produce the
 * SAME summary — title, status and progress all come from one parser rather than a
 * second mapping that could disagree with it.
 */
/** Spec 0145: the body is no longer rendered in the LIST — every spec now has
 * its own page — but it is still parsed here for the summary (title, status,
 * progress), which is what a row shows. */
type SpecWithBody = SpecSummary;

/** Spec 0155: exported so the live-digest route reads specs through the SAME
 * loader this tab renders from — two readers of one directory is how a digest
 * starts disagreeing with the panel it is supposed to be watching. */
export async function loadSpecsForPanel(projectSlug: string, projectId: string): Promise<SpecWithBody[]> {
  if (projectSlug === PLATFORM_PROJECT_SLUG) {
    try {
      return specsForProject(await listSpecs(), projectSlug).sort((a, b) => b.id.localeCompare(a.id));
    } catch {
      // Unreadable specs dir (bad LAUNCHPAD_REPO_ROOT, permissions). An empty list is
      // honest; a crashed tab is not — same posture as the panel this replaces.
      return [];
    }
  }
  // Spec 0141: a project's specs are FILES in its own specs directory (outside
  // the repo) and ROWS in `spec_files`. Read both and merge by name, file
  // winning: the file is the working copy an agent just wrote, the row is the
  // durable record (0129 A). Reading rows alone made a spec the user had
  // watched appear invisible until some later turn mirrored it.
  const byName = new Map<string, SpecWithBody>();
  try {
    for (const row of await listSpecFilesForProject(getDb(), projectId)) {
      byName.set(row.name, parseSpecSummary(row.name, row.body));
    }
  } catch {
    // DB unreachable — the files below are still an honest answer.
  }
  try {
    const dir = projectSpecsDir(projectSlug);
    for (const name of (await readdir(dir)).filter((f: string) => f.endsWith(".md"))) {
      byName.set(name, parseSpecSummary(name, await readFile(path.join(dir, name), "utf8")));
    }
  } catch {
    // No specs directory yet — normal for a project whose chat has not drafted one.
  }
  return [...byName.values()].sort((a, b) => b.id.localeCompare(a.id));
}

export async function SpecsTab({
  projectSlug,
  projectId,
}: {
  projectSlug: string;
  projectId: string;
}) {
  let specs = await loadSpecsForPanel(projectSlug, projectId);
  // Spec 0165: repair statuses that disagree with what shipped, here, because
  // this panel already holds every spec's body and status. Bounded to specs that
  // are NOT already terminal, so the git work is proportional to unfinished work
  // rather than to the size of the repo. Never throws — a bookkeeping sweep must
  // not 500 the page it is tidying.
  const dir = specsDirForProject(projectSlug);
  if (dir) {
    const stale = specs.filter((s) => !["promoted", "completed", "rejected"].includes(s.status));
    if (stale.length > 0) {
      const repaired = await reconcileSpecStatuses(
        stale.map((s) => ({
          id: s.id,
          filename: s.filename,
          status: s.status,
          ...(s.track ? { track: s.track } : {}),
        })),
        {
          specsDir: dir,
          // Only the platform's specs live in a git repo (spec 0141), so only they
          // have a branch to check or a commit to make.
          ...(projectSlug === PLATFORM_PROJECT_SLUG && process.env["LAUNCHPAD_REPO_ROOT"]
            ? { repoRoot: process.env["LAUNCHPAD_REPO_ROOT"] as string, commit: true }
            : { commit: false }),
        },
      );
      if (repaired.length > 0) {
        console.log(
          `[reconcile] ${projectSlug}: ${repaired.map((r) => `${r.id} ${r.from}→${r.to}`).join(", ")}`,
        );
        specs = await loadSpecsForPanel(projectSlug, projectId);
      }
    }
  }
  // Spec 0153 (the owner: "hide Iniciar when a run is active"). ONE Temporal query for
  // the whole list, project-scoped. Fails open — an unreachable Temporal shows
  // every button, which is what it did before this existed.
  const running = await listRunningSpecIds(projectSlug);
  const isPlatform = projectSlug === PLATFORM_PROJECT_SLUG;
  const active = specs.filter((s) => !s.archived);
  const archived = specs.filter((s) => s.archived);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Label>Specs de este proyecto</Label>
        <span className="text-[11px] text-faint">
          {active.length} {active.length === 1 ? "spec" : "specs"}
          {archived.length > 0 ? ` · ${archived.length} archivada(s)` : ""}
        </span>
      </div>

      {active.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">
          No hay specs para este proyecto.
        </Card>
      ) : (
        <div className="space-y-3">
          {active.map((spec) => (
            <SpecCard
              key={spec.filename}
              spec={spec}
              projectId={projectId}
              projectSlug={projectSlug}
              isPlatform={isPlatform}
              running={running.has(spec.id)}
            />
          ))}
        </div>
      )}

      {archived.length > 0 && (
        // Hidden, not lost: collapsed by default with the count in the summary, so
        // "archived" never becomes "gone". A <details> keeps this server-only.
        <details className="group">
          <summary className="cursor-pointer text-[12px] text-muted hover:text-foreground">
            Archivadas ({archived.length})
          </summary>
          <div className="mt-3 space-y-3 opacity-60">
            {archived.map((spec) => (
              <SpecCard
              key={spec.filename}
              spec={spec}
              projectId={projectId}
              projectSlug={projectSlug}
              isPlatform={isPlatform}
              running={running.has(spec.id)}
            />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * One spec, in the same shape as the Agentes tab's run card (the owner named that format):
 * icon block, title, a muted identity line, a progress indicator, a status badge and
 * actions on the right.
 *
 * The title area is the link to the spec page; the archive control is a SIBLING of
 * it, never nested inside — a `<button>` inside an `<a>` is invalid HTML and the
 * browser's behaviour on click is then anyone's guess.
 */
function SpecCard({
  spec,
  projectId,
  projectSlug,
  isPlatform,
  running,
}: {
  spec: SpecWithBody;
  projectId: string;
  /** Spec 0142: run start needs the slug — spec ids repeat across projects. */
  projectSlug: string;
  /** Spec 0141: only the platform's specs have a `/forge/specs/<file>` page —
   * a project's live outside this repo, so that route 404s for them. */
  isPlatform: boolean;
  /** Spec 0153: this spec's workflow is RUNNING right now. */
  running: boolean;
}) {
  const { checked, total } = spec.progress;
  const percent = total > 0 ? Math.round((checked / total) * 100) : 0;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-blue/40 bg-blue/10 text-blue">
          <FileText className="h-4 w-4" />
        </span>
        {/* Spec 0149: ONE spec page for every project — the platform's specs
            used to link to `/forge/specs/<file>` and everyone else's here,
            which is exactly the difference the owner asked us to remove. */}
        <Link
          href={`/projects/${projectSlug}/specs/${spec.id}`}
          className="group mr-auto min-w-0 flex-1 hover:text-foreground"
        >
          <p className="truncate text-[13px] text-foreground group-hover:text-brand">
            {spec.title}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-faint">
            spec {spec.id} · {spec.status}
            {spec.product ? ` · ${spec.product}` : ""}
          </p>
        </Link>
        <SpecStatusBadge spec={spec} />
        <Link
          href={`/projects/${projectSlug}/specs/${spec.id}`}
          className="flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
        >
          Ver spec <ExternalLink className="h-3 w-3" />
        </Link>
        {/* Spec 0141: START. Spec 0137 deleted SpecViewer with the chats-tab
            sidebar, and it carried the only "Iniciar" button a project spec
            had — leaving a spec the chat had just written with no way to run
            it from the UI. The action is the same one the Agentes tab uses. */}
        {/* Spec 0153: a spec with a run in flight has nothing to start — the
            action refuses ("already started — use Follow") and the click was
            pure friction. The row says what IS happening instead. */}
        {running ? (
          <Link
            href={`/projects/${projectSlug}/specs/${spec.id}`}
            className="flex items-center gap-1 rounded-md border border-cyan/40 bg-cyan/10 px-2 py-1 text-[11px] font-medium text-cyan hover:bg-cyan/20"
          >
            <Activity className="h-3 w-3" /> En curso
          </Link>
        ) : !spec.archived ? (
          <form
            action={startSpecRunAction.bind(
              null,
              projectId,
              projectSlug,
              spec.filename,
              spec.id,
              spec.title,
            )}
          >
            <button
              type="submit"
              className="flex items-center gap-1 rounded-md border border-brand/50 bg-brand/15 px-2 py-1 text-[11px] font-medium text-brand hover:bg-brand/25"
            >
              <Play className="h-3 w-3" /> Iniciar
            </button>
          </form>
        ) : null}
        <form action={setSpecArchivedAction.bind(null, projectId, projectSlug, spec.id, !spec.archived)}>
          <button
            type="submit"
            title={spec.archived ? "Restaurar" : "Archivar"}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground"
          >
            {spec.archived ? (
              <>
                <ArchiveRestore className="h-3 w-3" /> Restaurar
              </>
            ) : (
              <>
                <Archive className="h-3 w-3" /> Archivar
              </>
            )}
          </button>
        </form>
      </div>

      {/* Progress, from the spec's own ## Progress checklist — real counts, so there
          is nothing to fabricate. A spec with no checklist shows no bar rather than
          a misleading 0%. */}
      {total > 0 && (
        <div className="mt-3">
          <div className="h-1 w-full overflow-hidden rounded-full bg-surface">
            <div
              className={`h-full rounded-full ${percent === 100 ? "bg-brand" : "bg-cyan"}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-muted">
            {checked}/{total} items · {percent}%
          </p>
        </div>
      )}

      {spec.track === 1 && (
        // The owner's ask: a Track-1 spec is hand-authored and never runs through the
        // pipeline, so it has no run, no gates and nothing to promote. Say that,
        // rather than leave a reader wondering why a finished spec has no run.
        <p className="mt-2 text-[11px] text-faint">
          Track 1 · escrita a mano, no promovida desde la UI
        </p>
      )}
    </Card>
  );
}

/** Status as a badge, using the same tone vocabulary as the run badges. `promoted`
 * and a fully-ticked checklist both read as done; everything else is reported
 * verbatim rather than bucketed into a guess. */
function SpecStatusBadge({ spec }: { spec: SpecSummary }) {
  const done = spec.status === "promoted" || (spec.progress.total > 0 && spec.progress.checked === spec.progress.total);
  const tone = done
    ? "text-brand border-brand/30 bg-brand/10"
    : spec.status === "rejected"
      ? "text-rose border-rose/30 bg-rose/10"
      : "text-muted border-border bg-surface";
  return <span className={`rounded border px-2 py-0.5 text-[10px] ${tone}`}>{spec.status}</span>;
}
