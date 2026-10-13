/**
 * Streaming bridge route for the supervisor console (spec 0049 phase 1 /
 * spec 0050 phase 2 / ADR-022). Node runtime (it starts host-side Claude Agent
 * SDK sessions that shell out) — NOT the `/api/chat` AI-SDK surface. On POST
 * with the user's message it: enforces the flag + OWNER-session guard (spec
 * 0074), `loadCredential("owner")`, starts `runSupervisorConsoleTurn` (which streams
 * the Opus supervisor's turn and, when it emits `{type:"spawn_architect"}`,
 * sequentially spawns the Fable architect too — see lib/supervisor-console.ts),
 * and pipes normalized `SupervisorEvent`s to the browser as SSE. The owner
 * credential and any secret NEVER cross to the browser — only normalized
 * events do (same discipline as `/api/chat`).
 *
 * Optional `threadId` (spec 0067 item 3 continuity): when present, the route
 * loads the thread's pinned `sdk_session_id` and passes it as `resume` (so the
 * SAME SDK session continues instead of starting fresh), and persists this
 * turn's user prompt + the full assistant event log to `chat-store.ts` —
 * `appendMessage`/`setThreadSdkSession` degrade to a no-op on their own
 * (`ChatStoreResult`), so a Postgres outage never blocks the stream.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { loadCredential, modelForRole, type AskUserQuestionInput } from "@launchpad/agents";
import { activities, projectSpecsDir } from "@launchpad/pipeline";
import { projectById, upsertSpecFile, type ProjectRow } from "@launchpad/db";
import { sessionEmail, supervisorAccess } from "../../auth";
import { SlidingWindowLimiter } from "../../../lib/rate-limit";
import { recordAudit } from "../../../lib/audit";
import { startPipeline, workflowIdFor } from "../../../lib/pipeline";
import { getDb } from "../../../lib/db";
import {
  appendMessage,
  appendRunEvent,
  getThread,
  setThreadSdkSession,
  type ForgeThread,
} from "../../../lib/chat-store";
import { awaitAnswer, denyPendingQuestion, startRun } from "../../../lib/run-registry";
import { sseFromRun } from "../../../lib/run-sse";
import { runSupervisorConsoleTurn } from "../../../lib/supervisor-console";

export const runtime = "nodejs";
// Generous for a BOUNDED supervisor session (maxTurns + inactivity watchdog cap
// it); ADR-022 flags long Opus sessions as a risk — the watchdog is the guard.
export const maxDuration = 300;

/**
 * 10 supervisor turns/min per actor (spec 0092). Deliberately TIGHTER than the
 * 20/min spec 0074 gave `/api/chat`: a chat turn was one model reply sized for
 * human typing speed, whereas each of these spawns an Agent SDK session that
 * can run for minutes and shell out. 10/min is still far above any human pace
 * and a much harder wall on a runaway client loop. Module-level: one window per
 * server process, matching the limiter's single-owner design note.
 *
 * `/api/supervisor/threads*` stays UNLIMITED on purpose — cheap CRUD behind the
 * same OWNER gate, and throttling it would stall the thread sidebar.
 */
const supervisorLimiter = new SlidingWindowLimiter(10, 60_000);

/**
 * Spec 0135 D: mirror a chat-drafted spec into `spec_files`, best-effort (the
 * file on disk is still the working copy; the row is the durable record and
 * the run-start resolver's index). `chatId` is the thread that drafted it —
 * the link a later run start follows to find its branch.
 */
/**
 * Spec 0140 D: mirror EVERY spec file in the project's checkout into
 * `spec_files`, at the end of a turn.
 *
 * The event-driven mirror below only fires for the architect's `spec_draft`.
 * A project chat writes the file ITSELF (Write, or a shell heredoc), which
 * emits no such event — so the spec the user just watched appear had no row,
 * and the Specs tab (rows) and the Start button's branch derivation
 * (row → chatId → thread → branch) were both blind to it.
 *
 * A directory scan rather than a tool-event hook, deliberately: it is
 * idempotent, races nothing (the turn is over, the writes have landed), and
 * catches a spec written by ANY means. Best-effort — the file on disk is the
 * working copy, and losing a row must never fail a turn.
 */
async function mirrorCheckoutSpecs(
  project: ProjectRow,
  chatId: string,
  actor: string,
  workdir: string,
): Promise<void> {
  try {
    const dir = projectSpecsDir(project.slug);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    for (const name of files) {
      try {
        const body = await readFile(path.join(dir, name), "utf8");
        await upsertSpecFile(getDb(), {
          projectId: project.id,
          name,
          // The frontmatter's own status when it has one — a spec the chat
          // marked `approved` must not be demoted to `draft` by the mirror.
          status: /^status:\s*(\S+)/m.exec(body)?.[1] ?? "draft",
          body,
          author: actor,
          chatId,
        });
      } catch (err) {
        console.warn(`[supervisor] spec_files mirror skipped ${name}:`, err);
      }
    }
  } catch {
    // No specs/ dir in this checkout — normal for a project with no specs yet.
  }
}

async function recordDraftedSpecRow(
  project: ProjectRow,
  chatId: string,
  actor: string,
  workdir: string,
  specPath: string,
): Promise<void> {
  try {
    const absolute = path.isAbsolute(specPath) ? specPath : path.join(workdir, specPath);
    const body = await readFile(absolute, "utf8");
    await upsertSpecFile(getDb(), {
      projectId: project.id,
      name: path.basename(absolute),
      status: "draft",
      body,
      author: actor,
      chatId,
    });
  } catch (err) {
    console.warn("[supervisor] spec_files draft row skipped:", err);
  }
}

export async function POST(req: Request): Promise<Response> {
  // Body FIRST (cheap, side-effect free): since spec 0135 the access check is
  // project-SCOPED, and the scope lives in the body's threadId. Headers still
  // play no part — X-Forwarded-For/Host are client-controlled (audit #2).
  let prompt: string;
  let threadId: string | undefined;
  try {
    const body = (await req.json()) as { prompt?: unknown; threadId?: unknown };
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      return new Response("missing prompt", { status: 400 });
    }
    prompt = body.prompt;
    if (typeof body.threadId === "string" && body.threadId) threadId = body.threadId;
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }

  let thread: ForgeThread | null = null;
  if (threadId) {
    const res = await getThread(threadId);
    thread = res.ok ? res.data : null;
  }

  // Spec 0074's gate, widened by spec 0135: a thread scoped to a project
  // admits that project's MEMBERS; an unscoped (adhoc/platform) turn stays
  // OWNER-only — that surface is a shell on the launchpad's own checkout.
  const access = await supervisorAccess(
    thread?.projectId ? { projectId: thread.projectId } : {},
  );
  if (!access.ok) {
    return new Response(access.reason ?? "supervisor console access denied", { status: 403 });
  }

  // After the gate (so an unauthenticated flood can't consume an actor's
  // window) and before any credential load or session spawn.
  const actor = (await sessionEmail()) ?? "owner-session";
  if (!supervisorLimiter.allow(actor)) {
    return new Response("rate limit exceeded — try again in a minute", { status: 429 });
  }

  if (threadId) {
    await appendMessage(threadId, { role: "user", content: prompt });
  }
  // Continuity (spec 0067 item 3): resume the thread's pinned SDK session, if
  // it has one yet (a brand-new thread's first turn has none).
  const resume: string | undefined = thread?.sdkSessionId ?? undefined;

  // Spec 0135 C: the supervisor works where the project lives. A project
  // thread gets the PROJECT's checkout (materialized on demand — the same
  // 0129 machinery every run uses) and a context line naming project+branch;
  // the platform keeps LAUNCHPAD_REPO_ROOT. A checkout that cannot be
  // materialized is a REFUSAL, never a fallback — a chat working in the wrong
  // repo is the 0131 defect wearing a new hat.
  let workdir = process.env["LAUNCHPAD_REPO_ROOT"];
  let contextLine = "";
  let project: ProjectRow | null = null;
  if (thread?.projectId) {
    try {
      project = await projectById(getDb(), thread.projectId);
    } catch {
      project = null;
    }
    if (project && project.kind !== "platform") {
      try {
        workdir = await activities.ensureCheckout({
          slug: project.slug,
          repoOwner: project.repoOwner,
          repoName: project.repoName,
          kind: project.kind,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(
          `no pude preparar el checkout del proyecto ${project.slug}: ${message}`,
          { status: 500 },
        );
      }
      // Spec 0141: the agent must know specs do NOT live in the repo.
      //
      // …and WHO is asking. Without it, the first real project chat wrote
      // `requester: tester@example.com` into a spec — deduced from the branch
      // prefix `tester/…` by analogy with `owner/…`, and wrong: the account is
      // on a different (external) domain. The agent said it was guessing, which is the
      // only reason it was caught. `actor` is the VERIFIED session email and was
      // already in scope here; deriving a fact we can simply state is the same
      // mistake `/connect` made about production hosts.
      contextLine =
        `[Contexto: proyecto ${project.slug}` +
        (thread.branch ? ` · rama ${thread.branch}` : "") +
        ` · specs en ${projectSpecsDir(project.slug)} (FUERA del repo del cliente — ` +
        `nunca los commitees)` +
        ` · solicitante ${actor} (email verificado de la sesión: úsalo tal cual en ` +
        `\`requester:\`, nunca lo deduzcas del nombre de la rama)` +
        // Spec 0217 fixed the language for the spec-drafter prompt only. This
        // session narrates, asks questions and drafts too, and it opened the
        // first project chat in English against a Spanish brief in a Spanish UI.
        ` · idioma: español para todo lo que lee una persona (respuestas, ` +
        `preguntas, prosa del spec, mensajes de commit); en inglés sólo la ` +
        `estructura que el código parsea: encabezados \`##\`, llaves del ` +
        `frontmatter, \`(human)\`, y el tipo del commit (\`feat\`, \`fix\`…)]\n\n`;
    }
  }
  if (!workdir) {
    return new Response("LAUNCHPAD_REPO_ROOT not set", { status: 500 });
  }
  const repoRoot = workdir;

  let config;
  try {
    // loadCredential's error text names missing ENV VAR NAMES only (see
    // packages/agents/src/credentials.ts) — never a secret value — so it's
    // safe to relay to the client as-is.
    config = await loadCredential("owner");
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to load owner LLM credential";
    return new Response(message, { status: 500 });
  }

  // Spec 0075: one audit row per accepted console turn (the console can run
  // Bash — attribution matters). Never the prompt text, only shape flags.
  // Spec 0135: the actor is the verified SESSION email — a member's turn is
  // attributed to the member, not to a hardcoded owner.
  await recordAudit({
    actor,
    action: "console.turn",
    target: threadId ?? "adhoc",
    metadata: {
      resumed: Boolean(resume),
      ...(project ? { project: project.slug } : {}),
      // Spec 0140: WHICH profile ran is the security-relevant fact about a turn.
      profile: project && project.kind !== "platform" ? "project" : "inspect",
    },
  });

  // Spec 0127: the run belongs to the SERVER, not to this request. Nothing here
  // listens to `req.signal` any more — that wiring is what let a tab switch kill
  // an agent mid-thought. The run ends when the agent finishes, errors, or the
  // user explicitly stops it via /api/supervisor/stop.
  const runId = randomUUID();
  const handle = startRun({
    runId,
    threadId,
    produce: (signal) =>
      runSupervisorConsoleTurn({
        credential: config.primary,
        workdir: repoRoot,
        // Spec 0140: a project chat WORKS in its checkout (Write/Edit/Bash,
        // path-confined); the platform console stays inspect-only. The role
        // prompt always loads from the launchpad's own checkout — a customer
        // repo has neither CLAUDE.md nor agents/supervisor.md, and reading it
        // from the workdir produced an EMPTY system prompt (the reason the
        // first project chat never used its architect marker).
        ...(project && project.kind !== "platform"
          ? {
              profile: "project" as const,
              specsDir: projectSpecsDir(project.slug),
              ...(process.env["LAUNCHPAD_REPO_ROOT"]
                ? { promptRoot: process.env["LAUNCHPAD_REPO_ROOT"] }
                : {}),
              // Spec 0144 B: the question waits HERE for the human. The
              // tool_use event already streams the card's content; this is
              // the return path, resolved by POST /api/supervisor/answer.
              // Spec 0220 §4: no table records a person, so attribution can
              // only be captured at this seam — the route that starts the turn
              // already knows the verified session email. Project + summary
              // come with it, so the signal can say WHOSE question and WHERE.
              ...(threadId
                ? {
                    onQuestion: (input: AskUserQuestionInput) =>
                      awaitAnswer({
                        threadId: threadId!,
                        projectId: thread?.projectId ?? null,
                        askedOf: actor,
                        summary:
                          input.questions?.[0]?.header ??
                          input.questions?.[0]?.question ??
                          "Pregunta del agente",
                      }),
                  }
                : {}),
              // Spec 0174: the chat starts runs through the SAME starter the
              // button uses — project resolution, the thread's branch and
              // `branchStartRefusal` all included. A second starter is how
              // spec 0131 lost an afternoon; this one forwards.
              onStartRun: async (input) => {
                try {
                  await startPipeline(input.specId, input.request, actor, {
                    projectSlug: project.slug,
                    // Spec 0186 B: the comment above already claimed "the
                    // thread's branch … included" while this call passed only
                    // the slug. The thread IS bound to a branch, so forwarding
                    // it means the run's branch never depends on finding the
                    // spec's row — which, on a project whose chat just wrote the
                    // spec, does not exist yet at this instant.
                    ...(thread?.branch ? { branch: thread.branch } : {}),
                  });
                  return { ok: true, workflowId: workflowIdFor(input.specId, project.slug) };
                } catch (err) {
                  // The refusal text is the point: "esa rama ya tiene un run
                  // activo" is something the agent can act on; "failed" is not.
                  return { ok: false, problem: err instanceof Error ? err.message : String(err) };
                }
              },
            }
          : {}),
        // The context line is transport, not content: the stored user message
        // above is the person's words; only the SESSION sees the prefix.
        prompt: contextLine + prompt,
        resume,
        supervisorModel: modelForRole("supervisor", config.modelOverrides),
        // Spec 0099 collapsed `architect` into the one `spec-drafter` role, so
        // the in-UI spawn and the Temporal draftSpec activity now resolve the
        // SAME model (and honor the same LAUNCHPAD_MODEL_SPEC_DRAFTER override).
        architectModel: modelForRole("spec-drafter", config.modelOverrides),
        abortSignal: signal,
      }),
    // Every event lands in the store as it happens, so a reconnecting or
    // reopening browser can replay a turn that is still in flight.
    // Spec 0135 D: a spec drafted in a PROJECT chat additionally lands as a
    // spec_files row AT DRAFT TIME (with the drafting chat's id) — before
    // this, the only writer was the pipeline's setStatus, so a project spec
    // that never ran was invisible to run start and to the Specs tab.
    persist: threadId
      ? (rid, seq, event) => {
          if (event.type === "spec_draft" && project && project.kind !== "platform") {
            void recordDraftedSpecRow(project, threadId, actor, repoRoot, event.specPath);
          }
          return appendRunEvent(threadId, rid, seq, event);
        }
      : undefined,
    onFinish: async (events) => {
      if (!threadId) return;
      // Spec 0144 B: a run that ends with a question still pending must not
      // leave the answerer hanging — resolve it null (deny-with-reason).
      denyPendingQuestion(threadId);
      // Spec 0140 D: whatever the chat wrote into specs/ becomes a row, so the
      // Specs tab lists it and a run started from any button can follow
      // row → chatId → thread → branch.
      if (project && project.kind !== "platform") {
        await mirrorCheckoutSpecs(project, threadId, actor, repoRoot);
      }
      // The completed-turn message stays exactly as it was, so thread replay
      // (spec 0067) keeps working unchanged; forge_events is the in-progress
      // view, not a replacement for it.
      if (events.length > 0) await appendMessage(threadId, { role: "assistant", content: "", events });
      const session = events.find((e) => e.type === "session");
      if (session && session.type === "session") await setThreadSdkSession(threadId, session.sessionId);
    },
  });

  return new Response(sseFromRun(handle, runId, 0), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // The client needs the run id to reattach after a reload or tab change.
      "X-Run-Id": runId,
    },
  });
}
