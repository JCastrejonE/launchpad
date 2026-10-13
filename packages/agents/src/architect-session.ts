/**
 * In-UI architect spawn runner (spec 0050 / ADR-015 amendment + ADR-022 phase
 * 2) — the CONSTRAINED, execution-free sibling of `supervisor-session.ts`.
 *
 * NAMING (spec 0099 / G.1): the role this runs is now `spec-drafter` — the ONE
 * drafting role, after §10.A's collapse of the former `architect` role into it.
 * The `Architect*` export names are kept on purpose: they are the shared
 * drafting POLICY (`ARCHITECT_ALLOWED_TOOLS` + {@link createArchitectCanUseTool}
 * + {@link architectFenceViolations}), which the Temporal `draftSpec` activity
 * now imports so both entry points enforce the same thing. Renaming them would
 * churn this module's test file — the regression baseline for exactly these
 * guards — for no behaviour change. `architect_progress` likewise stays: it is
 * a spec-0067 wire contract the workspace chat renders, not a role label.
 *
 * When the Opus supervisor decides a spec is warranted it emits the
 * `[[SUPERVISOR_SPAWN_ARCHITECT]]` marker; the `/api/supervisor` route computes
 * the next free spec id and calls {@link runArchitectSpawn}, which wraps the
 * SAME Agent SDK `query()` primitive the pipeline uses (ADR-004) — but with a
 * DELIBERATELY NARROW tool surface so the drafting session can do ONE thing:
 * write `specs/<specId>-*.md` to disk. The result streams back as the SHARED
 * {@link SupervisorEvent} union so the console/route never parse raw SDK
 * messages.
 *
 * WHY A BESPOKE RUNNER (not `runAgentSession`): this runner STREAMS — it yields
 * {@link SupervisorEvent}s so the browser sees the draft being written, whereas
 * `runAgentSession` awaits a single result. That difference is real and is why
 * both survive spec 0099's collapse. (Historically there was a second reason:
 * `runAgentSession` hardcoded a `Bash` + Write-anywhere `acceptEdits` surface,
 * so routing an in-product architect through it would have broken the ADR-015
 * execution-free boundary. Spec 0099 fixed that at the source — it now accepts
 * `allowedTools`/`canUseTool` and drops `acceptEdits` whenever a gate is
 * supplied — which is precisely what let the pipeline's `draftSpec` adopt the
 * guards below instead of going without.) It wraps `query()` directly (the
 * pattern `streamSupervisorSession` already established) with:
 *   - `allowedTools` = {@link ARCHITECT_ALLOWED_TOOLS} (`Read`/`Grep`/`Glob`/
 *     `Write`; NO `Bash`, NO `Edit`), and
 *   - a `canUseTool` permission callback that DENIES any `Write` whose path is
 *     not `specs/<specId>-*.md` (A1),
 * PLUS a post-session working-tree scope fence (diff ⊆ `specs/*.md`) and a
 * model-identity check (requested === echoed) as
 * defense-in-depth before any draft is surfaced (A2, implemented below).
 *
 * It REUSES `session.ts`'s credential/scrub/abort + inactivity-watchdog
 * plumbing via {@link createSessionWatchdog} — do not duplicate.
 *
 * NOTE (dependency direction): `@launchpad/pipeline` depends on
 * `@launchpad/agents`, so this module must NOT import `fenceViolations` from
 * the pipeline's scope-fence (that would be a cycle). A2 implements an
 * EQUIVALENT pure check locally (the spec explicitly allows this).
 */
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { AgentCredential } from "./credentials.js";
import type { AskUserQuestionAnswers, AskUserQuestionInput } from "./supervisor-session.js";
import { credentialEnv } from "./credentials.js";
import { scrubAgentEnv } from "./env-scrub.js";
import { createSessionWatchdog, type QueryFn } from "./session.js";
import { createStderrTail } from "./stderr-tail.js";
import { modelForRole } from "./models.js";
import { specStructureViolations } from "./spec-structure.js";
import type { SupervisorEvent } from "./supervisor-session.js";

/**
 * The drafting role's tool surface — execution-free (spec 0050 / ADR-015).
 * Shared by BOTH entry points since spec 0099: this streaming runner and the
 * Temporal `draftSpec` activity, which passes it to `runAgentSession`. `Read`/
 * `Grep`/`Glob` to ground the spec in the codebase, and `Write` to create the
 * one spec file (further gated to `specs/<specId>-*.md` by `canUseTool`). NO
 * `Bash` (no shell/git/live-infra) and NO `Edit`. The no-Bash/no-Edit property
 * is unit-tested, mirroring the supervisor's no-gate-signal invariant.
 */
export const ARCHITECT_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Write",
  // Spec 0147: the drafter must be able to ASK. Its role file used to say
  // "when unsure, default to Track 1", and a mislabelled track renders as a
  // spec page with no gates and no Start — which reads as a broken product,
  // not a mislabelled spec. Asking is the fix, and this tool is what makes the
  // instruction executable rather than a lie about its own surface (the exact
  // shape of the 0140 failure: a prompt describing tools the session lacked).
  //
  // It does not widen the execution-free boundary (ADR-015): a question runs
  // nothing, writes nothing, and returns only what the human chose.
  "AskUserQuestion",
] as const;

export type ArchitectAllowedTool = (typeof ARCHITECT_ALLOWED_TOOLS)[number];

export interface ArchitectSpawnRequest {
  credential: AgentCredential;
  /** Spec 0147: how this drafting session asks its human a question (the track
   * decision, most often). Wired by the console; absent headless. */
  onQuestion?: (input: AskUserQuestionInput) => Promise<AskUserQuestionAnswers | null>;
  /** Absolute path of the repo the architect writes into (dev-local primary
   * checkout in phase 2; worktree isolation is deferred to phase 5). */
  workdir: string;
  /** Composed brief: the user's original request + the supervisor's briefing
   * (the supervisor's turn text, minus the spawn marker). Becomes the prompt. */
  brief: string;
  /** The pre-computed, zero-padded spec id the architect MUST use (the
   * orchestrator computed the next free id — the architect never guesses one,
   * avoiding collisions). The `canUseTool` gate binds Write to
   * `specs/<specId>-*.md`. */
  specId: string;
  /** Chosen model; defaults to `modelForRole("spec-drafter")` (mid-tier,
   * overridable — spec 0099 retired the claude-fable-5 pin). The runner still
   * verifies requested === echoed before surfacing a draft; the SDK echoes the
   * requested alias verbatim (verified for both aliases, spec 0099). */
  model?: string;
  /** Bounded per ADR-022 risk (no unbounded drafting session). */
  maxTurns?: number;
  /** Abort hookup — fires the SDK AbortController (reused from session.ts). */
  abortSignal?: AbortSignal;
  /** Inactivity-watchdog threshold; same semantics as session.ts. */
  sessionInactivityMs?: number;
  /** Per-message heartbeat (the SSE route pokes keep-alive). */
  onHeartbeat?: () => void;
  /** Timer-heartbeat interval; only active when `onHeartbeat` is set. */
  heartbeatIntervalMs?: number;
}

/** Repo-relative path of the drafting role's prompt — mirrors
 * `session.ts`'s `ROLE_FILES["spec-drafter"]` (kept independent so this module
 * never needs `AgentRole`-keyed lookups just to load one file, same choice
 * `supervisor-session.ts` made for `SUPERVISOR_ROLE_FILE`). Spec 0099 renamed
 * the file from `agents/architect.md` as part of the role collapse. */
const ARCHITECT_ROLE_FILE = "agents/spec-drafter.md";

async function architectSystemPrompt(workdir: string): Promise<string> {
  const claudeMd = await readFile(path.join(workdir, "CLAUDE.md"), "utf8").catch(() => "");
  const roleMd = await readFile(path.join(workdir, ARCHITECT_ROLE_FILE), "utf8").catch(() => "");
  return `${claudeMd}\n\n# Your role\n\n${roleMd}`;
}

/**
 * True when `filePath` (the ABSOLUTE path the SDK's `Write` tool receives,
 * per `FileWriteInput.file_path`) resolves to `specs/<specId>-*.md` directly
 * inside `workdir`'s `specs/` directory — no subdirectory, no `..` traversal.
 * Exported so the fence/`canUseTool` unit tests can exercise it directly.
 */
export function isAllowedArchitectWritePath(workdir: string, specId: string, filePath: string): boolean {
  const specsDir = path.join(workdir, "specs");
  const rel = path.relative(specsDir, path.resolve(filePath));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  if (rel.includes(path.sep)) return false; // must land directly inside specs/, no nesting
  return rel.startsWith(`${specId}-`) && rel.endsWith(".md");
}

/**
 * Builds the architect's `canUseTool` permission gate (spec 0050 A1): denies
 * any tool outside {@link ARCHITECT_ALLOWED_TOOLS} — defense-in-depth even
 * though `allowedTools` already excludes `Bash`/`Edit` at the SDK layer — and
 * denies any `Write` whose `file_path` is not `specs/<specId>-*.md` (per
 * {@link isAllowedArchitectWritePath}). Everything else is allowed.
 *
 * The allow branch MUST echo `updatedInput` (spec 0099). The SDK's runtime
 * schema for a permission response requires it — an allow without it is
 * REJECTED as malformed (`ZodError: expected record … path: ["updatedInput"]`),
 * the tool call fails, and nothing is written. `PermissionResult` types the
 * field as optional, so this cost nothing at compile time and everything at
 * runtime: from spec 0050 until 0099 this gate turned every PERMITTED write
 * into a hard failure, which is why a live drafting session could not produce a
 * spec at all. Caught by running one; no unit test could see it, because the
 * tests asserted our own return value rather than whether the SDK accepted it.
 */
export function createArchitectCanUseTool(
  workdir: string,
  specId: string,
  /** Spec 0147: resolves an `AskUserQuestion` with the human's answers, or
   * null when nobody answered. Absent in a headless drafting run, where the
   * tool then denies with a reason and the drafter proceeds on its judgement. */
  onQuestion?: (input: AskUserQuestionInput) => Promise<AskUserQuestionAnswers | null>,
): CanUseTool {
  return async (toolName, input) => {
    if (toolName === "AskUserQuestion") {
      if (!onQuestion) {
        return {
          behavior: "deny",
          message:
            "no hay quien responda preguntas en esta sesión — elige el track con tu mejor criterio y dilo en el spec",
        };
      }
      const answers = await onQuestion(input as AskUserQuestionInput);
      if (!answers) {
        return {
          behavior: "deny",
          message: "el usuario no respondió — elige el track con tu mejor criterio y dilo en el spec",
        };
      }
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }
    if (!(ARCHITECT_ALLOWED_TOOLS as readonly string[]).includes(toolName)) {
      return {
        behavior: "deny",
        message: `architect tool surface is execution-free (spec 0050 / ADR-015) — ${toolName} is not allowed`,
      };
    }
    if (toolName === "Write") {
      const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
      if (!filePath || !isAllowedArchitectWritePath(workdir, specId, filePath)) {
        return {
          behavior: "deny",
          message:
            `architect may only write specs/${specId}-*.md (execution-free boundary, spec 0050 / ADR-015); ` +
            `refused ${filePath ?? "a Write with no file_path"}`,
        };
      }
    }
    return { behavior: "allow", updatedInput: input };
  };
}

/** Narrow shape of an assistant content block — as loosely as
 * `supervisor-session.ts`'s `ContentBlock` narrows it (the SDK's content
 * union evolves between versions; the architect only needs `text`). */
interface ArchitectContentBlock {
  type: string;
  text?: string;
}

const execFileP = promisify(execFile);

/**
 * Repo-relative paths with uncommitted changes (`git status --porcelain`) —
 * the raw fact the A2 execution-free fence backstop compares before vs. after
 * the architect's turn. Deliberately a LOCAL equivalent of
 * `@launchpad/pipeline`'s `git.ts#dirtyFiles`, NOT an import of it:
 * `@launchpad/pipeline` depends on `@launchpad/agents`, so importing the
 * other direction would be a dependency cycle (see the module doc).
 */
export type GitStatusFn = (cwd: string) => Promise<string[]>;

async function defaultGitStatus(cwd: string): Promise<string[]> {
  const { stdout } = await execFileP("git", ["status", "--porcelain"], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  // Each porcelain line is "XY <path>"; the path starts at column 3.
  return stdout
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/**
 * True when repo-relative `relPath` (as `git status --porcelain` reports it,
 * forward-slash-separated) is `specs/<specId>-*.md` directly — the same rule
 * {@link isAllowedArchitectWritePath} enforces for the `canUseTool` gate,
 * restated over relative paths for the post-session fence backstop below.
 */
function isAllowedArchitectRelativePath(specId: string, relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/");
  const prefix = "specs/";
  if (!normalized.startsWith(prefix)) return false;
  const rest = normalized.slice(prefix.length);
  if (rest.includes("/")) return false; // must land directly inside specs/, no nesting
  return rest.startsWith(`${specId}-`) && rest.endsWith(".md");
}

/**
 * The A2 execution-free fence backstop: paths newly dirtied DURING the
 * architect's turn (present in `afterDirty` but not `beforeDirty`) that fall
 * outside `specs/<specId>-*.md`. Comparing against a `beforeDirty` snapshot
 * (rather than just filtering `afterDirty`) means an ALREADY-dirty repo at
 * spawn time (e.g. this very session's own uncommitted spec edits) never
 * produces a false violation — only what the architect's turn itself touched
 * counts. Empty ⇒ the diff is clean; exported so the fence can be unit-tested
 * directly, mirroring `@launchpad/pipeline`'s `fenceViolations` shape.
 */
export function architectFenceViolations(
  beforeDirty: string[],
  afterDirty: string[],
  specId: string,
): string[] {
  const before = new Set(beforeDirty);
  return afterDirty
    .filter((p) => !before.has(p))
    .filter((p) => !isAllowedArchitectRelativePath(specId, p));
}

/** The drafted spec's reviewable fields — read back off disk once the model-
 * identity check and the fence backstop both pass. */
export interface ArchitectSpecDraft {
  /** Repo-relative path, e.g. `specs/0051-example.md`. */
  specPath: string;
  title: string;
  summary: string;
  /** The file as written, so the caller can run {@link specStructureViolations}
   * over the drafting session's output without reading it a second time. */
  markdown: string;
}

/** Minimal frontmatter `title:` extraction — a scoped-down local echo of
 * `apps/web/lib/specs.ts#parseFrontmatter` (not imported: `apps/web` isn't a
 * dependency of `@launchpad/agents`, and this only needs one field). */
function parseSpecTitle(markdown: string): string | undefined {
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!block) return undefined;
  for (const line of (block[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^title:\s*(.*)$/);
    if (kv) return (kv[1] ?? "").trim() || undefined;
  }
  return undefined;
}

/** The first paragraph under `## Intent` — the house spec format's summary
 * (agents/spec-drafter.md), used as the review card's one-line-ish summary. */
function parseIntentSummary(markdown: string): string | undefined {
  const heading = markdown.match(/^## Intent\r?\n/m);
  if (!heading || heading.index === undefined) return undefined;
  const rest = markdown.slice(heading.index + heading[0].length);
  const end = rest.search(/\r?\n\r?\n|\r?\n## /);
  const paragraph = (end === -1 ? rest : rest.slice(0, end)).trim().replace(/\s+/g, " ");
  return paragraph || undefined;
}

/**
 * Reads the architect's drafted `specs/<specId>-*.md` back off disk (found by
 * id prefix, since the architect chooses its own slug) and extracts the
 * review-card fields. Returns `null` when no such file exists — the caller
 * treats that as "the architect didn't actually write a draft" and yields an
 * error instead of a `spec_draft` event.
 */
export async function readArchitectSpecDraft(
  workdir: string,
  specId: string,
): Promise<ArchitectSpecDraft | null> {
  const specsDir = path.join(workdir, "specs");
  let filenames: string[];
  try {
    filenames = await readdir(specsDir);
  } catch {
    return null;
  }
  const filename = filenames.find((f) => f.startsWith(`${specId}-`) && f.endsWith(".md"));
  if (!filename) return null;
  const specPath = path.join("specs", filename);
  const markdown = await readFile(path.join(workdir, specPath), "utf8");
  return {
    specPath,
    title: parseSpecTitle(markdown) ?? filename,
    summary: parseIntentSummary(markdown) ?? "",
    markdown,
  };
}

/**
 * Stream a constrained, execution-free architect session as normalized
 * {@link SupervisorEvent}s: `{type:"architect_progress",delta}` while it
 * works. See the module doc for the enforcement design.
 *
 * Wraps `queryFn(...)` with the drafting system prompt (`agents/spec-drafter.md`),
 * `allowedTools: ARCHITECT_ALLOWED_TOOLS`, the {@link createArchitectCanUseTool}
 * permission gate, a bounded `maxTurns`, and the same
 * `env: {...scrubAgentEnv(), ...credentialEnv(req.credential)}` +
 * abort/inactivity-watchdog plumbing `streamSupervisorSession` uses (via
 * {@link createSessionWatchdog} — do not duplicate). A stall or thrown SDK error surfaces as a terminal
 * `{type:"error"}` event.
 *
 * ITEM A2 enforcement, wired at the terminal SDK `result` message: (1) the
 * model-identity check — the SDK's `system`/`init` message (falling back to
 * an assistant message's echoed model) must equal `req.model ??
 * modelForRole("spec-drafter")`, else `{type:"error"}` and NO draft; (2) the
 * execution-free fence backstop — {@link architectFenceViolations} over a
 * `gitStatusFn` snapshot taken before the session vs. after, else
 * `{type:"error"}` and NO draft; (3) on success, {@link readArchitectSpecDraft}
 * reads the written file's title/summary and yields `{type:"spec_draft"}`.
 * `gitStatusFn` defaults to a real `git status --porcelain` (exported as
 * {@link GitStatusFn} for injection in tests).
 */
export async function* runArchitectSpawn(
  req: ArchitectSpawnRequest,
  queryFn: QueryFn = query,
  gitStatusFn: GitStatusFn = defaultGitStatus,
): AsyncGenerator<SupervisorEvent, void, unknown> {
  // Spec 0219 E: this session stalls the same way the pipeline's does, and
  // discarding its stderr would make the stall report "said nothing" when in
  // fact nobody listened.
  const stderrTail = createStderrTail();
  const watchdog = createSessionWatchdog({
    role: "spec-drafter",
    abortSignal: req.abortSignal,
    onHeartbeat: req.onHeartbeat,
    heartbeatIntervalMs: req.heartbeatIntervalMs,
    sessionInactivityMs: req.sessionInactivityMs,
    subprocessStderr: () => stderrTail.tail(),
  });
  const { abortController } = watchdog;
  const requestedModel = req.model ?? modelForRole("spec-drafter");

  try {
    const beforeDirty = await gitStatusFn(req.workdir);
    let echoedModel: string | undefined;

    const q = queryFn({
      prompt: `${req.brief}\n\nWrite specs/${req.specId}-<slug>.md now.`,
      options: {
        cwd: req.workdir,
        abortController,
        systemPrompt: await architectSystemPrompt(req.workdir),
        model: requestedModel,
        maxTurns: req.maxTurns ?? 30,
        permissionMode: "default",
        allowedTools: [...ARCHITECT_ALLOWED_TOOLS],
        canUseTool: createArchitectCanUseTool(req.workdir, req.specId, req.onQuestion),
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
          model?: string;
          message?: { content?: unknown; model?: string };
        };
        watchdog.recordMessage(m.type);

        if (m.type === "system" && m.subtype === "init" && typeof m.model === "string") {
          echoedModel = m.model;
        } else if (m.type === "assistant" && typeof m.message?.model === "string") {
          echoedModel = echoedModel ?? m.message.model;
        }

        if (m.type === "assistant" && Array.isArray(m.message?.content)) {
          for (const block of m.message!.content as ArchitectContentBlock[]) {
            if (block.type === "text" && typeof block.text === "string" && block.text) {
              yield { type: "architect_progress", delta: block.text };
            }
          }
        } else if (m.type === "result") {
          if (echoedModel !== requestedModel) {
            yield {
              type: "error",
              message:
                `architect model mismatch (spec 0050 / ADR-015): requested ${requestedModel}, ` +
                `got ${echoedModel ?? "unknown"} — discarding the draft`,
            };
            return;
          }

          const afterDirty = await gitStatusFn(req.workdir);
          const violations = architectFenceViolations(beforeDirty, afterDirty, req.specId);
          if (violations.length > 0) {
            yield {
              type: "error",
              message:
                `architect execution-free fence violation (spec 0050 / ADR-015): touched ` +
                `${violations.join(", ")} outside specs/${req.specId}-*.md — discarding the draft`,
            };
            return;
          }

          const draft = await readArchitectSpecDraft(req.workdir, req.specId);
          if (!draft) {
            yield {
              type: "error",
              message: `architect finished but did not write specs/${req.specId}-*.md`,
            };
            return;
          }

          // Spec 0217: the prose is Spanish, the STRUCTURE is English and
          // byte-identical, because `store.ts` parses it with literal regexes.
          // Same terminal-error shape as the fence violation above — a draft
          // whose headings are translated is discarded, not shown for review.
          const structure = specStructureViolations(draft.markdown);
          if (structure.length > 0) {
            yield {
              type: "error",
              message:
                `spec structure violation (spec 0217) in ${draft.specPath}: ` +
                `${structure.join("; ")} — discarding the draft`,
            };
            return;
          }

          yield {
            type: "spec_draft",
            specId: req.specId,
            specPath: draft.specPath,
            title: draft.title,
            summary: draft.summary,
            model: echoedModel,
          };
        }
      }
    } catch (err) {
      const stalledError = watchdog.stalledError();
      yield { type: "error", message: stalledError ? stalledError.message : errorMessage(err) };
      return;
    }

    const stalledError = watchdog.stalledError();
    if (stalledError) yield { type: "error", message: stalledError.message };
  } finally {
    watchdog.cleanup();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
