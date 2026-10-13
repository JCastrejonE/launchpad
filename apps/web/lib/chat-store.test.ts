import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THREAD_TITLE_MAX_LENGTH,
  appendMessage,
  appendRunEvent,
  isTerminalEvent,
  latestRunForThread,
  readRunEvents,
  createThread,
  deleteThread,
  deriveThreadTitle,
  getThread,
  getThreadMessages,
  listThreads,
  setThreadSdkSession,
  type SqlClient,
} from "./chat-store";
import type { SupervisorEvent } from "@launchpad/agents";

// --- deriveThreadTitle (pure) -----------------------------------------------

test("deriveThreadTitle collapses whitespace and keeps a short prompt intact", () => {
  assert.equal(deriveThreadTitle("  add   loyalty\npoints  "), "add loyalty points");
});

test("deriveThreadTitle falls back to a default for an empty prompt", () => {
  assert.equal(deriveThreadTitle("   \n  "), "New chat");
});

test("deriveThreadTitle truncates a long prompt with an ellipsis", () => {
  const title = deriveThreadTitle("x".repeat(200));
  assert.equal(title.length, THREAD_TITLE_MAX_LENGTH);
  assert.ok(title.endsWith("…"));
});

// --- I/O functions, against a fake SqlClient --------------------------------
//
// Mirrors the injectable-deps + fake pattern in supervisor-console.test.ts:
// a fake `SqlClient` records the SQL/params it was called with and returns
// canned rows, so these assert the CRUD's row<->domain mapping and query
// shape without a live Postgres.

interface FakeCall {
  text: string;
  params?: readonly unknown[];
}

/** A fake `SqlClient` that records every call and answers via `handler`. */
function fakeSql(handler: (call: FakeCall) => { rows: Record<string, unknown>[] }): {
  sql: SqlClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const sql: SqlClient = {
    async query<T extends Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      const call = { text, params };
      calls.push(call);
      return handler(call) as unknown as { rows: T[] };
    },
  };
  return { sql, calls };
}

test("createThread derives the title from the first prompt and inserts a row", async () => {
  const createdAt = "2024-01-01T00:00:00.000Z";
  const { sql, calls } = fakeSql((call) => {
    assert.match(call.text, /INSERT INTO forge_threads/);
    return { rows: [{ id: "t1", title: "add loyalty points", sdk_session_id: null, created_at: createdAt, updated_at: createdAt }] };
  });

  const res = await createThread("  add   loyalty\npoints  ", null, null, { sql });

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.data, {
    id: "t1",
    title: "add loyalty points",
    sdkSessionId: null,
    projectId: null,
    branch: null,
    createdAt,
    updatedAt: createdAt,
  });
  assert.equal(calls[0]?.params?.[1], "add loyalty points");
  // Spec 0081: unscoped create still writes the column, as NULL.
  assert.equal(calls[0]?.params?.[2], null);
});

test("listThreads returns threads newest-first by updated_at", async () => {
  const rows = [
    { id: "t2", title: "second", sdk_session_id: null, created_at: "2024-01-02T00:00:00.000Z", updated_at: "2024-01-02T00:00:00.000Z" },
    { id: "t1", title: "first", sdk_session_id: "sess-1", created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z" },
  ];
  const { sql } = fakeSql((call) => {
    assert.match(call.text, /ORDER BY updated_at DESC/);
    return { rows };
  });

  const res = await listThreads(undefined, { sql });

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.data.map((t) => t.id), ["t2", "t1"]);
  assert.equal(res.data[1]?.sdkSessionId, "sess-1");
});

// ── spec 0081 (C.2): project scoping ────────────────────────────────────────

test("listThreads scopes to one project when given a projectId", async () => {
  const { sql, calls } = fakeSql(() => ({ rows: [] }));

  await listThreads("11111111-1111-4111-8111-111111111111", { sql });

  assert.match(calls[0]?.text ?? "", /WHERE project_id = \$1/);
  assert.match(calls[0]?.text ?? "", /ORDER BY updated_at DESC/);
  assert.deepEqual(calls[0]?.params, ["11111111-1111-4111-8111-111111111111"]);
});

test("listThreads stays unscoped for a nullish projectId (no NULL-matching filter)", async () => {
  // `WHERE project_id = NULL` matches nothing in SQL, so a nullish id must fall
  // back to the all-threads list rather than silently emptying the sidebar.
  for (const nullish of [undefined, null]) {
    const { sql, calls } = fakeSql(() => ({ rows: [] }));
    await listThreads(nullish, { sql });
    assert.doesNotMatch(calls[0]?.text ?? "", /WHERE project_id/);
    assert.equal(calls[0]?.params, undefined);
  }
});

test("createThread persists the project_id link when scoped", async () => {
  const createdAt = "2024-01-01T00:00:00.000Z";
  const { sql, calls } = fakeSql(() => ({
    rows: [{ id: "t1", title: "hi", sdk_session_id: null, created_at: createdAt, updated_at: createdAt }],
  }));

  await createThread("hi", "22222222-2222-4222-8222-222222222222", "feature/pos", { sql });

  assert.match(calls[0]?.text ?? "", /INSERT INTO forge_threads \(id, title, project_id, branch\)/);
  assert.equal(calls[0]?.params?.[2], "22222222-2222-4222-8222-222222222222");
  // Spec 0135 B: the branch rides the insert — a project thread is born bound.
  assert.equal(calls[0]?.params?.[3], "feature/pos");
});

test("getThread loads a single thread by id, or null when it doesn't exist", async () => {
  const row = { id: "t1", title: "add loyalty points", sdk_session_id: "sess-1", created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z" };
  const { sql, calls } = fakeSql((call) => {
    assert.match(call.text, /WHERE id = \$1/);
    return { rows: call.params?.[0] === "t1" ? [row] : [] };
  });

  const found = await getThread("t1", { sql });
  assert.equal(found.ok, true);
  if (found.ok) assert.equal(found.data?.sdkSessionId, "sess-1");

  const missing = await getThread("nope", { sql });
  assert.equal(missing.ok, true);
  if (missing.ok) assert.equal(missing.data, null);
  assert.equal(calls.length, 2);
});

test("getThreadMessages replays messages in insertion order with events JSONB", async () => {
  const events: SupervisorEvent[] = [{ type: "text", delta: "hi" }];
  const rows = [
    { id: "m1", thread_id: "t1", role: "user", content: "hello", events: null, created_at: "2024-01-01T00:00:00.000Z" },
    { id: "m2", thread_id: "t1", role: "assistant", content: "", events, created_at: "2024-01-01T00:00:01.000Z" },
  ];
  const { sql } = fakeSql((call) => {
    assert.match(call.text, /WHERE thread_id = \$1 ORDER BY created_at ASC/);
    return { rows };
  });

  const res = await getThreadMessages("t1", { sql });

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.data.length, 2);
  assert.equal(res.data[0]?.events, null);
  assert.deepEqual(res.data[1]?.events, events);
});

test("appendMessage stores assistant events as JSONB and bumps updated_at", async () => {
  const events: SupervisorEvent[] = [{ type: "result", ok: true }];
  const { sql, calls } = fakeSql((call) => {
    if (/INSERT INTO forge_messages/.test(call.text)) {
      return {
        rows: [{ id: "m1", thread_id: "t1", role: "assistant", content: "", events, created_at: "2024-01-01T00:00:00.000Z" }],
      };
    }
    return { rows: [] };
  });

  const res = await appendMessage("t1", { role: "assistant", content: "", events }, { sql });

  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.data.events, events);
  const insertCall = calls.find((c) => /INSERT INTO forge_messages/.test(c.text));
  assert.equal(insertCall?.params?.[4], JSON.stringify(events));
  assert.ok(calls.some((c) => /UPDATE forge_threads SET updated_at = now\(\)/.test(c.text)));
});

test("setThreadSdkSession pins the thread's sdk_session_id", async () => {
  const { sql, calls } = fakeSql(() => ({ rows: [] }));

  const res = await setThreadSdkSession("t1", "sess-99", { sql });

  assert.equal(res.ok, true);
  assert.match(calls[0]?.text ?? "", /UPDATE forge_threads SET sdk_session_id = \$1/);
  assert.deepEqual(calls[0]?.params, ["sess-99", "t1"]);
});

test("deleteThread removes the thread (messages cascade via the FK)", async () => {
  const { sql, calls } = fakeSql(() => ({ rows: [] }));

  const res = await deleteThread("t1", { sql });

  assert.equal(res.ok, true);
  assert.match(calls[0]?.text ?? "", /DELETE FROM forge_threads WHERE id = \$1/);
  assert.deepEqual(calls[0]?.params, ["t1"]);
});

test("a rejected sql.query degrades to {ok:false} (never throws)", async () => {
  const sql: SqlClient = {
    async query() {
      throw new Error("connection refused");
    },
  };

  const res = await listThreads(undefined, { sql });

  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /connection refused/);
});

// ---------------------------------------------------------------------------
// Spec 0127: live run events. These are what make a turn survive its tab.
// ---------------------------------------------------------------------------

test("appendRunEvent stores the event at the caller's seq, JSON-encoded", async () => {
  const { sql, calls } = fakeSql(() => ({ rows: [] }));
  const res = await appendRunEvent(
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
    7,
    { type: "tool_use", name: "Bash", input: { command: "pnpm -r test" } },
    { sql },
  );
  assert.equal(res.ok, true);
  const call = calls.at(-1);
  assert.match(call?.text ?? "", /INSERT INTO forge_events/);
  assert.equal(call?.params?.[2], "22222222-2222-2222-2222-222222222222"); // run_id
  assert.equal(call?.params?.[3], 7); // seq — the caller owns it
  assert.match(String(call?.params?.[4]), /"type":"tool_use"/);
});

// sinceSeq being EXCLUSIVE is the whole resume contract: a client that rendered
// up to N must receive N+1 onward — no duplicate, no gap.
test("readRunEvents resumes strictly AFTER sinceSeq, in order", async () => {
  const { sql, calls } = fakeSql(() => ({
    rows: [
      { run_id: "r1", seq: 4, event: { type: "text", delta: "d" }, created_at: "2024-01-01T00:00:00.000Z" },
      { run_id: "r1", seq: 5, event: { type: "result", ok: true }, created_at: "2024-01-01T00:00:01.000Z" },
    ],
  }));
  const res = await readRunEvents("r1", 3, { sql });
  assert.equal(res.ok, true);
  assert.deepEqual(res.ok ? res.data.map((e) => e.seq) : [], [4, 5]);
  const call = calls.at(-1);
  assert.match(call?.text ?? "", /seq > \$2/, "must be exclusive (>), not >=");
  assert.match(call?.text ?? "", /ORDER BY seq ASC/);
  assert.equal(call?.params?.[1], 3);
});

test("readRunEvents parses a jsonb column delivered as a string", async () => {
  const { sql } = fakeSql(() => ({
    rows: [{ run_id: "r1", seq: 1, event: '{"type":"text","delta":"hola"}', created_at: "2024-01-01T00:00:00.000Z" }],
  }));
  const res = await readRunEvents("r1", 0, { sql });
  assert.deepEqual(res.ok ? res.data[0]?.event : null, { type: "text", delta: "hola" });
});

// The bug this test exists for: `seq` restarts at 1 per run, so ordering the
// "which run is newest" query by seq would return whichever run was LONGEST.
test("latestRunForThread picks the NEWEST run, not the longest one", async () => {
  const { sql, calls } = fakeSql((call) =>
    call.text.includes("LIMIT 1")
      ? { rows: [{ run_id: "newest-run" }] }
      : { rows: [{ last_seq: 2, terminal: 0 }] },
  );
  const res = await latestRunForThread("t1", { sql });
  assert.deepEqual(res.ok ? res.data : null, { runId: "newest-run", lastSeq: 2, finished: false });
  const pick = calls[0];
  assert.match(pick?.text ?? "", /ORDER BY created_at DESC/, "created_at must be the FIRST ordering key");
  assert.equal(/ORDER BY seq DESC/.test(pick?.text ?? ""), false, "seq must not lead the ordering");
});

test("latestRunForThread reports finished when a terminal event is stored", async () => {
  const { sql } = fakeSql((call) =>
    call.text.includes("LIMIT 1") ? { rows: [{ run_id: "r" }] } : { rows: [{ last_seq: 9, terminal: 1 }] },
  );
  const res = await latestRunForThread("t1", { sql });
  assert.equal(res.ok && res.data?.finished, true);
  assert.equal(res.ok && res.data?.lastSeq, 9);
});

test("latestRunForThread returns null for a thread with no run events", async () => {
  const { sql } = fakeSql(() => ({ rows: [] }));
  const res = await latestRunForThread("t1", { sql });
  assert.equal(res.ok && res.data, null);
});

// A run is finished when it stored a terminal event. Anything else — including a
// tool still running — is in flight, which is what lets the UI distinguish
// "thinking" from "interrupted by a restart".
test("only result and error end a run", () => {
  assert.equal(isTerminalEvent({ type: "result", ok: true } as never), true);
  assert.equal(isTerminalEvent({ type: "error", message: "boom" } as never), true);
  for (const live of [
    { type: "text", delta: "x" },
    { type: "tool_use", name: "Read", input: {} },
    { type: "tool_result", name: "Read", ok: true },
    { type: "session", sessionId: "s" },
    { type: "gate", specId: "0127" },
  ]) {
    assert.equal(isTerminalEvent(live as never), false, live.type);
  }
});

test("a store failure degrades rather than throwing (the module's contract)", async () => {
  const sql: SqlClient = {
    async query() {
      throw new Error("connection refused");
    },
  };
  const appended = await appendRunEvent("t", "r", 1, { type: "text", delta: "x" }, { sql });
  const read = await readRunEvents("r", 0, { sql });
  assert.equal(appended.ok, false);
  assert.equal(read.ok, false);
});
