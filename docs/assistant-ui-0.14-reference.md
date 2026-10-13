# assistant-ui 0.14.27 — API reference for the Forge chat rebuild (spec 0067)

**Why this file exists:** the coder cannot browse the web, and
`assistant-ui.com` documents a NEWER major API than what this repo installs.
This reference is extracted verbatim from the installed type definitions
(`@assistant-ui/react@0.14.27` → `@assistant-ui/core@0.2.21`). **Trust this
file and `node_modules/.../@assistant-ui/**/dist/*.d.ts`, NOT assistant-ui.com.**

## ⚠️ Version gotcha (the #1 time-sink)

The live docs describe `defineToolkit()` + `Tools()` + `useAui()` and call
`makeAssistantToolUI` "deprecated." **That is a later release.** In **0.14.27**,
`makeAssistantToolUI` is the current, correct, non-deprecated API — use it.
Do NOT chase `defineToolkit`/`Tools()` from the website; verify any symbol
exists by grepping the installed `dist/index.d.ts` before using it.

## The custom runtime (item 4 — this is what to build)

`useLocalRuntime(adapter)` turns a `ChatModelAdapter` into a runtime; wrap the
tree in `AssistantRuntimeProvider`.

```ts
import { useLocalRuntime, AssistantRuntimeProvider, type ChatModelAdapter } from "@assistant-ui/react";

const adapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) { /* see below */ },
};

function ForgeChat() {
  const runtime = useLocalRuntime(adapter);
  return <AssistantRuntimeProvider runtime={runtime}>{/* Thread UI */}</AssistantRuntimeProvider>;
}
```

### ChatModelAdapter — exact shape (core 0.2.21)

```ts
type ChatModelAdapter = {
  run(options: ChatModelRunOptions): Promise<ChatModelRunResult> | AsyncGenerator<ChatModelRunResult, void>;
};

type ChatModelRunOptions = {
  readonly messages: readonly ThreadMessage[];   // full conversation so far
  readonly runConfig: RunConfig;
  readonly abortSignal: AbortSignal;             // wire to fetch({ signal })
  readonly context: ModelContext;
  // ...unstable_* fields (ids) omitted — not needed here
};

type ChatModelRunResult = {
  readonly content?: readonly ThreadAssistantMessagePart[];  // CUMULATIVE, see below
  readonly status?: MessageStatus;
  readonly metadata?: { /* steps, timing, custom, ... */ };
};
```

**THE CRITICAL CONTRACT — content is cumulative, not a delta.** When `run` is
an `AsyncGenerator`, every `yield` carries the ENTIRE assistant message so far
in `content` (the full parts array), not just the new piece. The runtime
replaces the message with each yield. So: keep a mutable `content:
ThreadAssistantMessagePart[]` array in the generator, mutate/append to it as
your source stream arrives, and `yield { content: [...content] }` after each
change.

### Content part shapes (only these two matter for item 4)

```ts
type TextMessagePart = { readonly type: "text"; readonly text: string };

type ToolCallMessagePart<TArgs = ReadonlyJSONObject, TResult = unknown> = {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: TArgs;        // parsed args (partial during streaming)
  readonly argsText: string;   // raw JSON arg text
  readonly result?: TResult;
  readonly isError?: boolean;
  // ...timing/mcp/approval/... all optional, ignore for now
};

type ThreadAssistantMessagePart = TextMessagePart | ToolCallMessagePart | /* reasoning|source|file|image|data|generative */ ...;
```

### Adapter recipe: `/api/supervisor` SSE → cumulative content

`POST /api/supervisor` streams `data: <json>\n\n` frames of the normalized
`SupervisorEvent` union (see `packages/agents/src/supervisor-session.ts`:
`text` | `tool_use` | `tool_result` | `gate` | `spawn_architect` |
`architect_progress` | `spec_draft` | `watch_run` | `session` | `result` |
`error`). This is the SAME read loop `SupervisorConsole.sendPrompt` runs today
— reuse that parsing. Map each event into the cumulative `content` array:

- `text` delta → find/create the trailing `{type:"text"}` part, append to its
  `text`.
- `tool_use` → push a `{type:"tool-call", toolCallId, toolName, args, argsText}`
  part; `tool_result` → set `result`/`isError` on the matching `toolCallId`.
- **marker events** (`gate`, `spec_draft`, `watch_run`, `architect_progress`)
  → push a SYNTHETIC `{type:"tool-call"}` part whose `toolName` is a fixed
  name (`"supervisor_gate"`, `"spec_draft"`, `"watch_run"`,
  `"architect_progress"`) and whose `args` is the event payload. Item 5 renders
  these via `makeAssistantToolUI` (below). This is how the existing cards keep
  working — the marker→card mapping just becomes event→synthetic-tool-part→toolUI.
- `session` → not content; capture `sessionId` for thread persistence.
- `result` → end the generator (return); `error` → yield a final text part
  with the message (or set an error status) and return.

Keep the adapter a pure `SupervisorEvent[] → content` fold so it is unit-testable
without a live stream (mirror `forge-chat-runtime.test.ts`).

## Generative cards (item 5 — `makeAssistantToolUI`)

`makeAssistantToolUI` registers a render-only component for a `toolName`; it
renders nothing itself and must be mounted inside the runtime provider.

```ts
import { makeAssistantToolUI } from "@assistant-ui/react";

const GateToolUI = makeAssistantToolUI<GateArgs, never>({
  toolName: "supervisor_gate",
  render: ({ args, status }) => <GateCard {...args} />,  // reuse the EXISTING card
});
```

`render` receives `ToolCallMessagePartProps<TArgs, TResult>`:
`{ args, argsText, result, toolName, toolCallId, status, addResult, isError, ... }`.
`status.type` is `"running" | "complete" | "incomplete" | "requires-action"`
(`incomplete` carries `reason`). Map the three synthetic tools onto the
EXISTING components — `supervisor_gate` → the gate card
(`resolveSupervisorGateCard` + `GateActionButtons`), `spec_draft` → the
review-only draft card, `watch_run` → `RunFollowCard`. Render-only discipline
holds: cards call the EXISTING `signalGateAction` / run-route on human click;
the tool UI adds no new signal/spawn call site.

## Thread UI primitives (the shell)

`ThreadPrimitive`, `ComposerPrimitive`, `MessagePrimitive` (namespaced
compound components: `ThreadPrimitive.Root/Viewport/Messages`,
`ComposerPrimitive.Root/Input/Send`, `MessagePrimitive.Root/Parts`). They are
headless — style with the repo's Tailwind 4 + DESIGN.md tokens. Start
text-first (item 4): render text parts only, get streaming working end-to-end,
THEN add the tool UIs (item 5). Do not build the sidebar/history until item 6.

## Turn-budget discipline (why the coder stalled before)

Run scoped checks, not the whole monorepo: `pnpm --filter @launchpad/web typecheck`
and `pnpm --filter @launchpad/web test` are far faster than `pnpm -r ...` and
save the turn budget for the integration. Only run `pnpm -r` once before the
final commit.
