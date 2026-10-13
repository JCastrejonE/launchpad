/**
 * The chat assistant's tool WHITELIST and its gate-safety invariant (spec
 * 0016, ADR-010/011). The assistant is a thin tool-calling layer over
 * EXISTING server actions / lib functions — it adds no new pipeline
 * capability. This module is the pure, framework-free contract those tools
 * are built from: the SDK `tool()` definitions (spec 0016 item 5) import this
 * registry, and the guardrail below is unit-tested so the core safety
 * property is locked from day one.
 *
 * THE INVARIANT (acceptance criterion): the model can NEVER fire a gate
 * approval/promotion itself. Gate tools are RENDER-ONLY — they emit a card;
 * the actual signal fires only from the human clicking that card's button,
 * which calls the same server action the spec page uses today (recording
 * the verified session email as actor, spec 0074). `specRejected` is the
 * deliberate exception: it's the in-app escape hatch and stays available in
 * both PR and local-diff modes (spec 0016 Scope), so it is NOT one of the
 * guarded gate signals.
 *
 * Framework-free (no `ai`/React import) so it compiles under
 * tsconfig.test.json and runs under `node --test`. The EXECUTE handlers below
 * (spec 0016 item 5) stay framework-free in the same sense — plain async
 * functions over the existing lib/pipeline.ts + lib/specs.ts surfaces;
 * `app/api/chat/route.ts` is the only place that imports `ai`'s `tool()` and
 * wraps each handler for the SDK.
 */
import type { PullRequestRef, Gate2PollState } from "@launchpad/pipeline";
import {
  startPipeline as startPipelineIO,
  signalGate as signalGateIO,
  getPipelineViewStateSafe as getPipelineViewStateSafeIO,
  getPrLiveState as getPrLiveStateIO,
  type GateSignal,
  type PipelineViewState,
  type PrLiveStateResult,
} from "./pipeline";
import {
  listSpecs as listSpecsIO,
  readSpecFile as readSpecFileIO,
  parseSpecSummary,
  parseHandoffLog,
  type SpecSummary,
} from "./specs";

/** Every tool the assistant may invoke — nothing outside this list is exposed
 * to the model. */
export type ChatToolName =
  // Executing tools — thin wrappers over existing lib functions.
  | "startPipeline" // draft a spec from plain language (startPipeline → draftSpec)
  | "specStatus" // read-only: describePipeline / getPipelineViewStateSafe
  | "listSpecs" // read-only: enumerate specs for the inbox surface
  | "rejectSpec" // specRejected — the in-app escape hatch (both modes)
  // Render-only tools — emit a generative gate card; the human's click fires
  // the signal, never the model.
  | "renderSpecDraftCard" // gate 1 — Approve/Reject buttons
  | "renderPrLinkCard" // gate 2 — GitHub review/merge (ADR-016), poll-health badge
  | "renderPromoteCard"; // gate 3 — explicit Promote button

export interface ChatToolSpec {
  name: ChatToolName;
  /** true ⇒ the tool only renders a card; any state change happens from the
   * human's button click, not from the model's invocation. */
  renderOnly: boolean;
  /** Gate signals this tool fires DIRECTLY when the model invokes it. MUST NOT
   * contain any guarded gate signal (see GUARDED_GATE_SIGNALS) — that's the
   * property `assertNoToolFiresGateApproval` enforces. `rejectSpec` carries
   * `specRejected`, which is intentionally not guarded. */
  firesSignals: GateSignal[];
}

/** The gate signals the MODEL must never be able to fire — the three that
 * advance/approve the pipeline. `specRejected` is intentionally excluded: it's
 * the in-app escape hatch, allowed in both modes (spec 0016 Scope). */
export const GUARDED_GATE_SIGNALS: readonly GateSignal[] = [
  "specApproved",
  "prApproved",
  "promote",
] as const;

/**
 * The whitelist. Gate cards are render-only with NO fired signals; the only
 * signal any tool fires directly is `rejectSpec`'s `specRejected` (unguarded).
 */
export const CHAT_TOOL_REGISTRY: readonly ChatToolSpec[] = [
  { name: "startPipeline", renderOnly: false, firesSignals: [] },
  { name: "specStatus", renderOnly: false, firesSignals: [] },
  { name: "listSpecs", renderOnly: false, firesSignals: [] },
  { name: "rejectSpec", renderOnly: false, firesSignals: ["specRejected"] },
  { name: "renderSpecDraftCard", renderOnly: true, firesSignals: [] },
  { name: "renderPrLinkCard", renderOnly: true, firesSignals: [] },
  { name: "renderPromoteCard", renderOnly: true, firesSignals: [] },
] as const;

/** True if the tool fires any GUARDED gate signal — must be false for every
 * tool in the registry. */
export function toolFiresGuardedGateSignal(spec: ChatToolSpec): boolean {
  return spec.firesSignals.some((s) => GUARDED_GATE_SIGNALS.includes(s));
}

// ---------------------------------------------------------------------------
// Wired handlers (spec 0016 item 5) — one per CHAT_TOOL_REGISTRY entry.
//
// `ChatToolDeps` is the same injectable-dependency test seam lib/pipeline.ts
// already uses for I/O (SignalClient, GetPrLiveStateDeps): every handler below
// takes the real I/O functions as its LAST parameter, defaulted to the real
// implementations, so chat-tools.test.ts can pass fakes and assert exactly
// which underlying function each handler calls — the wired-handler half of
// the gate-safety invariant (the registry above only proves the DECLARED
// shape; these prove the CALLS actually match it: no handler calls
// signalGateIO with "specApproved" | "prApproved" | "promote", and no
// render-only handler calls startPipelineIO/signalGateIO at all).
//
// Callers pass ONLY `input` (plus, for the two mutating handlers, the
// verified session `actor` — spec 0074) from the SDK `tool()` `execute`
// wrapper — never forward the SDK's second `ToolExecutionOptions` argument
// here, or it would silently clobber a defaulted parameter.
// ---------------------------------------------------------------------------

export interface ChatToolDeps {
  startPipeline: typeof startPipelineIO;
  signalGate: typeof signalGateIO;
  getPipelineViewStateSafe: typeof getPipelineViewStateSafeIO;
  getPrLiveState: typeof getPrLiveStateIO;
  listSpecs: typeof listSpecsIO;
  readSpecFile: typeof readSpecFileIO;
}

export const defaultChatToolDeps: ChatToolDeps = {
  startPipeline: startPipelineIO,
  signalGate: signalGateIO,
  getPipelineViewStateSafe: getPipelineViewStateSafeIO,
  getPrLiveState: getPrLiveStateIO,
  listSpecs: listSpecsIO,
  readSpecFile: readSpecFileIO,
};

/** Loads a spec's summary + current PipelineViewState by filename — the
 * shared read shared by specStatus and all three render-only card handlers,
 * so they never drift on how a spec is looked up. */
async function loadSpecView(
  filename: string,
  deps: ChatToolDeps,
): Promise<{ specId: string; title: string; status: string; markdown: string; view: PipelineViewState | null }> {
  const markdown = await deps.readSpecFile(filename);
  const summary = parseSpecSummary(filename, markdown);
  const view = await deps.getPipelineViewStateSafe(summary.id, summary.status);
  return { specId: summary.id, title: summary.title, status: summary.status, markdown, view };
}

export interface StartPipelineResult {
  ok: boolean;
  specId: string;
  error?: string;
}

/** Executing tool: drafts a spec from plain language and starts its pipeline
 * run (existing startPipeline → draftSpec). Never fires a gate signal.
 * `actor` is the VERIFIED session email (spec 0074) — the route supplies it;
 * this module never reads an env-var identity. */
export async function executeStartPipeline(
  input: { specId: string; request: string },
  actor: string,
  deps: ChatToolDeps = defaultChatToolDeps,
): Promise<StartPipelineResult> {
  try {
    await deps.startPipeline(input.specId, input.request, actor);
    return { ok: true, specId: input.specId };
  } catch (err) {
    return { ok: false, specId: input.specId, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SpecStatusResult {
  ok: boolean;
  filename: string;
  specId?: string;
  title?: string;
  status?: string;
  view?: PipelineViewState | null;
  /** Last few handoff-log entries, newest first. */
  handoffTail?: string[];
  error?: string;
}

/** Read-only executing tool: spec status via getPipelineViewStateSafe. */
export async function executeSpecStatus(
  input: { filename: string },
  deps: ChatToolDeps = defaultChatToolDeps,
): Promise<SpecStatusResult> {
  try {
    const bundle = await loadSpecView(input.filename, deps);
    return {
      ok: true,
      filename: input.filename,
      specId: bundle.specId,
      title: bundle.title,
      status: bundle.status,
      view: bundle.view,
      handoffTail: parseHandoffLog(bundle.markdown).slice(-3).reverse(),
    };
  } catch (err) {
    return { ok: false, filename: input.filename, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ListSpecsResult {
  ok: boolean;
  specs?: SpecSummary[];
  error?: string;
}

/** Read-only executing tool: enumerate specs for the inbox surface. */
export async function executeListSpecs(
  deps: ChatToolDeps = defaultChatToolDeps,
): Promise<ListSpecsResult> {
  try {
    return { ok: true, specs: await deps.listSpecs() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RejectSpecResult {
  ok: boolean;
  specId: string;
  error?: string;
}

/** Executing tool: the in-app escape hatch (specRejected — unguarded, both
 * modes). The only handler in this module that fires a signal. `actor` is
 * the verified session email (spec 0074). */
export async function executeRejectSpec(
  input: { specId: string; reason: string },
  actor: string,
  deps: ChatToolDeps = defaultChatToolDeps,
): Promise<RejectSpecResult> {
  try {
    await deps.signalGate(input.specId, "specRejected", actor, input.reason);
    return { ok: true, specId: input.specId };
  } catch (err) {
    return { ok: false, specId: input.specId, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RenderGateCardResult {
  ok: boolean;
  filename: string;
  specId?: string;
  title?: string;
  /** Which gate buttons the human may click — the CARD renders the button,
   * the human's click fires the signal (never this handler). */
  actions?: GateSignal[];
  error?: string;
}

/** Render-only tool: gate-1 spec-draft preview card data. Never fires
 * specApproved — only reads. */
export async function executeRenderSpecDraftCard(
  input: { filename: string },
  deps: ChatToolDeps = defaultChatToolDeps,
): Promise<RenderGateCardResult> {
  try {
    const bundle = await loadSpecView(input.filename, deps);
    return {
      ok: true,
      filename: input.filename,
      specId: bundle.specId,
      title: bundle.title,
      actions: bundle.view?.availableActions ?? [],
    };
  } catch (err) {
    return { ok: false, filename: input.filename, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Render-only tool: gate-3 promote confirmation card data. Never fires
 * promote — only reads. */
export async function executeRenderPromoteCard(
  input: { filename: string },
  deps: ChatToolDeps = defaultChatToolDeps,
): Promise<RenderGateCardResult> {
  try {
    const bundle = await loadSpecView(input.filename, deps);
    return {
      ok: true,
      filename: input.filename,
      specId: bundle.specId,
      title: bundle.title,
      actions: bundle.view?.availableActions ?? [],
    };
  } catch (err) {
    return { ok: false, filename: input.filename, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface RenderPrLinkCardResult {
  ok: boolean;
  filename: string;
  specId?: string;
  pr?: PullRequestRef;
  live?: PrLiveStateResult | null;
  gate2Poll?: Gate2PollState;
  actions?: GateSignal[];
  error?: string;
}

/** Render-only tool: gate-2 PR link card data — reuses the shipped
 * pipelinePr/gate2Poll queries + getPrLiveState, no new PR plumbing. Never
 * fires prApproved — only reads. */
export async function executeRenderPrLinkCard(
  input: { filename: string },
  deps: ChatToolDeps = defaultChatToolDeps,
): Promise<RenderPrLinkCardResult> {
  try {
    const bundle = await loadSpecView(input.filename, deps);
    const pr = bundle.view?.pr;
    if (!pr) {
      return {
        ok: false,
        filename: input.filename,
        specId: bundle.specId,
        error: "no PR ref recorded for this spec yet",
      };
    }
    const live = pr.number > 0 ? await deps.getPrLiveState(pr) : null;
    return {
      ok: true,
      filename: input.filename,
      specId: bundle.specId,
      pr,
      live,
      gate2Poll: bundle.view?.gate2Poll,
      actions: bundle.view?.availableActions ?? [],
    };
  } catch (err) {
    return { ok: false, filename: input.filename, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Every whitelisted tool's wired handler, keyed by `ChatToolName`. The
 * `satisfies Record<ChatToolName, ...>` below is a compile-time proof that
 * this map has EXACTLY the registry's names — no handler silently added
 * outside the whitelist, none silently missing. `app/api/chat/route.ts` is
 * the only caller — it wraps each in the SDK's `tool()` and must invoke with
 * `(input)` only (see the module doc comment above on the deps-clobber
 * hazard). */
export const CHAT_TOOL_HANDLERS = {
  startPipeline: executeStartPipeline,
  specStatus: executeSpecStatus,
  listSpecs: executeListSpecs,
  rejectSpec: executeRejectSpec,
  renderSpecDraftCard: executeRenderSpecDraftCard,
  renderPrLinkCard: executeRenderPrLinkCard,
  renderPromoteCard: executeRenderPromoteCard,
} satisfies Record<ChatToolName, (...args: never[]) => Promise<{ ok: boolean }>>;
