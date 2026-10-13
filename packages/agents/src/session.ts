/**
 * Agent session runner — one headless Claude Agent SDK session per call,
 * following the long-running-agent pattern (agents/initializer.md,
 * agents/coder.md). Paperclip registration for budget/audit lands in phase 5.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createStderrTail } from "./stderr-tail.js";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { AgentCredential } from "./credentials.js";
import { credentialEnv } from "./credentials.js";
import { scrubAgentEnv } from "./env-scrub.js";

/**
 * Shape of the SDK's `query` entry point, extracted so tests can inject a
 * fake implementation (e.g. to simulate the SDK's terminal error result for
 * a bogus model) without hitting the network. Defaults to the real SDK.
 */
export type QueryFn = typeof query;

export type AgentRole =
  | "initializer"
  | "coder"
  | "spec-drafter"
  | "fixer"
  | "supervisor";

/**
 * The tool surface every role gets unless the caller narrows it via
 * {@link SessionRequest.allowedTools}. Broad on purpose: the initializer, coder,
 * fixer and coder all have to edit files, run the repo's checks and commit.
 * Exported so tests can prove the default is unchanged for those roles (spec
 * 0099) — a silent widening here would hand Bash to a session that shouldn't
 * have it.
 */
export const DEFAULT_SESSION_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] as const;

/** Default inactivity threshold for the session watchdog (spec 0018): if the
 * SDK streams no message for this long, runAgentSession aborts the session and
 * throws {@link SessionStalledError}. 5 minutes keeps a >=2x margin over the
 * longest observed silent tool call (the coder's mandated full `pnpm -r test`);
 * the exact measured margin is recorded in spec 0018's Handoff log. Injectable
 * per-request (`SessionRequest.sessionInactivityMs`) and via env
 * (`LAUNCHPAD_SESSION_INACTIVITY_MS`). */
export const DEFAULT_SESSION_INACTIVITY_MS = 5 * 60_000;

/**
 * Thrown by {@link runAgentSession} when the SDK streams nothing for longer
 * than the inactivity threshold (spec 0018 watchdog). The session's
 * AbortController is fired first so the stuck agent subprocess dies. Retryable
 * on purpose — the activity's `AGENT_ACTIVITY_OPTIONS` retries still govern;
 * the watchdog's only job is to DETECT the stall in minutes instead of burning
 * the full 30-minute `startToCloseTimeout` (the ADR-014 timer heartbeat keeps
 * beating regardless of SDK events, so Temporal can't detect the silence — our
 * watchdog is the deliberate, faster detector). Carries the role, the elapsed
 * silence, and the last SDK message type so the failure is diagnosable and can
 * feed the fixer's repair context.
 */
export class SessionStalledError extends Error {
  readonly role: AgentRole;
  readonly elapsedMs: number;
  readonly lastMessageType: string;
  /**
   * What the SDK subprocess itself said before going quiet (spec 0219 E).
   *
   * Without this the error names our own timeout and nothing about the cause —
   * which is exactly why three sessions could stall for 50 minutes and leave no
   * evidence to tell an API wait from a starved CPU. Empty string means it said
   * nothing, which is itself a fact worth having.
   */
  readonly subprocessStderr: string | undefined;
  constructor(
    role: AgentRole,
    elapsedMs: number,
    lastMessageType: string,
    /** `""` = it said nothing. `undefined` = nobody was listening — a
     * distinction rule #14 exists for: an instrument that cannot tell those
     * apart reports a false negative and gets believed. */
    subprocessStderr?: string,
  ) {
    super(
      `${role} session stalled: no SDK activity for ${elapsedMs}ms ` +
        `(last message type: ${lastMessageType})` +
        (subprocessStderr === undefined
          ? `\n--- subprocess stderr: NOT CAPTURED (no reader wired at this call site) ---`
          : subprocessStderr
            ? `\n--- subprocess stderr (last lines) ---\n${subprocessStderr}`
            : `\n--- subprocess stderr: nothing at all ---`),
    );
    this.name = "SessionStalledError";
    this.role = role;
    this.elapsedMs = elapsedMs;
    this.lastMessageType = lastMessageType;
    this.subprocessStderr = subprocessStderr;
  }
}

export interface SessionRequest {
  role: AgentRole;
  credential: AgentCredential;
  /** Absolute path of the checked-out repo (spec/<id> branch). */
  workdir: string;
  /**
   * Where to read the ROLE file from, when that is not the workdir (spec 0200).
   *
   * A customer's checkout has no `agents/` directory, so a pipeline session
   * running in one read `<worktree>/agents/coder.md`, caught the ENOENT, and ran
   * with an EMPTY role prompt — on every customer run since the pipeline learned
   * to work in customer repos. Spec 0140 fixed the same bug for the supervisor;
   * this is that fix for the pipeline's own sessions.
   *
   * Only the role file moves. The project preamble (`CLAUDE.md`/`AGENTS.md`)
   * still comes from `workdir`, which is the whole point of spec 0196: the ROLE
   * is ours, the CONVENTIONS are the project's.
   */
  promptRoot?: string;
  /** Spec file path (absolute or repo-relative). */
  specPath: string;
  /** Task prompt for this session. */
  prompt: string;
  maxTurns?: number;
  /**
   * Claude model to use, e.g. from `modelForRole(role, cfg.modelOverrides)`
   * (see models.ts). Optional here so foundations compile before every call
   * site is updated; acceptance criteria require every real call site to
   * pass one explicitly — an unset value falls back to the SDK/CLI default.
   */
  model?: string;
  /**
   * Called once per SDK message while the session streams (spec 0006). The
   * caller (a Temporal activity) passes `() => Context.current().heartbeat()`
   * so a force-killed worker is detected within the activity's
   * `heartbeatTimeout` instead of stalling for the full
   * `startToCloseTimeout`. Optional — plain (non-activity) callers omit it.
   */
  onHeartbeat?: () => void;
  /**
   * Interval for TIMER-based heartbeats (spec 0017, ADR-014 bootstrapping
   * fix). The event-driven per-message `onHeartbeat` call starves whenever a
   * single tool call streams nothing for longer than the activity's
   * heartbeatTimeout — e.g. the coder's mandated full `pnpm -r test` run
   * (>60s on the grown monorepo) killed runCoder attempts 3/3 on spec
   * 0015's runs. A steady timer heartbeats regardless of SDK events.
   * Defaults to 15000ms; only active when `onHeartbeat` is provided.
   */
  heartbeatIntervalMs?: number;
  /**
   * Abort hookup (spec 0017): when this signal fires (e.g. Temporal
   * cancelled the activity after a heartbeat timeout), the SDK session's
   * AbortController is aborted so the agent subprocess terminates instead
   * of living on as an orphan that mutates the working tree unattended —
   * observed live on spec 0015 run 2.
   */
  abortSignal?: AbortSignal;
  /**
   * Inactivity watchdog threshold (spec 0018). When set, runAgentSession
   * aborts the session and throws {@link SessionStalledError} if no SDK message
   * arrives for this many milliseconds — catching a HUNG SDK subprocess in
   * minutes instead of stalling for the full activity `startToCloseTimeout`.
   * Defaults to {@link DEFAULT_SESSION_INACTIVITY_MS} (5 min) when unset; the
   * activity call sites read `LAUNCHPAD_SESSION_INACTIVITY_MS` to override it.
   * A silent tool call that later emits a message resets the clock; unbroken
   * silence past the threshold trips it.
   */
  sessionInactivityMs?: number;
  /**
   * Narrow this session's tool surface (spec 0099 / G.1). Defaults to
   * {@link DEFAULT_SESSION_TOOLS}. The drafting role passes
   * `ARCHITECT_ALLOWED_TOOLS` — `Read`/`Grep`/`Glob`/`Write`, no `Bash`, no
   * `Edit` — because a session whose entire job is to create one markdown file
   * has no business shelling out.
   */
  allowedTools?: readonly string[];
  /**
   * Per-tool-call permission gate (spec 0099 / G.1), e.g.
   * `createArchitectCanUseTool(workdir, specId)` to bind `Write` to
   * `specs/<specId>-*.md`.
   *
   * Passing this ALSO switches `permissionMode` from `acceptEdits` to
   * `default`, because `acceptEdits` auto-approves file edits — which would
   * sail straight past the very gate the caller asked for. Deriving it rather
   * than exposing a third knob means a guarded session cannot be misconfigured
   * into an unguarded one; it mirrors `runArchitectSpawn`'s proven combination.
   */
  canUseTool?: CanUseTool;
}

/**
 * Options shared by every session runner that needs the abort-forwarding +
 * heartbeat + inactivity-watchdog plumbing (spec 0017/0018). Extracted so
 * {@link streamSupervisorSession} (spec 0049) can reuse it byte-for-byte
 * instead of re-implementing timer bookkeeping that's already covered by
 * `session.test.ts`.
 */
export interface SessionWatchdogOptions {
  /** Attributed on a tripped {@link SessionStalledError}. */
  role: AgentRole;
  abortSignal?: AbortSignal;
  onHeartbeat?: () => void;
  heartbeatIntervalMs?: number;
  sessionInactivityMs?: number;
  /**
   * Reads the SDK subprocess's recent stderr AT THE MOMENT the stall fires
   * (spec 0219 E). A function, not a string, because the interesting output is
   * whatever arrived during the silence.
   */
  subprocessStderr?: () => string;
}

export interface SessionWatchdogHandle {
  /** Feed this into the SDK `query()` call's `options.abortController`. */
  abortController: AbortController;
  /**
   * Call once per streamed SDK message with its `type` (for
   * {@link SessionStalledError.lastMessageType}) — fires the per-message
   * heartbeat and reschedules the inactivity timer.
   */
  recordMessage(messageType: string): void;
  /**
   * Set once the reset-on-message inactivity timer actually fires (full
   * silence for `sessionInactivityMs`). Check after the SDK generator
   * ends/throws — a stall-triggered abort may surface as the SDK's own abort
   * error (or nothing), so the watchdog's diagnosis must win either way.
   */
  stalledError(): SessionStalledError | undefined;
  /** Clears both timers and the abort-forwarding listener. Call in a finally. */
  cleanup(): void;
}

/**
 * Build the abort + heartbeat + inactivity-watchdog handle shared by
 * {@link runAgentSession} and `streamSupervisorSession` (spec 0049). See
 * those callers' doc comments (specs 0006/0017/0018) for the rationale behind
 * each timer.
 */
export function createSessionWatchdog(opts: SessionWatchdogOptions): SessionWatchdogHandle {
  const abortController = new AbortController();
  const forwardAbort = () => abortController.abort();
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) forwardAbort();
    else opts.abortSignal.addEventListener("abort", forwardAbort, { once: true });
  }

  const heartbeatTimer = opts.onHeartbeat
    ? setInterval(() => opts.onHeartbeat?.(), opts.heartbeatIntervalMs ?? 15_000)
    : undefined;
  heartbeatTimer?.unref?.();

  // Spec 0219 E: read at FIRE time, not at construction — the whole point is
  // what the subprocess said in the silent five minutes before the stall.
  const readStderr = opts.subprocessStderr ?? (() => undefined);
  const inactivityMs = opts.sessionInactivityMs ?? DEFAULT_SESSION_INACTIVITY_MS;
  let lastMessageAt = Date.now();
  let lastMessageType = "session-start";
  let stalledError: SessionStalledError | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      const elapsedMs = Date.now() - lastMessageAt;
      if (elapsedMs >= inactivityMs) {
        stalledError = new SessionStalledError(
          opts.role,
          elapsedMs,
          lastMessageType,
          readStderr(),
        );
        abortController.abort();
      } else {
        // Clock skew / early fire guard — reschedule for the remainder.
        scheduleWatchdog();
      }
    }, inactivityMs);
    // Deliberately NOT unref'd: this timer's whole job is to fire even when
    // it's the only thing pending (a fully hung SDK subprocess leaves
    // nothing else scheduled) — an unref'd timer can let Node decide the
    // event loop is done and exit before it ever fires.
  };
  scheduleWatchdog();

  return {
    abortController,
    recordMessage(messageType: string) {
      lastMessageAt = Date.now();
      opts.onHeartbeat?.();
      lastMessageType = messageType;
      scheduleWatchdog();
    },
    stalledError() {
      return stalledError;
    },
    cleanup() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      opts.abortSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

export interface SessionResult {
  role: AgentRole;
  ok: boolean;
  handoffNote: string;
  costUsd?: number; // api-key mode only; subscription draws plan limits
  numTurns?: number;
  /** Model that actually ran this session (echoes SessionRequest.model). */
  model?: string;
  /**
   * Tokens the SDK reports on its `result` message (spec 0194). Present on any
   * plan — unlike `costUsd`, which only api-key mode fills in — and the reason
   * this exists: "what does a run cost" was unanswerable from our own database
   * while the number was arriving on every session and being dropped here.
   */
  usage?: SessionUsage;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cache reads are most of a coder session's input; counting them inside
   * `inputTokens` would make context reloads look like real work. */
  cacheReadTokens: number;
}

const ROLE_FILES: Record<AgentRole, string> = {
  initializer: "agents/initializer.md",
  coder: "agents/coder.md",
  // The one guarded drafting role (spec 0099 / G.1, SPEC-ALIGNMENT §10.A).
  // Reached from BOTH entry points — the Temporal `draftSpec` activity (awaits
  // a result, via runAgentSession) and the in-UI supervisor spawn (streams
  // events, via runArchitectSpawn) — which is why it gets a real role file
  // instead of pointing straight at docs/SPEC_FORMAT.md: the format is only
  // half the contract, the execution-free guards are the other half. Both
  // callers run it with ARCHITECT_ALLOWED_TOOLS + the Write gate.
  "spec-drafter": "agents/spec-drafter.md",
  fixer: "agents/fixer.md",
  // The in-UI Opus supervisor role (spec 0049 / ADR-022). Unlike the other
  // roles, this session is an INTERACTIVE agent steered from the browser
  // console, not a Temporal-driven pipeline session — but it reuses the same
  // credential/scrub/abort/watchdog plumbing via streamSupervisorSession.
  supervisor: "agents/supervisor.md",
};

async function systemPromptFor(
  role: AgentRole,
  workdir: string,
  promptRoot?: string,
): Promise<string> {
  // Spec 0196: `CLAUDE.md` first, then `AGENTS.md` — the de-facto standard file,
  // and the one a CUSTOMER's repo carries. Without this the project preamble was
  // empty on every customer session and each one re-derived the conventions from
  // the code; run 5's initializer said so out loud ("No hay CLAUDE.md en el
  // checkout"). First match wins rather than concatenating: two convention files
  // in one tree means one of them is the stale copy.
  const claudeMd =
    (await readFile(path.join(workdir, "CLAUDE.md"), "utf8").catch(() => "")) ||
    (await readFile(path.join(workdir, "AGENTS.md"), "utf8").catch(() => ""));
  // Spec 0200: the ROLE file comes from `promptRoot` when given — see
  // SessionRequest.promptRoot for why an empty role prompt went unnoticed.
  const roleMd = await readFile(
    path.join(promptRoot ?? workdir, ROLE_FILES[role]),
    "utf8",
  ).catch(() => "");
  return `${claudeMd}\n\n# Your role\n\n${roleMd}`;
}

export async function runAgentSession(
  req: SessionRequest,
  queryFn: QueryFn = query,
): Promise<SessionResult> {
  // Abort forwarding (spec 0017) + timer heartbeat (spec 0017) + inactivity
  // watchdog (spec 0018), shared with streamSupervisorSession (spec 0049) via
  // createSessionWatchdog.
  // Spec 0219 E: the SDK's own stderr, kept so a stall can name its cause. It
  // was discarded before, which is why 50 minutes of stalled sessions produced
  // no evidence at all.
  const stderrTail = createStderrTail();
  const watchdog = createSessionWatchdog({
    role: req.role,
    abortSignal: req.abortSignal,
    onHeartbeat: req.onHeartbeat,
    heartbeatIntervalMs: req.heartbeatIntervalMs,
    sessionInactivityMs: req.sessionInactivityMs,
    subprocessStderr: () => stderrTail.tail(),
  });
  const { abortController } = watchdog;

  try {
  const q = queryFn({
    prompt: req.prompt,
    options: {
      cwd: req.workdir,
      abortController,
      systemPrompt: await systemPromptFor(req.role, req.workdir, req.promptRoot),
      model: req.model,
      maxTurns: req.maxTurns ?? 50,
      // See SessionRequest.canUseTool: acceptEdits would auto-approve the very
      // writes a supplied gate exists to vet, so a gated session runs in
      // "default" mode.
      permissionMode: req.canUseTool ? "default" : "acceptEdits",
      allowedTools: [...(req.allowedTools ?? DEFAULT_SESSION_TOOLS)],
      canUseTool: req.canUseTool,
      env: { ...scrubAgentEnv(), ...credentialEnv(req.credential) } as Record<string, string>,
      stderr: (data: string) => stderrTail.capture(data),
    },
  });

  let ok = false;
  let handoffNote = "";
  let costUsd: number | undefined;
  let numTurns: number | undefined;
  let usage: SessionUsage | undefined;

  try {
    for await (const message of q) {
      // Narrow defensively: SDK message unions evolve between versions.
      const m = message as {
        type: string;
        subtype?: string;
        result?: string;
        total_cost_usd?: number;
        num_turns?: number;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
      watchdog.recordMessage(m.type);
      if (m.type === "result") {
        ok = m.subtype === "success";
        handoffNote = m.result ?? m.subtype ?? "";
        costUsd = m.total_cost_usd;
        numTurns = m.num_turns;
        // Spec 0194. Absent on an SDK version that does not report it — the
        // narrowing above is defensive for exactly that, and a missing `usage`
        // must leave the row's counters at zero rather than fail the session.
        usage = m.usage
          ? {
              inputTokens: m.usage.input_tokens ?? 0,
              outputTokens: m.usage.output_tokens ?? 0,
              cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
            }
          : undefined;
      }
    }
  } catch (err) {
    // A stall-triggered abort may surface as the SDK's own abort error (or
    // nothing, if the generator just ends) — the watchdog's diagnosis wins
    // either way once it has fired.
    const stalledError = watchdog.stalledError();
    if (stalledError) throw stalledError;
    throw err;
  }

  const stalledError = watchdog.stalledError();
  if (stalledError) throw stalledError;
  if (!ok) throw new Error(`${req.role} session failed: ${handoffNote || "no result"}`);
  return {
    role: req.role,
    ok,
    handoffNote,
    costUsd,
    numTurns,
    model: req.model,
    ...(usage ? { usage } : {}),
  };
  } finally {
    watchdog.cleanup();
  }
}
