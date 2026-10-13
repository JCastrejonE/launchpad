/**
 * What a workspace panel is watching, reduced to one comparable string
 * (spec 0155).
 *
 * ## The bug this exists to kill
 *
 * The workspace refreshed itself every 8s with a blanket `router.refresh()`
 * (spec 0143). That re-renders the WHOLE route — all eleven panels, including
 * the ones nobody is looking at and the one that SSHes into a VPS — and then
 * reconciles the result into the DOM. Most of those refreshes change nothing,
 * but React still rebuilds the subtree, so a control can be replaced under the
 * pointer between mousedown and mouseup. It ate three of my clicks while I was
 * verifying spec 0154, and it had already eaten a branch name the owner was typing.
 *
 * So the poll now asks a much smaller question — *did THIS panel's data
 * change?* — and only then pays for a refresh. When the answer is no, which is
 * the common case, the DOM is not touched at all.
 *
 * These functions are PURE and take data the caller already loaded, so the
 * digest cannot drift from what the panel renders: the route feeds them the
 * SAME loaders the panels use.
 */

/** Panels with data that moves on its own. Everything else never polls. */
export const LIVE_PANELS = ["overview", "agentes", "specs", "ramas"] as const;
export type LivePanel = (typeof LIVE_PANELS)[number];

export function isLivePanel(value: string): value is LivePanel {
  return (LIVE_PANELS as readonly string[]).includes(value);
}

/**
 * A spec row changes visibly when its status, archived flag or checklist counts
 * change — and, since spec 0153, when its run starts or stops (Iniciar ⇄ En
 * curso). Nothing else on the card is derived from anything that moves.
 */
export function specsDigest(
  specs: readonly { id: string; status: string; archived?: boolean; progress: { checked: number; total: number } }[],
  runningSpecIds: ReadonlySet<string>,
): string {
  return specs
    .map(
      (s) =>
        `${s.id}:${s.status}:${s.archived ? 1 : 0}:${s.progress.checked}/${s.progress.total}:${
          runningSpecIds.has(s.id) ? 1 : 0
        }`,
    )
    .sort()
    .join("|");
}

/**
 * A run card changes on its status, its step, and its gate. The gate is NOT
 * read here: it costs a Temporal query per run, and a run cannot arrive at a
 * gate without its projected phase/step moving first (spec 0088 routes every
 * phase change through one choke point). Watching the cheap field catches the
 * expensive one.
 */
export function runsDigest(
  runs: readonly { workflow: string; status: string; step?: number; phase?: string }[],
): string {
  return runs
    .map((r) => `${r.workflow}:${r.status}:${r.step ?? ""}:${r.phase ?? ""}`)
    .sort()
    .join("|");
}

/** A branch row changes on its staging environment, its PR and its merge. */
export function branchesDigest(
  branches: readonly {
    name: string;
    stagingStatus?: string | null;
    stagingHost?: string | null;
    prNumber?: number | null;
    mergedAt?: Date | null;
  }[],
): string {
  return branches
    .map(
      (b) =>
        `${b.name}:${b.stagingStatus ?? ""}:${b.stagingHost ?? ""}:${b.prNumber ?? ""}:${
          b.mergedAt ? b.mergedAt.getTime() : ""
        }`,
    )
    .sort()
    .join("|");
}
