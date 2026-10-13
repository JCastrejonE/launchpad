"use client";

/**
 * `makeAssistantToolUI` wrappers (spec 0067 item 5) mapping the SYNTHETIC
 * marker tool-call parts `foldSupervisorEvents` produces
 * (`lib/forge-chat-runtime.ts`'s `SYNTHETIC_TOOL_NAMES`) onto the EXISTING
 * card components `SupervisorConsole.tsx` already rendered: the gate card
 * (`resolveSupervisorGateCard` + `GateActionButtons`), the review-only
 * spec-draft card (`deriveSpecDraftCard`), and `RunFollowCard`. Render-only
 * discipline preserved verbatim: every card fires its signal/spawn ONLY from
 * a human's button click through the same existing call sites — mounting a
 * tool UI adds none.
 *
 * `makeAssistantToolUI` "registers a render-only component for a `toolName`"
 * by being RENDERED (see `docs/assistant-ui-0.14-reference.md` §"Generative
 * cards") — `ForgeChat.tsx` mounts each of these once inside the
 * `AssistantRuntimeProvider` tree; `MessagePrimitive.Parts` then dispatches
 * matching `tool-call` parts to them automatically, no per-message wiring.
 *
 * The architect_progress card renders the fold's coalesced trailing delta
 * (spec 0067 item 4 handoff) as a growing text block, not one card per streamed
 * chunk. Its label was "Architect · fable" until spec 0099 collapsed the role and
 * dropped the model pin; see the card itself.
 */
import { createContext, useContext, useEffect, useState } from "react";
import { makeAssistantToolUI, useThread, useThreadRuntime } from "@assistant-ui/react";
import {
  deriveSpecDraftCard,
  resolveSupervisorGateCard,
  type SpecDraftCard,
  type SupervisorGateCard,
} from "../../app/forge/actions";
// Spec 0101: the shadcn Card family is retired. The template's `Card` is a
// single styled div, so header/body/footer become padded children — the same
// shape the mockup uses for its own sectioned cards.
import { Card } from "../ui";
import { GateActionButtons } from "../chat/GateActionButtons";
import { SYNTHETIC_TOOL_NAMES } from "../../lib/forge-chat-runtime";
import { RunFollowCard } from "./RunFollowCard";

interface GateArgs {
  specId: string;
}

function GateToolCard({ args }: { args: GateArgs }) {
  const [card, setCard] = useState<SupervisorGateCard | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setCard(undefined);
    void resolveSupervisorGateCard(args.specId).then((resolved) => {
      if (!cancelled) setCard(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [args.specId]);

  if (card === undefined) {
    return (
      <p className="m-0" role="status" aria-live="polite">
        <span className="sr-only">Resolving gate for spec {args.specId}…</span>
        <span className="mc-skeleton block h-[13px] w-28" aria-hidden="true" />
      </p>
    );
  }
  if (card === null) {
    return (
      <p className="mt-6 text-center text-xs text-faint">
        No gate action available for spec {args.specId} right now.
      </p>
    );
  }
  return (
    <Card className="max-w-md">
      <div className="flex flex-col gap-1 p-4">
        <h3 className="text-sm font-semibold leading-none text-foreground">Gate: {card.title}</h3>
      </div>
      <div className="px-4 pb-4 text-sm text-muted">
        <p>
          {card.specId} — {card.filename}
        </p>
      </div>
      <div className="flex items-center gap-2 px-4 pb-4">
        <GateActionButtons filename={card.filename} specId={card.specId} actions={card.actions} />
      </div>
    </Card>
  );
}

export const SupervisorGateToolUI = makeAssistantToolUI<GateArgs, never>({
  toolName: SYNTHETIC_TOOL_NAMES.gate,
  render: GateToolCard,
});

interface SpecDraftArgs {
  specId: string;
  specPath: string;
  title: string;
  summary: string;
  model: string;
}

/** REVIEW-ONLY — see `SupervisorConsole.tsx`'s `SpecDraftCardView` (retired in
 * item 6): this card deliberately carries no commit/run/promote control; the
 * shipped path is asking the console to run it, which emits the existing
 * `watch_run` marker instead. */
function SpecDraftToolCard({ args }: { args: SpecDraftArgs }) {
  const [card, setCard] = useState<SpecDraftCard | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void deriveSpecDraftCard(args).then((resolved) => {
      if (!cancelled) setCard(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [args.specId, args.specPath, args.title, args.summary, args.model]);

  if (!card) {
    return (
      <p className="m-0" role="status" aria-live="polite">
        <span className="sr-only">Preparing spec draft {args.specId}…</span>
        <span className="mc-skeleton block h-[13px] w-28" aria-hidden="true" />
      </p>
    );
  }
  return (
    <Card className="max-w-md">
      <div className="flex flex-col gap-1 p-4">
        <h3 className="text-sm font-semibold leading-none text-foreground">
          Spec draft: {card.title}
        </h3>
      </div>
      <div className="flex flex-col gap-2 px-4 pb-4 text-sm text-muted">
        <p>
          {card.specId} · {card.model}
        </p>
        <p>{card.summary}</p>
      </div>
      <div className="flex flex-col items-start gap-2 px-4 pb-4">
        {/* An anchor, not a button — so it carries `Btn`'s utilities inline
            rather than rendering the template's <button> primitive. */}
        <a
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3.5 py-2 text-[13px] font-medium text-foreground transition-colors hover:border-border-strong hover:bg-card-hover"
          href={card.href}
        >
          Review draft
        </a>
        <p className="text-xs text-faint">
          Reviewing a draft — ask the console to run it: the Start click commits the draft and starts a watched run.
        </p>
      </div>
    </Card>
  );
}

export const SpecDraftToolUI = makeAssistantToolUI<SpecDraftArgs, never>({
  toolName: SYNTHETIC_TOOL_NAMES.specDraft,
  render: SpecDraftToolCard,
});

interface WatchRunArgs {
  specId: string;
}

/** `onDiagnose` composes and sends the diagnosis prompt as a normal new user
 * turn via `threadRuntime.append` (spec 0067 item 5's "becomes a composer
 * send") — the SAME guarded `/api/supervisor` bridge the typed composer uses,
 * never a new call site. `busy` (the thread's `isRunning`) disables the
 * button while a turn is already streaming, mirroring the old console's
 * `busy` prop. */
function WatchRunToolCard({ args }: { args: WatchRunArgs }) {
  const runtime = useThreadRuntime();
  const isRunning = useThread((t) => t.isRunning);
  const projectSlug = useContext(ProjectSlugContext);
  return (
    <RunFollowCard
      specId={args.specId}
      projectSlug={projectSlug}
      busy={isRunning}
      onDiagnose={(prompt) => runtime.append(prompt)}
    />
  );
}

export const WatchRunToolUI = makeAssistantToolUI<WatchRunArgs, never>({
  toolName: SYNTHETIC_TOOL_NAMES.watchRun,
  render: WatchRunToolCard,
});

interface ArchitectProgressArgs {
  delta: string;
}

function ArchitectProgressToolCard({ args }: { args: ArchitectProgressArgs }) {
  return (
    <div>
      {/* Spec 0099 collapsed the architect into the one `spec-drafter` role and
          retired its claude-fable-5 pin, so the old "Architect · fable" label
          would now assert a model the session isn't running. The
          `architect_progress` event carries only `delta` (a spec-0067 wire
          contract, deliberately unchanged), so name the role, not the model —
          the verified model still appears on the spec_draft review card. */}
      <p className="text-xs text-faint">Spec drafter</p>
      <p style={{ whiteSpace: "pre-wrap" }}>{args.delta}</p>
    </div>
  );
}

export const ArchitectProgressToolUI = makeAssistantToolUI<ArchitectProgressArgs, never>({
  toolName: SYNTHETIC_TOOL_NAMES.architectProgress,
  render: ArchitectProgressToolCard,
});

// --- Spec 0144 B: the AskUserQuestion card -----------------------------------

/** The thread whose run is asking — set by ForgeChat so the card's answer can
 * find its way back without threading props through @assistant-ui. */
export const QuestionThreadContext = createContext<string | null>(null);

/**
 * Which project's workspace this transcript is rendered in (spec 0224).
 *
 * `null` on the `/forge` platform console, which has no project — the one case
 * where an unscoped spec lookup is correct. Everywhere else it must be set, or
 * the follow card asks about spec `0001` with no project and the server resolves
 * it to the platform's `0001-launchpad-foundations.md`: a MEMBER was refused
 * from their own run, and an OWNER was shown the platform's workflow instead.
 *
 * A context rather than prop-drilling because assistant-ui registers tool UIs
 * globally — `QuestionThreadContext` above solves the same problem the same way.
 */
export const ProjectSlugContext = createContext<string | null>(null);

interface AskUserQuestionArgs {
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  /** Present once the turn resumed with answers (the allow's updatedInput). */
  answers?: Record<string, string | string[]>;
}

/**
 * The owner's third facturas failure: "Ask user question in chat gets skipped". The
 * question now BLOCKS the run until answered (spec 0144 B) — this card is the
 * answering surface. One POST per question set; the buttons disable once
 * anything is chosen, and the run's own tool_result closes the loop visually.
 */
function AskUserQuestionToolCard({ args }: { args: AskUserQuestionArgs }) {
  const threadId = useContext(QuestionThreadContext);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [sent, setSent] = useState(false);
  const questions = args.questions ?? [];
  if (questions.length === 0) return null;
  const answered = Boolean(args.answers) || sent;

  const toggle = (q: string, label: string, multi: boolean) => {
    setChosen((prev) => {
      const current = prev[q] ?? [];
      if (!multi) return { ...prev, [q]: [label] };
      return {
        ...prev,
        [q]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label],
      };
    });
  };

  const send = async () => {
    if (!threadId || sent) return;
    setSent(true);
    const answers: Record<string, string | string[]> = {};
    for (const q of questions) {
      const picks = chosen[q.question] ?? [];
      answers[q.question] = q.multiSelect ? picks : (picks[0] ?? "");
    }
    try {
      await fetch("/api/supervisor/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, answers }),
      });
    } catch {
      setSent(false); // let the human retry a network blip
    }
  };

  return (
    <div className="rounded-lg border border-brand/40 bg-brand/5 p-3 text-[13px]">
      {questions.map((q) => (
        <div key={q.question} className="mb-2">
          <p className="mb-1 font-medium text-foreground">
            {q.header ? `${q.header}: ` : ""}
            {q.question}
          </p>
          <div className="flex flex-wrap gap-2">
            {(q.options ?? []).map((option) => {
              const active = (chosen[q.question] ?? []).includes(option.label);
              const final = args.answers?.[q.question];
              const wasFinal = Array.isArray(final)
                ? final.includes(option.label)
                : final === option.label;
              return (
                <button
                  key={option.label}
                  type="button"
                  disabled={answered}
                  title={option.description ?? ""}
                  onClick={() => toggle(q.question, option.label, Boolean(q.multiSelect))}
                  className={`rounded-md border px-2 py-1 text-[12px] ${
                    wasFinal || active
                      ? "border-brand bg-brand/20 text-brand"
                      : "border-border text-muted hover:text-foreground"
                  } ${answered ? "opacity-60" : ""}`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {!answered ? (
        <button
          type="button"
          onClick={send}
          className="mt-1 rounded-md border border-brand/50 bg-brand/15 px-3 py-1 text-[12px] font-medium text-brand hover:bg-brand/25"
        >
          Responder
        </button>
      ) : (
        <p className="mt-1 text-[11px] text-faint">Respondido — el agente continúa.</p>
      )}
    </div>
  );
}

export const AskUserQuestionToolUI = makeAssistantToolUI<AskUserQuestionArgs, never>({
  toolName: "AskUserQuestion",
  render: AskUserQuestionToolCard,
});
