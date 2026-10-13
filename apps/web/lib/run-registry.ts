/**
 * In-flight agent runs, owned by the SERVER rather than by an HTTP request
 * (spec 0127).
 *
 * The bug this exists to kill: `/api/supervisor` wired the SDK turn's
 * `AbortController` to `req.signal` and to the response stream's `cancel()`, so
 * switching tabs — which unmounts the chat and aborts its `fetch` — *killed the
 * agent mid-thought*. A run is not a property of a connection; it is work the
 * server was asked to do.
 *
 * So: a run is started here, iterated in a detached loop, and every event is
 * both persisted (`persist`) and pushed to any current subscribers. A subscriber
 * leaving is nothing more than that. Only {@link RunHandle.stop} — an explicit
 * user action — aborts the producer.
 *
 * Scope, stated honestly: this registry is module state, so it holds for ONE web
 * process. That is already the accepted shape (spec 0125 — git's index lock is
 * per-checkout, so the app runs single-instance), and it survives everything the
 * user does in a browser. What it does NOT survive is a restart of this process,
 * i.e. our own deploys. Because every event is also persisted, that case is
 * recoverable and visible rather than silent: a run with no terminal event and
 * no live handle was interrupted. Moving the producer to a Temporal activity
 * later means writing the same rows — the store is the seam, not this map.
 */
import type { SupervisorEvent } from "@launchpad/agents";
import {
  QUESTION_EXPIRED_NOTICE,
  QUESTION_RUN_STOPPED_NOTICE,
  defaultPendingQuestionDeps,
  type PendingQuestionDeps,
} from "./pending-questions";

/** An event with its position in the run, which is what a resume keys on. */
export interface SequencedEvent {
  seq: number;
  event: SupervisorEvent;
}

/** Notified with each event, then with `null` exactly once when the run ends. */
export type RunSubscriber = (next: SequencedEvent | null) => void;

export interface RunHandle {
  readonly runId: string;
  readonly threadId?: string | undefined;
  /** Everything this run has produced, for a subscriber that arrives late. */
  readonly events: SequencedEvent[];
  /** True once the producer has finished (or been stopped). */
  finished: boolean;
  /** Abort the producer. The ONLY way a run dies early. */
  stop(): void;
  /**
   * Receive events from `sinceSeq` (exclusive) onward: the buffered ones
   * immediately, then live ones as they arrive. Returns an unsubscribe function.
   * Unsubscribing does NOT stop the run — that is the entire point.
   */
  subscribe(sinceSeq: number, subscriber: RunSubscriber): () => void;
}

export interface StartRunOptions {
  runId: string;
  threadId?: string | undefined;
  /** The producer, given the abort signal an explicit stop will fire. */
  produce: (signal: AbortSignal) => AsyncIterable<SupervisorEvent>;
  /** Store one event. Failures are swallowed: a Postgres blip must not kill a
   * live turn (`chat-store`'s degrade-don't-block contract). */
  persist?: (runId: string, seq: number, event: SupervisorEvent) => Promise<unknown>;
  /** Called once when the run ends, with its full event log — where the route
   * writes the completed assistant message and pins the SDK session. */
  onFinish?: (events: SupervisorEvent[]) => Promise<unknown>;
  /** Normalized terminal event for a producer that threw. */
  onError?: (message: string) => SupervisorEvent;
}

const runs = new Map<string, RunHandle>();

/** The live handle for a run, or undefined if this process has none. */
export function getRun(runId: string): RunHandle | undefined {
  return runs.get(runId);
}

/** Live runs, for tests and for a "still working" indicator. */
export function activeRunCount(): number {
  let n = 0;
  for (const handle of runs.values()) if (!handle.finished) n += 1;
  return n;
}

/** Drop a finished run's handle. Called after its subscribers have drained. */
export function forgetRun(runId: string): void {
  const handle = runs.get(runId);
  if (handle?.finished) runs.delete(runId);
}

/**
 * Start a run and return immediately. The producer is iterated in a detached
 * task, so the caller's lifetime — an HTTP request — is irrelevant to it.
 */
export function startRun(opts: StartRunOptions): RunHandle {
  const existing = runs.get(opts.runId);
  if (existing) return existing;

  const abort = new AbortController();
  const events: SequencedEvent[] = [];
  const subscribers = new Set<RunSubscriber>();

  const handle: RunHandle = {
    runId: opts.runId,
    threadId: opts.threadId,
    events,
    finished: false,
    stop() {
      abort.abort();
    },
    subscribe(sinceSeq, subscriber) {
      // Replay first so a late or reconnecting subscriber sees the whole run,
      // then follow. Both happen before any await, so nothing can interleave
      // and produce a gap between the replay and the live feed.
      for (const item of events) {
        if (item.seq > sinceSeq) subscriber(item);
      }
      if (handle.finished) {
        subscriber(null);
        return () => {};
      }
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
  runs.set(opts.runId, handle);

  void (async () => {
    let seq = 0;
    const emit = async (event: SupervisorEvent) => {
      seq += 1;
      const item: SequencedEvent = { seq, event };
      events.push(item);
      if (opts.persist) {
        try {
          await opts.persist(opts.runId, seq, event);
        } catch {
          // Deliberately ignored: losing durability is bad, killing a live
          // turn over it is worse.
        }
      }
      for (const subscriber of [...subscribers]) subscriber(item);
    };

    try {
      for await (const event of opts.produce(abort.signal)) {
        await emit(event);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await emit(opts.onError?.(message) ?? ({ type: "error", message } as SupervisorEvent));
    } finally {
      handle.finished = true;
      if (opts.onFinish) {
        try {
          await opts.onFinish(events.map((e) => e.event));
        } catch {
          // Same reasoning: a persistence failure must not become an unhandled
          // rejection that takes the process with it.
        }
      }
      for (const subscriber of [...subscribers]) subscriber(null);
      subscribers.clear();
    }
  })();

  return handle;
}

// ---------------------------------------------------------------------------
// Spec 0144 B — pending questions.
//
// `AskUserQuestion` blocks the agent's turn inside `canUseTool` until the
// human answers. The promise lives HERE, keyed by thread (one live run per
// thread is the working shape, spec 0127 decision 4): the route registers a
// waiter, the answer endpoint resolves it, and a stop or timeout resolves it
// null — which the session layer turns into a deny with a reason. Never a
// silent skip.
//
// Spec 0220: the map is still where the promise lives, but every entry now also
// leaves a ROW, and each of the four endings — answered, expired, superseded,
// run stopped — updates it. The two SILENT endings (expired, run stopped) also
// append a notice to the thread, because a fallback that looks identical to the
// deliberate case is not observable (verification rule #9).
// ---------------------------------------------------------------------------

type QuestionAnswers = Record<string, string | string[]>;

const pendingQuestions = new Map<
  string,
  {
    resolve: (answers: QuestionAnswers | null) => void;
    timer: NodeJS.Timeout;
    deps: PendingQuestionDeps;
    /** The row's insert. Every later write chains off it, so an ending can
     * never reach the database ahead of the row it resolves — the run-stopped
     * path can fire milliseconds after the question opens. Never rejects. */
    opened: Promise<unknown>;
  }
>();

/**
 * Run `next` once `prev` has settled either way, swallowing its failure: losing
 * a row must never break a live turn (chat-store's degrade-don't-block
 * contract). Never rejects, so the result is safe to chain again.
 */
function afterWrite(prev: Promise<unknown>, next: () => Promise<unknown>): Promise<unknown> {
  return prev.then(next, next).catch((err) => {
    console.warn("[run-registry] pending-question write failed:", err);
  });
}

/** What {@link awaitAnswer} needs to make the question visible outside its
 * thread: who is being asked (null ⇒ everyone, never nobody), where, and what
 * about — never the answers or the option list (spec 0075's metadata rule). */
export interface PendingQuestionInput {
  threadId: string;
  projectId: string | null;
  askedOf: string | null;
  summary: string;
  /** Test seam for the 15-minute fuse. */
  timeoutMs?: number;
}

/** How long a question may wait on the human. Generous — the watchdog is fed
 * while pending (spec 0144), so this is about abandoned tabs, not stalls. */
const QUESTION_TIMEOUT_MS = 15 * 60_000;

/**
 * Register the run's question and wait for the human. One pending question
 * per thread: a second question REPLACES the first (resolving it null), which
 * can only happen if a turn asks twice without awaiting — a bug shape, and
 * losing the stale one is the honest outcome.
 */
export function awaitAnswer(
  question: PendingQuestionInput,
  deps: PendingQuestionDeps = defaultPendingQuestionDeps,
): Promise<QuestionAnswers | null> {
  const { threadId, projectId, askedOf, summary } = question;
  return new Promise((resolve) => {
    const stale = pendingQuestions.get(threadId);
    if (stale) {
      clearTimeout(stale.timer);
      stale.resolve(null);
    }
    // `openPendingQuestion` closes a still-pending row as `superseded` before
    // inserting — the partial unique index leaves it no choice — so the stale
    // branch writes no ending of its own. It must still run AFTER that row's
    // insert, hence the chain.
    const opened = afterWrite(stale?.opened ?? Promise.resolve(), () =>
      deps.open({ threadId, projectId, askedOf, summary }),
    );
    const timer = setTimeout(() => {
      pendingQuestions.delete(threadId);
      // The ending nobody watched. The row records it; the thread notice is
      // what lets a human, reading the chat later, tell "the agent acted on an
      // answer" apart from "the agent acted on nobody's answer".
      void afterWrite(opened, () => deps.resolve(threadId, "expired"));
      void afterWrite(opened, () => deps.notice(threadId, QUESTION_EXPIRED_NOTICE));
      resolve(null);
    }, question.timeoutMs ?? QUESTION_TIMEOUT_MS);
    pendingQuestions.set(threadId, { resolve, timer, deps, opened });
  });
}

/** Resolve the thread's pending question with the user's answers. False when
 * nothing was pending (double-click, or the question already timed out). */
export function answerQuestion(threadId: string, answers: QuestionAnswers): boolean {
  const pending = pendingQuestions.get(threadId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingQuestions.delete(threadId);
  // No thread notice: an answered question is already legible in the chat (the
  // card and the answer the human gave it). Only the silent endings need one.
  void afterWrite(pending.opened, () => pending.deps.resolve(threadId, "answered"));
  pending.resolve(answers);
  return true;
}

/** Deny the thread's pending question, if any — called when its run stops. */
export function denyPendingQuestion(threadId: string): void {
  const pending = pendingQuestions.get(threadId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingQuestions.delete(threadId);
  void afterWrite(pending.opened, () => pending.deps.resolve(threadId, "run_stopped"));
  void afterWrite(pending.opened, () => pending.deps.notice(threadId, QUESTION_RUN_STOPPED_NOTICE));
  pending.resolve(null);
}

/** The threads with a question waiting RIGHT NOW, in this process.
 *
 * The read path intersects the unresolved rows with these: a row whose thread
 * is not here belongs to a run this process no longer knows about (a deploy
 * emptied the map), and presenting it as pending would be the stale
 * "requiere tu atención" spec 0122 deleted. */
export function pendingQuestionThreadIds(): string[] {
  return [...pendingQuestions.keys()];
}
