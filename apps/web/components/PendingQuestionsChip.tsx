"use client";

/**
 * "Alguien está esperando tu respuesta" — the one surface of spec 0220 a person
 * sees.
 *
 * An `AskUserQuestion` used to live only inside its chat thread: a run parked
 * 10 minutes because nobody happened to open the thread, and at 15 minutes the
 * question expires and the agent proceeds alone. `TopBar` renders on every
 * screen, so the signal reaches whoever is looking at anything.
 *
 * Three constraints, each earned elsewhere:
 *
 *  1. **Nothing when the count is zero.** Spec 0122 deleted the Resumen's
 *     "requiere tu atención" line for showing non-actionable noise. The route
 *     already answers only with unresolved ∩ live questions; this renders
 *     literally nothing when there are none, so it can never become a permanent
 *     "revísame".
 *  2. **`document.hidden` and no overlapping request** — `PanelLive`'s two
 *     guards, for its reasons: a background tab is not a user (verification
 *     rule #13), and a slow answer must not queue more of them.
 *  3. **Whose question it is.** the owner and a teammate work in parallel, so each entry
 *     names the project and the person. A question with no recorded actor is
 *     everyone's (the route marks it `mine`) — fail visible, never silent.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { HelpCircle } from "lucide-react";
// Type-only (erased at build), so this client component does not pull the
// module's `@launchpad/db` imports into the bundle — `ForgeChat`'s import of
// `chat-store`'s types, for the same reason. It also means the chip cannot
// drift from what `GET /api/pending-questions` actually returns.
import type { PendingQuestionView } from "../lib/pending-questions";

const POLL_MS = 8000;

export function PendingQuestionsChip() {
  const [questions, setQuestions] = useState<PendingQuestionView[]>([]);
  const [open, setOpen] = useState(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (document.hidden || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const res = await fetch("/api/pending-questions", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { questions: PendingQuestionView[] };
        if (!cancelled) setQuestions(body.questions);
      } catch {
        // Offline, navigating away, server restarting — try again next tick.
      } finally {
        inFlightRef.current = false;
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (questions.length === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`${questions.length} pregunta(s) esperando respuesta`}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-amber/40 bg-amber/10 px-2.5 py-1.5 text-[11px] text-amber hover:bg-amber/20"
      >
        <HelpCircle className="h-3.5 w-3.5" />
        <span>{questions.length}</span>
        <span className="hidden sm:inline">esperando respuesta</span>
      </button>
      {open && (
        <div className="absolute right-0 top-10 w-80 rounded-lg border border-border bg-card p-2 shadow-xl">
          {questions.map((q) => {
            const body = (
              <>
                <p className="flex items-center gap-1.5 text-[11px]">
                  <span className="truncate text-faint">{q.projectName ?? "Plataforma"}</span>
                  <span className={`ml-auto shrink-0 ${q.mine ? "text-amber" : "text-faint"}`}>
                    {q.askedOf === null ? "cualquiera" : q.mine ? "para ti" : q.askedOf}
                  </span>
                </p>
                <p className={`mt-1 line-clamp-2 text-[13px] ${q.mine ? "text-foreground" : "text-muted"}`}>
                  {q.summary}
                </p>
              </>
            );
            const className = `block rounded-md border-l-2 px-2.5 py-2 ${
              q.mine ? "border-amber bg-amber/5" : "border-border"
            }`;
            // A thread with no project cannot be deep-linked (the workspace route
            // is per-project); showing it unlinked beats hiding a real question.
            return q.projectSlug ? (
              <Link
                key={q.threadId}
                href={`/projects/${encodeURIComponent(q.projectSlug)}/chats?chat=${encodeURIComponent(q.threadId)}`}
                onClick={() => setOpen(false)}
                className={`${className} hover:bg-card-hover`}
              >
                {body}
              </Link>
            ) : (
              <div key={q.threadId} className={className}>
                {body}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
