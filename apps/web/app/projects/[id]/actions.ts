"use server";

/**
 * Server actions behind the project workspace (spec 0086, C.4c; the spec-viewer
 * modal's `readSpecBodyAction` was deleted with the chats-tab specs sidebar,
 * spec 0137 — the Specs TAB reads through `specs-tab.tsx` instead).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isSafeSpecFilename } from "../../../lib/specs";
// Spec 0122: the frontmatter writer lives with the other spec-file readers.
import { setArchivedInDir, setStatusInDir, findSpecFileInDir, parseStatus } from "@launchpad/pipeline";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { upsertSpecFile, projectById, setProjectRepo } from "@launchpad/db";
import { getDb } from "../../../lib/db";
import { actorFor, isProjectMember, supervisorAccess } from "../../auth";
import { capabilityForSignal } from "../../../lib/capabilities";
import { specsDirForProject } from "../../../lib/spec-source";
import { commitSpecFile } from "../../../lib/spec-commit";
import { PLATFORM_PROJECT_SLUG } from "../../../lib/spec-project";
import { parseRepoRef } from "../../../lib/project-create";
import { verifyRepoUsable } from "../../../lib/repo-access";
import { currentViewer } from "../../viewer";
import { gateAuditAction, recordAudit } from "../../../lib/audit";
import type { GateSignal } from "../../../lib/gate-actions";
import { runWorkspaceGateAction } from "../../../lib/workspace-gate";
import { runStartPipelineAction } from "../../../lib/supervisor-run";
import { mergeGate2Pr } from "../../../lib/gate2-merge";

/**
 * Where a failed action sends the user back to (spec 0152).
 *
 * Every redirect in this file used `/projects/${projectId}` — the project's
 * UUID. That route resolves its segment by SLUG (`projectBySlug`), so a UUID is
 * not a project: the user landed on Next's bare **404 page**, with the reason
 * sitting unread in the query string. The owner, on pressing Iniciar for a spec that
 * already had a run: *"I cant start a spec run in the UI."* It had refused
 * correctly and then thrown the refusal away.
 *
 * Falls back to the id if the lookup fails — a 404 is still better than an
 * unhandled exception inside an error path.
 */
async function workspacePath(
  projectId: string,
  error?: string,
  /** Spec 0157: the panel, now a real route SEGMENT (`/projects/<slug>/<panel>`)
   * rather than the `?tab=` query 0153 threaded through. Each action passes the
   * panel its buttons live on, so a refusal is answered where it was asked. */
  panel: "specs" | "agentes" = "specs",
): Promise<string> {
  let slug = projectId;
  try {
    slug = (await projectById(getDb(), projectId))?.slug ?? projectId;
  } catch {
    // DB unreachable while already reporting a failure — use what we have.
  }
  const path = `/projects/${slug}/${panel}`;
  return error ? `${path}?error=${encodeURIComponent(error)}` : path;
}

/**
 * Spec 0160: commit a spec file the UI just wrote — platform only.
 *
 * Every other project's specs live OUTSIDE any repository (spec 0141), so there
 * is nothing to commit and nothing to dirty. Only the platform keeps its specs
 * in a git-tracked tree that pipeline runs also work in, which is why only the
 * platform can brick the next merge.
 */
async function commitPlatformSpec(projectSlug: string, file: string, message: string): Promise<void> {
  if (projectSlug !== PLATFORM_PROJECT_SLUG) return;
  const root = process.env["LAUNCHPAD_REPO_ROOT"];
  if (!root) return;
  await commitSpecFile(root, file, message);
}

/**
 * Workspace sibling of the spec page's `signalGateAction` (spec 0095): the
 * Agentes tab's gate buttons post here instead of to `/forge/specs/<file>`.
 * Reuses the exact guard-then-signal core (`runWorkspaceGateAction`) the spec
 * page's action reuses `resolvePromoteSignalGuard`/`signalGate` for — a
 * second surface for the same signal must never become a way around the
 * gate-3 CI guard. `projectId` is only used to redirect/revalidate back to
 * this workspace; the workflow itself is addressed by `specId`.
 */
export async function signalGateAction(
  projectId: string,
  specId: string,
  signal: GateSignal,
  /** Spec 0142 C: the project's SLUG — workflow ids are namespaced by it. */
  projectSlug?: string,
): Promise<void> {
  // Spec 0144 E: the capability check answers "may this ROLE do this KIND of
  // thing"; it never asked WHICH project. A MEMBER of project A could act on
  // project B by crafting the request — 0143 gated the page and named this as
  // the remaining hole. Membership is checked FIRST so a non-member never
  // learns whether the spec or run exists.
  if (!(await isProjectMember(projectId))) {
    redirect(await workspacePath(projectId, "No eres miembro de este proyecto.", "agentes"));
    return;
  }
  // Spec 0074 (audit #3): gate signals are authenticated, attributable
  // mutations — the actor recorded on the workflow is the verified session
  // email. Spec 0117 splits WHICH session may send WHICH signal: approve/reject
  // need `request` (MEMBER or OWNER), `promote` needs `promote` (OWNER only,
  // because the merge is the production deploy).
  const check = await actorFor(capabilityForSignal(signal));
  if (!check.ok) {
    // A signed-in user refused a signal is an audit event in its own right —
    // the classic "who tried to promote" question a three-person control plane
    // has to be able to answer. Signed-out attempts carry no actor and are not
    // worth a row.
    if (check.actor) {
      await recordAudit({
        actor: check.actor,
        action: "gate.denied",
        target: specId,
        metadata: { projectId, signal },
      });
    }
    redirect(await workspacePath(projectId, check.reason, "agentes"));
    return;
  }
  const actor = check.actor;
  const result = await runWorkspaceGateAction(specId, signal, actor, undefined, projectSlug);
  if (!result.ok) {
    redirect(await workspacePath(projectId, result.reason, "agentes"));
    return;
  }
  await recordAudit({ actor, action: gateAuditAction(signal), target: specId, metadata: { projectId } });
  revalidatePath(await workspacePath(projectId, undefined, "specs"));
}

/**
 * Merge the run's PR — which IS gate 2 (spec 0225 D).
 *
 * `awaitPrApproval` returns `{outcome:"approved", via:"merge"}` on
 * `state.merged` (ADR-016), so the pipeline has always accepted this act. What
 * did not exist was a way to perform it from the app: `suppressDuplicateApprove`
 * correctly hides the in-app approve when GitHub's review is the gate, and
 * nothing replaced it — so every platform run parked at `awaiting_pr_approval`
 * until a human opened GitHub. Ten consecutive PRs show `approved_by=—`,
 * because every one was merged by hand.
 *
 * NOT a new gate, and deliberately not a new signal: this merges, and the
 * workflow's own poll notices. Gated on `promote` (OWNER) because the merge is
 * the production act, and performed with the ACTOR'S OWN credential — never the
 * bot — for the same reason branch-promote does it that way (spec 0136): a
 * merge attributed to a person must have been performed by that person.
 */
export async function mergeGatePrAction(
  projectId: string,
  specId: string,
  projectSlug?: string,
): Promise<void> {
  // Membership first, so a non-member never learns whether the run exists.
  if (!(await isProjectMember(projectId))) {
    redirect(await workspacePath(projectId, "No eres miembro de este proyecto.", "agentes"));
    return;
  }
  const check = await actorFor("promote");
  if (!check.ok) {
    if (check.actor) {
      await recordAudit({
        actor: check.actor,
        action: "gate.denied",
        target: specId,
        metadata: { projectId, signal: "gate2.merge" },
      });
    }
    redirect(await workspacePath(projectId, check.reason, "agentes"));
    return;
  }
  const actor = check.actor;

  const result = await mergeGate2Pr(specId, projectSlug, actor);
  if (!result.ok) {
    redirect(await workspacePath(projectId, result.problem, "agentes"));
    return;
  }
  await recordAudit({
    actor,
    action: "gate2.merge",
    target: specId,
    metadata: { projectId, prNumber: result.prNumber, mergedSha: result.mergedSha },
  });
  revalidatePath(await workspacePath(projectId, undefined, "agentes"));
}

/**
 * Start a pipeline run for `specId` from the project workspace (spec 0104).
 *
 * The workspace twin of the spec page's `startPipelineAction`. It exists as a
 * separate wrapper for one reason: that one redirects failures to
 * `/forge/specs/<file>?error=…`, i.e. into the page spec 0102 plans to retire, so
 * calling it from here would reintroduce the dependency this spec removes. The
 * async CORE is reused verbatim — `runStartPipelineAction` (lib/supervisor-run.ts)
 * already resolves watched-vs-unwatched start mode and returns
 * `{ ok } | { ok: false, reason }`, so nothing new is implemented here.
 *
 * Same authority rules as every other mutating workspace action (spec 0074): no
 * OWNER session, no run; the recorded actor is the verified session email.
 * `projectId` is bound by the caller so the form action carries only the spec.
 */
export async function startSpecRunAction(
  projectId: string,
  /** Spec 0142: the project's SLUG, not just its uuid. Spec ids repeat across
   * projects (every project numbers from 0001), so run start must be told
   * which project's 0001 this is — otherwise it resolves against this repo's
   * own `specs/` and aims a customer's run at the platform. */
  projectSlug: string,
  filename: string,
  specId: string,
  title: string,
): Promise<void> {
  // Spec 0144 E: the capability check answers "may this ROLE do this KIND of
  // thing"; it never asked WHICH project. A MEMBER of project A could act on
  // project B by crafting the request — 0143 gated the page and named this as
  // the remaining hole. Membership is checked FIRST so a non-member never
  // learns whether the spec or run exists.
  if (!(await isProjectMember(projectId))) {
    redirect(await workspacePath(projectId, "No eres miembro de este proyecto.", "specs"));
    return;
  }
  // Spec 0117: starting a run is `request` — it produces a branch and a PR,
  // never a production change, so a MEMBER may do it.
  const check = await actorFor("request");
  if (!check.ok) {
    redirect(await workspacePath(projectId, check.reason, "specs"));
    return;
  }
  const actor = check.actor;
  const access = await supervisorAccess();
  const result = await runStartPipelineAction(specId, title, actor, access, undefined, {
    projectSlug,
  });
  if (!result.ok) {
    redirect(await workspacePath(projectId, `Could not start run: ${result.reason}`, "specs"));
    return;
  }
  await recordAudit({
    actor,
    action: "pipeline.start",
    target: specId,
    metadata: { projectId, filename, watched: access.ok },
  });
  revalidatePath(await workspacePath(projectId, undefined, "specs"));
}

/**
 * Archive or un-archive a spec (spec 0122).
 *
 * `request`-gated, not `promote`: archiving hides a row from a list and changes no
 * production state, so a MEMBER may do it (spec 0117's split). It is also fully
 * reversible — the flag lives in frontmatter, in git — which is why the button has
 * no confirmation step.
 *
 * Audited like every other effectful action (spec 0075), with the direction in the
 * metadata so the log distinguishes archiving from restoring.
 */
export async function setSpecArchivedAction(
  projectId: string,
  /** Spec 0154: the project's SLUG. Without it this action read
   * `LAUNCHPAD_REPO_ROOT/specs` for EVERY project — so archiving
   * ab-test-sandbox's `0003` rewrote the PLATFORM's `0003`. */
  projectSlug: string,
  specId: string,
  archived: boolean,
): Promise<void> {
  // Spec 0144 E: the capability check answers "may this ROLE do this KIND of
  // thing"; it never asked WHICH project. A MEMBER of project A could act on
  // project B by crafting the request — 0143 gated the page and named this as
  // the remaining hole. Membership is checked FIRST so a non-member never
  // learns whether the spec or run exists.
  if (!(await isProjectMember(projectId))) {
    redirect(await workspacePath(projectId, "No eres miembro de este proyecto.", "specs"));
    return;
  }
  const check = await actorFor("request");
  if (!check.ok) {
    redirect(await workspacePath(projectId, check.reason, "specs"));
    return;
  }
  // Spec 0154: the ONE resolver (0149). A project's specs live outside its repo
  // (0141), so `LAUNCHPAD_REPO_ROOT` is the right directory for exactly one
  // project — and spec ids repeat across projects, so the wrong directory does
  // not fail, it silently edits somebody else's spec of the same number.
  const dir = specsDirForProject(projectSlug);
  if (!dir) {
    redirect(
      await workspacePath(projectId, "LAUNCHPAD_REPO_ROOT is not set on the web server", "specs"),
    );
    return;
  }
  try {
    await setArchivedInDir(dir, specId, archived);
  } catch (err) {
    // A spec id that does not resolve to a file, or an unwritable repo — say so
    // rather than silently doing nothing, since the list would look unchanged.
    redirect(
      await workspacePath(
        projectId,
        `Could not ${archived ? "archive" : "restore"} spec ${specId}: ${(err as Error).message}`,
        "specs",
      ),
    );
    return;
  }
  // Spec 0129 A: keep the durable row in step with the file it mirrors.
  try {
    const file = await findSpecFileInDir(dir, specId);
    const body = await readFile(file, "utf8");
    await upsertSpecFile(getDb(), {
      projectId,
      name: path.basename(file),
      status: parseStatus(body),
      body,
    });
    // Spec 0160: and COMMIT it. The platform's specs are tracked in this repo, so
    // an uncommitted edit leaves the shared primary checkout dirty until a human
    // notices — and the bill is paid by whatever pipeline run merges next, whose
    // `assertCleanTree` names files the operator never connected to this button.
    await commitPlatformSpec(projectSlug, file, `chore(spec-${specId}): ${archived ? "archived" : "restored"} from the UI`);
  } catch {
    /* the file on disk is still the working truth */
  }
  await recordAudit({
    actor: check.actor,
    action: "spec.archived",
    target: specId,
    metadata: { projectId, projectSlug, archived },
  });
  revalidatePath(await workspacePath(projectId, undefined, "specs"));
}

/**
 * Mark a spec completed (spec 0149 — the project-scoped twin of the forge
 * page's `completeSpecAction`).
 *
 * Track-1 work has no run to finish it, so completion is a human act. This
 * exists so the ONE spec page can offer it for every project instead of only
 * the platform: same capability (`request` — it changes no production state and
 * is reversible in frontmatter) and the same membership gate as every other
 * action here.
 */
export async function completeProjectSpecAction(
  projectId: string,
  projectSlug: string,
  specId: string,
): Promise<void> {
  const back = `/projects/${projectSlug}/specs/${specId}`;
  if (!(await isProjectMember(projectId))) {
    redirect(`${back}?error=${encodeURIComponent("No eres miembro de este proyecto.")}`);
    return;
  }
  const check = await actorFor("request");
  if (!check.ok) {
    redirect(`${back}?error=${encodeURIComponent(check.reason)}`);
    return;
  }
  // Spec 0141: a project's specs live outside its repo, so there is no repo
  // root to hand `setStatus`. `specsDirForProject` is the ONE place that
  // difference is decided — the page reads through it too.
  const dir = specsDirForProject(projectSlug);
  if (!dir) {
    redirect(
      `${back}?error=${encodeURIComponent("LAUNCHPAD_REPO_ROOT is not set on the web server")}`,
    );
    return;
  }
  let body: string;
  let name: string;
  try {
    await setStatusInDir(dir, specId, "completed");
    // Spec 0129 A: the FILE is what agents read; the ROW is what survives a lost
    // checkout. Re-read after the write so the row carries the new status inside
    // the body too, not just in its column.
    const file = await findSpecFileInDir(dir, specId);
    name = path.basename(file);
    body = await readFile(file, "utf8");
  } catch (err) {
    redirect(
      `${back}?error=${encodeURIComponent(
        `No pude completar el spec ${specId}: ${err instanceof Error ? err.message : String(err)}`,
      )}`,
    );
    return;
  }
  // Best-effort, like every other projection into `spec_files`: losing the row
  // is bad, losing the completion because the DB blinked is worse.
  try {
    await upsertSpecFile(getDb(), { projectId, name, status: "completed", body });
  } catch {
    /* the file on disk is still the working truth */
  }
  // Spec 0160: commit the status edit for the same reason archiving does.
  try {
    await commitPlatformSpec(
      projectSlug,
      await findSpecFileInDir(dir, specId),
      `chore(spec-${specId}): status -> completed (from the UI)`,
    );
  } catch {
    /* the file on disk is still the working truth */
  }
  await recordAudit({
    actor: check.actor,
    action: "spec.completed",
    target: specId,
    metadata: { projectId, projectSlug },
  });
  revalidatePath(back);
}

/**
 * Link a GitHub repository to a project that has none (spec 0151).
 *
 * The owner: *"I cannot start runs because we need to link the repo first in the db."*
 * A project could only ever be linked at creation, so one created without a repo
 * was permanently stuck: every run start refused with "no tiene repositorio
 * vinculado", and the Repositorio tab's only advice was to link it *while
 * creating the project* — which had already happened.
 *
 * `request`, like creating the project itself: it asks for work to be possible,
 * it does not ship anything. Membership first, as everywhere here (0144 E).
 *
 * Returns its result rather than redirecting: the project page drops `?error=`
 * on the floor today, and a link form whose failures are invisible is worse than
 * no form. The caller renders `problem` next to the input.
 */
export async function linkProjectRepoAction(
  projectId: string,
  projectSlug: string,
  _prev: { ok: boolean; problem?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; problem?: string }> {
  if (!(await isProjectMember(projectId))) {
    return { ok: false, problem: "No eres miembro de este proyecto." };
  }
  const check = await actorFor("request");
  if (!check.ok) return { ok: false, problem: check.reason };

  const parsed = parseRepoRef(String(formData.get("repo") ?? ""));
  if (!parsed.ok) return { ok: false, problem: parsed.problem };

  // Refuse to REPLACE a link, deliberately. A linked project has a checkout at
  // `repo_root` full of the old repository, and pointing the row at a different
  // one would leave every future run working in a tree that no longer matches
  // its origin. Re-linking is a real operation with real cleanup; it is not this.
  const project = await projectById(getDb(), projectId);
  if (!project) return { ok: false, problem: "No encontré este proyecto." };
  if (project.repoOwner && project.repoName) {
    return {
      ok: false,
      problem: `Este proyecto ya está vinculado a ${project.repoOwner}/${project.repoName}.`,
    };
  }

  // Spec 0128 C: the server token must be able to push AND the person asking must
  // have write access. Same check `/new` runs, same module.
  const viewer = await currentViewer();
  const usable = await verifyRepoUsable(parsed.owner, parsed.name, viewer?.githubLogin);
  if (!usable.ok) return { ok: false, problem: usable.problem };

  try {
    await setProjectRepo(getDb(), projectSlug, parsed.owner, parsed.name);
  } catch (err) {
    return {
      ok: false,
      problem: `No pude guardar el repositorio: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  await recordAudit({
    actor: check.actor,
    action: "project.repo_linked",
    target: projectSlug,
    // Shape only (spec 0075) — the repo is the subject of the action, not a secret.
    metadata: { projectId, repo: `${parsed.owner}/${parsed.name}` },
  });
  revalidatePath(`/projects/${projectSlug}`);
  return { ok: true };
}
