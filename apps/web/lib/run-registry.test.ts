import test from "node:test";
import assert from "node:assert/strict";
import type { SupervisorEvent } from "@launchpad/agents";
import { activeRunCount, forgetRun, getRun, startRun } from "./run-registry";

/** A producer whose events the test releases one at a time, so "the client left
 * mid-run" is a real interleaving rather than a simulated one. */
function controllable() {
  // A counting semaphore, not a single gate: a test may call step() twice before
  // the generator resumes, and each call must still release exactly one event.
  // (The single-gate version silently dropped the second, which made this
  // helper — not the registry — the thing under test.)
  const waiting: (() => void)[] = [];
  let permits = 0;
  const acquire = () => {
    if (permits > 0) {
      permits -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  };
  const step = () => {
    const next = waiting.shift();
    if (next) next();
    else permits += 1;
  };

  const seen: string[] = [];
  let aborted = false;

  async function* produce(signal: AbortSignal): AsyncIterable<SupervisorEvent> {
    signal.addEventListener("abort", () => (aborted = true));
    for (const delta of ["one", "two", "three"]) {
      await acquire();
      if (signal.aborted) return;
      seen.push(delta);
      yield { type: "text", delta };
    }
    yield { type: "result", ok: true } as SupervisorEvent;
  }
  return { produce, step, producedCount: () => seen.length, wasAborted: () => aborted };
}

const settle = () => new Promise((r) => setImmediate(r));

let n = 0;
const nextRunId = () => `run-${(n += 1)}`;

// ---------------------------------------------------------------------------
// THE test for spec 0127. The owner: "after changing the tab inside the UI the progress
// was stopped ... We cannot lose chat progress if the tab is closed."
//
// It asserts the OUTCOME (events keep being produced and persisted after the
// subscriber leaves), not that we avoided calling abort. Asserting the latter
// would prove intent, not behaviour — docs/VERIFICATION.md #1.
// ---------------------------------------------------------------------------
test("a run keeps going and keeps persisting after its subscriber unsubscribes", async () => {
  const persisted: { seq: number; event: SupervisorEvent }[] = [];
  const c = controllable();
  const runId = nextRunId();
  const handle = startRun({
    runId,
    threadId: "t1",
    produce: c.produce,
    persist: async (_rid, seq, event) => void persisted.push({ seq, event }),
  });

  const received: SupervisorEvent[] = [];
  const unsubscribe = handle.subscribe(0, (next) => {
    if (next) received.push(next.event);
  });

  c.step();
  await settle();
  assert.equal(received.length, 1, "subscriber saw the first event");

  // The tab goes away. This is exactly what used to kill the agent.
  unsubscribe();

  c.step();
  c.step();
  await settle();
  await settle();

  assert.equal(c.wasAborted(), false, "the producer was never aborted");
  assert.equal(received.length, 1, "the departed subscriber stopped receiving, as expected");
  assert.ok(c.producedCount() >= 3, `the run kept producing (${c.producedCount()} events)`);
  assert.ok(
    persisted.length >= 3,
    `progress kept landing in the store after the client left (${persisted.length} persisted)`,
  );
  // Sequence numbers are dense and 1-based, which is what a resume relies on.
  assert.deepEqual(
    persisted.map((p) => p.seq).slice(0, 3),
    [1, 2, 3],
  );
});

test("a subscriber that arrives late gets the whole run, then follows live", async () => {
  const c = controllable();
  const handle = startRun({ runId: nextRunId(), produce: c.produce });

  c.step();
  c.step();
  await settle();

  const late: number[] = [];
  handle.subscribe(0, (next) => {
    if (next) late.push(next.seq);
  });
  assert.deepEqual(late, [1, 2], "replayed what it missed, immediately");

  c.step();
  await settle();
  // 3 is the third text event; 4 is the terminal `result`, which the producer
  // yields straight after the loop without waiting for another step.
  assert.deepEqual(late, [1, 2, 3, 4], "then followed live with no gap");
});

test("sinceSeq skips what a reconnecting client already rendered", async () => {
  const c = controllable();
  const handle = startRun({ runId: nextRunId(), produce: c.produce });
  c.step();
  c.step();
  await settle();

  const resumed: number[] = [];
  handle.subscribe(1, (next) => {
    if (next) resumed.push(next.seq);
  });
  assert.deepEqual(resumed, [2], "seq 1 was already seen, so only 2 replays");
});

test("stop() is the ONLY thing that ends a run early, and it aborts the producer", async () => {
  const c = controllable();
  const handle = startRun({ runId: nextRunId(), produce: c.produce });
  c.step();
  await settle();

  handle.stop();
  c.step();
  await settle();
  await settle();

  assert.equal(c.wasAborted(), true);
  assert.equal(handle.finished, true);
});

test("subscribers are told the run ended, exactly once", async () => {
  const c = controllable();
  const handle = startRun({ runId: nextRunId(), produce: c.produce });
  let ends = 0;
  handle.subscribe(0, (next) => {
    if (next === null) ends += 1;
  });
  for (let i = 0; i < 4; i += 1) {
    c.step();
    await settle();
  }
  await settle();
  assert.equal(handle.finished, true);
  assert.equal(ends, 1);
});

test("subscribing to an already-finished run replays it and ends immediately", async () => {
  const c = controllable();
  const handle = startRun({ runId: nextRunId(), produce: c.produce });
  for (let i = 0; i < 4; i += 1) {
    c.step();
    await settle();
  }
  await settle();

  const seen: (number | null)[] = [];
  handle.subscribe(0, (next) => seen.push(next ? next.seq : null));
  assert.deepEqual(seen.at(-1), null, "ends without waiting for an event that will never come");
  assert.ok(seen.length > 1, "and replayed the run first");
});

// A Postgres blip must not take a live turn with it (chat-store's
// degrade-don't-block contract, extended to the event writer).
test("a persist failure does not stop the run", async () => {
  const c = controllable();
  const handle = startRun({
    runId: nextRunId(),
    produce: c.produce,
    persist: async () => {
      throw new Error("connection refused");
    },
  });
  const received: number[] = [];
  handle.subscribe(0, (next) => {
    if (next) received.push(next.seq);
  });
  c.step();
  c.step();
  await settle();
  assert.deepEqual(received, [1, 2]);
  assert.equal(handle.finished, false);
});

test("a producer that throws yields one terminal error event and finishes", async () => {
  async function* boom(): AsyncIterable<SupervisorEvent> {
    yield { type: "text", delta: "partial" };
    throw new Error("sdk exploded");
  }
  const handle = startRun({ runId: nextRunId(), produce: () => boom() });
  const seen: SupervisorEvent[] = [];
  handle.subscribe(0, (next) => {
    if (next) seen.push(next.event);
  });
  await settle();
  await settle();
  assert.equal(handle.finished, true);
  assert.equal(seen.at(-1)?.type, "error");
  // The partial work survives the failure rather than being discarded.
  assert.equal(seen[0]?.type, "text");
});

test("onFinish receives the full event log once, for the completed-turn write", async () => {
  const c = controllable();
  const logs: SupervisorEvent[][] = [];
  startRun({ runId: nextRunId(), produce: c.produce, onFinish: async (events) => void logs.push(events) });
  for (let i = 0; i < 4; i += 1) {
    c.step();
    await settle();
  }
  await settle();
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.length, 4);
});

test("a run is retrievable by id while live, and forgettable once finished", async () => {
  const c = controllable();
  const runId = nextRunId();
  const handle = startRun({ runId, produce: c.produce });
  assert.equal(getRun(runId), handle, "reattachable by id — this is what a reconnect needs");
  assert.equal(activeRunCount() >= 1, true);

  forgetRun(runId);
  assert.equal(getRun(runId), handle, "a LIVE run is never forgotten");

  for (let i = 0; i < 4; i += 1) {
    c.step();
    await settle();
  }
  await settle();
  forgetRun(runId);
  assert.equal(getRun(runId), undefined);
});

test("starting the same runId twice returns the first handle instead of two producers", async () => {
  const a = controllable();
  const b = controllable();
  const runId = nextRunId();
  const first = startRun({ runId, produce: a.produce });
  const second = startRun({ runId, produce: b.produce });
  assert.equal(second, first);
  a.step();
  await settle();
  assert.equal(b.producedCount(), 0, "the second producer never ran");
});
