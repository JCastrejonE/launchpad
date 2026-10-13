/**
 * Spec 0220 acceptance criteria 3 and 4, and the read path's staleness rule.
 *
 * The four endings are asserted through the INJECTED deps (a fake), which per
 * verification rule #1 proves the call we make and not the contract Postgres
 * imposes — criterion 2 is the live check that covers that, and it is a
 * `(human)` Progress item for exactly this reason.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { PendingQuestionOpen, PendingQuestionRow } from "@launchpad/db";
import {
  QUESTION_EXPIRED_NOTICE,
  actionablePendingQuestions,
  QUESTION_RUN_STOPPED_NOTICE,
  defaultPendingQuestionDeps,
  type PendingQuestionDeps,
} from "./pending-questions";
import { answerQuestion, awaitAnswer, denyPendingQuestion } from "./run-registry";

/** Records every write in order, so a test can assert both WHAT was written and
 * that nothing ran ahead of the insert it depends on. */
function recorder() {
  const writes: string[] = [];
  const opened: PendingQuestionOpen[] = [];
  const notices: { threadId: string; text: string }[] = [];
  const deps: PendingQuestionDeps = {
    async open(question) {
      opened.push(question);
      writes.push(`open:${question.threadId}`);
    },
    async resolve(threadId, resolution) {
      writes.push(`resolve:${threadId}:${resolution}`);
    },
    async notice(threadId, text) {
      notices.push({ threadId, text });
      writes.push(`notice:${threadId}`);
    },
  };
  return { deps, writes, opened, notices };
}

/** Detached writes chain through microtasks; `setImmediate` runs after they drain. */
const settle = () => new Promise((r) => setImmediate(r));

let n = 0;
const nextThreadId = () => `thread-${(n += 1)}`;

const ask = (threadId: string, deps: PendingQuestionDeps, timeoutMs?: number) =>
  awaitAnswer(
    {
      threadId,
      projectId: "project-1",
      askedOf: "owner@example.com",
      summary: "¿Qué alcance?",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
    deps,
  );

// --- criterion 3: every exit path writes its resolution, none deletes -------

test("answering writes resolution = answered", async () => {
  const r = recorder();
  const threadId = nextThreadId();
  const pending = ask(threadId, r.deps);
  await settle();
  assert.deepEqual(r.opened, [
    { threadId, projectId: "project-1", askedOf: "owner@example.com", summary: "¿Qué alcance?" },
  ]);

  assert.equal(answerQuestion(threadId, { "¿Qué alcance?": "sólo el chip" }), true);
  assert.deepEqual(await pending, { "¿Qué alcance?": "sólo el chip" });
  await settle();
  assert.deepEqual(r.writes, [`open:${threadId}`, `resolve:${threadId}:answered`]);
});

test("the timeout writes resolution = expired", async () => {
  const r = recorder();
  const threadId = nextThreadId();
  // The agent still gets `null` — spec 0220 does not change the null semantics.
  assert.equal(await ask(threadId, r.deps, 1), null);
  await settle();
  assert.ok(r.writes.includes(`resolve:${threadId}:expired`), r.writes.join(","));
});

test("a second question on the same thread supersedes the first", async () => {
  const r = recorder();
  const threadId = nextThreadId();
  const first = ask(threadId, r.deps);
  await settle();
  const second = ask(threadId, r.deps);

  // The stale waiter is released with null (the agent proceeds), and the second
  // `open` runs AFTER the first insert — the ending itself is written by that
  // open (`openPendingQuestion` resolves `superseded` before it inserts, which
  // the partial unique index makes mandatory, not a choice).
  assert.equal(await first, null);
  await settle();
  assert.deepEqual(r.writes, [`open:${threadId}`, `open:${threadId}`]);

  answerQuestion(threadId, {});
  await second;
});

test("denyPendingQuestion writes resolution = run_stopped", async () => {
  const r = recorder();
  const threadId = nextThreadId();
  const pending = ask(threadId, r.deps);
  denyPendingQuestion(threadId);
  assert.equal(await pending, null);
  await settle();
  // Ordered after the insert even though the stop landed before it resolved:
  // a run can die milliseconds after its question opens.
  assert.deepEqual(r.writes.slice(0, 2), [`open:${threadId}`, `resolve:${threadId}:run_stopped`]);
});

test("no exit path deletes the row", () => {
  // Structural, and the honest version of the claim: the writer's whole I/O
  // surface is these three calls, so no ending can be recorded by removal.
  assert.deepEqual(Object.keys(defaultPendingQuestionDeps).sort(), ["notice", "open", "resolve"]);
});

// --- criterion 4: the two silent endings leave a readable trace -------------

test("the timeout appends QUESTION_EXPIRED_NOTICE to the thread", async () => {
  const r = recorder();
  const threadId = nextThreadId();
  await ask(threadId, r.deps, 1);
  await settle();
  assert.deepEqual(r.notices, [{ threadId, text: QUESTION_EXPIRED_NOTICE }]);
});

test("a stopped run appends QUESTION_RUN_STOPPED_NOTICE to the thread", async () => {
  const r = recorder();
  const threadId = nextThreadId();
  const pending = ask(threadId, r.deps);
  denyPendingQuestion(threadId);
  await pending;
  await settle();
  assert.deepEqual(r.notices, [{ threadId, text: QUESTION_RUN_STOPPED_NOTICE }]);
});

// --- the read path ---------------------------------------------------------

const PROJECTS = [{ id: "p1", slug: "floreria-bella", name: "Florería Bella" }];

const row = (over: Partial<PendingQuestionRow> = {}): PendingQuestionRow => ({
  id: "q1",
  threadId: "t1",
  projectId: "p1",
  askedOf: "owner@example.com",
  summary: "¿Qué alcance?",
  askedAt: new Date("2026-08-19T12:00:00Z"),
  resolvedAt: null,
  resolution: null,
  ...over,
});

const actionable = (over: Partial<Parameters<typeof actionablePendingQuestions>[0]> = {}) =>
  actionablePendingQuestions({
    rows: [row()],
    liveThreadIds: ["t1"],
    projects: PROJECTS,
    viewerEmail: "owner@example.com",
    isPlatformMember: false,
    ...over,
  });

test("an unresolved row whose thread has no live question is NOT actionable", () => {
  // The deploy case: the row outlived the process that owned the question, so
  // nobody is actually waiting. Showing it would be the stale nag of spec 0122.
  assert.deepEqual(actionable({ liveThreadIds: [] }), []);
});

test("an unresolved row with a live question is actionable", () => {
  assert.deepEqual(actionable(), [
    {
      threadId: "t1",
      projectSlug: "floreria-bella",
      projectName: "Florería Bella",
      askedOf: "owner@example.com",
      mine: true,
      summary: "¿Qué alcance?",
      askedAt: "2026-08-19T12:00:00.000Z",
    },
  ]);
});

test("asked_of null renders as everyone's question, never nobody's", () => {
  const [q] = actionable({ rows: [row({ askedOf: null })], viewerEmail: "teammate@example.com" });
  assert.equal(q?.askedOf, null);
  assert.equal(q?.mine, true, "a question nobody was named for is everyone's, including this viewer");
});

test("a question on a project the viewer is not a member of is not returned", () => {
  // Same scoping as every other project read (spec 0143/0144 E): the summary and
  // the person asked are project data. Non-membership is the empty project list.
  assert.deepEqual(actionable({ projects: [] }), []);
  // And a project-less (platform) thread only for a platform member.
  assert.deepEqual(actionable({ rows: [row({ projectId: null })] }), []);
  assert.equal(
    actionable({ rows: [row({ projectId: null })], isPlatformMember: true }).length,
    1,
  );
});
