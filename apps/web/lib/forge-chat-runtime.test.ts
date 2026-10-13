import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupervisorEvent } from "@launchpad/agents";
import {
  SYNTHETIC_TOOL_NAMES,
  describeStep,
  foldSupervisorEvents,
  toInitialMessages,
  type ForgeToolCallPart,
  type ReplayableMessage,
} from "./forge-chat-runtime";

// --- Foundation smoke (spec 0067 items 4–5) — these run now. ----------------

test("synthetic tool names are the fixed marker-tool identifiers item 5 keys off", () => {
  assert.equal(SYNTHETIC_TOOL_NAMES.gate, "supervisor_gate");
  assert.equal(SYNTHETIC_TOOL_NAMES.specDraft, "spec_draft");
  assert.equal(SYNTHETIC_TOOL_NAMES.watchRun, "watch_run");
  assert.equal(SYNTHETIC_TOOL_NAMES.architectProgress, "architect_progress");
});

test("foldSupervisorEvents is total on an empty stream", () => {
  const { content, sdkSessionId } = foldSupervisorEvents([]);
  assert.deepEqual(content, []);
  assert.equal(sdkSessionId, null);
});

// --- The event→content fold coverage (spec 0067 item 4). ---------------------

test("text deltas coalesce into a single trailing text part", () => {
  const events: SupervisorEvent[] = [
    { type: "text", delta: "Hel" },
    { type: "text", delta: "lo" },
  ];
  const { content } = foldSupervisorEvents(events);
  assert.deepEqual(content, [{ type: "text", text: "Hello" }]);
});

test("tool_use then tool_result pair by toolCallId (result + isError set)", () => {
  const events: SupervisorEvent[] = [
    { type: "tool_use", name: "Bash", input: { command: "ls" } },
    { type: "tool_result", name: "Bash", ok: true, output: "file.txt" },
  ];
  const { content } = foldSupervisorEvents(events);
  assert.equal(content.length, 1);
  const call = content[0] as ForgeToolCallPart;
  assert.equal(call.type, "tool-call");
  assert.equal(call.toolName, "Bash");
  assert.deepEqual(call.args, { command: "ls" });
  assert.equal(call.result, "file.txt");
  assert.equal(call.isError, false);
});

test("a failed tool_result sets isError true", () => {
  const events: SupervisorEvent[] = [
    { type: "tool_use", name: "Grep", input: {} },
    { type: "tool_result", name: "Grep", ok: false, output: "no matches" },
  ];
  const { content } = foldSupervisorEvents(events);
  const call = content[0] as ForgeToolCallPart;
  assert.equal(call.isError, true);
  assert.equal(call.result, "no matches");
});

test("gate/spec_draft/watch_run → synthetic tool-call parts named per SYNTHETIC_TOOL_NAMES", () => {
  const events: SupervisorEvent[] = [
    { type: "gate", specId: "0067" },
    {
      type: "spec_draft",
      specId: "0068",
      specPath: "specs/0068-foo.md",
      title: "Foo",
      summary: "Bar",
      model: "fable",
    },
    { type: "watch_run", specId: "0069" },
  ];
  const { content } = foldSupervisorEvents(events);
  assert.equal(content.length, 3);
  const gate = content[0] as ForgeToolCallPart;
  const specDraft = content[1] as ForgeToolCallPart;
  const watchRun = content[2] as ForgeToolCallPart;
  assert.equal(gate.toolName, SYNTHETIC_TOOL_NAMES.gate);
  assert.deepEqual(gate.args, { specId: "0067" });
  assert.equal(specDraft.toolName, SYNTHETIC_TOOL_NAMES.specDraft);
  assert.equal(specDraft.args["specPath"], "specs/0068-foo.md");
  assert.equal(watchRun.toolName, SYNTHETIC_TOOL_NAMES.watchRun);
  assert.deepEqual(watchRun.args, { specId: "0069" });
});

test("architect_progress deltas coalesce into one trailing synthetic tool-call part", () => {
  const events: SupervisorEvent[] = [
    { type: "spawn_architect" },
    { type: "architect_progress", delta: "Draft" },
    { type: "architect_progress", delta: "ing…" },
  ];
  const { content } = foldSupervisorEvents(events);
  assert.equal(content.length, 1);
  const call = content[0] as ForgeToolCallPart;
  assert.equal(call.toolName, SYNTHETIC_TOOL_NAMES.architectProgress);
  assert.deepEqual(call.args, { delta: "Drafting…" });
});

test("a session event is captured as sdkSessionId, not content", () => {
  const events: SupervisorEvent[] = [
    { type: "text", delta: "hi" },
    { type: "session", sessionId: "sess-123" },
  ];
  const { content, sdkSessionId } = foldSupervisorEvents(events);
  assert.deepEqual(content, [{ type: "text", text: "hi" }]);
  assert.equal(sdkSessionId, "sess-123");
});

test("an error event surfaces as a trailing text part", () => {
  const events: SupervisorEvent[] = [
    { type: "text", delta: "before " },
    { type: "error", message: "stall detected" },
  ];
  const { content } = foldSupervisorEvents(events);
  assert.deepEqual(content, [{ type: "text", text: "before stall detected" }]);
});

// --- Replay on thread-open (spec 0067 item 6). -------------------------------

test("toInitialMessages replays a user message's stored prompt verbatim", () => {
  const messages: ReplayableMessage[] = [{ id: "m1", role: "user", content: "hello", events: null }];
  assert.deepEqual(toInitialMessages(messages), [{ id: "m1", role: "user", content: "hello" }]);
});

test("toInitialMessages folds an assistant message's stored events through the same fold the live stream uses", () => {
  const messages: ReplayableMessage[] = [
    {
      id: "m2",
      role: "assistant",
      content: "",
      events: [
        { type: "text", delta: "hi " },
        { type: "text", delta: "there" },
      ],
    },
  ];
  assert.deepEqual(toInitialMessages(messages), [
    { id: "m2", role: "assistant", content: [{ type: "text", text: "hi there" }] },
  ]);
});

test("toInitialMessages treats a null events array as an empty assistant turn", () => {
  const messages: ReplayableMessage[] = [{ id: "m3", role: "assistant", content: "", events: null }];
  assert.deepEqual(toInitialMessages(messages), [{ id: "m3", role: "assistant", content: [] }]);
});

// ---------------------------------------------------------------------------
// Spec 0127: the current step. The owner — "we also need a way to show the user the
// current thinking step."
// ---------------------------------------------------------------------------

test("currentStep names the running tool and clears when it reports back", () => {
  const running = foldSupervisorEvents([
    { type: "text", delta: "Voy a correr las pruebas." },
    { type: "tool_use", name: "Bash", input: { command: "pnpm -r test" } },
  ]);
  assert.equal(running.currentStep, "Bash: pnpm -r test");

  const done = foldSupervisorEvents([
    { type: "tool_use", name: "Bash", input: { command: "pnpm -r test" } },
    { type: "tool_result", name: "Bash", ok: true, output: "1159 pass" },
  ]);
  assert.equal(done.currentStep, null, "a finished tool is no longer the current step");
});

test("currentStep is the LATEST tool, not the first", () => {
  const fold = foldSupervisorEvents([
    { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
    { type: "tool_result", name: "Read", ok: true },
    { type: "tool_use", name: "Grep", input: { pattern: "startRun" } },
  ]);
  assert.equal(fold.currentStep, "Grep: startRun");
});

test("a finished turn has no current step", () => {
  for (const terminal of [
    { type: "result", ok: true },
    { type: "error", message: "boom" },
  ] as const) {
    const fold = foldSupervisorEvents([
      { type: "tool_use", name: "Bash", input: { command: "sleep 1" } },
      terminal as never,
    ]);
    assert.equal(fold.currentStep, null, terminal.type);
  }
});

test("nothing running yet → no step (thinking, not tooling)", () => {
  assert.equal(foldSupervisorEvents([{ type: "text", delta: "pensando" }]).currentStep, null);
  assert.equal(foldSupervisorEvents([]).currentStep, null);
});

// The security half: a tool input can be an entire file, or a secret inside one.
// The status line takes a whitelisted field, truncated — never the input.
test("describeStep never dumps the tool input", () => {
  const secretish = "x".repeat(5000);
  const line = describeStep("Write", { file_path: "/srv/launchpad/repo/.env", content: secretish });
  assert.equal(line.includes(secretish), false, "file contents must never reach the status line");
  assert.match(line, /^Write: /);
  assert.ok(line.length < 100, `status line stayed short (${line.length})`);
});

test("describeStep picks the field that says what is being acted on", () => {
  assert.equal(describeStep("Bash", { command: "pnpm -r test" }), "Bash: pnpm -r test");
  assert.equal(describeStep("Read", { file_path: "/x/y.ts" }), "Read: /x/y.ts");
  assert.equal(describeStep("Grep", { pattern: "TODO" }), "Grep: TODO");
  assert.equal(describeStep("WebFetch", { url: "https://example.test" }), "WebFetch: https://example.test");
  // Unknown shape degrades to the bare tool name rather than guessing.
  assert.equal(describeStep("MysteryTool", { weird: 1 }), "MysteryTool");
  assert.equal(describeStep("MysteryTool", "not an object"), "MysteryTool");
});

test("a long argument is truncated with an ellipsis, and collapses whitespace", () => {
  const line = describeStep("Bash", { command: `echo ${"a".repeat(200)}` });
  assert.ok(line.length <= "Bash: ".length + 60, `truncated (${line.length})`);
  assert.match(line, /…$/);
  assert.equal(describeStep("Bash", { command: "a\n\n  b" }), "Bash: a b");
});
