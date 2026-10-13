import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  runAgentSession,
  SessionStalledError,
  DEFAULT_SESSION_TOOLS,
  type QueryFn,
} from "./session.js";
import { ARCHITECT_ALLOWED_TOOLS, createArchitectCanUseTool } from "./architect-session.js";

/** Repo root — packages/agents's tests run with cwd=packages/agents, but role
 * md files (e.g. agents/uiux-coder.md) live at the repo root. */
const REPO_ROOT = path.resolve(process.cwd(), "../..");

const credential = { mode: "api-key", apiKey: "sk-test" } as const;

/** Build a fake `queryFn` yielding a single terminal SDK result message. */
function fakeQuery(result: {
  subtype: string;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}): QueryFn {
  return (() => {
    async function* gen() {
      yield { type: "result", ...result } as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as QueryFn;
}

test("runAgentSession fails loudly when the SDK reports a non-success result (e.g. a bogus model)", async () => {
  const q = fakeQuery({ subtype: "error_bogus_model", result: "model not found: claude-nope" });
  await assert.rejects(
    () =>
      runAgentSession(
        {
          role: "coder",
          credential,
          workdir: process.cwd(),
          specPath: "specs/0004-per-role-model-selection.md",
          prompt: "irrelevant",
          model: "claude-nope",
        },
        q,
      ),
    /coder session failed: model not found: claude-nope/,
  );
});

test("runAgentSession calls onHeartbeat once per streamed SDK message (spec 0006)", async () => {
  function fakeStreamingQuery(): QueryFn {
    return (() => {
      async function* gen() {
        yield { type: "assistant" } as never;
        yield { type: "assistant" } as never;
        yield { type: "result", subtype: "success", result: "done" } as never;
      }
      const iter = gen();
      return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
    }) as QueryFn;
  }
  let heartbeats = 0;
  const res = await runAgentSession(
    {
      role: "coder",
      credential,
      workdir: process.cwd(),
      specPath: "specs/0006-coder-loop-convergence.md",
      prompt: "irrelevant",
      onHeartbeat: () => {
        heartbeats += 1;
      },
    },
    fakeStreamingQuery(),
  );
  assert.equal(res.ok, true);
  assert.equal(heartbeats, 3);
});

test("runAgentSession resolves with the echoed model on a successful result", async () => {
  const q = fakeQuery({ subtype: "success", result: "done", total_cost_usd: 0.01, num_turns: 3 });
  const res = await runAgentSession(
    {
      role: "initializer",
      credential,
      workdir: process.cwd(),
      specPath: "specs/0004-per-role-model-selection.md",
      prompt: "irrelevant",
      model: "claude-opus-4-8",
    },
    q,
  );
  assert.equal(res.ok, true);
  assert.equal(res.model, "claude-opus-4-8");
  assert.equal(res.costUsd, 0.01);
  assert.equal(res.numTurns, 3);
});

// --- Spec 0064: uiux-coder role md resolution -------------------------------

test("runAgentSession composes the uiux-coder role md into the system prompt", async () => {
  let capturedSystemPrompt: string | undefined;
  const capturingQuery: QueryFn = ((args: { options?: { systemPrompt?: string } }) => {
    capturedSystemPrompt = args.options?.systemPrompt;
    async function* gen() {
      yield { type: "result", subtype: "success", result: "done" } as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as unknown as QueryFn;

  await runAgentSession(
    {
      role: "fixer",
      credential,
      workdir: REPO_ROOT,
      specPath: "specs/0018-repair-rounds.md",
      prompt: "irrelevant",
      model: "claude-opus-5",
    },
    capturingQuery,
  );
  assert.ok(capturedSystemPrompt, "query never received a systemPrompt");
  assert.match(capturedSystemPrompt!, /Role: Fixer/);
});

// --- Spec 0017 (ADR-014 bootstrapping fix): timer heartbeat + abort ---------

test("runAgentSession heartbeats on a TIMER during long silent tool calls (spec 0017)", async () => {
  // A query that streams NOTHING for ~120ms, then the terminal result —
  // simulating the coder's silent full-test run that starved the 60s
  // event-driven heartbeat on spec 0015's runs.
  const silentThenResult: QueryFn = (() => {
    async function* gen() {
      await new Promise((r) => setTimeout(r, 120));
      yield { type: "result", subtype: "success", result: "ok" } as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as QueryFn;

  let beats = 0;
  await runAgentSession(
    {
      role: "coder",
      credential,
      workdir: process.cwd(),
      specPath: "specs/0015-github-pr-gate.md",
      prompt: "irrelevant",
      model: "claude-sonnet-5",
      onHeartbeat: () => beats++,
      heartbeatIntervalMs: 20,
    },
    silentThenResult,
  );
  // Event-driven alone would give exactly 1 beat (the single message);
  // the timer must have fired several times during the silent window.
  assert.ok(beats >= 3, `expected >=3 heartbeats during silence, got ${beats}`);
});

test("runAgentSession forwards the caller's abortSignal into the SDK AbortController (spec 0017)", async () => {
  let captured: AbortController | undefined;
  const capturingQuery: QueryFn = ((args: { options?: { abortController?: AbortController } }) => {
    captured = args.options?.abortController;
    async function* gen() {
      // End promptly once aborted; otherwise finish with a failure result.
      await new Promise((r) => setTimeout(r, 50));
      yield { type: "result", subtype: "aborted", result: "session aborted" } as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as unknown as QueryFn;

  const external = new AbortController();
  const pending = assert.rejects(
    () =>
      runAgentSession(
        {
          role: "coder",
          credential,
          workdir: process.cwd(),
          specPath: "specs/0015-github-pr-gate.md",
          prompt: "irrelevant",
          model: "claude-sonnet-5",
          abortSignal: external.signal,
        },
        capturingQuery,
      ),
    /coder session failed/,
  );
  // Abort mid-session: the SDK-side controller must observe it.
  setTimeout(() => external.abort(), 10);
  await pending;
  assert.ok(captured, "query never received an AbortController");
  assert.equal(captured!.signal.aborted, true, "SDK controller was not aborted");
});

// --- Spec 0018: inactivity watchdog -----------------------------------------

test("runAgentSession trips the inactivity watchdog on full silence: aborts the SDK controller and throws SessionStalledError", async () => {
  let captured: AbortController | undefined;
  // Streams NOTHING, ever — simulating a hung SDK subprocess. The generator
  // only ends once our own watchdog aborts the controller it was given,
  // proving the abort (not a real network/process failure) drove the exit.
  const foreverSilent: QueryFn = ((args: { options?: { abortController?: AbortController } }) => {
    captured = args.options?.abortController;
    async function* gen() {
      await new Promise((resolve) => {
        captured!.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
      // No message ever yielded — the loop just ends once aborted.
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as unknown as QueryFn;

  await assert.rejects(
    () =>
      runAgentSession(
        {
          role: "coder",
          credential,
          workdir: process.cwd(),
          specPath: "specs/0018-run-resilience.md",
          prompt: "irrelevant",
          model: "claude-sonnet-5",
          sessionInactivityMs: 30,
        },
        foreverSilent,
      ),
    (err: unknown) => {
      assert.ok(err instanceof SessionStalledError, `expected SessionStalledError, got ${err}`);
      assert.equal(err.role, "coder");
      assert.ok(err.elapsedMs >= 30, `expected elapsedMs >= 30, got ${err.elapsedMs}`);
      assert.equal(err.lastMessageType, "session-start");
      return true;
    },
  );
  assert.ok(captured, "query never received an AbortController");
  assert.equal(captured!.signal.aborted, true, "watchdog did not abort the SDK controller");
});

test("runAgentSession's inactivity watchdog resets on every message — silent-then-message never trips it", async () => {
  // Two short silences (15ms each), each followed by a message, then the
  // terminal result — the running silence never reaches the 30ms threshold
  // even though the TOTAL elapsed time (>30ms) would trip a non-resetting
  // timer.
  const silentThenMessages: QueryFn = (() => {
    async function* gen() {
      await new Promise((r) => setTimeout(r, 15));
      yield { type: "assistant" } as never;
      await new Promise((r) => setTimeout(r, 15));
      yield { type: "result", subtype: "success", result: "ok" } as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as QueryFn;

  const res = await runAgentSession(
    {
      role: "coder",
      credential,
      workdir: process.cwd(),
      specPath: "specs/0018-run-resilience.md",
      prompt: "irrelevant",
      model: "claude-sonnet-5",
      sessionInactivityMs: 30,
    },
    silentThenMessages,
  );
  assert.equal(res.ok, true);
  assert.equal(res.handoffNote, "ok");
});

// --- Tool-surface / permission-gate passthrough (spec 0099 / G.1) -----------
//
// `runAgentSession` used to hardcode Read/Write/Edit/Glob/Grep/Bash for EVERY
// role, which is why the Temporal drafting session ran with Bash + Edit it has
// no use for while the in-UI one was fenced three ways. These lock both halves:
// callers can narrow the surface, and callers who DON'T are unaffected.

/** Capture the `options` object the SDK would receive. */
function captureOptions(): { calls: Array<Record<string, unknown>>; queryFn: QueryFn } {
  const calls: Array<Record<string, unknown>> = [];
  const queryFn = ((args: { options: Record<string, unknown> }) => {
    calls.push(args.options);
    async function* gen() {
      yield { type: "result", subtype: "success", result: "done" } as never;
    }
    const iter = gen();
    return Object.assign(iter, { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as unknown as QueryFn;
  return { calls, queryFn };
}

const baseReq = {
  credential,
  workdir: REPO_ROOT,
  specPath: "specs/0099-one-drafting-role.md",
  prompt: "irrelevant",
} as const;

test("runAgentSession keeps the default tool surface + acceptEdits when the caller narrows nothing", async () => {
  const { calls, queryFn } = captureOptions();
  await runAgentSession({ ...baseReq, role: "coder" }, queryFn);
  assert.equal(calls.length, 1);
  // The coder/initializer/fixer/uiux-coder roles must be untouched by spec 0099:
  // they edit files, run pnpm and commit.
  assert.deepEqual(calls[0]!["allowedTools"], [...DEFAULT_SESSION_TOOLS]);
  assert.deepEqual([...DEFAULT_SESSION_TOOLS], ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
  assert.equal(calls[0]!["permissionMode"], "acceptEdits");
  assert.equal(calls[0]!["canUseTool"], undefined);
});

test("runAgentSession passes a narrowed allowedTools through to the SDK", async () => {
  const { calls, queryFn } = captureOptions();
  await runAgentSession(
    { ...baseReq, role: "spec-drafter", allowedTools: ARCHITECT_ALLOWED_TOOLS },
    queryFn,
  );
  const tools = calls[0]!["allowedTools"] as string[];
  // Spec 0147: AskUserQuestion joined the drafting surface (it asks, it does
  // not execute). The invariant this test guards is the two lines below.
  assert.deepEqual(tools, ["Read", "Grep", "Glob", "Write", "AskUserQuestion"]);
  assert.ok(!tools.includes("Bash"), "a narrowed drafting session must not receive Bash");
  assert.ok(!tools.includes("Edit"), "a narrowed drafting session must not receive Edit");
});

test("supplying canUseTool drops acceptEdits, so the gate cannot be sailed past", async () => {
  const { calls, queryFn } = captureOptions();
  const gate = createArchitectCanUseTool(REPO_ROOT, "0099");
  await runAgentSession({ ...baseReq, role: "spec-drafter", canUseTool: gate }, queryFn);
  assert.equal(calls[0]!["canUseTool"], gate, "the gate must reach the SDK");
  // This is the load-bearing half: acceptEdits auto-approves file edits, which
  // would make a supplied Write gate decorative.
  assert.equal(calls[0]!["permissionMode"], "default");
});

test("the gate handed to a drafting session denies Bash and off-spec writes", async () => {
  const gate = createArchitectCanUseTool(REPO_ROOT, "0099");
  const decide = async (tool: string, input: Record<string, unknown>) =>
    (await gate(tool, input, {} as never))?.behavior;
  assert.equal(await decide("Bash", { command: "git push" }), "deny");
  assert.equal(await decide("Write", { file_path: path.join(REPO_ROOT, "packages/db/src/x.ts") }), "deny");
  assert.equal(
    await decide("Write", { file_path: path.join(REPO_ROOT, "specs/0099-one-drafting-role.md") }),
    "allow",
  );
});

// --- spec 0194: the tokens the SDK already reports ---------------------------

test("runAgentSession carries the result's token usage", async () => {
  const q = fakeQuery({
    subtype: "success",
    result: "done",
    num_turns: 7,
    usage: { input_tokens: 1200, output_tokens: 3400, cache_read_input_tokens: 98000 },
  });
  const res = await runAgentSession(
    {
      role: "coder",
      credential,
      workdir: REPO_ROOT,
      specPath: "specs/0194-what-a-run-actually-costs.md",
      prompt: "irrelevant",
      model: "claude-opus-5",
    },
    q,
  );
  assert.deepEqual(res.usage, {
    inputTokens: 1200,
    outputTokens: 3400,
    cacheReadTokens: 98000,
  });
  assert.equal(res.numTurns, 7);
});

// An SDK version that stops reporting `usage` must leave the counters absent —
// never zero-that-looks-measured, and never a thrown session.
test("a result with no usage block is a session without usage, not a failure", async () => {
  const res = await runAgentSession(
    {
      role: "coder",
      credential,
      workdir: REPO_ROOT,
      specPath: "specs/0194-what-a-run-actually-costs.md",
      prompt: "irrelevant",
      model: "claude-opus-5",
    },
    fakeQuery({ subtype: "success", result: "done", num_turns: 2 }),
  );
  assert.equal(res.usage, undefined);
  assert.equal(res.ok, true);
});

// --- spec 0196: the convention file a CUSTOMER's repo carries ---------------

test("systemPromptFor falls back to AGENTS.md when there is no CLAUDE.md", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "agents-md-"));
  mkdirSync(path.join(dir, "agents"), { recursive: true });
  writeFileSync(path.join(dir, "agents", "coder.md"), "# coder role\n");
  writeFileSync(path.join(dir, "AGENTS.md"), "REGLA: monta el componente en page.tsx\n");

  let seenPrompt = "";
  const q: QueryFn = ((opts: { options?: { systemPrompt?: string } }) => {
    seenPrompt = opts.options?.systemPrompt ?? "";
    async function* gen() {
      yield { type: "result", subtype: "success", result: "ok" } as never;
    }
    return Object.assign(gen(), { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as QueryFn;

  await runAgentSession(
    {
      role: "coder",
      credential,
      workdir: dir,
      specPath: "specs/0001-x.md",
      prompt: "irrelevant",
      model: "claude-opus-5",
    },
    q,
  );
  assert.match(seenPrompt, /monta el componente en page\.tsx/);
});

// --- spec 0197: the prompts must match the product -------------------------
//
// `agents/coder.md` and `agents/fixer.md` told the agent to gate on
// `pnpm -r typecheck && pnpm -r test` — this monorepo's command, meaningless in
// the customer checkout where every A/B run since run 1 has happened. Run 5's
// coder worked around it on its own and ran `npx tsc --noEmit`; a good agent
// papering over a wrong instruction is luck, not a system.

test("the loop prompts do not prescribe THIS repo's gate unconditionally", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const role of ["coder", "fixer"]) {
    const md = await readFile(path.join(REPO_ROOT, "agents", `${role}.md`), "utf8");
    // The command may appear — as an example OF THIS REPO. What must not appear
    // is an unqualified instruction to run it.
    assert.match(
      md,
      /AGENTS\.md/,
      `${role}.md must point at the project's own conventions file`,
    );
    assert.match(
      md,
      /customer/i,
      `${role}.md must say that most runs are a customer's checkout`,
    );
  }
});

test("the coder owes a reachability answer — run 4's defect, written down", async () => {
  const { readFile } = await import("node:fs/promises");
  const md = await readFile(path.join(REPO_ROOT, "agents", "coder.md"), "utf8");
  assert.match(md, /REACHABLE/, "the coder must be asked whether its work is reachable");
  assert.match(md, /Contacto\.tsx/, "with the concrete failure that motivated it");
});

test("no prompt still carries the deleted ui_only path fence", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  for (const file of await readdir(path.join(REPO_ROOT, "agents"))) {
    if (!file.endsWith(".md")) continue;
    const md = await readFile(path.join(REPO_ROOT, "agents", file), "utf8");
    assert.doesNotMatch(
      md,
      /every item scoped under `apps\/web\/`/,
      `${file} still carries spec 0196's deleted fence`,
    );
  }
});

// --- spec 0200: the role prompt reaches a session in a CUSTOMER checkout -----
//
// `systemPromptFor` read `<workdir>/agents/<role>.md`, and a customer's checkout
// has no `agents/` directory, so every pipeline session in one ran with an EMPTY
// role prompt — caught by `.catch(() => "")` and never noticed. Proven three
// ways on run 6: no `agents/` on disk, coder.md's commit-SHA rule never fired in
// any Progress item, and every handoff cited `AGENTS.md` and never the role.
//
// This asserts the prompt the SDK ACTUALLY RECEIVES (VERIFICATION #1), in the
// failing shape: a workdir with no `agents/` at all.

test("the role prompt comes from promptRoot when the workdir has no agents/", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  // A customer checkout: conventions, no `agents/`.
  const workdir = mkdtempSync(path.join(tmpdir(), "customer-"));
  writeFileSync(path.join(workdir, "AGENTS.md"), "REGLA DEL PROYECTO: monta el componente\n");

  let seen = "";
  const q: QueryFn = ((opts: { options?: { systemPrompt?: string } }) => {
    seen = opts.options?.systemPrompt ?? "";
    async function* gen() {
      yield { type: "result", subtype: "success", result: "ok" } as never;
    }
    return Object.assign(gen(), { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as QueryFn;

  await runAgentSession(
    {
      role: "coder",
      credential,
      workdir,
      promptRoot: REPO_ROOT,
      specPath: "specs/0200-x.md",
      prompt: "irrelevant",
      model: "claude-opus-5",
    },
    q,
  );
  // The ROLE is ours...
  assert.match(seen, /Role: Coder/, "the role prompt must reach the session");
  // ...and the CONVENTIONS are still the project's (spec 0196).
  assert.match(seen, /REGLA DEL PROYECTO/, "the project preamble must still come from the workdir");
});

test("without promptRoot the role prompt is empty — the bug this spec fixes", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const workdir = mkdtempSync(path.join(tmpdir(), "customer-noroot-"));
  writeFileSync(path.join(workdir, "AGENTS.md"), "REGLA DEL PROYECTO\n");

  let seen = "";
  const q: QueryFn = ((opts: { options?: { systemPrompt?: string } }) => {
    seen = opts.options?.systemPrompt ?? "";
    async function* gen() {
      yield { type: "result", subtype: "success", result: "ok" } as never;
    }
    return Object.assign(gen(), { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as QueryFn;

  await runAgentSession(
    { role: "coder", credential, workdir, specPath: "s.md", prompt: "x", model: "claude-opus-5" },
    q,
  );
  // Documents the old behaviour so the fix cannot be silently reverted: no
  // promptRoot and no local `agents/` means no role at all.
  assert.doesNotMatch(seen, /Role: Coder/);
});

// --- Spec 0219 E: the stall must name its cause, not just our timeout -------

test("spec 0219 E: a stalled session carries the SDK subprocess's own stderr", async () => {
  // Says one thing on stderr, then goes silent forever — the shape of the three
  // sessions that burned 50 minutes leaving nothing but our own timeout.
  const talksThenHangs: QueryFn = ((args: {
    options?: { abortController?: AbortController; stderr?: (d: string) => void };
  }) => {
    const ac = args.options?.abortController;
    args.options?.stderr?.("Claude AI usage limit reached, waiting\n");
    async function* gen() {
      await new Promise((resolve) => {
        ac!.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    }
    return Object.assign(gen(), { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as unknown as QueryFn;

  await assert.rejects(
    () =>
      runAgentSession(
        {
          role: "initializer",
          credential,
          workdir: process.cwd(),
          specPath: "specs/0219-dos-personas-una-produccion.md",
          prompt: "irrelevant",
          model: "claude-sonnet-5",
          sessionInactivityMs: 30,
        },
        talksThenHangs,
      ),
    (err: unknown) => {
      assert.ok(err instanceof SessionStalledError, `expected SessionStalledError, got ${err}`);
      assert.equal(err.subprocessStderr, "Claude AI usage limit reached, waiting");
      // In the message too — that is what reaches the Temporal failure a human reads.
      assert.match(err.message, /usage limit reached/);
      return true;
    },
  );
});

test("spec 0219 E: a subprocess that says nothing is reported as silence, not as un-instrumented", async () => {
  const silent: QueryFn = ((args: { options?: { abortController?: AbortController } }) => {
    const ac = args.options?.abortController;
    async function* gen() {
      await new Promise((resolve) => {
        ac!.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    }
    return Object.assign(gen(), { close() {} }) as unknown as ReturnType<QueryFn>;
  }) as unknown as QueryFn;

  await assert.rejects(
    () =>
      runAgentSession(
        {
          role: "initializer",
          credential,
          workdir: process.cwd(),
          specPath: "specs/0219-dos-personas-una-produccion.md",
          prompt: "irrelevant",
          model: "claude-sonnet-5",
          sessionInactivityMs: 30,
        },
        silent,
      ),
    (err: unknown) => {
      assert.ok(err instanceof SessionStalledError);
      assert.equal(err.subprocessStderr, ""); // listened, heard nothing
      assert.match(err.message, /nothing at all/);
      assert.doesNotMatch(err.message, /NOT CAPTURED/);
      return true;
    },
  );
});
