/**
 * Reconcile `agent_runs` rows against Temporal (spec 0092).
 *
 * The projection is written BY the workflow at each phase transition (spec
 * 0088), which covers every outcome the workflow itself reaches — promoted,
 * rejected, failed. It cannot cover **termination**: a terminated workflow runs
 * no more code, so its row keeps claiming `running` forever.
 *
 * That is not cosmetic. The Launchpad's "Agentes activos" stat counts rows, so a
 * single terminated run inflates it permanently — which is why this **persists**
 * the correction instead of just fixing the display.
 *
 * Called on workspace page load rather than from a cron: at this scale the work
 * is bounded (only rows claiming to be live are described, and there are single
 * digits of those), and a scheduled job would be a whole operational surface for
 * a rare edge. Revisit if run volume ever makes that untrue.
 *
 * **Fail-open throughout.** An unreachable Temporal or DB leaves rows exactly as
 * they were — the same discipline as `recordAudit` (spec 0075) and the
 * projection activities themselves. A stale row is a smaller problem than a
 * workspace that will not render.
 */
import { upsertAgentRun, type AgentRunRow, type Db } from "@launchpad/db";
import { getClient } from "./pipeline";
import { isTerminalProjectionStatus, reconciledStatus } from "./agent-run-view";

/** Ask Temporal for one workflow's execution status. `undefined` when it cannot
 * be determined (not found, connection refused) — `reconciledStatus` then keeps
 * the projected value rather than guessing an outcome. */
async function statusOf(workflowId: string): Promise<string | undefined> {
  try {
    const client = await getClient();
    const description = await client.workflow.getHandle(workflowId).describe();
    return description.status.name;
  } catch {
    return undefined;
  }
}

/**
 * Correct any row that claims to be live but whose workflow has closed.
 * Returns the rows with corrected statuses applied, so the caller can render
 * the truth on this very request instead of the next one.
 */
export async function reconcileAgentRuns(db: Db, rows: AgentRunRow[]): Promise<AgentRunRow[]> {
  const live = rows.filter((r) => !isTerminalProjectionStatus(r.status));
  if (live.length === 0) return rows; // nothing to ask about — no I/O at all

  const corrections = new Map<string, string>();
  await Promise.all(
    live.map(async (row) => {
      const status = reconciledStatus(row.status, await statusOf(row.workflowId));
      if (status !== row.status) corrections.set(row.id, status);
    }),
  );
  if (corrections.size === 0) return rows;

  // Persist, so `projectCounts` (and therefore the Launchpad stat) agrees.
  // Individually try/caught: one failed write must not discard the others.
  await Promise.all(
    rows
      .filter((row) => corrections.has(row.id))
      .map(async (row) => {
        try {
          await upsertAgentRun(db, {
            projectId: row.projectId,
            workflowId: row.workflowId,
            agent: row.agent,
            task: row.task,
            status: corrections.get(row.id)!,
            phase: row.phase,
            step: row.step,
            totalSteps: row.totalSteps,
          });
        } catch {
          /* fail-open: the display correction below still stands */
        }
      }),
  );

  return rows.map((row) =>
    corrections.has(row.id) ? { ...row, status: corrections.get(row.id)! } : row,
  );
}
