"use client";

/**
 * The assistant-ui-based Forge chat shell (spec 0067 items 4–6). Replaces the
 * hand-rolled SSE reader + turn state in `SupervisorConsole.tsx` with
 * `useLocalRuntime` + a custom `ChatModelAdapter`: the SAME `/api/supervisor`
 * bridge and SSE `SupervisorEvent` read loop (`SupervisorConsole.sendPrompt`'s
 * parsing, reused verbatim below), folded into assistant-ui content parts by
 * `foldSupervisorEvents` (`lib/forge-chat-runtime.ts`).
 *
 * Text/tool-call parts stream end-to-end for a plain conversation, and the
 * SYNTHETIC marker parts (`supervisor_gate`/`spec_draft`/`watch_run`/
 * `architect_progress`) render as the EXISTING cards via the `makeAssistant
 * ToolUI` wrappers in `ForgeToolUIs.tsx` (spec 0067 item 5 — see
 * `docs/assistant-ui-0.14-reference.md` §"Generative cards").
 *
 * **Thread persistence + history (item 6):** a sidebar lists threads from
 * `GET /api/supervisor/threads`; opening one replays its stored messages via
 * `runtime.thread.reset(toInitialMessages(...))` (the SAME
 * `foldSupervisorEvents` the live stream uses, so a reopened thread
 * re-renders the identical event→card mapping — `lib/forge-chat-runtime.ts`).
 * A fresh mount starts with NO active thread (an unsaved conversation,
 * matching "a new empty chat per conversation"); the first message of that
 * conversation lazily creates a real thread (`POST .../threads`) so it
 * appears in history from then on — every subsequent turn passes `threadId`
 * to `/api/supervisor`, which is what item 3's `resume` continuity keys off.
 * "New chat" resets back to that same unsaved state. Any thread-route fetch
 * failure (Postgres unreachable) degrades to an ephemeral notice rather than
 * blocking the composer (spec §3 "degrade, don't block") — the bridge itself
 * already tolerates a missing `threadId`.
 *
 * **Mount points (spec 0081, C.2):** `/forge` renders this unscoped (every
 * thread), and the project workspace's "Chats · sdd" tab renders it with a
 * `projectId`, which scopes both the sidebar list and newly-created threads to
 * that project. C.3 retires the standalone `/forge` surface, leaving the
 * workspace tab as the only mount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  useMessagePart,
  useThread,
  type ChatModelAdapter,
  type ChatModelRunOptions,
  type ChatModelRunResult,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { SupervisorEvent } from "@launchpad/agents";
import { Btn } from "../ui";
import type { ChatStoreResult, ForgeMessage, ForgeThread } from "../../lib/chat-store";
import { describeStep, foldSupervisorEvents, toInitialMessages, type ForgeAssistantContentPart } from "../../lib/forge-chat-runtime";
import { AgentElementsToolRow } from "./AgentElementsToolRow";
import {
  ArchitectProgressToolUI,
  AskUserQuestionToolUI,
  ProjectSlugContext,
  QuestionThreadContext,
  SpecDraftToolUI,
  SupervisorGateToolUI,
  WatchRunToolUI,
} from "./ForgeToolUIs";

/** Thin fetch wrappers over the item-2 thread routes — each returns `null` on
 * any failure (network error, non-2xx, or a `{ok:false}` store result) so
 * callers degrade instead of throwing (spec §3 "degrade, don't block"). */
async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(input, init);
    if (!res.ok) return null;
    const result = (await res.json()) as ChatStoreResult<T>;
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

/** Spec 0081 (C.2): `projectId` scopes the sidebar + new threads to one
 * project (the workspace "Chats · sdd" tab). Nullish = the unscoped list the
 * standalone `/forge` console still uses. */
function fetchThreads(projectId?: string | null): Promise<ForgeThread[] | null> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  return fetchJson<ForgeThread[]>(`/api/supervisor/threads${query}`);
}

function createThreadRequest(
  firstPrompt: string,
  projectId?: string | null,
  branch?: string | null,
): Promise<ForgeThread | null> {
  return fetchJson<ForgeThread>("/api/supervisor/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firstPrompt, projectId: projectId ?? null, branch: branch ?? null }),
  });
}

function fetchThreadMessages(id: string): Promise<ForgeMessage[] | null> {
  return fetchJson<ForgeMessage[]>(`/api/supervisor/threads/${id}`);
}

async function deleteThreadRequest(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/supervisor/threads/${id}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

/** `lib/forge-chat-runtime.ts` deliberately stays framework-free (no
 * `@assistant-ui/react` import, so it compiles under `tsconfig.test.json`) —
 * its `args: Record<string, unknown>` is looser than assistant-ui's
 * `ReadonlyJSONObject`. Every value this fold ever puts in `args` (event
 * payloads: strings, and the plain JSON `tool_use.input`) IS JSON-safe; this
 * is the one place the two type systems meet, so the cast is bridged here
 * instead of loosening the library's stricter type. */
function toRuntimeContent(content: ForgeAssistantContentPart[]): ChatModelRunResult["content"] {
  return content as unknown as ChatModelRunResult["content"];
}

/** The bridge takes one NL prompt per turn — the newest user message's text
 * (assistant-ui hands the adapter the full conversation so far). */
function latestUserPrompt(messages: ChatModelRunOptions["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    return message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

/** The adapter needs the ACTIVE thread id at run time, which changes over the
 * session (sidebar selection, lazy-create on first message) — passed as a
 * getter/setter pair (backed by refs in `ForgeChat`) rather than recreating
 * the adapter/runtime on every thread switch. */
interface ThreadHooks {
  getActiveThreadId: () => string | null;
  /** Called once, the first time a brand-new (never-yet-persisted)
   * conversation sends its first message — lazily creates the real thread row
   * so "a new empty chat per conversation" persists from its first turn. */
  onThreadCreated: (thread: ForgeThread) => void;
  /** Spec 0127: the tool the agent is currently inside, or null between tools
   * and when the turn ends. Drives the status line above the composer. */
  onStep: (step: string | null) => void;
  /** Spec 0127: the server's id for this run, so a reload or tab change can
   * reattach to a turn that is still going instead of losing it. */
  onRunId: (runId: string | null) => void;
  /** Spec 0135 B: the branch the NEXT new thread binds to (the picker's
   * current value; null for platform chats). */
  getNewChatBranch: () => string | null;
}

function makeForgeChatAdapter(
  hooks: ThreadHooks,
  projectId?: string | null,
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const prompt = latestUserPrompt(messages);
      if (!prompt.trim()) return;

      let threadId = hooks.getActiveThreadId();
      if (!threadId) {
        // Spec 0135 B: a project thread is born bound to the branch the picker
        // holds — read at run time (a ref) so the selection made a moment ago
        // is what the lazily-created thread records.
        const created = await createThreadRequest(prompt, projectId, hooks.getNewChatBranch());
        if (created) {
          threadId = created.id;
          hooks.onThreadCreated(created);
        }
      }

      const res = await fetch("/api/supervisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, threadId: threadId ?? undefined }),
        signal: abortSignal,
      });
      if (!res.ok || !res.body) {
        const message = (await res.text().catch(() => "")) || `request failed (${res.status})`;
        yield { content: [{ type: "text", text: message }] };
        return;
      }
      // Spec 0127: the run now outlives this request, so remember which run it
      // is — that id is what a returning tab reattaches to.
      hooks.onRunId(res.headers.get("X-Run-Id"));

      // Same SSE read loop as SupervisorConsole.sendPrompt: `data: <json>\n\n`
      // frames of a normalized SupervisorEvent.
      const events: SupervisorEvent[] = [];
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          events.push(JSON.parse(dataLine.slice("data: ".length)) as SupervisorEvent);
          const folded = foldSupervisorEvents(events);
          hooks.onStep(folded.currentStep);
          yield { content: toRuntimeContent(folded.content) };
        }
      }
      // The view of the run ended. Whether the RUN ended is a separate question
      // (it may still be going server-side), so the status line is cleared only
      // because this client is no longer watching it.
      hooks.onStep(null);
      hooks.onRunId(null);
    },
  };
}

/** Empty-state hero (DESIGN.md §1.4/§5: `/forge`'s empty state is the ONE
 * Committed cobalt surface). Reuses the existing `.hero`/`.kicker` treatment
 * `ChatThread` already renders for the gate-off front door, so both `/forge`
 * surfaces read as the same product rather than "nothing here". Shown only
 * while the thread has no messages. */
// Spec 0101: restyled off the legacy `.forge-*`/`.msg`/`.composer`/`.hero`
// component classes onto the Mission Control template's tokens. The composer's
// focus ring is `focus-within:border-brand/40` (was a :focus-within box-shadow),
// and the hero reuses the template's own `mc-glow`.
const HINT = "text-xs text-faint";

function EmptyHero() {
  const isEmpty = useThread((t) => t.messages.length === 0);
  if (!isEmpty) return null;
  return (
    <div className="mc-glow mx-auto mt-[7vh] flex max-w-[720px] flex-col items-center gap-5 rounded-xl border border-brand/20 bg-card px-7 py-10 text-center">
      <div className="text-xs text-brand">~/forge ❯</div>
      <h1 className="text-3xl font-bold tracking-[-0.032em] text-balance text-foreground">
        ¿Qué construimos?
      </h1>
    </div>
  );
}

function ForgeUserMessage() {
  return (
    <MessagePrimitive.Root className="flex gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1 text-foreground">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * Spec 0137 C: the transcript's tool timeline. Every generic `tool_use` the
 * fold pushes becomes one compact row — name + whitelisted summary
 * (`describeStep`, never raw input) + outcome dot — collapsed to a single
 * line; the four synthetic cards keep their own richer renderers.
 */
function ToolStepRow() {
  const part = useMessagePart();
  if (part.type !== "tool-call") return null;
  const summary = describeStep(part.toolName, part.args as Record<string, unknown>);
  const finished = part.result !== undefined;
  const failed = part.isError === true;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/60 bg-surface/40 px-2.5 py-1 text-[12px] text-muted">
      <span
        className={`h-1.5 w-1.5 flex-none rounded-full ${
          failed ? "bg-red-500" : finished ? "bg-emerald-500" : "bg-amber-400 animate-pulse"
        }`}
      />
      <span className="truncate">{summary ?? part.toolName}</span>
    </div>
  );
}

function ForgeAssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1 text-muted">
        {/* Spec 0144 D: Agent Elements cards replace the one-line dot rows. */}
        <MessagePrimitive.Parts components={{ tools: { Fallback: AgentElementsToolRow } }} />
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * The agent's current step (spec 0127). The owner could see text arrive but not what the
 * agent was DOING, and a long turn scrolls its tool cards out of view — so this
 * one line is pinned directly above the composer, where the eye already is.
 *
 * Spec 0147: three-way render. A tool is active ⇒ the summary bar. No tool but
 * the turn is still running ⇒ a quiet "Pensando…" bar (the gaps between tools no
 * longer flash an empty space). Idle ⇒ nothing. The `.mc-ellipsis` "…" freezes
 * to static text under `prefers-reduced-motion` (globals.css:163), so AC5 holds
 * with no new CSS.
 */
function CurrentStep({ step }: { step: string | null }) {
  const isRunning = useThread((t) => t.isRunning);
  if (!step) {
    if (!isRunning) return null;
    return (
      <div
        className="sticky bottom-[76px] mx-auto flex max-w-full items-center gap-2 rounded-lg border border-border bg-card/95 px-3 py-1.5 text-xs text-muted"
        aria-live="polite"
      >
        {/* AC5 (gate-2 review): `.mc-ellipsis` freezes under prefers-reduced-motion
            (globals.css) but Tailwind's `animate-pulse` does NOT — so the text went
            static while the dot kept pulsing, and AC5 asks the indicator to degrade
            as a whole. `motion-reduce:` rather than a new `.mc-*` class because it is
            one utility on one element. FLAGGED, not fixed here: the same gap exists on
            every other `animate-pulse`/`animate-spin` in the repo (twice more in this
            file, plus /new, DeployTenantForm, agent-elements) — pre-existing. */}
        <span
          className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-brand motion-reduce:animate-none"
          aria-hidden
        />
        <span className="mc-ellipsis truncate text-[11px]">Pensando</span>
      </div>
    );
  }
  return (
    <div
      className="sticky bottom-[76px] mx-auto flex max-w-full items-center gap-2 rounded-lg border border-border bg-card/95 px-3 py-1.5 text-xs text-muted"
      aria-live="polite"
    >
      <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-brand" aria-hidden />
      <span className="truncate font-mono text-[11px]">{step}</span>
    </div>
  );
}

export function ForgeChat({
  projectId,
  projectSlug = null,
  branches = [],
}: {
  projectId?: string | null;
  /** Spec 0224: the URL slug. `null` on the platform console, which has no
   * project — the one place an unscoped spec lookup is correct. */
  projectSlug?: string | null;
  branches?: string[];
} = {}) {
  const [threads, setThreads] = useState<ForgeThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  // Spec 0135 B: the branch a NEW chat will bind to. Defaults to the first
  // unmerged branch; a ref mirrors it so the adapter's run() reads the value
  // picked a moment ago without waiting for a re-render.
  const [newChatBranch, setNewChatBranch] = useState<string | null>(branches[0] ?? null);
  const newChatBranchRef = useRef<string | null>(branches[0] ?? null);
  function pickNewChatBranch(branch: string | null) {
    newChatBranchRef.current = branch;
    setNewChatBranch(branch);
  }
  // Spec 0127: what the agent is doing right now, and which server-side run is
  // producing it.
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  // The adapter reads this at run time (see ThreadHooks doc above) — a ref,
  // not the `activeThreadId` state, so a lazily-created thread's id is visible
  // to the SAME run() call that created it without waiting for a re-render.
  const activeThreadIdRef = useRef<string | null>(null);

  const refreshThreads = useCallback(async () => {
    const loaded = await fetchThreads(projectId);
    setHistoryUnavailable(loaded === null);
    if (loaded) setThreads(loaded);
  }, [projectId]);

  // Spec 0137 A: reattach to a turn still running server-side (spec 0127 built
  // the durable stream; this is the client finally using it). Opening a thread
  // asks the stream route for its latest run — live means tail it from seq 0
  // into a compact panel; when the turn ends, the finished message is in the
  // store, so a message reload shows the full transcript.
  const [liveTail, setLiveTail] = useState<{
    runId: string;
    step: string | null;
    text: string;
    count: number;
  } | null>(null);
  const reattachAbortRef = useRef<AbortController | null>(null);
  /** The stored messages currently in the thread — what a live reattach builds on. */
  const initialMessagesRef = useRef<ThreadMessageLike[]>([]);

  const loadThreadMessages = useCallback(
    async (id: string): Promise<ThreadMessageLike[]> => {
      const messages = await fetchThreadMessages(id);
      const initial = messages ? (toInitialMessages(messages) as unknown as ThreadMessageLike[]) : [];
      runtime.thread.reset(initial);
      return initial;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const reattach = useCallback(
    async (threadId: string) => {
      reattachAbortRef.current?.abort();
      const controller = new AbortController();
      reattachAbortRef.current = controller;
      setLiveTail(null);
      try {
        const res = await fetch(`/api/supervisor/stream?threadId=${encodeURIComponent(threadId)}`, {
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return; // no run / store down — nothing to show
        const runId = res.headers.get("X-Run-Id");
        if (res.headers.get("X-Run-Live") !== "1" || !runId) {
          // A finished run's transcript is already in the thread's messages; a
          // replay here would show the last turn twice.
          void res.body.cancel();
          return;
        }
        // Spec 0144 C: the in-flight turn folds into the TRANSCRIPT — the owner's
        // "reconnecting should load message history". The stored messages are
        // already in the thread; the live run's replayed+following events
        // become one growing assistant message, exactly what the adapter
        // would have produced had the tab never closed. The question card
        // (0144 B) rides along and stays answerable after a reload.
        const initial = initialMessagesRef.current;
        const events: SupervisorEvent[] = [];
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
            if (!dataLine) continue;
            const event = JSON.parse(dataLine.slice("data: ".length)) as SupervisorEvent;
            events.push(event);
            const folded = foldSupervisorEvents(events);
            runtime.thread.reset([
              ...initial,
              {
                id: `live-${runId}`,
                role: "assistant",
                content: folded.content,
              } as unknown as ThreadMessageLike,
            ]);
            setLiveTail({ runId, step: folded.currentStep, text: "", count: events.length });
          }
        }
        // Terminal (or the stream closed): the finished turn is stored now.
        setLiveTail(null);
        await loadThreadMessages(threadId);
      } catch {
        // Aborted (thread switch) or network — the panel simply goes away.
        setLiveTail(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadThreadMessages],
  );

  async function stopLiveRun() {
    const runId = liveTail?.runId ?? activeRunIdRef.current;
    if (!runId) return;
    try {
      await fetch("/api/supervisor/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
    } catch {
      // The panel clears when the stream ends server-side either way.
    }
  }

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  // Spec 0144 C: a reload reopens the thread named in the URL — including its
  // in-flight run, which reattach folds back into the transcript.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("chat");
    if (wanted) openThread(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const adapter = useMemo(
    () =>
      makeForgeChatAdapter(
        {
          getActiveThreadId: () => activeThreadIdRef.current,
          onThreadCreated: (thread) => {
            activeThreadIdRef.current = thread.id;
            setActiveThreadId(thread.id);
            setThreads((prev) => [thread, ...prev]);
          },
          onStep: setCurrentStep,
          onRunId: (runId) => {
            activeRunIdRef.current = runId;
          },
          getNewChatBranch: () => newChatBranchRef.current,
        },
        projectId,
      ),
    [projectId],
  );
  const runtime = useLocalRuntime(adapter);

  // A stream in flight is still yielding into the CURRENT thread's message
  // list; resetting it out from under that generator (switching/clearing
  // threads mid-turn) would corrupt whichever conversation is reset to, so
  // every thread-switching action no-ops while a turn is running — the same
  // busy-guards-re-entry discipline `SupervisorConsole`'s `busy` flag and
  // `RunFollowCard`'s Diagnose button already use.
  function isBusy(): boolean {
    return runtime.thread.getState().isRunning;
  }

  function startNewChat() {
    if (isBusy()) return;
    reattachAbortRef.current?.abort();
    setLiveTail(null);
    activeThreadIdRef.current = null;
    setActiveThreadId(null);
    initialMessagesRef.current = [];
    const url = new URL(window.location.href);
    url.searchParams.delete("chat");
    window.history.replaceState(null, "", url);
    runtime.thread.reset([]);
  }

  function openThread(id: string) {
    if (id === activeThreadId || isBusy()) return;
    activeThreadIdRef.current = id;
    setActiveThreadId(id);
    // Spec 0144 C: the open thread lives in the URL, so a reload comes BACK
    // here (with ?tab=chats from 0143) instead of dropping to a blank chat.
    const url = new URL(window.location.href);
    url.searchParams.set("chat", id);
    window.history.replaceState(null, "", url);
    void loadThreadMessages(id).then((initial) => {
      initialMessagesRef.current = initial;
      return reattach(id);
    });
  }

  async function removeThread(id: string) {
    if (id === activeThreadId && isBusy()) return;
    if (!(await deleteThreadRequest(id))) return;
    setThreads((prev) => prev.filter((t) => t.id !== id));
    if (id === activeThreadId) startNewChat();
  }

  return (
    <QuestionThreadContext.Provider value={activeThreadId}>
    <ProjectSlugContext.Provider value={projectSlug}>
    <AssistantRuntimeProvider runtime={runtime}>
      {/* Rendering each registers its toolName's renderer (spec 0067 item 5) —
          no visual output of its own; MessagePrimitive.Parts dispatches
          matching tool-call parts to them automatically. */}
      <SupervisorGateToolUI />
      <SpecDraftToolUI />
      <WatchRunToolUI />
      <ArchitectProgressToolUI />
      {/* Spec 0144 B: the question card answers through the thread's live run. */}
      <AskUserQuestionToolUI />
      <div className="flex items-start gap-6">
        <aside className="flex w-[220px] flex-none flex-col gap-3">
          <Btn className="h-8 px-3 text-xs" onClick={startNewChat}>
            + Nuevo chat
          </Btn>
          {historyUnavailable && (
            <p className={HINT}>History unavailable — chat still works, just not saved.</p>
          )}
          <ul className="flex flex-col gap-0.5">
            {threads.map((t) => (
              <li
                key={t.id}
                className={`flex items-center gap-2 rounded-lg hover:bg-card-hover ${
                  t.id === activeThreadId ? "bg-card-hover" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => openThread(t.id)}
                  className={`min-w-0 flex-1 truncate px-3 py-2 text-left text-[13px] ${
                    t.id === activeThreadId ? "font-semibold text-foreground" : "text-muted"
                  }`}
                >
                  {t.title}
                  {t.branch ? (
                    <span className="ml-1.5 rounded bg-brand/10 px-1 py-px text-[10px] text-brand">
                      {t.branch}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${t.title}`}
                  onClick={() => void removeThread(t.id)}
                  className="flex-none px-2 py-1 text-faint hover:text-rose"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <ThreadPrimitive.Root className="mx-auto min-w-0 max-w-[760px] flex-1">
          <ThreadPrimitive.Viewport className="my-6 flex flex-col gap-5">
            <EmptyHero />
            <ThreadPrimitive.Messages
              components={{ UserMessage: ForgeUserMessage, AssistantMessage: ForgeAssistantMessage }}
            />
          </ThreadPrimitive.Viewport>
          {/* Spec 0137 A: a turn that survived a tab switch/reload — the 0127
              durable stream, finally visible. Compact on purpose: when it
              ends, the stored message renders the full transcript. */}
          {liveTail ? (
            <div className="mb-2 rounded-xl border border-amber-400/40 bg-amber-400/[0.06] px-4 py-3 text-[12.5px]">
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-amber-400" />
                <span className="text-foreground">
                  Turno en curso — reconectado ({liveTail.count} eventos)
                </span>
                <button
                  type="button"
                  onClick={() => void stopLiveRun()}
                  className="ml-auto rounded-md border border-rose/40 px-2 py-0.5 text-[11px] text-rose hover:bg-rose/10"
                >
                  Detener
                </button>
              </div>
              {liveTail.step ? <p className="mt-1 text-muted">{liveTail.step}</p> : null}
              {liveTail.text ? (
                <p className="mt-1 whitespace-pre-wrap break-words text-muted">{liveTail.text}</p>
              ) : null}
            </div>
          ) : null}
          {/* Spec 0127: the current step, pinned above the composer so it stays
              visible when a long turn has scrolled its tool cards away. */}
          <CurrentStep step={currentStep} />
          {currentStep && activeRunIdRef.current ? (
            <div className="mb-2 text-right">
              <button
                type="button"
                onClick={() => void stopLiveRun()}
                className="rounded-md border border-rose/40 px-2 py-0.5 text-[11px] text-rose hover:bg-rose/10"
              >
                Detener turno
              </button>
            </div>
          ) : null}
          {/* Spec 0135 B: a project chat operates over ONE branch. A new chat
              picks it here (creation lives in Ramas & builds); an open thread
              shows the branch it was born with. */}
          {projectId && !activeThreadId ? (
            branches.length > 0 ? (
              <div className="mb-2 flex items-center gap-2 text-[12px] text-muted">
                <span>Rama:</span>
                <select
                  className="rounded-lg border border-border bg-card px-2 py-1 text-[12px] text-foreground outline-none focus:border-brand/40"
                  value={newChatBranch ?? ""}
                  onChange={(e) => pickNewChatBranch(e.target.value || null)}
                  aria-label="Rama del chat"
                >
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="mb-2 text-[12px] text-muted">
                Este proyecto no tiene ramas abiertas — créala primero en Ramas &amp; builds.
              </p>
            )
          ) : null}
          {projectId && activeThreadId ? (
            (() => {
              const branch = threads.find((t) => t.id === activeThreadId)?.branch;
              return branch ? (
                <p className="mb-2 text-[12px] text-muted">
                  Rama del chat: <code className="text-brand">{branch}</code>
                </p>
              ) : null;
            })()
          ) : null}
          {/* Spec 0183: `items-start` pins Send to the TOP of the row, so it stays
              where the cursor last saw it as the textarea grows. With `items-end`
              the button slides down line by line and a click aimed at it lands in
              the textarea and silently does nothing — it cost two sends during the
              A/B test, to someone who knew why it was happening. */}
          <ComposerPrimitive.Root className="sticky bottom-5 flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors focus-within:border-brand/40">
            <ComposerPrimitive.Input
              placeholder="Describe el cambio que quieres en este proyecto…"
              rows={1}
              className="max-h-60 flex-1 resize-none border-0 bg-transparent py-2 text-foreground placeholder:text-faint outline-none"
            />
            <ComposerPrimitive.Send
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-brand/50 bg-brand/15 px-3.5 py-2 text-[13px] font-medium text-brand transition-colors hover:bg-brand/25"
              aria-label="Enviar"
            >
              Enviar
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
          <p className={`${HINT} mt-3 text-center`}>
            Las compuertas sólo las dispara un botón que tú presionas — nunca el modelo.
          </p>
        </ThreadPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
    </ProjectSlugContext.Provider>
    </QuestionThreadContext.Provider>
  );
}
