/**
 * Pure helpers for the supervisor console (spec 0049 / ADR-022): the ACCESS
 * GUARD (flag + OWNER session since spec 0074; the header-derived "localhost"
 * signal is gone — audit #2), the SSE event FRAMING, and the
 * gate-card RESOLUTION (specId -> filename/title/actions). Kept pure and
 * framework-free (no `next`/React/`ai` import, no "use server") so it
 * compiles under apps/web's tsconfig.test.json (`lib` only) and runs under
 * `node --test` — the home for item B2's guard/framing/wiring unit tests.
 * `app/forge/actions.ts`'s `resolveSupervisorGateCard` is a thin
 * "use server" wrapper over {@link resolveSupervisorGateCard} here, the SAME
 * lib-holds-the-logic / action-is-a-thin-wrapper split
 * `app/forge/specs/[filename]/actions.ts` already uses over `lib/pipeline.ts`.
 *
 * The route (app/api/supervisor/route.ts) is the ONLY place these compose with
 * the SDK bridge; it never lets the owner credential or a raw shell command
 * cross to the browser — only normalized SupervisorEvents, SSE-framed here.
 *
 * Implemented in spec 0049 item B1 (guard + framing); item B2 adds the
 * gate-card resolution (moved here from actions.ts so it's unit-testable)
 * plus the full unit-test coverage (the "foundation smoke" tests above
 * already exercise the fail-closed default).
 */
import type { AgentCredential, SupervisorEvent, SupervisorProfile } from "@launchpad/agents";
import { runArchitectSpawn as runArchitectSpawnIO, streamSupervisorSession as streamSupervisorSessionIO } from "@launchpad/agents";
import type { UserRole } from "./auth-core";
import { isSupervisorConsoleEnabled } from "./env";
import { getPipelineViewStateSafe as getPipelineViewStateSafeIO, type GateSignal } from "./pipeline";
import {
  resolveSpecFilenameById as resolveSpecFilenameByIdIO,
  readSpecFile as readSpecFileIO,
  listSpecs as listSpecsIO,
  parseSpecSummary,
} from "./specs";
import { nextSpecId } from "./tenant-start";
import { allocateSpecId as allocateSpecIdIO, projectBySlug } from "@launchpad/db";
import { getDb } from "./db";
import { PLATFORM_PROJECT_SLUG } from "./spec-project";

/** Inputs to the access guard — pure, so it's unit-testable without a live
 * request. `enabled` is `isSupervisorConsoleEnabled(env)`; `role` is the
 * Auth.js session role (spec 0073), null when signed out. Spec 0074 replaced
 * the header-derived "localhost" input here: `X-Forwarded-For`/`Host` are
 * client-controlled and were never a trust boundary (audit #2). */
export interface SupervisorAccessInput {
  enabled: boolean;
  /** The verified session role, or null for a signed-out request. */
  role: UserRole | null;
  /**
   * Spec 0135: whether the caller is a member of the PROJECT this request is
   * scoped to. `undefined` means the request is NOT project-scoped (the
   * platform console, an adhoc turn) — which stays OWNER-only: that surface is
   * a shell on the launchpad's own checkout. `false` means "scoped, and they
   * are not a member" — refused with its own message so the person knows what
   * to ask for.
   */
  projectMember?: boolean;
}

export interface SupervisorAccessResult {
  ok: boolean;
  /** Human-readable refusal reason when `ok` is false (never leaks secrets). */
  reason?: string;
}

/**
 * Access guard (spec 0074, widened by spec 0135): the chat is reachable when
 * the flag is on AND the caller is either a signed-in OWNER (any scope) or a
 * signed-in MEMBER of the request's project. VIEWER stays refused even as a
 * project member — the chat can run commands, and VIEWER means "read, never
 * write" (spec 0117). Refuses by default: flag off, signed out, unscoped
 * non-OWNER, and scoped non-member all fail closed.
 */
export function checkSupervisorAccess(input: SupervisorAccessInput): SupervisorAccessResult {
  if (!input.enabled) {
    return { ok: false, reason: "supervisor console is disabled (SUPERVISOR_CONSOLE_ENABLED is not set)" };
  }
  if (input.role === null) {
    return { ok: false, reason: "supervisor console requires a signed-in session (you are signed out)" };
  }
  // A VIEWER never reaches a chat, member or not: this session runs Bash on the
  // worker behind 0070's DENY-list, which is a deny-list and not a sandbox. The
  // role floor is checked BEFORE membership — reversing the two (the first cut
  // of spec 0168) let a VIEWER who belonged to a project open a shell, and the
  // suite caught it.
  if (input.role === "VIEWER") {
    return {
      ok: false,
      reason: `the chat can run commands, so it requires OWNER or MEMBER (session role is ${input.role})`,
    };
  }
  // Spec 0168: a PROJECT-SCOPED chat is gated on membership for EVERYONE,
  // including an OWNER. This used to short-circuit on `role === "OWNER"` before
  // any project check — harmless while OWNER meant one person, but v0 makes all
  // five users OWNERs, and of the three role short-circuits 0168 removed this
  // was the widest: it granted a Bash-capable session on every project's
  // checkout. `projectMember === undefined` means the UNSCOPED platform console,
  // which keeps OWNER + flag (ADR-022's floor) and is untouched.
  if (input.projectMember === true) return { ok: true };
  if (input.projectMember === false) {
    return {
      ok: false,
      reason: "this chat is scoped to a project you are not a member of — ask a project owner to add you",
    };
  }
  if (input.role === "OWNER") return { ok: true };
  return {
    ok: false,
    reason:
      input.projectMember === undefined
        ? `the platform console requires the OWNER role (session role is ${input.role})`
        : `the chat requires OWNER or a project membership (session role is ${input.role})`,
  };
}

// --- Forge-root render decision (spec 0060, re-based on sessions in 0074) --
//
// `/forge` renders the supervisor console when the SAME fail-closed gate that
// guards `/api/supervisor` passes (flag on + OWNER session), and the Forge
// chat otherwise. This decides only which PAGE renders — it never moves,
// weakens, duplicates, or bypasses the capability gate (ADR-022 §3 unchanged):
// `/api/supervisor` re-checks the gate on every request regardless of which
// surface rendered.

/** Decide which surface `/forge` renders: `"console"` only when the gate
 * passes (flag on AND OWNER session), `"chat"` otherwise. Fail-closed by
 * construction — flag unset, signed out, or a non-OWNER role all yield
 * `"chat"` — because it delegates the policy to `checkSupervisorAccess`
 * and so can never diverge from `/api/supervisor`'s 403 gate. */
export function resolveForgeRootSurface(
  role: UserRole | null,
  env: Record<string, string | undefined> = process.env,
): "console" | "chat" {
  return checkSupervisorAccess({ enabled: isSupervisorConsoleEnabled(env), role }).ok
    ? "console"
    : "chat";
}

/**
 * Frame one normalized event as a single SSE message (`data: <json>\n\n`). The
 * browser reads these back as `SupervisorEvent`s — raw SDK messages never
 * cross the wire.
 */
export function encodeSupervisorEvent(event: SupervisorEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// --- Supervisor turn orchestration (spec 0050 item B1) ----------------------
//
// The route used to pipe `streamSupervisorSession`'s events straight to the
// SSE stream. Phase 2 (ADR-022) adds a SEQUENTIAL follow-on: when the
// supervisor's turn emits `{type:"spawn_architect"}`, the orchestrator (this
// function — moved out of the route so it's unit-testable the same way
// `resolveSupervisorGateCard` is) computes the next free spec id and runs the
// Fable architect, piping ITS events onto the SAME stream. The supervisor
// turn's own `text` events (marker already stripped by streamSupervisorSession)
// accumulate into the architect BRIEF alongside the user's original prompt.

/** Composes the architect's BRIEF (spec 0050): the user's original request
 * plus the supervisor's own briefing text (its turn's `text` events, marker
 * already stripped). Pure so it's unit-tested without a live session. */
export function composeArchitectBrief(userRequest: string, supervisorBriefText: string): string {
  const brief = supervisorBriefText.trim();
  const request = userRequest.trim();
  if (!brief) return request;
  return `${request}\n\n---\n\nSupervisor brief:\n${brief}`;
}

/** Injectable I/O seam for {@link runSupervisorConsoleTurn} — real functions by
 * default, fakes in tests, mirroring `SupervisorGateDeps`. */
export interface SupervisorOrchestrationDeps {
  streamSupervisorSession: typeof streamSupervisorSessionIO;
  runArchitectSpawn: typeof runArchitectSpawnIO;
  listSpecs: typeof listSpecsIO;
  /** Spec 0164: the atomic per-project allocator. Injected like every other IO
   * seam here so the collision case is testable without a database. */
  allocateSpecId: (projectId: string, floor: number) => Promise<string>;
  /** The platform project's id, for a console turn with no project bound. */
  platformProjectId: () => Promise<string>;
}

export const defaultSupervisorOrchestrationDeps: SupervisorOrchestrationDeps = {
  streamSupervisorSession: streamSupervisorSessionIO,
  runArchitectSpawn: runArchitectSpawnIO,
  listSpecs: listSpecsIO,
  allocateSpecId: async (projectId, floor) => allocateSpecIdIO(getDb(), projectId, floor),
  platformProjectId: async () => {
    const row = await projectBySlug(getDb(), PLATFORM_PROJECT_SLUG);
    if (!row) throw new Error("supervisor-console: no platform project row to allocate a spec id from");
    return row.id;
  },
};

/** Everything the route knows about one console turn — the owner credential,
 * the primary-checkout workdir, the user's prompt, and the two roles' models
 * (independently overridable via `AccountLlmConfig.modelOverrides`). */
export interface SupervisorOrchestrationRequest {
  /** Spec 0140: `project` gives the session Write/Edit inside its checkout;
   * omitted (or `inspect`) keeps the read-only platform console. */
  profile?: SupervisorProfile;
  /** Spec 0140: where `agents/supervisor.md` lives — the launchpad checkout. */
  promptRoot?: string;
  /** Spec 0141: the project's specs directory, outside its checkout. */
  specsDir?: string;
  /** Spec 0164: whose counter allocates the spec id. Absent ⇒ the platform's own
   * project; the allocator needs a row to serialise on, and "the directory plus
   * one" is precisely the race this replaces. */
  projectId?: string;
  /** Spec 0144 B: resolves an AskUserQuestion with the human's answers. */
  onQuestion?: (input: import("@launchpad/agents").AskUserQuestionInput) =>
    Promise<import("@launchpad/agents").AskUserQuestionAnswers | null>;
  /** Spec 0174: the chat's one way to start a run — forwarded to the SAME
   * `startPipeline` the UI button calls, refusals and all. */
  onStartRun?: (input: import("@launchpad/agents").StartRunInput) =>
    Promise<import("@launchpad/agents").StartRunResult>;
  credential: AgentCredential;
  workdir: string;
  prompt: string;
  /** SDK session id to resume (spec 0067 item 3 continuity) — the thread's
   * pinned `sdk_session_id`, forwarded verbatim to `streamSupervisorSession`. */
  resume?: string;
  supervisorModel?: string;
  architectModel?: string;
  maxTurns?: number;
  abortSignal?: AbortSignal;
  sessionInactivityMs?: number;
  onHeartbeat?: () => void;
  heartbeatIntervalMs?: number;
}

/**
 * Runs one supervisor console turn end-to-end: streams `streamSupervisorSession`
 * events through unchanged, and — ONLY when the supervisor's turn emitted
 * `{type:"spawn_architect"}` — sequentially (after the supervisor's generator
 * ends) ALLOCATES the next spec id from the project's counter (spec 0164 —
 * `nextSpecId` + `listSpecs` was a read-then-write race that handed two
 * concurrent chats the same number) and streams `runArchitectSpawn`'s events too. The route
 * (`app/api/supervisor/route.ts`) is a thin SSE-framing wrapper over this.
 */
export async function* runSupervisorConsoleTurn(
  req: SupervisorOrchestrationRequest,
  deps: SupervisorOrchestrationDeps = defaultSupervisorOrchestrationDeps,
): AsyncGenerator<SupervisorEvent, void, unknown> {
  let supervisorBriefText = "";
  let spawnArchitect = false;

  for await (const event of deps.streamSupervisorSession({
    credential: req.credential,
    workdir: req.workdir,
    prompt: req.prompt,
    resume: req.resume,
    // Spec 0140: a project chat WORKS in its checkout; the platform console
    // stays inspect-only. The role prompt always comes from the launchpad's
    // own checkout — a customer repo has no `agents/supervisor.md`, and
    // reading it from the workdir silently produced an empty system prompt.
    ...(req.profile ? { profile: req.profile } : {}),
    ...(req.promptRoot ? { promptRoot: req.promptRoot } : {}),
    ...(req.specsDir ? { specsDir: req.specsDir } : {}),
    ...(req.onQuestion ? { onQuestion: req.onQuestion } : {}),
    ...(req.onStartRun ? { onStartRun: req.onStartRun } : {}),
    model: req.supervisorModel,
    maxTurns: req.maxTurns,
    abortSignal: req.abortSignal,
    sessionInactivityMs: req.sessionInactivityMs,
    onHeartbeat: req.onHeartbeat,
    heartbeatIntervalMs: req.heartbeatIntervalMs,
  })) {
    yield event;
    if (event.type === "text") supervisorBriefText += event.delta;
    if (event.type === "spawn_architect") spawnArchitect = true;
  }

  if (!spawnArchitect) return;

  // Spec 0164: the filesystem gives the FLOOR (never hand back an id a file
  // already uses — a project's specs live outside git, and the platform's
  // predate the counter); the DATABASE gives the number, in one atomic
  // statement, so two chats drafting at once cannot collide.
  const floor = Number(nextSpecId((await deps.listSpecs()).map((s) => s.id))) - 1;
  const specId = await deps.allocateSpecId(req.projectId ?? (await deps.platformProjectId()), floor);
  const brief = composeArchitectBrief(req.prompt, supervisorBriefText);

  for await (const event of deps.runArchitectSpawn({
    credential: req.credential,
    workdir: req.workdir,
    brief,
    specId,
    model: req.architectModel,
    abortSignal: req.abortSignal,
    sessionInactivityMs: req.sessionInactivityMs,
    onHeartbeat: req.onHeartbeat,
    heartbeatIntervalMs: req.heartbeatIntervalMs,
    // Spec 0147: the drafter asks the human which track this is, through the
    // same card the supervisor uses (0144 B) — one question path, not two.
    ...(req.onQuestion ? { onQuestion: req.onQuestion } : {}),
    ...(req.onStartRun ? { onStartRun: req.onStartRun } : {}),
  })) {
    yield event;
  }
}

// --- Gate-card resolution (item B2, moved from actions.ts for testability) -

/** Gate-card props the EXISTING `GateActionButtons` needs — resolved from the
 * bridge's bare `{type:"gate",specId}` event. */
export interface SupervisorGateCard {
  filename: string;
  specId: string;
  title: string;
  actions: GateSignal[];
}

/** Injectable I/O seam, mirroring `lib/chat-tools.ts`'s `ChatToolDeps` pattern:
 * real functions by default, fakes in tests, so `resolveSupervisorGateCard`'s
 * render-only property (never calls `signalGate`/`startPipeline` — it isn't
 * even given those functions) is provable rather than merely asserted. */
export interface SupervisorGateDeps {
  resolveSpecFilenameById: typeof resolveSpecFilenameByIdIO;
  readSpecFile: typeof readSpecFileIO;
  getPipelineViewStateSafe: typeof getPipelineViewStateSafeIO;
}

export const defaultSupervisorGateDeps: SupervisorGateDeps = {
  resolveSpecFilenameById: resolveSpecFilenameByIdIO,
  readSpecFile: readSpecFileIO,
  getPipelineViewStateSafe: getPipelineViewStateSafeIO,
};

/** Resolves a bare spec id (the wire gate event's ONLY payload) to gate-card
 * props, or `null` when the spec can't be found or isn't actually parked at a
 * gate right now (e.g. the agent's marker was stale). Read-only: it never
 * signals a gate itself — only the human's click on the rendered
 * `GateActionButtons` does that, via the existing `signalGateAction`. Never
 * throws into the caller (a client component awaiting this in a stream
 * handler). */
export async function resolveSupervisorGateCard(
  specId: string,
  deps: SupervisorGateDeps = defaultSupervisorGateDeps,
): Promise<SupervisorGateCard | null> {
  try {
    const filename = await deps.resolveSpecFilenameById(specId);
    if (!filename) return null;
    const markdown = await deps.readSpecFile(filename);
    const summary = parseSpecSummary(filename, markdown);
    const view = await deps.getPipelineViewStateSafe(summary.id, summary.status);
    if (!view || view.availableActions.length === 0) return null;
    return { filename, specId: summary.id, title: summary.title, actions: view.availableActions };
  } catch {
    return null;
  }
}

// --- Spec-draft review card (spec 0050 phase 2, item B2) -------------------

/**
 * REVIEW-ONLY card props derived from a `{type:"spec_draft"}` SupervisorEvent
 * (spec 0050 / ADR-022 phase 2). Deliberately carries NO commit/run/promote
 * action — phase 2 stops at review; committing + running is phase 4 (the card
 * reserves that action seam). `href` links to `/forge/specs/<specId>`, which
 * already reads the UNCOMMITTED draft off disk. `model` surfaces the verified
 * drafting-session model (whatever `modelForRole("spec-drafter")` resolved to —
 * spec 0099 retired the claude-fable-5 pin, so this is read from the event, not
 * assumed).
 */
export interface SpecDraftCard {
  specId: string;
  specPath: string;
  title: string;
  summary: string;
  model: string;
  /** Link to the readable draft — the detail page reads specs/ from disk, so
   * the uncommitted draft is viewable without a commit. */
  href: string;
}

/**
 * Pure event → review-card-props derivation (spec 0050 item B2): a
 * `{type:"spec_draft"}` event carries exactly the fields the card needs
 * (`readArchitectSpecDraft`'s summary is already trimmed) plus the one
 * derived field, `href` — the link to `/forge/specs/<specId>`, which reads
 * the UNCOMMITTED draft straight off disk (no commit needed to review it).
 * `SpecDraftCard` itself deliberately has NO commit/run/promote field (see
 * its doc comment) — the console renders review-only affordances from these
 * props, proven by `supervisor-console.test.ts`'s no-commit-field assertion.
 */
export function deriveSpecDraftCard(event: {
  specId: string;
  specPath: string;
  title: string;
  summary: string;
  model: string;
}): SpecDraftCard {
  return {
    specId: event.specId,
    specPath: event.specPath,
    title: event.title,
    summary: event.summary,
    model: event.model,
    href: `/forge/specs/${event.specId}`,
  };
}
