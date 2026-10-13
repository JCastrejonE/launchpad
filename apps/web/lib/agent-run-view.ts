/**
 * `agent_runs` row → the shape the Agentes tab renders (spec 0088, Phase D).
 * The sibling of `lib/project-view.ts`, and it follows the same rule: pass
 * through what the projection knows, and never invent what it does not.
 *
 * Two fields need translating rather than copying:
 *   - `workflow` — the mockup's name for what the DB calls `workflowId`.
 *   - `started`  — the mockup rendered a pre-humanised string ("hace 8 min");
 *     the projection stores a real timestamp, so it is humanised here.
 *
 * Pure and framework-free, so it compiles under `tsconfig.test.json`.
 */
import type { AgentRunRow } from "@launchpad/db";

export interface AgentRunView {
  id: string;
  agent: string;
  task: string;
  workflow: string;
  status: string;
  phase: string;
  step: number;
  totalSteps: number;
  started: string;
  /** The checkout the run worked in (spec 0131 C). `""` for a row written before
   * the column existed — the tab shows nothing rather than claiming a repo. */
  repoRoot: string;
  /** The branch this run lands commits on (spec 0133), `""` for a run on the
   * per-spec model. Gate 2 needs it: a branch run's approval is the in-app
   * signal, never a GitHub review (spec 0142). */
  branch: string;
}

/** Coarse relative time — minutes/hours/days. Deliberately not a date library:
 * one call site, and "hace 8 min" is all the tab shows. `now` is injectable so
 * the unit test is not clock-dependent. */
export function humanizeSince(started: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - started.getTime()) / 1000));
  if (seconds < 60) return "hace segundos";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

export function toAgentRunView(row: AgentRunRow, now?: Date): AgentRunView {
  return {
    id: row.id,
    agent: row.agent,
    task: row.task,
    workflow: row.workflowId,
    status: row.status,
    phase: row.phase,
    step: row.step,
    totalSteps: row.totalSteps,
    started: humanizeSince(row.startedAt, now),
    repoRoot: row.repoRoot,
    branch: row.branch,
  };
}

export function toAgentRunViews(rows: AgentRunRow[], now?: Date): AgentRunView[] {
  return rows.map((row) => toAgentRunView(row, now));
}

// ── spec 0092: terminal reconciliation ──────────────────────────────────────

/** The projection statuses that mean "this run is over". Anything else is a
 * claim that the run is still live, which Temporal can contradict. */
const TERMINAL_PROJECTION_STATUSES = new Set(["completed", "failed"]);

export function isTerminalProjectionStatus(status: string): boolean {
  return TERMINAL_PROJECTION_STATUSES.has(status);
}

/**
 * Reconcile a projection row against Temporal, which is the source of truth
 * (SPEC §8).
 *
 * The projection is written BY the workflow at each phase transition, so a
 * workflow that is **terminated** writes nothing — it runs no more code — and
 * its row claims `running` forever. That is not cosmetic: the Launchpad's
 * "Agentes activos" stat counts rows, so one terminated run inflates it
 * permanently.
 *
 * Pure. `temporalStatus` is `undefined` when Temporal could not be asked, in
 * which case the projected value stands (degrade, don't guess).
 */
export function reconciledStatus(projected: string, temporalStatus?: string): string {
  // An already-terminal row is authoritative: the workflow itself wrote it,
  // with more detail than a closed-execution status carries.
  if (isTerminalProjectionStatus(projected)) return projected;
  switch (temporalStatus) {
    case "COMPLETED":
      return "completed";
    // Terminated/cancelled/failed/timed-out all mean the run stopped without
    // reaching its own terminal phase — "failed" is the honest projection.
    case "TERMINATED":
    case "CANCELED":
    case "FAILED":
    case "TIMED_OUT":
      return "failed";
    // RUNNING, CONTINUED_AS_NEW, or unknown/unavailable → trust the projection.
    default:
      return projected;
  }
}
