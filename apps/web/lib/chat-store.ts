/**
 * Owner-scoped chat persistence for the Forge chat rebuild (spec 0067 phase 1,
 * item 1). The FIRST consumer of the launchpad Postgres (`DATABASE_URL`); the
 * schema and storage are ours (assistant-ui carries no server persistence).
 *
 * Design (per spec §3):
 * - **Injectable I/O seam** ({@link ChatStoreDeps}) exactly like
 *   `lib/supervisor-console.ts`'s `SupervisorOrchestrationDeps` — a minimal
 *   {@link SqlClient} (`query(text, params) => {rows}`) so unit tests inject a
 *   FAKE pool while {@link defaultChatStoreDeps} wires the shared pool.
 * - **Schema is Drizzle-managed (spec 0078).** `forge_threads`/`forge_messages`
 *   are folded into `@launchpad/db` — the single control-plane DB layer
 *   (SPEC-ALIGNMENT §4). This module no longer bootstraps DDL or owns a pool;
 *   it borrows `@launchpad/db`'s `createPool` and issues the same parameterized
 *   SQL. (The migration owns the schema now, incl. the SPEC §5 `project_id`
 *   link, populated in Phase C; converting these queries to the Drizzle query
 *   builder is a Phase-C follow-up once threads are project-scoped.)
 * - **Degrade, don't block** ({@link ChatStoreResult}). If Postgres is
 *   unreachable (or `DATABASE_URL`/the migration is missing) the chat still
 *   works ephemerally with a visible "not saving" notice — every I/O function
 *   returns `{ok:false,reason}` rather than throwing, and the caller degrades.
 * - **Owner-scoped = no user column.** Multi-user auth is phase 5, out of scope
 *   here ("per user" = the single owner's own threads).
 *
 * Schema (owned by `@launchpad/db` migration 0002; SPEC §5 ChatThread/ChatMessage):
 *   forge_threads(id uuid pk, title text, sdk_session_id text null,
 *                 project_id uuid null → projects, created_at, updated_at)
 *   forge_messages(id uuid pk, thread_id fk, role text check in
 *                 ('user','assistant'), content text, events jsonb null,
 *                 created_at timestamptz)
 * A user message stores its prompt in `content`; an assistant message stores
 * the full ordered `SupervisorEvent[]` in `events`, so reopening a thread
 * REPLAYS the same event→card mapping the live stream uses.
 */
import { randomUUID } from "node:crypto";
import { createPool } from "@launchpad/db";
import type { SupervisorEvent } from "@launchpad/agents";

/** A persisted conversation. `sdkSessionId` pins the thread to its Agent-SDK
 * session so the next turn resumes it (item 3 continuity); null until the first
 * assistant turn yields a `{type:"session"}` event. */
export interface ForgeThread {
  id: string;
  title: string;
  sdkSessionId: string | null;
  /** SPEC §5 project link (spec 0081) — null for an unscoped thread. Exposed
   * since spec 0135 so the supervisor routes can scope ACCESS by membership. */
  projectId: string | null;
  /** The branch this thread operates over (spec 0135) — null for platform
   * threads. Every run the thread spawns lands its commits here. */
  branch: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One persisted turn. A `user` message stores its prompt in `content`; an
 * `assistant` message stores the full ordered `SupervisorEvent[]` in `events`
 * (null for user messages) so a reopened thread replays event→card mapping. */
export interface ForgeMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  events: SupervisorEvent[] | null;
  createdAt: string;
}

/** Graceful-degrade result: persistence failure must NOT brick the console, so
 * every I/O returns this instead of throwing. `ok:false` ⇒ the chat runs
 * ephemerally with a visible "not saving" notice (spec §3 "degrade, don't
 * block"). */
export type ChatStoreResult<T> = { ok: true; data: T } | { ok: false; reason: string };

/**
 * Minimal SQL executor the store needs — structurally the subset of `pg`'s
 * `Pool.query` this module calls, so tests inject a fake pool while
 * {@link defaultChatStoreDeps} wires the real one.
 */
export interface SqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Injectable I/O seam — real client by default, a fake in tests. */
export interface ChatStoreDeps {
  sql: SqlClient;
}

// The pool is borrowed lazily from @launchpad/db (the one control-plane DB
// layer) on first query — NOT at module load — so importing this module stays
// side-effect-free. `createPool` throws if DATABASE_URL is unset; that throw
// happens inside the query action and is caught by `run()` → {ok:false}, so
// degrade-don't-block is preserved. The schema is owned by the Drizzle
// migrations now (spec 0078), so there is no bootstrap DDL here anymore.
let sharedPool: ReturnType<typeof createPool> | null = null;
function getPool(): ReturnType<typeof createPool> {
  sharedPool ??= createPool();
  return sharedPool;
}

/** Default deps: the shared `@launchpad/db` pool from `DATABASE_URL`. */
export const defaultChatStoreDeps: ChatStoreDeps = {
  sql: {
    query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) {
      return getPool().query<T>(text, params as unknown[]);
    },
  },
};

/** Max length of a derived thread title before truncation. */
export const THREAD_TITLE_MAX_LENGTH = 60;

/**
 * Derive a thread title from the first user prompt (spec §"Phase 1 scope" 1):
 * collapse whitespace, take a single trimmed line, truncate with an ellipsis.
 * Pure — the one concrete helper the foundation ships so item 1's tests have a
 * real target; the I/O functions below remain stubs for the coder.
 */
export function deriveThreadTitle(firstPrompt: string): string {
  const collapsed = firstPrompt.replace(/\s+/g, " ").trim();
  if (!collapsed) return "New chat";
  if (collapsed.length <= THREAD_TITLE_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, THREAD_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

/** Runs `action`, wrapping a thrown/rejected error into `{ok:false}` rather
 * than letting it propagate (spec §3 "degrade, don't block"). */
async function run<T>(fn: string, action: () => Promise<T>): Promise<ChatStoreResult<T>> {
  try {
    return { ok: true, data: await action() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `chat-store.${fn} failed: ${message}` };
  }
}

interface ThreadRow extends Record<string, unknown> {
  id: string;
  title: string;
  sdk_session_id: string | null;
  project_id: string | null;
  branch: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/** pg returns timestamptz columns as `Date`s; a fake test pool may hand back
 * plain ISO strings — accept either. */
function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function rowToThread(row: ThreadRow): ForgeThread {
  return {
    id: row.id,
    title: row.title,
    sdkSessionId: row.sdk_session_id,
    projectId: row.project_id ?? null,
    branch: row.branch ?? null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

interface MessageRow extends Record<string, unknown> {
  id: string;
  thread_id: string;
  role: ForgeMessage["role"];
  content: string;
  events: SupervisorEvent[] | string | null;
  created_at: string | Date;
}

function rowToMessage(row: MessageRow): ForgeMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    events: typeof row.events === "string" ? JSON.parse(row.events) : row.events,
    createdAt: toIsoString(row.created_at),
  };
}

/** List threads newest-first (by `updated_at`).
 *
 * Spec 0081 (C.2): pass a `projectId` to scope the list to one project's
 * threads (the workspace "Chats · sdd" tab). Omitted/nullish keeps the
 * unscoped "every thread" list — what the standalone `/forge` console still
 * uses until C.3 retires it. Nullish deliberately means *unscoped* rather than
 * "threads with a NULL project_id": `WHERE project_id = NULL` matches nothing
 * in SQL, so treating it as a filter would silently return an empty sidebar. */
export async function listThreads(
  projectId?: string | null,
  deps: ChatStoreDeps = defaultChatStoreDeps,
): Promise<ChatStoreResult<ForgeThread[]>> {
  return run("listThreads", async () => {
    const columns = "SELECT id, title, sdk_session_id, project_id, branch, created_at, updated_at FROM forge_threads";
    const { rows } = projectId
      ? await deps.sql.query<ThreadRow>(
          `${columns} WHERE project_id = $1 ORDER BY updated_at DESC`,
          [projectId],
        )
      : await deps.sql.query<ThreadRow>(`${columns} ORDER BY updated_at DESC`);
    return rows.map(rowToThread);
  });
}

/** Load a single thread by id (spec 0067 item 3 continuity — the route reads
 * `sdkSessionId` off it before starting a turn). `data` is `null` when no
 * thread has that id. */
export async function getThread(
  threadId: string,
  deps: ChatStoreDeps = defaultChatStoreDeps,
): Promise<ChatStoreResult<ForgeThread | null>> {
  return run("getThread", async () => {
    const { rows } = await deps.sql.query<ThreadRow>(
      "SELECT id, title, sdk_session_id, project_id, branch, created_at, updated_at FROM forge_threads WHERE id = $1",
      [threadId],
    );
    const row = rows[0];
    return row ? rowToThread(row) : null;
  });
}

/** Create a new (empty) thread, titled from `firstPrompt` via
 * {@link deriveThreadTitle}.
 *
 * Spec 0081 (C.2): `projectId` links the thread to its SPEC §5 `Project` (the
 * workspace tab passes the resolved project; `/forge` passes nothing and the
 * link stays null, i.e. an unscoped thread). */
export async function createThread(
  firstPrompt: string,
  projectId?: string | null,
  branch?: string | null,
  deps: ChatStoreDeps = defaultChatStoreDeps,
): Promise<ChatStoreResult<ForgeThread>> {
  return run("createThread", async () => {
    const { rows } = await deps.sql.query<ThreadRow>(
      "INSERT INTO forge_threads (id, title, project_id, branch) VALUES ($1, $2, $3, $4) " +
        "RETURNING id, title, sdk_session_id, project_id, branch, created_at, updated_at",
      [randomUUID(), deriveThreadTitle(firstPrompt), projectId ?? null, branch ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error("insert into forge_threads returned no row");
    return rowToThread(row);
  });
}

/** Load a thread's messages in insertion order (for replay on open). */
export async function getThreadMessages(
  threadId: string,
  deps: ChatStoreDeps = defaultChatStoreDeps,
): Promise<ChatStoreResult<ForgeMessage[]>> {
  return run("getThreadMessages", async () => {
    const { rows } = await deps.sql.query<MessageRow>(
      "SELECT id, thread_id, role, content, events, created_at FROM forge_messages " +
        "WHERE thread_id = $1 ORDER BY created_at ASC",
      [threadId],
    );
    return rows.map(rowToMessage);
  });
}

/** Append a user or assistant message to a thread (assistant = full event log
 * JSONB); bumps the thread's `updated_at`. */
export async function appendMessage(
  threadId: string,
  message: { role: ForgeMessage["role"]; content: string; events?: SupervisorEvent[] | null },
  deps: ChatStoreDeps = defaultChatStoreDeps,
): Promise<ChatStoreResult<ForgeMessage>> {
  return run("appendMessage", async () => {
    const events = message.events ?? null;
    const { rows } = await deps.sql.query<MessageRow>(
      "INSERT INTO forge_messages (id, thread_id, role, content, events) VALUES ($1, $2, $3, $4, $5) " +
        "RETURNING id, thread_id, role, content, events, created_at",
      [randomUUID(), threadId, message.role, message.content, events === null ? null : JSON.stringify(events)],
    );
    const row = rows[0];
    if (!row) throw new Error("insert into forge_messages returned no row");
    await deps.sql.query("UPDATE forge_threads SET updated_at = now() WHERE id = $1", [threadId]);
    return rowToMessage(row);
  });
}

/** Pin the thread to its Agent-SDK session id (item 3 continuity). */
export async function setThreadSdkSession(
  threadId: string,
  sdkSessionId: string,
  deps: ChatStoreDeps = defaultChatStoreDeps,
): Promise<ChatStoreResult<void>> {
  return run("setThreadSdkSession", async () => {
    await deps.sql.query("UPDATE forge_threads SET sdk_session_id = $1, updated_at = now() WHERE id = $2", [
      sdkSessionId,
      threadId,
    ]);
  });
}

/** Delete a thread and its messages (history-sidebar delete; `ON DELETE
 * CASCADE` on `forge_messages.thread_id` covers the messages). */
export async function deleteThread(
  threadId: string,
  deps: ChatStoreDeps = defaultChatStoreDeps,
): Promise<ChatStoreResult<void>> {
  return run("deleteThread", async () => {
    await deps.sql.query("DELETE FROM forge_threads WHERE id = $1", [threadId]);
  });
}

// ---------------------------------------------------------------------------
// Live run events (spec 0127). `forge_messages.events` above is a COMPLETED
// turn's log; these are the events of a turn still in flight, appended as they
// arrive so that closing or switching a tab cannot lose progress.
// ---------------------------------------------------------------------------

/** One stored agent event, with the sequence number a tail resumes from. */
export interface ForgeEvent {
  runId: string;
  seq: number;
  event: SupervisorEvent;
  createdAt: string;
}

interface EventRow extends Record<string, unknown> {
  run_id: string;
  seq: number;
  event: SupervisorEvent | string;
  created_at: Date | string;
}

function rowToEvent(row: EventRow): ForgeEvent {
  return {
    runId: row.run_id,
    seq: row.seq,
    event: typeof row.event === "string" ? (JSON.parse(row.event) as SupervisorEvent) : row.event,
    createdAt: toIsoString(row.created_at),
  };
}

/**
 * Event types that END a run. A run with one of these stored is finished; a run
 * with none and no live producer was interrupted (a restart), which the UI
 * reports rather than pretending it is still thinking.
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(["result", "error"]);

export function isTerminalEvent(event: SupervisorEvent): boolean {
  return TERMINAL_EVENT_TYPES.has(event.type);
}

/**
 * Append one event at `seq`. The caller owns the sequence (it is the producer,
 * and it is single-threaded per run), while `(run_id, seq)` UNIQUE makes a
 * duplicate a database error rather than a silently reordered tail.
 *
 * Does NOT bump `forge_threads.updated_at` on every token: that would be one
 * extra write per delta, and the turn's completion already bumps it via
 * `appendMessage`.
 */
export async function appendRunEvent(
  threadId: string,
  runId: string,
  seq: number,
  event: SupervisorEvent,
  deps: ChatStoreDeps = defaultChatStoreDeps,
): Promise<ChatStoreResult<void>> {
  return run("appendRunEvent", async () => {
    await deps.sql.query(
      "INSERT INTO forge_events (id, thread_id, run_id, seq, event) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), threadId, runId, seq, JSON.stringify(event)],
    );
  });
}

/**
 * Read a run's events after `sinceSeq`, in order. `sinceSeq` is EXCLUSIVE, so a
 * client that rendered up to seq N passes N and receives N+1 onward — the
 * resume is exact, with no duplicate rendering and no gap.
 */
export async function readRunEvents(
  runId: string,
  sinceSeq = 0,
  deps: ChatStoreDeps = defaultChatStoreDeps,
): Promise<ChatStoreResult<ForgeEvent[]>> {
  return run("readRunEvents", async () => {
    const { rows } = await deps.sql.query<EventRow>(
      "SELECT run_id, seq, event, created_at FROM forge_events " +
        "WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC",
      [runId, sinceSeq],
    );
    return rows.map(rowToEvent);
  });
}

/**
 * The most recent run on a thread, for reopening a tab: `{runId, lastSeq,
 * finished}`. `null` when the thread has no stored run events at all.
 *
 * `finished` comes from a terminal event being present, which is why no
 * `forge_runs` table exists — there is one place the truth lives.
 */
export async function latestRunForThread(
  threadId: string,
  deps: ChatStoreDeps = defaultChatStoreDeps,
): Promise<ChatStoreResult<{ runId: string; lastSeq: number; finished: boolean } | null>> {
  return run("latestRunForThread", async () => {
    // created_at FIRST, not seq: `seq` restarts at 1 per run, so ordering by it
    // would pick whichever run happened to be LONGEST rather than newest.
    const { rows } = await deps.sql.query<{ run_id: string }>(
      "SELECT run_id FROM forge_events WHERE thread_id = $1 ORDER BY created_at DESC, seq DESC LIMIT 1",
      [threadId],
    );
    const runId = rows[0]?.run_id;
    if (!runId) return null;
    const { rows: agg } = await deps.sql.query<{ last_seq: number; terminal: number }>(
      "SELECT MAX(seq) AS last_seq, " +
        "COUNT(*) FILTER (WHERE event->>'type' IN ('result', 'error')) AS terminal " +
        "FROM forge_events WHERE run_id = $1",
      [runId],
    );
    const row = agg[0];
    return {
      runId,
      lastSeq: Number(row?.last_seq ?? 0),
      finished: Number(row?.terminal ?? 0) > 0,
    };
  });
}
