/**
 * SPEC §5 `AgentRun` reads/writes (spec 0088, Phase D).
 *
 * This table is a **projection**, not a source of truth — Temporal owns the
 * real state of a workflow (SPEC §8). Its whole job is to let the UI list
 * "what are the agents doing" with one indexed query instead of fanning out to
 * Temporal visibility on every page render.
 *
 * Because it is a projection, the writer is an UPSERT keyed on `workflow_id`
 * (UNIQUE as of migration 0003): the pipeline calls it again at every phase
 * transition, and one row advances rather than a row accumulating per phase.
 * That also makes the write safely retryable — Temporal activities can and do
 * run more than once.
 */
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { agentRuns } from "./schema.js";

export type AgentRunRow = typeof agentRuns.$inferSelect;

/** The fields a pipeline run reports about itself. `workflowId` is the identity
 * — everything else is the advancing state. */
export interface AgentRunUpsert {
  projectId: string;
  workflowId: string;
  agent: string;
  task?: string;
  status: string;
  phase?: string;
  step?: number;
  totalSteps?: number;
  /** Spec 0131 C: the checkout the run works in. Optional so a caller that does
   * not know it records nothing rather than a guess. */
  repoRoot?: string;
  /** Spec 0133: the branch the run lands its commits on — '' for per-spec
   * runs. The promote roll-up (spec 0136) reads it to find which specs rode a
   * branch. */
  branch?: string;
}

/** Validate + shape a run for insert. Pure, so the defaulting and the guards
 * are unit-testable without a database — the same split as
 * {@link auditEntryValues}: a bad call site should be loud in tests, while the
 * runtime fail-open lives in the caller's wrapper (the pipeline activity). */
export function agentRunValues(run: AgentRunUpsert): typeof agentRuns.$inferInsert {
  const workflowId = run.workflowId.trim();
  if (!workflowId) throw new Error("agent run needs a non-empty workflowId");
  if (!run.projectId.trim()) throw new Error("agent run needs a projectId");
  const agent = run.agent.trim();
  if (!agent) throw new Error("agent run needs a non-empty agent");
  const status = run.status.trim();
  if (!status) throw new Error("agent run needs a non-empty status");
  return {
    projectId: run.projectId,
    workflowId,
    agent,
    task: run.task ?? "",
    status,
    phase: run.phase ?? "",
    step: run.step ?? 0,
    totalSteps: run.totalSteps ?? 0,
    repoRoot: run.repoRoot ?? "",
    branch: run.branch ?? "",
  };
}

/** Idempotent by `workflow_id`. Returns the row id.
 *
 * `started_at` is deliberately NOT in the update set: it defaults on insert and
 * must keep its original value as the run advances, otherwise every phase
 * transition would reset "when did this start".
 *
 * `repo_root` (spec 0131 C) is out of the update set for the same reason and a
 * stronger one: a run's checkout is decided when it starts and cannot change, so
 * the insert is the only moment it can be learned — and leaving it out means a
 * caller that re-upserts a row WITHOUT it (the terminal reconciler in apps/web
 * does exactly that) cannot blank the one field that proves which repo a run
 * touched. `branch` (spec 0133) is out for the identical reason — the promote
 * roll-up must not lose it to a branchless re-upsert. */
export async function upsertAgentRun(db: Db, run: AgentRunUpsert): Promise<string> {
  const values = agentRunValues(run);
  const rows = await db
    .insert(agentRuns)
    .values(values)
    .onConflictDoUpdate({
      target: agentRuns.workflowId,
      set: {
        projectId: values.projectId,
        agent: values.agent,
        task: values.task,
        status: values.status,
        phase: values.phase,
        step: values.step,
        totalSteps: values.totalSteps,
        // Spec 0142: update these two only when the incoming value is NON-EMPTY.
        //
        // They were excluded from the update set entirely (0131 C) because the
        // reconcile path re-upserts without them, and a plain assignment would
        // blank a real value. But excluding them means a workflow id REUSED by
        // a later run keeps the FIRST run's values forever: `spec-0001` was
        // restarted as a branch run on `owner/hola-addon` and the row still read
        // branch='' from the earlier main-based attempt. Silent, and it matters
        // — 0136's promote roll-up finds a branch's specs through this column.
        //
        // `COALESCE(NULLIF(excluded, ''), current)` keeps both properties: an
        // empty incoming value preserves what is stored, a real one wins.
        repoRoot: sql`coalesce(nullif(excluded.${sql.raw(agentRuns.repoRoot.name)}, ''), ${agentRuns.repoRoot})`,
        branch: sql`coalesce(nullif(excluded.${sql.raw(agentRuns.branch.name)}, ''), ${agentRuns.branch})`,
      },
    })
    .returning({ id: agentRuns.id });
  const row = rows[0];
  if (!row) throw new Error(`upsert of agent_run ${JSON.stringify(run.workflowId)} returned no row`);
  return row.id;
}

/** One project's runs, newest first — the workspace "Agentes" tab read. */
export async function listAgentRuns(db: Db, projectId: string): Promise<AgentRunRow[]> {
  return db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.projectId, projectId))
    .orderBy(desc(agentRuns.startedAt));
}

/**
 * Spec 0142 C: the workflow id RECORDED for a spec's run.
 *
 * Workflow ids were `spec-<id>` for every project, so two projects' spec 0001
 * shared one Temporal id. New runs are namespaced (`spec-<slug>-<id>`), which
 * leaves every id already in flight on the old shape — so resolution reads
 * what was actually recorded instead of recomputing a formula that has since
 * changed. `agent_runs.workflow_id` is unique, and the row is written at the
 * run's first phase transition.
 *
 * `projectId` disambiguates when the caller knows it. Without it, a suffix
 * match can hit two projects' same-numbered specs — that ambiguity is real, so
 * it returns `null` rather than guessing, and the caller falls back to the
 * legacy id.
 */
export async function recordedWorkflowIdForSpec(
  db: Db,
  specId: string,
  projectId?: string,
): Promise<string | null> {
  const legacy = `spec-${specId}`;
  const rows = await db
    .select({ workflowId: agentRuns.workflowId, projectId: agentRuns.projectId })
    .from(agentRuns)
    .where(
      projectId
        ? and(
            eq(agentRuns.projectId, projectId),
            or(eq(agentRuns.workflowId, legacy), like(agentRuns.workflowId, `%-${specId}`)),
          )
        : or(eq(agentRuns.workflowId, legacy), like(agentRuns.workflowId, `%-${specId}`)),
    );
  // A suffix match is loose on purpose (it must find `spec-<slug>-<id>` for any
  // slug), so drop anything whose id is not one of the two legitimate shapes.
  const matches = rows.filter(
    (r) => r.workflowId === legacy || /^spec-.+-\d+$/.test(r.workflowId),
  );
  if (matches.length === 1) return matches[0]!.workflowId;
  // A project that ran this spec BEFORE the rename and again after has both a
  // legacy row and a namespaced one. Prefer the namespaced id: it is the newer
  // scheme, so it is the newer run. Stated explicitly because the fallback
  // would have produced the same answer by luck, and luck is not a rule.
  const namespaced = matches.filter((r) => r.workflowId !== legacy);
  if (namespaced.length === 1) return namespaced[0]!.workflowId;
  // Several PROJECTS have run this spec number and the caller did not say
  // which: refusing beats returning someone else's run.
  return null;
}
