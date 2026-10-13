/**
 * The pure SSE-`SupervisorEvent[]` → assistant-message-content fold for the
 * Forge chat runtime adapter (spec 0067 phase 1, items 4–5). Kept here in
 * `lib` (framework-free, no `@assistant-ui/react` import) so it compiles under
 * `tsconfig.test.json` and runs under `node --test` — the fold is the
 * unit-testable heart of item 4's `ChatModelAdapter.run()` (the React shell in
 * `components/forge/ForgeChat.tsx` calls this; the shell itself is coder-owned
 * with the dependency add).
 *
 * See `docs/assistant-ui-0.14-reference.md` — the crux: `run()` yields a
 * CUMULATIVE `content` array re-sent each yield (not deltas), so the adapter
 * folds the running `SupervisorEvent` list into the whole content array each
 * time. This module defines that fold as `SupervisorEvent[] → content[]`.
 *
 * The local {@link ForgeAssistantContentPart} shapes mirror assistant-ui
 * 0.14.27's `TextMessagePart` / `ToolCallMessagePart` (reference §"Content part
 * shapes") structurally, so a value produced here is assignable to
 * assistant-ui's `ThreadAssistantMessagePart` when item 4 wires the runtime —
 * no need to import the library here.
 */
import type { SupervisorEvent } from "@launchpad/agents";

/** Mirrors assistant-ui 0.14.27 `TextMessagePart`. */
export interface ForgeTextPart {
  type: "text";
  text: string;
}

/** Mirrors assistant-ui 0.14.27 `ToolCallMessagePart` (the subset we set). Both
 * real tool calls (`Bash`/`Read`/…) and the SYNTHETIC marker tools
 * ({@link SYNTHETIC_TOOL_NAMES}) are rendered as tool-call parts; item 5's
 * `makeAssistantToolUI` wrappers key off `toolName`. */
export interface ForgeToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  argsText: string;
  result?: unknown;
  isError?: boolean;
}

export type ForgeAssistantContentPart = ForgeTextPart | ForgeToolCallPart;

/**
 * Fixed tool names for the SYNTHETIC tool-call parts the marker events
 * (`gate` / `spec_draft` / `watch_run` / `architect_progress`) become, so item
 * 5's `makeAssistantToolUI` wrappers render the EXISTING cards. Render-only:
 * the cards fire the existing `signalGateAction` / run-route on a human click;
 * mapping an event to a synthetic tool part adds no new signal/spawn call site.
 */
export const SYNTHETIC_TOOL_NAMES = {
  gate: "supervisor_gate",
  specDraft: "spec_draft",
  watchRun: "watch_run",
  architectProgress: "architect_progress",
} as const;

/** The `session` event captured out-of-band (item 3 continuity) — not content,
 * so the fold surfaces the thread's SDK session id separately from the parts. */
export interface FoldResult {
  content: ForgeAssistantContentPart[];
  /** SDK session id from a `{type:"session"}` event, if any arrived. */
  sdkSessionId: string | null;
  /**
   * What the agent is doing RIGHT NOW (spec 0127), or null when it is not in a
   * tool — i.e. thinking, writing, or done. This is the last `tool_use` with no
   * `tool_result` yet, summarised for a status line.
   *
   * The owner asked for a way to see the current step. The tool CARDS already render
   * every call, but a long turn scrolls them out of view, so the one fact worth
   * pinning ("still running `pnpm -r test`") had nowhere to live.
   */
  currentStep: string | null;
}

/** How much of a tool argument may appear in a status line. */
const STEP_DETAIL_MAX = 60;

function truncate(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > STEP_DETAIL_MAX ? `${flat.slice(0, STEP_DETAIL_MAX - 1)}…` : flat;
}

/**
 * One short line describing a tool call: the tool name plus the single argument
 * that says what it is acting on.
 *
 * Deliberately a WHITELIST of fields, never the whole input. A `Write` or `Edit`
 * call carries entire file contents, and an `Edit` carries the replacement text —
 * dumping `input` into the UI would paste a file into a status line, and any
 * secret inside it along with the file.
 */
export function describeStep(toolName: string, input: unknown): string {
  if (!isPlainObject(input)) return toolName;
  const pick = (key: string): string | null => {
    const value = input[key];
    return typeof value === "string" && value.trim() ? truncate(value) : null;
  };
  const detail =
    pick("command") ?? // Bash
    pick("file_path") ?? // Read / Write / Edit
    pick("pattern") ?? // Grep
    pick("path") ?? // Glob / ls
    pick("url") ?? // WebFetch
    pick("query") ?? // WebSearch
    pick("description") ?? // Task / Agent
    pick("specId"); // the synthetic gate/spec-draft/watch-run cards
  return detail ? `${toolName}: ${detail}` : toolName;
}

/** True `SupervisorEvent`'s normalized `tool_use`/`tool_result` carry only a
 * tool `name`, never an SDK call id (see `packages/agents/src/
 * supervisor-session.ts` — the id is stripped when normalizing). The bridge
 * runs one tool at a time (no concurrent tool calls), so pairing the newest
 * still-unresolved tool-call part with a matching `toolName` is unambiguous;
 * this synthesizes assistant-ui's required `toolCallId` (never used to pair
 * anything upstream, only as this fold's own React-key-shaped id). */
function findPendingToolCall(
  content: ForgeAssistantContentPart[],
  toolName: string,
): ForgeToolCallPart | undefined {
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (part && part.type === "tool-call" && part.toolName === toolName && part.result === undefined) return part;
  }
  return undefined;
}

/**
 * Fold the running list of `SupervisorEvent`s into the cumulative assistant
 * content array (+ the captured SDK session id). Pure and total, so it is
 * unit-tested without a live stream:
 *  - `text` → append to the trailing text part (create one if needed);
 *  - `tool_use` → push a tool-call part; `tool_result` → set `result`/`isError`
 *    on the matching `toolCallId`;
 *  - marker events (`gate`/`spec_draft`/`watch_run`) → push a synthetic
 *    tool-call part named per {@link SYNTHETIC_TOOL_NAMES} with the event
 *    payload as `args` (each fires at most once per turn);
 *  - `architect_progress` → coalesces into a TRAILING synthetic tool-call part
 *    (same mechanism as `text`, not a new part per delta) so the streamed
 *    architect briefing renders as one growing block, not one card per delta
 *    — item 5's tool UI reads its accumulated `args.delta`;
 *  - `spawn_architect` → no content (pure orchestration signal; the
 *    `architect_progress`/`spec_draft` events that follow are what render);
 *  - `session` → capture `sdkSessionId` (not content);
 *  - `result` → terminal, no content change (the adapter ends the generator);
 *  - `error` → surfaces as a trailing text part.
 */
export function foldSupervisorEvents(events: readonly SupervisorEvent[]): FoldResult {
  const content: ForgeAssistantContentPart[] = [];
  let sdkSessionId: string | null = null;
  let nextToolCallId = 0;
  // Spec 0127: set when a tool starts, cleared when it reports back or the turn
  // ends — so it always answers "what is happening now", never "what happened".
  let currentStep: string | null = null;

  function appendText(text: string): void {
    const last = content[content.length - 1];
    if (last && last.type === "text") {
      last.text += text;
    } else {
      content.push({ type: "text", text });
    }
  }

  function pushToolCall(toolName: string, args: Record<string, unknown>): ForgeToolCallPart {
    const part: ForgeToolCallPart = {
      type: "tool-call",
      toolCallId: `tool-${nextToolCallId++}`,
      toolName,
      args,
      argsText: JSON.stringify(args),
    };
    content.push(part);
    return part;
  }

  for (const event of events) {
    switch (event.type) {
      case "text":
        appendText(event.delta);
        break;
      case "tool_use":
        pushToolCall(event.name, isPlainObject(event.input) ? event.input : {});
        currentStep = describeStep(event.name, event.input);
        break;
      case "tool_result": {
        const pending = findPendingToolCall(content, event.name);
        if (pending) {
          pending.result = event.output;
          pending.isError = !event.ok;
        }
        currentStep = null;
        break;
      }
      case "gate":
        pushToolCall(SYNTHETIC_TOOL_NAMES.gate, { specId: event.specId });
        break;
      case "spec_draft":
        pushToolCall(SYNTHETIC_TOOL_NAMES.specDraft, {
          specId: event.specId,
          specPath: event.specPath,
          title: event.title,
          summary: event.summary,
          model: event.model,
        });
        break;
      case "watch_run":
        pushToolCall(SYNTHETIC_TOOL_NAMES.watchRun, { specId: event.specId });
        break;
      case "architect_progress": {
        const pending = findPendingToolCall(content, SYNTHETIC_TOOL_NAMES.architectProgress);
        const delta = (typeof pending?.args["delta"] === "string" ? pending.args["delta"] : "") + event.delta;
        if (pending) {
          pending.args = { delta };
          pending.argsText = JSON.stringify(pending.args);
        } else {
          pushToolCall(SYNTHETIC_TOOL_NAMES.architectProgress, { delta });
        }
        break;
      }
      case "session":
        sdkSessionId = event.sessionId;
        break;
      case "spawn_architect":
        break;
      case "result":
        currentStep = null;
        break;
      case "error":
        appendText(event.message);
        currentStep = null;
        break;
    }
  }

  return { content, sdkSessionId, currentStep };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One persisted message, replayed into the runtime on thread-open (spec 0067
 * item 6). Structurally a subset of `lib/chat-store.ts`'s `ForgeMessage` —
 * duck-typed rather than imported so this module stays decoupled from the
 * `pg`-backed store (mirrors how `ForgeAssistantContentPart` mirrors
 * assistant-ui's part shapes instead of importing the library). */
export interface ReplayableMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  events: SupervisorEvent[] | null;
}

/** Mirrors assistant-ui 0.14.27's `ThreadMessageLike` (the subset `runtime.
 * thread.reset()` needs): a user message replays its stored prompt verbatim;
 * an assistant message replays through the SAME fold the live stream uses, so
 * a reopened thread re-renders the identical event→card mapping. */
export interface ForgeThreadMessageLike {
  id: string;
  role: "user" | "assistant";
  content: string | ForgeAssistantContentPart[];
}

/** Maps a thread's stored messages (insertion order) to the shape
 * `runtime.thread.reset()` expects for replay. */
export function toInitialMessages(messages: readonly ReplayableMessage[]): ForgeThreadMessageLike[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.role === "user" ? message.content : foldSupervisorEvents(message.events ?? []).content,
  }));
}
