/**
 * SPEC §5 `AgentRun`'s missing half (spec 0194): one row per spawned SESSION.
 *
 * `agent-runs.ts` projects a workflow — where a run is. This records what it
 * cost: how many sessions, in which roles, for how long, how many turns and
 * tokens. Append-only and never updated: a session is over by the time it is
 * written, and two rows for one session would be two sessions.
 *
 * Arithmetic only, deliberately. No prompt, no handoff text, no content — the
 * rule spec 0075 set for `audit_log` metadata, for the same reason, and every
 * question this table exists to answer is a count or a duration.
 */
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { agentSessions } from "./schema.js";

export type AgentSessionRow = typeof agentSessions.$inferSelect;

/** What the harness knows about a session that just ended. */
export interface AgentSessionRecord {
  workflowId: string;
  specId?: string;
  projectId?: string | null;
  role: string;
  model?: string;
  startedAt: Date;
  finishedAt: Date;
  seconds: number;
  turns?: number;
  /** Only reported in api-key mode; absent on a subscription plan. */
  costUsd?: number | undefined;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  ok?: boolean;
}

export async function recordAgentSession(db: Db, s: AgentSessionRecord): Promise<void> {
  await db.insert(agentSessions).values({
    workflowId: s.workflowId,
    specId: s.specId ?? "",
    // A platform run has no project row; the column is nullable for exactly this.
    projectId: s.projectId ?? null,
    role: s.role,
    model: s.model ?? "",
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    seconds: s.seconds,
    turns: s.turns ?? 0,
    // drizzle's `numeric` maps to a string; undefined stays NULL.
    costUsd: s.costUsd === undefined ? null : String(s.costUsd),
    inputTokens: s.inputTokens ?? 0,
    outputTokens: s.outputTokens ?? 0,
    cacheReadTokens: s.cacheReadTokens ?? 0,
    ok: s.ok ?? true,
  });
}

/** Every session of one run, oldest first — the order they happened. */
export async function sessionsForWorkflow(db: Db, workflowId: string): Promise<AgentSessionRow[]> {
  return db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.workflowId, workflowId))
    .orderBy(agentSessions.startedAt);
}

/** What a run cost, as one row per role — the roll-up the spec page shows. */
export interface SessionRollupRow {
  role: string;
  sessions: number;
  seconds: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export async function sessionRollup(db: Db, workflowId: string): Promise<SessionRollupRow[]> {
  const rows = await db
    .select({
      role: agentSessions.role,
      sessions: sql<number>`count(*)::int`,
      seconds: sql<number>`coalesce(sum(${agentSessions.seconds}), 0)::int`,
      turns: sql<number>`coalesce(sum(${agentSessions.turns}), 0)::int`,
      inputTokens: sql<number>`coalesce(sum(${agentSessions.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${agentSessions.outputTokens}), 0)::int`,
    })
    .from(agentSessions)
    .where(eq(agentSessions.workflowId, workflowId))
    .groupBy(agentSessions.role)
    .orderBy(desc(sql`count(*)`));
  return rows;
}
