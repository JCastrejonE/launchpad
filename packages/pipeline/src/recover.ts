/**
 * recover.ts — pure recovery-decision core for `supervise.mjs --recover`
 * (spec 0051 / ADR-023 steps 1-4). Pure, no I/O — the same pure-core/thin-IO
 * split as loop.ts / scope-fence.ts: `supervise.mjs --recover` gathers the raw
 * facts (git porcelain, `ps` process list, open-workflow ids from Temporal) and
 * asks the two classifiers here; nothing in this module touches ps, git,
 * Temporal, the filesystem, or spawns anything. `pnpm -r test` covers the two
 * genuine policy decisions in isolation while the script keeps its side effects
 * thin. `supervise.mjs` imports the BUILT helpers from `dist/recover.js` (the
 * same createRequire / dist-import pattern the script already uses for
 * `@temporalio/client` and `dist/task-queue.js`).
 *
 * Exactly TWO classifiers live here. The git-reconcile rule is deliberately NOT
 * duplicated — `--recover` calls the existing `ensureMainSynced` in
 * supervise.mjs (one shared copy, no mirrored classifier, no drift). The infra
 * "any component down ⇒ run preflight" decision is a one-line inline `if` in
 * the script, not a named module here.
 */

/** Parse the repo-relative path out of one `git status --porcelain` line. The
 * first two columns are the XY status codes, then a space, then the path; a
 * rename/copy line reads "R  old -> new" — take the destination. */
function porcelainPath(line: string): string {
  const path = line.slice(3);
  const arrow = path.indexOf(" -> ");
  return arrow === -1 ? path : path.slice(arrow + 4);
}

/** One dirty path split by {@link classifyDirt}: repo-relative, from a
 * `git status --porcelain` line's path column. */
export interface DirtClassification {
  /** Dirty paths that are EXPECTED and must NOT be reported as stray: the spec
   * file of an open workflow currently in `drafting` phase, which the harness
   * itself will commit (spec 0029). */
  expected: string[];
  /** Every other dirty path — LEFT IN THE TREE by `--recover`, never stashed,
   * and reported loudly by the caller (which also computes the `packages/`
   * subset note). */
  stray: string[];
}

/** Input to {@link classifyDirt}. */
export interface ClassifyDirtInput {
  /** Raw `git status --porcelain` lines (e.g. ` M packages/pipeline/src/x.ts`).
   * The path column is parsed out by the classifier. */
  porcelainLines: string[];
  /** Repo-relative spec-file paths of open workflows currently in `drafting`
   * phase (spec 0029) — these are expected dirt, not stray. */
  draftingSpecFiles: string[];
}

/** A discovered supervise.mjs watcher process, from `ps`. */
export interface WatcherProcess {
  /** The specId the watcher is attached to (its argv[0]). */
  specId: string;
  /** The OS process id. */
  pid: number;
}

/** Input to {@link planWatcherRecovery}. */
export interface PlanWatcherRecoveryInput {
  /** Every discovered supervise.mjs watcher process for this repo (source of
   * truth = `ps`, not a lockfile — a power outage skips every exit handler, so
   * a lockfile would be guaranteed stale in exactly the recovery scenario). */
  processes: WatcherProcess[];
  /** The ids of every currently-open workflow (from `open-pipeline-workflows`). */
  openWorkflowIds: string[];
  /** This `--recover` invocation's own pid — never in the kill set. */
  selfPid: number;
  /** When present, scope kill + reattach to this one specId (the
   * `--recover <specId>` form); absent ⇒ all open workflows. */
  scopeSpecId?: string;
}

/** The convergence plan from {@link planWatcherRecovery}: KILL ALL, RE-ATTACH
 * FRESH — no labels, no pidfiles, just the kill pids and the reattach set. */
export interface WatcherRecoveryPlan {
  /** Pids to SIGTERM (self excluded; filtered to `scopeSpecId` when scoped). */
  kill: number[];
  /** Workflow ids to re-attach exactly one fresh tracked `--no-start` watcher
   * to (in scope; = the open set when unscoped). */
  reattach: string[];
}

/**
 * Split every dirty path into `expected` (the spec file of an open workflow in
 * `drafting` phase — spec 0029, the harness commits it, so NOT reported) and
 * `stray` (every other dirty path — left in the tree, reported loudly by the
 * caller). An empty `stray` ⇒ no warning. Pure; the caller decides how loudly
 * to print and computes the `packages/`-subset note.
 */
export function classifyDirt({ porcelainLines, draftingSpecFiles }: ClassifyDirtInput): DirtClassification {
  const drafting = new Set(draftingSpecFiles);
  const expected: string[] = [];
  const stray: string[] = [];
  for (const line of porcelainLines) {
    if (!line) continue;
    const path = porcelainPath(line);
    if (drafting.has(path)) expected.push(path);
    else stray.push(path);
  }
  return { expected, stray };
}

/**
 * Plan watcher convergence: `kill` = every discovered watcher pid except
 * `selfPid` (filtered to `scopeSpecId` when scoped); `reattach` = every open
 * workflow id in scope (each gets exactly one fresh tracked watcher). No
 * labels, no pidfiles — ambiguity can't survive a kill-all, so there is no
 * taxonomy to compute.
 */
export function planWatcherRecovery({
  processes,
  openWorkflowIds,
  selfPid,
  scopeSpecId,
}: PlanWatcherRecoveryInput): WatcherRecoveryPlan {
  const inScope = (specId: string) => !scopeSpecId || specId === scopeSpecId;
  const kill = processes.filter((p) => p.pid !== selfPid && inScope(p.specId)).map((p) => p.pid);
  const reattach = openWorkflowIds.filter((id) => inScope(id));
  return { kill, reattach };
}
