/**
 * In-UI supervisor session runner (spec 0049 / ADR-022) — the browser↔Claude-
 * Code bridge. Wraps the SAME Agent SDK `query()` primitive `session.ts`
 * already uses (ADR-004), run host-side with a real command-execution tool
 * surface (`Bash`/`Read`/`Grep`/`Glob`), and STREAMS a normalized
 * {@link SupervisorEvent} union so the transport/UI never parse raw SDK
 * messages.
 *
 * DISTINCT from `/api/chat` (the AI-SDK `streamText` no-shell surface): the
 * supervisor needs a real Claude Code session (command execution, later
 * sub-agent spawn), so it is its own surface. It REUSES `session.ts`'s
 * credential/scrub/abort + inactivity-watchdog plumbing (do not duplicate —
 * `runAgentSession` must stay byte-identical for the pipeline).
 *
 * INVARIANTS (carried from ADR-007 + the chat-tools no-gate-signal property):
 * - The supervisor's tool surface ({@link SUPERVISOR_ALLOWED_TOOLS}) is
 *   inspect/steer only — NO `Write`/`Edit`, and NO gate-signal capability. The
 *   agent can only CAUSE a gate card to render ({type:"gate",specId}); the
 *   human's button click is the only thing that fires `signalGate`.
 *
 * Item A1 implemented the streaming + normalization + watchdog/abort reuse.
 * Item A2 (this file's {@link GATE_MARKER_RE} handling) adds the gate-card
 * contract: the agent emits a structured marker
 * (`[[SUPERVISOR_GATE:<specId>]]`) in its text output — the marker-fallback
 * option the spec calls out as acceptable when custom SDK-tool wiring is
 * heavier than a phase-1 increment needs (it would require a new `zod`
 * dependency plus restructuring the {@link SUPERVISOR_ALLOWED_TOOLS}
 * invariant tests). The runner strips the marker from the visible text and
 * yields a `{type:"gate",specId}` event instead; the browser renders the
 * EXISTING gate button from that event (B1/B2). The agent's tool surface
 * still carries no gate-signal capability — the marker only causes a CARD to
 * render, exactly like the render-only chat tools in `lib/chat-tools.ts`.
 */
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { AgentCredential } from "./credentials.js";
import { credentialEnv } from "./credentials.js";
import { scrubAgentEnv } from "./env-scrub.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  supervisorBashDenial,
  projectChatBashDenial,
  writeTargetDenial,
} from "./supervisor-tool-policy.js";
import { createSessionWatchdog, type QueryFn } from "./session.js";
import { createStderrTail } from "./stderr-tail.js";

/**
 * The supervisor's tool SURFACE — inspect/steer only (spec 0049). NO
 * `Write`/`Edit`, and no gate-signal capability: the human's gate-card click
 * fires the signal, never the agent. Enforced MECHANICALLY (spec 0070) by
 * {@link supervisorCanUseTool}, not by prose — `Bash` is gated by a command
 * deny-list (`supervisor-tool-policy.ts`) and every non-surface tool is denied.
 */
export const SUPERVISOR_ALLOWED_TOOLS = ["Bash", "Read", "Grep", "Glob"] as const;

export type SupervisorAllowedTool = (typeof SUPERVISOR_ALLOWED_TOOLS)[number];

/**
 * The auto-approved (read-only) subset of the surface — safe to run without the
 * `canUseTool` gate, so it goes in the SDK's `allowedTools`. `Bash` is
 * deliberately EXCLUDED: it must pass through {@link supervisorCanUseTool} so
 * its command deny-list is enforced (per the SDK, `allowedTools` is
 * auto-approval, NOT availability, so an entry here bypasses `canUseTool`).
 */
export const SUPERVISOR_AUTO_APPROVED_TOOLS = ["Read", "Grep", "Glob"] as const;

/**
 * The supervisor's programmatic permission gate (SDK `canUseTool`) — makes the
 * "inspect/steer only, human-only gate signal, no Write/Edit" invariant
 * mechanical: a `Bash` call runs through {@link supervisorBashDenial}; the
 * read-only tools are allowed; every other tool (Write/Edit/…) is denied.
 */
/**
 * Spec 0140: the PROJECT profile's tool surface. `Write`/`Edit`/`TodoWrite`
 * are the work; `Task` lets it delegate; `Bash` stays OUT of the auto-approved
 * list for the same reason as in `inspect` — every command must pass the
 * deny-list through `canUseTool`.
 */
export const PROJECT_ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Grep",
  "Glob",
  "Write",
  "Edit",
  "TodoWrite",
  "Task",
] as const;

/** Auto-approved (no per-call gate) in the project profile. `Bash`, `Write`
 * and `Edit` are deliberately absent: Bash runs the deny-list, and the two
 * writers run the path confinement. */
/** Spec 0174: what the chat asks the host to start. */
export interface StartRunInput {
  specId: string;
  request: string;
}

/** What the host answers — `problem` is shown to the agent verbatim, so a
 * refusal it can act on ("esa rama ya tiene un run activo") reaches it intact
 * instead of becoming a generic failure. */
export interface StartRunResult {
  ok: boolean;
  problem?: string;
  workflowId?: string;
}

/** Spec 0174. The MCP server name and tool, as the model sees them. */
export const START_RUN_MCP_SERVER = "forge";
export const START_RUN_TOOL = "start_pipeline";
/** The SDK's namespaced form, which is what `allowedTools` must list. */
export const START_RUN_TOOL_FQN = `mcp__${START_RUN_MCP_SERVER}__${START_RUN_TOOL}`;

export const PROJECT_AUTO_APPROVED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "TodoWrite",
  "Task",
  // Spec 0174: auto-approved deliberately. Starting a run is not a gate — it is
  // the request the gates then answer — and a permission prompt nobody is
  // watching would strand the very turn this tool exists to complete.
  START_RUN_TOOL_FQN,
] as const;

/**
 * The one tool a project chat gets beyond the file/shell surface (spec 0174):
 * it starts a pipeline run through the host's own starter.
 *
 * Exported for the unit test — building it here and asserting its handler
 * forwards + reports is the whole contract; the SDK wiring below is one line.
 */
export function createStartRunServer(onStartRun: (input: StartRunInput) => Promise<StartRunResult>) {
  return createSdkMcpServer({
    name: START_RUN_MCP_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        START_RUN_TOOL,
        "Arranca el pipeline para una spec ya redactada de ESTE proyecto: el coder la implementa, " +
          "corre CI, abre el PR y para en las compuertas humanas. Es la unica forma de que el " +
          "codigo llegue a la rama — no implementes ni hagas commit tu.",
        {
          specId: z.string().describe("El id de la spec, cuatro digitos (p.ej. 0001)."),
          request: z
            .string()
            .describe("Que debe construir el run, en una o dos frases — lo que el coder lee."),
        },
        async (args: StartRunInput) => {
          const result = await onStartRun({ specId: args.specId, request: args.request });
          return {
            content: [
              {
                type: "text" as const,
                text: result.ok
                  ? `run iniciado${result.workflowId ? ` (${result.workflowId})` : ""} — ` +
                    "sigue su avance en la tarjeta del run; las compuertas las aprueba una persona."
                  : `no se pudo arrancar el run: ${result.problem ?? "sin razon reportada"}`,
              },
            ],
          };
        },
      ),
    ],
  });
}

/** The path fields the SDK's writers carry. `notebook_path` is included so a
 * notebook edit cannot slip past the confinement by using another key. */
const WRITE_PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

/**
 * The project profile's permission gate (spec 0140): Bash through the
 * universal deny-list, `Write`/`Edit` confined to the checkout, everything
 * else allowed (the surface is `PROJECT_ALLOWED_TOOLS`).
 *
 * `realpathSync` resolves symlinks BEFORE comparing, because a run's worktree
 * links `specs/` back to the project root — a lexical check would refuse a
 * legitimate spec write, and would miss a link pointing out of the checkout.
 * A path that does not exist yet (the normal case for a new file) resolves via
 * its nearest existing parent.
 */
export function makeProjectCanUseTool(
  checkoutRoot: string,
  specsDir?: string,
  /** Spec 0144 B: resolves with the user's answers, or null for unanswered. */
  onQuestion?: (input: AskUserQuestionInput) => Promise<AskUserQuestionAnswers | null>,
): CanUseTool {
  // Spec 0141: a project's specs live OUTSIDE its checkout (git cannot reach
  // them, so no exclusion to respect and no `git add -f` to abuse), which
  // makes the specs directory a second legitimate write root.
  const roots = [checkoutRoot, ...(specsDir ? [specsDir] : [])];
  const resolve = (p: string): string => {
    const absolute = path.isAbsolute(p) ? p : path.join(checkoutRoot, p);
    let candidate = path.normalize(absolute);
    // Walk up to the nearest EXISTING ancestor so a not-yet-created file still
    // resolves through any symlinked parent.
    const parts: string[] = [];
    for (;;) {
      try {
        return path.join(realpathSync(candidate), ...parts.reverse());
      } catch {
        const parent = path.dirname(candidate);
        if (parent === candidate) return path.normalize(absolute);
        parts.push(path.basename(candidate));
        candidate = parent;
      }
    }
  };
  return async (toolName, input) => {
    if (toolName === "Bash") {
      const command = typeof input?.["command"] === "string" ? (input["command"] as string) : "";
      const denial = projectChatBashDenial(command, specsDir);
      return denial ? { behavior: "deny", message: denial } : { behavior: "allow", updatedInput: input };
    }
    if (toolName === "AskUserQuestion") {
      // Spec 0144 B: the question BLOCKS here until the human answers. No
      // handler (or an unanswered question) is a deny with a reason the agent
      // can work with — never a silent allow that skips the question.
      if (!onQuestion) {
        return {
          behavior: "deny",
          message: "no hay quien responda preguntas en esta sesión — continúa con tu mejor criterio",
        };
      }
      const answers = await onQuestion(input as AskUserQuestionInput);
      if (!answers) {
        return {
          behavior: "deny",
          message: "el usuario no respondió — continúa con tu mejor criterio y dilo",
        };
      }
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
      const key = WRITE_PATH_KEYS.find((k) => typeof input?.[k] === "string");
      const target = key ? (input[key] as string) : undefined;
      // Allowed when the target is inside ANY permitted root.
      const denials = roots.map((root) => writeTargetDenial(root, target, resolve));
      const allowed = denials.some((d) => d === null);
      return allowed
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: denials[0] ?? "denied: write outside the allowed roots." };
    }
    return { behavior: "allow", updatedInput: input };
  };
}

export const supervisorCanUseTool: CanUseTool = async (toolName, input) => {
  if (toolName === "Bash") {
    const command = typeof input?.["command"] === "string" ? (input["command"] as string) : "";
    const denial = supervisorBashDenial(command);
    return denial
      ? { behavior: "deny", message: denial }
      : { behavior: "allow", updatedInput: input };
  }
  if ((SUPERVISOR_AUTO_APPROVED_TOOLS as readonly string[]).includes(toolName)) {
    return { behavior: "allow", updatedInput: input };
  }
  return {
    behavior: "deny",
    message: `denied: "${toolName}" is not in the supervisor's inspect/steer-only surface (Bash/Read/Grep/Glob) — no Write/Edit, ever.`,
  };
};

/**
 * Normalized supervisor event stream. Deliberately extensible: later phases add
 * architect-spawn / watcher-step / phase-progress events (ADR-022 roadmap)
 * without the transport or UI having to learn raw SDK message shapes.
 */
export type SupervisorEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean; output?: string }
  /** The SDK's init message carries the session id for this turn (spec 0067
   * item 3 continuity). The route pins it to the thread (`setThreadSdkSession`)
   * so the NEXT turn in that thread can pass it back as `resume`, giving the
   * agent real conversation history instead of a brand-new session per turn. */
  | { type: "session"; sessionId: string }
  /** The gate-card contract (item A2): agent output → the browser renders the
   * EXISTING gate button for this spec. The agent NEVER signals the gate. */
  | { type: "gate"; specId: string }
  /** Phase-2 architect handoff (spec 0050 / ADR-015 + ADR-022). The supervisor
   * emitted `[[SUPERVISOR_SPAWN_ARCHITECT]]` in its text (a second marker, same
   * mechanism as the gate marker); the runner strips it and yields this. The
   * supervisor's tool surface gains NOTHING — it only CAUSES the orchestrator
   * to spawn the Fable architect (sequential, after the supervisor turn ends).
   * The supervisor's turn text (minus the marker) is the architect BRIEF. */
  | { type: "spawn_architect" }
  /** Streamed text from the spawned architect session (spec 0050 A2). Rendered
   * distinctly in the console (e.g. "Architect · fable"). */
  | { type: "architect_progress"; delta: string }
  /** The architect wrote `specs/<specId>-*.md` to disk and the runner verified
   * its model identity + working-tree scope fence (spec 0050 A2). The console
   * renders a REVIEW-ONLY spec-draft card from this (no commit/run/promote). */
  | {
      type: "spec_draft";
      specId: string;
      specPath: string;
      title: string;
      summary: string;
      model: string;
    }
  /** Phase-3 watch-run handoff (spec 0052 / ADR-022 §6). The supervisor emitted
   * `[[SUPERVISOR_WATCH:<specId>]]` in its text (a THIRD marker, same
   * strip-and-yield mechanism as the gate and spawn-architect markers); the
   * runner strips it and yields this. The agent's tool surface gains NOTHING —
   * the marker only CAUSES a RunFollowCard to render; the human's Follow-button
   * click is the only thing that spawns the (FOLLOW-only, `--no-start`) watcher,
   * exactly as the human's gate-button click is the only thing that signals a
   * gate. */
  | { type: "watch_run"; specId: string }
  | { type: "result"; ok: boolean; handoffNote?: string; costUsd?: number; numTurns?: number }
  | { type: "error"; message: string };

export interface SupervisorSessionRequest {
  credential: AgentCredential;
  /** Absolute path of the repo the session inspects (localhost, phase 1). */
  workdir: string;
  /** The user's natural-language message from the console. */
  prompt: string;
  /** SDK session id to resume (spec 0067 item 3 continuity) — the thread's
   * pinned `sdk_session_id`, so this turn loads the conversation history the
   * SDK already has for it, rather than starting a brand-new session. */
  resume?: string;
  /** Bounded per ADR-022 risk (no unbounded Opus session). */
  maxTurns?: number;
  /** Chosen model, e.g. `modelForRole("supervisor", overrides)`. */
  model?: string;
  /** Abort hookup — fires the SDK AbortController (reused from session.ts). */
  abortSignal?: AbortSignal;
  /** Inactivity-watchdog threshold; same semantics as session.ts. */
  sessionInactivityMs?: number;
  /** Per-message heartbeat (the SSE route pokes keep-alive). */
  onHeartbeat?: () => void;
  /** Timer-heartbeat interval; only active when `onHeartbeat` is set. */
  heartbeatIntervalMs?: number;
  /**
   * Spec 0140: which session PROFILE to run.
   *
   *  - `inspect` (default) — the platform console, unchanged: Bash/Read/Grep/
   *    Glob, no Write/Edit, no git mutation, no file write. It is a shell on
   *    OUR repo, so it stays read-only.
   *  - `project` — a chat bound to a project + branch (spec 0135). It WORKS in
   *    that project's checkout: Write/Edit/TodoWrite/Task join the tool set and
   *    the Bash deny-list keeps only its universal clauses. Gate signals stay
   *    human-only and the host stays off-limits in BOTH profiles.
   */
  profile?: SupervisorProfile;
  /** Spec 0141: this project's specs directory, OUTSIDE the checkout. A second
   * allowed write root, and named in the scope block so the agent puts specs
   * there instead of in the customer's repository. */
  specsDir?: string;
  /**
   * Spec 0144 B: how a PROJECT session asks its human a question.
   *
   * `AskUserQuestion` reaches `canUseTool` and BLOCKS the turn until this
   * resolves — the host renders the options, collects the answer, and the
   * promise's value becomes `updatedInput.answers`. `null` means unanswered
   * (timeout, stop, or no handler): the tool is denied with a message the
   * agent can act on, instead of the silent skip the owner watched happen live.
   */
  onQuestion?: (input: AskUserQuestionInput) => Promise<AskUserQuestionAnswers | null>;
  /**
   * Spec 0174: start a pipeline run for this project. Injected, never
   * implemented here — the resolution of the spec's project, the thread's
   * branch and `branchStartRefusal` all live in apps/web, which this package
   * must not import. The tool forwards and reports back; it does not become a
   * second starter (spec 0131: four disagreed, and the one in the path was the
   * one nobody had fixed).
   */
  onStartRun?: (input: StartRunInput) => Promise<StartRunResult>;
  /**
   * Where the ROLE PROMPT lives — the launchpad's own checkout. Separate from
   * `workdir` since spec 0140: a project chat works in the CUSTOMER's checkout,
   * which has no `agents/supervisor.md` and no `CLAUDE.md`, so reading the
   * prompt from the workdir silently produced an EMPTY system prompt. That is
   * why the first project chat behaved like a generic assistant and never used
   * its architect-spawn marker. Defaults to `workdir` (the platform case).
   */
  promptRoot?: string;
}

/** Spec 0140 — see `SupervisorSessionRequest.profile`. */
export type SupervisorProfile = "inspect" | "project";

/** The `AskUserQuestion` tool's input, as the SDK delivers it (spec 0144 B). */
export interface AskUserQuestionInput {
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  [key: string]: unknown;
}

/** question text -> chosen label(s). */
export type AskUserQuestionAnswers = Record<string, string | string[]>;

/** Repo-relative path of the supervisor's role prompt — mirrors
 * `session.ts`'s `ROLE_FILES["supervisor"]` (kept independent so this module
 * never needs `AgentRole`-keyed lookups just to load one file). */
const SUPERVISOR_ROLE_FILE = "agents/supervisor.md";

/**
 * Spec 0140's scope block for the PROJECT profile. The role file says "you have
 * no Write/Edit tool" — true for `inspect`, a LIE for `project`, and a lie the
 * agent obeys: the first project chat refused to draft a spec it had the tools
 * to write. This block states the working contract, and restates the two
 * limits that do NOT move.
 */
/** Spec 0174: exported for the prompt test — the shipped string is the
 * contract, and a test that re-states it in its own words proves nothing. */
export function buildProjectScopeBlockForTest(workdir: string, specsDir?: string): string {
  return projectScopeBlock(workdir, specsDir);
}

function projectScopeBlock(workdir: string, specsDir?: string): string {
  const specsLine = specsDir
    ? [
        "",
        `**Specs live at \`${specsDir}\` — OUTSIDE this repository (spec 0141).**`,
        "Write and read spec files THERE, never inside the checkout, and never commit a",
        "spec into the customer's repository. Code goes in the checkout; specs do not.",
      ]
    : [];
  return [
    "# This session's scope (specs 0140/0144 — project working session)",
    "",
    `You are working INSIDE one customer project's checkout: \`${workdir}\`.`,
    ...specsLine,
    "",
    "You help the user deliver changes to THIS project: understand the request, read the",
    "code, draft the spec, and then START THE RUN. Ask with AskUserQuestion when a real",
    "decision is the user's to make.",
    "",
    "**How a change actually lands here (spec 0174).** Draft the spec in the specs directory",
    "above with `track: 2` in its frontmatter — track 2 IS the pipeline; track 1 means direct work",
    "with no run and no gates, and a spec that says so while a run executes it makes the product",
    "contradict itself on screen (spec 0179).",
    `above, then call \`${START_RUN_TOOL_FQN}\` with its id and a one- or two-sentence`,
    "request. The run's coder implements it, runs CI, opens the PR and stops at the human",
    "gates. That is the ONLY way code reaches the branch.",
    "",
    "**Do not implement the change yourself, and do not commit.** You have a shell and an",
    "editor for reading, exploring and preparing — not for landing work. A commit from here",
    "skips CI, the PR and both gates, and the permission gate refuses it. If you catch",
    "yourself writing the feature, stop and start the run instead.",
    "",
    "Two limits do not move:",
    "",
    "1. **Gate signals are human-only (ADR-007).** Never run a pipeline gate verb",
    "   (approve-spec / approve-pr / promote / reject) and never signal Temporal. Starting a",
    "   run is not a gate — it is the request the gates answer — and it goes through the tool",
    "   above, never through a CLI.",
    "2. **The host is out of scope.** No sudo/systemctl/docker/ssh, nothing under `/etc`,",
    "   and never read `.env`, `launchpad.env`, `.git-credentials` or an SSH key.",
    "",
    "Writes are confined to this checkout and the specs directory above — anywhere else is",
    "refused by the permission gate.",
  ].join("\n");
}

/** What the SDK accepts as a system prompt: a raw string, or the official
 * Claude Code PRESET with an optional append (spec 0144). */
type SystemPromptOption =
  | string
  | { type: "preset"; preset: "claude_code"; append?: string };

async function supervisorSystemPrompt(
  workdir: string,
  promptRoot: string,
  profile: SupervisorProfile,
  specsDir?: string,
): Promise<SystemPromptOption> {
  const claudeMd = await readFile(path.join(workdir, "CLAUDE.md"), "utf8").catch(() => "");
  if (profile === "project") {
    // Spec 0144: the REAL Claude Code system prompt, not our imitation of it.
    // Specs 0049–0140 built a "supervisor" role that re-taught a weaker
    // version of what the preset already knows; every live failure on the
    // facturas branch traced back to that cage. The append carries only what
    // Claude Code cannot know: this project's scope and the two rails.
    const scope = projectScopeBlock(workdir, specsDir);
    const append = claudeMd ? `${scope}\n\n# Project CLAUDE.md\n\n${claudeMd}` : scope;
    return { type: "preset", preset: "claude_code", append };
  }
  // `inspect` (the platform console) is byte-identical to its pre-0144 self.
  const roleMd = await readFile(path.join(promptRoot, SUPERVISOR_ROLE_FILE), "utf8").catch(() => "");
  return `${claudeMd}\n\n# Your role\n\n${roleMd}`;
}

/** Best-effort text rendering of a `tool_result` content payload (a plain
 * string or an Anthropic content-block array) for the `tool_result`
 * SupervisorEvent's `output` field. */
function renderToolResultOutput(content: unknown): string | undefined {
  if (content == null) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : undefined,
      )
      .filter((t): t is string => typeof t === "string")
      .join("\n");
    return text || JSON.stringify(content);
  }
  return JSON.stringify(content);
}

/**
 * The gate-card contract's marker (spec 0049 item A2): the supervisor's role
 * prompt (`agents/supervisor.md`) instructs it to include this EXACT marker
 * in its text output when a spec is parked at a gate the human should act on.
 * Global so a single text block can carry more than one gate reference.
 */
const GATE_MARKER_RE = /\[\[SUPERVISOR_GATE:([A-Za-z0-9._-]+)\]\]/g;

/** Strips every {@link GATE_MARKER_RE} occurrence out of a text delta and
 * returns the specs it named, in order. The cleaned text is what the console
 * actually renders — the marker itself is a runner-internal signal, never
 * shown to the human. */
function extractGateMarkers(text: string): { text: string; specIds: string[] } {
  const specIds: string[] = [];
  const cleaned = text.replace(GATE_MARKER_RE, (_match, specId: string) => {
    specIds.push(specId);
    return "";
  });
  return { text: cleaned, specIds };
}

/**
 * The architect-spawn contract's marker (spec 0050 item A1) — a SECOND
 * text marker, the exact same mechanism as {@link GATE_MARKER_RE}:
 * `agents/supervisor.md` instructs the supervisor to emit this EXACT literal
 * in its reply when the user's request warrants a new spec. The runner
 * strips it from the visible text and yields `{type:"spawn_architect"}`
 * instead; the supervisor's tool surface gains nothing — it only CAUSES the
 * orchestrator (the `/api/supervisor` route, B1) to spawn the Fable architect
 * sequentially, after the supervisor's turn ends.
 */
const SPAWN_ARCHITECT_MARKER = "[[SUPERVISOR_SPAWN_ARCHITECT]]";

/** Strips every {@link SPAWN_ARCHITECT_MARKER} occurrence out of a text delta,
 * mirroring {@link extractGateMarkers}. The cleaned text (the architect
 * BRIEF) is what the console renders; the marker itself is runner-internal. */
function extractSpawnArchitectMarker(text: string): { text: string; spawnArchitect: boolean } {
  if (!text.includes(SPAWN_ARCHITECT_MARKER)) return { text, spawnArchitect: false };
  return { text: text.split(SPAWN_ARCHITECT_MARKER).join(""), spawnArchitect: true };
}

/**
 * The watch-run contract's marker (spec 0052 item C) — a THIRD text marker,
 * the exact same mechanism as {@link GATE_MARKER_RE} and
 * {@link SPAWN_ARCHITECT_MARKER}: `agents/supervisor.md` instructs the
 * supervisor to emit this EXACT literal (with the spec id) when the user asks
 * to run/follow/watch a spec whose workflow is already started. The runner
 * strips it from the visible text and yields `{type:"watch_run",specId}`
 * instead; the supervisor's tool surface gains nothing — the marker only
 * CAUSES a RunFollowCard to render, and only the human's Follow-button click
 * spawns the (FOLLOW-only) watcher.
 */
const WATCH_MARKER_RE = /\[\[SUPERVISOR_WATCH:([A-Za-z0-9._-]+)\]\]/g;

/** Strips every {@link WATCH_MARKER_RE} occurrence out of a text delta and
 * returns the spec ids it named, in order — mirrors {@link extractGateMarkers}. */
function extractWatchMarkers(text: string): { text: string; specIds: string[] } {
  const specIds: string[] = [];
  const cleaned = text.replace(WATCH_MARKER_RE, (_match, specId: string) => {
    specIds.push(specId);
    return "";
  });
  return { text: cleaned, specIds };
}

/** The literal prefix every marker ([[SUPERVISOR_GATE / _SPAWN_ARCHITECT /
 * _WATCH) shares. Used to decide how much of a text buffer is safe to emit. */
const MARKER_PREFIX = "[[SUPERVISOR_";

/**
 * Index into `buf` from which the tail must be HELD BACK because it could be a
 * marker split across streamed assistant text blocks (the SDK chunks a turn's
 * text into multiple blocks; the browser concatenates the `{type:"text"}`
 * deltas, so a marker straddling a chunk boundary would leak AND yield no
 * event if each block were stripped independently). Returns the earliest index
 * whose suffix is either (1) an initial fragment of `MARKER_PREFIX` (`[`,
 * `[[`, `[[SUP`…) or (2) a marker in progress (`[[SUPERVISOR_…` with no closing
 * `]]` yet). Everything before that index is safe to emit now. Plain prose
 * brackets (`[[foo]]`, a stray `[[`) are NOT held. Exported for unit tests. */
export function markerHoldIndex(buf: string): number {
  for (let i = 0; i < buf.length; i++) {
    const tail = buf.slice(i);
    if (MARKER_PREFIX.startsWith(tail)) return i;
    if (tail.startsWith(MARKER_PREFIX) && !tail.includes("]]")) return i;
  }
  return buf.length;
}

/** Narrow shape of an Anthropic content block, as loosely as `session.ts`
 * narrows top-level SDK messages — the union evolves between SDK versions. */
interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Stream a supervisor session as normalized {@link SupervisorEvent}s.
 *
 * Wraps `queryFn(...)` with the supervisor system prompt
 * (`agents/supervisor.md`), `allowedTools: SUPERVISOR_ALLOWED_TOOLS`, a
 * bounded `maxTurns`, and `env: {...scrubAgentEnv(),
 * ...credentialEnv(req.credential)}` — reusing session.ts's abort +
 * inactivity-watchdog plumbing via {@link createSessionWatchdog} (do not
 * duplicate; `runAgentSession` stays byte-identical). Each SDK message is
 * normalized to a `SupervisorEvent`: assistant `text`/`tool_use` content
 * blocks, paired `tool_result` blocks off the following `user` message, and
 * the terminal `result`. A stall (watchdog trip) or thrown SDK error both
 * surface as a terminal `{type:"error"}` event rather than an unhandled
 * rejection, since this is a long-lived UI stream, not a one-shot Promise.
 *
 * The SDK's `system`/`init` message's `session_id` (spec 0067 item 3
 * continuity) is yielded as `{type:"session",sessionId}` — the caller pins it
 * to the thread so the NEXT turn can pass it back as `req.resume`, which is
 * forwarded verbatim to the SDK's `Options.resume`.
 *
 * A `[[SUPERVISOR_GATE:<specId>]]` marker anywhere in a text block (item A2)
 * is stripped from the visible text and yielded as `{type:"gate",specId}` —
 * the agent-output-to-gate-event contract; the agent never fires the signal
 * itself, only the human's button click does (B1/B2 wire the click).
 *
 * A `[[SUPERVISOR_SPAWN_ARCHITECT]]` marker (spec 0050 item A1) is stripped
 * the same way and yielded as `{type:"spawn_architect"}` — the remaining text
 * (minus both markers) is the architect BRIEF the orchestrator composes into
 * an `ArchitectSpawnRequest` (B1 spawns `runArchitectSpawn` sequentially,
 * after this generator's `result` event, per architect-session.ts).
 *
 * A `[[SUPERVISOR_WATCH:<specId>]]` marker (spec 0052 item C) is stripped the
 * same way and yielded as `{type:"watch_run",specId}` — the console renders a
 * RunFollowCard from it; only the human's Follow-button click spawns the
 * watcher (this marker grants the agent no new capability, same as the gate
 * and spawn-architect markers).
 */
export async function* streamSupervisorSession(
  req: SupervisorSessionRequest,
  queryFn: QueryFn = query,
): AsyncGenerator<SupervisorEvent, void, unknown> {
  // Spec 0219 E: this session stalls the same way the pipeline's does, and
  // discarding its stderr would make the stall report "said nothing" when in
  // fact nobody listened.
  const stderrTail = createStderrTail();
  const watchdog = createSessionWatchdog({
    role: "supervisor",
    abortSignal: req.abortSignal,
    onHeartbeat: req.onHeartbeat,
    heartbeatIntervalMs: req.heartbeatIntervalMs,
    sessionInactivityMs: req.sessionInactivityMs,
    subprocessStderr: () => stderrTail.tail(),
  });
  const { abortController } = watchdog;

  // tool_use id -> tool name, so the paired tool_result (delivered on the
  // NEXT SDK "user" message) can report which tool produced it.
  const toolNameById = new Map<string, string>();

  // Assistant text is accumulated here across SDK blocks so a marker split
  // over a chunk boundary is still matched (the browser concatenates the
  // deltas — stripping per-block would leak a straddling marker and fire no
  // event). Complete markers are extracted from the buffer; a possible
  // partial-marker tail is held back (markerHoldIndex) and flushed at the
  // terminal `result` (or when the stream ends).
  let textBuffer = "";

  // Spec 0144 B: while a question waits on the human, no SDK messages flow —
  // the inactivity watchdog would read that silence as a stall and kill a
  // session that is doing exactly what it should. Feed it while pending.
  const onQuestion = req.onQuestion
    ? async (input: AskUserQuestionInput) => {
        const keepalive = setInterval(() => watchdog.recordMessage("question-pending"), 15_000);
        try {
          return await req.onQuestion!(input);
        } finally {
          clearInterval(keepalive);
        }
      }
    : undefined;

  // Spec 0144 A: a hit turn cap resumes the SAME session instead of dying —
  // "Reached maximum number of turns (30)" was the owner's first failure. Bounded:
  // the cap per query rises to 100 and at most 3 chained queries serve one
  // user message, so a runaway loop still terminates. `inspect` keeps its
  // pre-0144 single query at 30.
  const isProject = (req.profile ?? "inspect") === "project";
  const systemPrompt = await supervisorSystemPrompt(
    req.workdir,
    req.promptRoot ?? req.workdir,
    req.profile ?? "inspect",
    req.specsDir,
  );
  let resume = req.resume;
  let chainPrompt = req.prompt;
  let capturedSessionId: string | undefined;
  const maxChains = isProject ? 3 : 1;

  try {
    for (let chain = 0; chain < maxChains; chain++) {
      let hitTurnCap = false;
      const q = queryFn({
      prompt: chainPrompt,
      options: {
        cwd: req.workdir,
        abortController,
        systemPrompt,
        model: req.model,
        maxTurns: req.maxTurns ?? (isProject ? 100 : 30),
        resume,
        permissionMode: "default",
        // Auto-approve only the read-only tools; `Bash` is gated by
        // supervisorCanUseTool (its command deny-list) rather than pre-approved
        // — see SUPERVISOR_AUTO_APPROVED_TOOLS (spec 0070).
        // Spec 0140: the project profile pre-approves the working tools and
        // gates Bash + write TARGETS through `projectCanUseTool`; `inspect` is
        // byte-identical to spec 0070's surface.
        allowedTools:
          (req.profile ?? "inspect") === "project"
            ? [...PROJECT_AUTO_APPROVED_TOOLS]
            : [...SUPERVISOR_AUTO_APPROVED_TOOLS],
        canUseTool:
          (req.profile ?? "inspect") === "project"
            ? makeProjectCanUseTool(req.workdir, req.specsDir, onQuestion)
            : supervisorCanUseTool,
        // Spec 0174: the project chat's one way to start a run. Absent for the
        // inspect console, which starts nothing.
        ...(isProject && req.onStartRun
          ? { mcpServers: { [START_RUN_MCP_SERVER]: createStartRunServer(req.onStartRun) } }
          : {}),
        env: { ...scrubAgentEnv(), ...credentialEnv(req.credential) } as Record<string, string>,
        stderr: (data: string) => stderrTail.capture(data),
      },
    });

    try {
      for await (const message of q) {
        // Narrow defensively: SDK message unions evolve between versions.
        const m = message as {
          type: string;
          subtype?: string;
          message?: { content?: unknown };
          result?: string;
          total_cost_usd?: number;
          num_turns?: number;
          session_id?: string;
        };
        watchdog.recordMessage(m.type);

        if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string") {
          capturedSessionId = m.session_id;
          yield { type: "session", sessionId: m.session_id };
        } else if (m.type === "assistant" && Array.isArray(m.message?.content)) {
          for (const block of m.message!.content as ContentBlock[]) {
            if (block.type === "text" && typeof block.text === "string") {
              // Accumulate, extract COMPLETE markers from the whole buffer
              // (so a marker split across blocks still matches), then emit
              // only the safe prefix and retain any partial-marker tail.
              textBuffer += block.text;
              const { text: afterGate, specIds } = extractGateMarkers(textBuffer);
              const { text: afterSpawn, spawnArchitect } = extractSpawnArchitectMarker(afterGate);
              const { text: afterWatch, specIds: watchSpecIds } = extractWatchMarkers(afterSpawn);
              const hold = markerHoldIndex(afterWatch);
              const emit = afterWatch.slice(0, hold);
              textBuffer = afterWatch.slice(hold);
              if (emit) yield { type: "text", delta: emit };
              for (const specId of specIds) yield { type: "gate", specId };
              if (spawnArchitect) yield { type: "spawn_architect" };
              for (const specId of watchSpecIds) yield { type: "watch_run", specId };
            } else if (block.type === "tool_use" && typeof block.name === "string") {
              if (typeof block.id === "string") toolNameById.set(block.id, block.name);
              yield { type: "tool_use", name: block.name, input: block.input };
            }
          }
        } else if (m.type === "user" && Array.isArray(m.message?.content)) {
          for (const block of m.message!.content as ContentBlock[]) {
            if (block.type === "tool_result") {
              const name = (block.tool_use_id && toolNameById.get(block.tool_use_id)) || "unknown";
              yield {
                type: "tool_result",
                name,
                ok: !block.is_error,
                output: renderToolResultOutput(block.content),
              };
            }
          }
        } else if (m.type === "result") {
          // Flush any held text tail (a partial-marker candidate that never
          // completed is just text) before the terminal result event.
          if (textBuffer) {
            yield { type: "text", delta: textBuffer };
            textBuffer = "";
          }
          // Spec 0144 A: a turn-cap result on a project session is NOT
          // terminal — the session is persisted, so the next chained query
          // resumes it. The intermediate result is deliberately not yielded:
          // the user sees one continuous turn, not three stitched ones.
          if (m.subtype === "error_max_turns" && isProject && chain < maxChains - 1) {
            hitTurnCap = true;
            break;
          }
          yield {
            type: "result",
            ok: m.subtype === "success",
            handoffNote: m.result,
            costUsd: m.total_cost_usd,
            numTurns: m.num_turns,
          };
        }
      }
      // Stream ended without a terminal result — flush any retained tail.
      if (textBuffer) {
        yield { type: "text", delta: textBuffer };
        textBuffer = "";
      }
      if (hitTurnCap && capturedSessionId) {
        // Chain the next query onto the SAME session.
        resume = capturedSessionId;
        chainPrompt =
          "Alcanzaste el límite de turnos de la consulta anterior. Continúa exactamente " +
          "donde quedaste — no repitas trabajo ya hecho.";
        continue;
      }
      // Fall through to the post-chain stall check below, then stop chaining.
    } catch (err) {
      // A stall-triggered abort may surface as the SDK's own abort error (or
      // nothing, if the generator just ends) — the watchdog's diagnosis wins
      // either way once it has fired (mirrors runAgentSession).
      const stalledError = watchdog.stalledError();
      yield { type: "error", message: stalledError ? stalledError.message : errorMessage(err) };
      return;
    }

    if (watchdog.stalledError() !== undefined) {
      // `??` instead of narrowing: TS de-narrows captured bindings around
      // generator yields here, so the fallback keeps the type a plain string.
      yield { type: "error", message: watchdog.stalledError()?.message ?? "session stalled" };
    }
    break;
    } // for (chain) — spec 0144 A
  } finally {
    watchdog.cleanup();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
