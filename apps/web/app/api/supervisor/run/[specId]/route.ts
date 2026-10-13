/**
 * Run-follow route for supervisor-in-UI phase 3 (spec 0052 / ADR-022 §6, item
 * D). Node runtime (it reads Temporal + the events file and detach-spawns the
 * host-side watcher). BOTH verbs sit behind the SAME fail-closed
 * `supervisorAccess` guard as the POST bridge route (flag off / signed out /
 * non-OWNER ⇒ 403; spec 0074):
 *
 *  - GET  → `getRunFollowState(specId)` as JSON (pipeline view + watcher
 *           liveness + parsed events tail) — refresh/reconnect is free because
 *           it re-derives from durable-ish state, never a held stream.
 *  - POST → an OPTIONAL JSON body
 *           `{mode?: "follow" | "start" | "recover" | "resume-polished"}`.
 *           Body absent, unparseable, or `"follow"` ⇒ `spawnWatcher(specId)`
 *           (the human Follow-button click, byte-identical to phase 3):
 *           validates the id, refuses when a watcher is already running or
 *           the workflow isn't RUNNING, then detach-spawns EXACTLY
 *           `node scripts/supervise.mjs <id> --no-start --events`. `"start"`
 *           ⇒ `spawnStartWatcher(specId, request, requestedBy)` (spec 0056
 *           phase 4c, rewired by spec 0131 A — the human Start-button click):
 *           same refusal discipline, then STARTS the run here via the
 *           project-aware `startPipeline` and attaches the same `--no-start`
 *           watcher. `"recover"` ⇒ `spawnRecover(specId)` (spec 0057
 *           phase 4b — the human Recover-button click, ADR-023 reconnect):
 *           refuses only on a bad id or a `--recover` already in progress,
 *           detach-spawns EXACTLY
 *           `node scripts/supervise.mjs --recover <id> --events`.
 *           `"resume-polished"` ⇒ `spawnPolishedWatcher(specId)` (spec 0057
 *           phase 4b — the human Resume-(polished)-button click): same
 *           attach-to-a-RUNNING-run refusal discipline as follow,
 *           detach-spawns EXACTLY
 *           `node scripts/supervise.mjs <id> --polished --no-start --events`.
 *           Any other mode value ⇒ 400.
 *
 * No secret and no raw command ever cross to the browser — only the typed
 * RunFollowState / SpawnWatcherResult JSON.
 */
import { sessionEmail, supervisorAccess } from "../../../../auth";
import { recordAudit } from "../../../../../lib/audit";
import { locateSpec } from "../../../../../lib/spec-locate";
import {
  getRunFollowState,
  parseWatcherMode,
  spawnPolishedWatcher,
  spawnRecover,
  spawnStartWatcher,
  spawnWatcher,
} from "../../../../../lib/supervisor-run";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ specId: string }> };

/**
 * The run's request text (spec 0131 B) — the spec's own title.
 *
 * It reaches the workflow as `input.request`, which matters more than it looks:
 * for a project whose checkout has no spec file yet, `draftSpec` DRAFTS from
 * this string. The console's POST body carries only `{mode}`, and the string it
 * replaces was `supervise.mjs`'s literal
 * "Run spec NNNN through the pipeline (supervise.mjs)." — a description of the
 * mechanism, not of the work.
 */
async function requestFor(specId: string, projectSlug: string): Promise<string> {
  // Spec 0135 D: one way to FIND a spec — files for the platform, rows for
  // every other project, resolved by the same helper run start uses.
  // Spec 0224: scoped, or `0001` finds the platform's foundations spec.
  const located = await locateSpec(specId, projectSlug || undefined);
  return located?.summary.title ?? `Run spec ${specId} through the pipeline.`;
}

/**
 * Which project is this request about? (Spec 0224.)
 *
 * `?project=<slug>` — sent by the card whenever it renders inside a project
 * workspace. Without it, `locateSpec("0001")` scans the platform's specs first
 * and finds `0001-launchpad-foundations.md`, so a customer's run resolved to the
 * platform: a MEMBER was refused with "the platform console requires OWNER", and
 * an OWNER was shown the platform's `spec-0001` instead of their own run.
 *
 * It is a SCOPING HINT, never authority: `supervisorAccess` still checks
 * membership on it, and the spec is resolved within it — so a forged value can
 * only narrow the request to a project the caller already belongs to.
 * Absent means the platform console, which is the one correct unscoped case.
 */
function projectOf(req: Request): string {
  return new URL(req.url).searchParams.get("project")?.trim() ?? "";
}

/** The access verdict for this spec, scoped (spec 0135 + 0224). Shared so the
 * two handlers cannot drift. */
async function accessFor(specId: string, projectSlug: string) {
  const located = await locateSpec(specId, projectSlug || undefined);
  const slug = projectSlug || located?.projectSlug;
  return supervisorAccess(slug && slug !== "platform" ? { projectSlug: slug } : {});
}

export async function GET(req: Request, context: RouteContext): Promise<Response> {
  const { specId } = await context.params;
  const projectSlug = projectOf(req);
  // Spec 0135: scoped by the SPEC's project — a member follows their own
  // project's runs; a platform spec stays OWNER-only.
  const access = await accessFor(specId, projectSlug);
  if (!access.ok) {
    return new Response(access.reason ?? "supervisor console access denied", { status: 403 });
  }
  return Response.json(await getRunFollowState(specId, projectSlug));
}

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  const { specId } = await context.params;
  const projectSlug = projectOf(req);
  const access = await accessFor(specId, projectSlug);
  if (!access.ok) {
    return new Response(access.reason ?? "supervisor console access denied", { status: 403 });
  }
  const rawBody = await req.text().catch(() => "");
  const mode = parseWatcherMode(rawBody);
  if (mode === "invalid") {
    return new Response(
      'invalid mode (must be "follow", "start", "recover", or "resume-polished")',
      { status: 400 },
    );
  }
  // Spec 0133: an optional branch rides the start body. Parsed here, VALIDATED
  // only in `startPipeline`'s refusal ladder — one choke point.
  let branch: string | undefined;
  try {
    const parsed = JSON.parse(rawBody) as { branch?: unknown };
    if (typeof parsed.branch === "string" && parsed.branch) branch = parsed.branch;
  } catch {
    // No body / not JSON — exactly the follow-button case; no branch.
  }
  // Spec 0131 B: a start now records who asked for it and what they asked for.
  // The actor is the verified session email (spec 0135: a member's start is
  // attributed to the member); refusing on its absence beats starting a run
  // attributed to nobody.
  const actor = await sessionEmail();
  if (mode === "start" && !actor) {
    return new Response("no session email to attribute this run to", { status: 403 });
  }
  const result =
    mode === "start"
      ? await spawnStartWatcher(specId, await requestFor(specId, projectSlug), actor!, undefined, {
          ...(branch ? { branch } : {}),
        })
      : mode === "recover"
        ? await spawnRecover(specId)
        : mode === "resume-polished"
          ? await spawnPolishedWatcher(specId)
          : await spawnWatcher(specId);
  if (result.ok) {
    // Spec 0075: each accepted watcher/recover spawn is an effectful action.
    await recordAudit({
      actor: actor ?? "owner-session",
      action: `console.${mode}`,
      target: specId,
      // Spec 0133: the branch is an identifier, never content — safe metadata.
      ...(mode === "start" && branch ? { metadata: { branch } } : {}),
    });
  }
  // 409 Conflict for a typed refusal (bad id / not RUNNING / already
  // following) — the request was well-formed, the state just doesn't allow
  // it right now; 200 with the pid on success.
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
