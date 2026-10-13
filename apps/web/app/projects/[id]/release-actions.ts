"use server";

/**
 * The ship button (spec 0170).
 *
 * The owner: *"one thing is to decide to merge the new change into our current version,
 * and other thing is to actually move that changes to production."* This is the
 * second decision, and unlike gate 3 it is about a NAMED version — so *not now*
 * and *not this one* are both real answers.
 *
 * Gated twice, deliberately: project membership (spec 0168 — the global role no
 * longer grants project access) AND `actorFor("promote")`, which is what
 * CLAUDE.md means by "the merge IS the production deploy — OWNER only". The
 * refusal is audited, because "who tried to ship" is a question a control plane
 * has to answer.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { revalidatePath } from "next/cache";
import {
  deployedRelease,
  listAgentRuns,
  listBranchesForProject,
  listReleases,
  membershipFor,
  projectBySlug,
  releaseByVersion,
} from "@launchpad/db";
import {
  checkoutPathFor,
  decideReleaseDeploy,
  DEPLOY_RELEASE_WORKFLOW,
  isNewer,
  TASK_QUEUE,
  type deployReleaseWorkflow,
  type ReleaseDeployDecision,
} from "@launchpad/pipeline";
import { GithubClient, latestStatusForContext } from "@launchpad/github";
import { actorFor } from "../../auth";
import { currentViewer } from "../../viewer";
import { recordAudit } from "../../../lib/audit";
import { getDb } from "../../../lib/db";
import { getClient, listRunningSpecIds, specIdFromWorkflowId } from "../../../lib/pipeline";
import { startPlatformDeploy } from "../../../lib/platform-deploy";
import { isStagingControlPlane } from "../../../lib/env";
import { releaseWasStaged } from "../../../lib/release-staging";
import {
  decidePlatformDeploy,
  type InterruptedRun,
} from "../../../lib/platform-release-decision";
import { parseFrontmatter, readSpecFile, resolveSpecFilenameById } from "../../../lib/specs";
import { createCandidateForCommit } from "../../../lib/release-candidate";
import { PLATFORM_PROJECT_SLUG } from "../../../lib/spec-project";

const exec = promisify(execFile);

export interface ReleaseActionResult {
  ok: boolean;
  problem?: string;
}

async function requireProjectMember(slug: string) {
  const viewer = await currentViewer();
  if (!viewer) return { ok: false as const, problem: "Sesión no válida." };
  const db = getDb();
  const project = await projectBySlug(db, slug);
  if (!project) return { ok: false as const, problem: `No existe el proyecto "${slug}".` };
  if (!(await membershipFor(db, project.id, viewer.userId))) {
    return { ok: false as const, problem: "No eres miembro de este proyecto." };
  }
  return { ok: true as const, viewer, project, db };
}

/**
 * Is the release's commit still an ancestor of `origin/main`?
 *
 * `undefined`, never `false`, when git cannot answer — a missing checkout is not
 * evidence that history was rewritten, and the decision treats the two
 * differently on purpose.
 */
export async function commitStillOnMain(
  repoRoot: string,
  commitSha: string,
): Promise<boolean | undefined> {
  try {
    await exec("git", ["fetch", "origin", "main"], { cwd: repoRoot });
    await exec("git", ["merge-base", "--is-ancestor", commitSha, "origin/main"], { cwd: repoRoot });
    return true;
  } catch (err) {
    // Exit 1 is git's honest "no". Anything else (128 = unknown object, not a
    // repo) is a broken question, and a broken question is not an answer.
    return (err as { code?: number }).code === 1 ? false : undefined;
  }
}

/**
 * Cut a release candidate for the PLATFORM from the current `origin/main`
 * (spec 0213 C).
 *
 * Every other project cuts its candidate at branch-promote
 * (`branch-actions.ts`). The platform uses the per-spec model and never promotes
 * a branch, which is the entire reason `project_releases` held zero rows for it —
 * not a missing versioning story. `createCandidateForCommit` already handles a
 * non-Odoo project: `usesOdooManifest("platform")` is false, so it allocates
 * `nextVersion(highest, "patch")`, and the first one is `1.0.0`.
 *
 * `request`, not `promote`: cutting a candidate names a commit, it does not ship
 * it. Over-gating a reversible act trains people to ignore the gate on the
 * irreversible one.
 */
export async function cutPlatformCandidateAction(slug: string): Promise<ReleaseActionResult> {
  const ctx = await requireProjectMember(slug);
  if (!ctx.ok) return ctx;
  if (ctx.project.kind !== "platform") {
    return { ok: false, problem: "Cortar versión aquí es solo para el proyecto plataforma." };
  }
  const actor = await actorFor("request");
  if (!actor.ok) return { ok: false, problem: actor.reason };

  const repoRoot = ctx.project.repoRoot || process.env["LAUNCHPAD_REPO_ROOT"] || "";
  if (!repoRoot) return { ok: false, problem: "No sé dónde está el checkout de la plataforma." };

  let sha: string;
  try {
    await exec("git", ["fetch", "origin", "main"], { cwd: repoRoot });
    const { stdout } = await exec("git", ["rev-parse", "origin/main"], { cwd: repoRoot });
    sha = stdout.trim();
  } catch (err) {
    return { ok: false, problem: `No pude leer origin/main: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, problem: `origin/main no dio un SHA: ${sha}` };

  try {
    const release = await createCandidateForCommit(ctx.db, {
      projectId: ctx.project.id,
      kind: ctx.project.kind,
      commitSha: sha,
      createdBy: actor.actor,
    });
    await recordAudit({
      actor: actor.actor,
      action: "release.cut",
      target: `${slug}@${release.version}`,
      metadata: { projectSlug: slug, version: release.version, commitSha: sha },
    });
    revalidatePath(`/projects/${slug}/versiones`);
    return { ok: true };
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Platform runs a deploy would interrupt (spec 0219 D).
 *
 * Two sources, both needed. `agent_runs` carries the phase and is one query;
 * Temporal carries the truth about what is actually RUNNING. A worker killed
 * mid-run leaves its row saying `running` forever, so the DB alone would name
 * phantoms — and a warning that cries wolf gets ignored, which is the same as
 * not having it. The intersection is what we can defend.
 *
 * Never throws: this decorates a decision, it does not gate one.
 */
async function platformRunsAtRisk(
  db: ReturnType<typeof getDb>,
  projectId: string,
  slug: string,
): Promise<InterruptedRun[]> {
  try {
    const [rows, live] = await Promise.all([
      listAgentRuns(db, projectId),
      listRunningSpecIds(slug),
    ]);
    const out: InterruptedRun[] = [];
    for (const row of rows) {
      if (row.status !== "running") continue;
      const specId = specIdFromWorkflowId(row.workflowId);
      if (!live.has(specId)) continue;
      out.push({ specId: `spec-${specId}`, phase: row.phase, who: await requesterOf(specId) });
    }
    return out;
  } catch {
    return [];
  }
}

/** Who asked for this spec — the frontmatter's `requested_by`, "" if unknown. */
async function requesterOf(specId: string): Promise<string> {
  try {
    const filename = await resolveSpecFilenameById(specId);
    if (!filename) return "";
    return parseFrontmatter(await readSpecFile(filename))["requested_by"] ?? "";
  } catch {
    return "";
  }
}

/** The live decision for one release, for the panel and the action to share — so
 * the button and the refusal can never disagree. */
export async function releaseDeployDecision(
  slug: string,
  version: string,
): Promise<ReleaseDeployDecision> {
  const ctx = await requireProjectMember(slug);
  if (!ctx.ok) return { blocked: true, tone: "danger", message: ctx.problem };
  const { db, project } = ctx;

  const release = await releaseByVersion(db, project.id, version);
  if (!release) {
    return { blocked: true, tone: "danger", message: `No existe la versión ${version}.` };
  }
  const live = await deployedRelease(db, project.id);

  // Spec 0213 D: the platform's production is the box this is running on — not a
  // configuration, a fact. `decideReleaseDeploy` asks which KIND of production a
  // project has (a customer's odoo.sh, our fleet) and refuses when there is
  // none, which for the platform is always. Its own verdict, on its own terms.
  if (project.kind === "platform") {
    return decidePlatformDeploy({
      version: release.version,
      onMain: await commitStillOnMain(
        project.repoRoot || process.env["LAUNCHPAD_REPO_ROOT"] || "",
        release.commitSha,
      ),
      liveVersion: live?.version ?? null,
      isStaging: isStagingControlPlane(),
      interrupts: await platformRunsAtRisk(db, project.id, project.slug),
    });
  }

  // Was the code in this release ever stood up on a branch staging? Absence is a
  // WARN, never a block — it means we do not know it was tried, not that it
  // failed.
  //
  // Spec 0223: this compared `stagingSha === release.commitSha` and those are
  // never equal — promote merges with `merge_method: "merge"`, so the release is
  // cut at a NEW commit that is by construction not the branch head. The warning
  // fired on every release ever cut. Containment is the honest question.
  const branches = await listBranchesForProject(db, project.id).catch(() => []);
  const staged = await releaseWasStaged(
    project.repoRoot || checkoutPathFor(project.slug),
    branches.map((b) => b.stagingSha),
    release.commitSha,
  );

  let odooShBuild: "success" | "failure" | "pending" | "unknown" | undefined;
  if (project.productionKind === "odoosh" && project.repoOwner && project.repoName) {
    const token = process.env["GITHUB_TOKEN"];
    if (token) {
      try {
        const client = new GithubClient({ token, owner: project.repoOwner, repo: project.repoName });
        const status = latestStatusForContext(
          await client.getCommitStatuses(release.commitSha),
          "ci/odoo.sh",
        );
        odooShBuild =
          status?.state === "success"
            ? "success"
            : status?.state === "failure" || status?.state === "error"
              ? "failure"
              : status?.state === "pending"
                ? "pending"
                : "unknown";
      } catch {
        odooShBuild = "unknown";
      }
    }
  }

  return decideReleaseDeploy({
    version: release.version,
    onMain: await commitStillOnMain(project.repoRoot || checkoutPathFor(project.slug), release.commitSha),
    liveVersion: live?.version ?? null,
    // `undefined` when git could not answer — `decideReleaseDeploy` warns only on
    // an explicit `false`, so an unanswerable question stays silent rather than
    // becoming the same lie in a new place (spec 0223 decision 2).
    ...(staged === undefined ? {} : { staged }),
    productionKind: project.productionKind,
    ...(odooShBuild ? { odooShBuild } : {}),
    ...(await deployInFlight(project.slug)),
  });
}

/** A deploy already running for this project, by version — Temporal is the only
 * place that knows, since the row is not written until it finishes. */
async function deployInFlight(slug: string): Promise<{ deployInFlight?: string }> {
  try {
    const client = await getClient();
    const handle = client.workflow.getHandle(`release-deploy-${slug}`);
    const description = await handle.describe();
    if (description.status.name === "RUNNING") return { deployInFlight: "en curso" };
  } catch {
    // No such workflow, or Temporal unreachable. Neither is evidence of a deploy.
  }
  return {};
}

/**
 * Ship a version.
 *
 * Re-decides on the server rather than trusting the button: the panel's verdict
 * was computed when the page rendered, and main can move in between.
 */
export async function deployReleaseAction(
  slug: string,
  version: string,
  opts: { acceptWarn?: boolean } = {},
): Promise<ReleaseActionResult> {
  const ctx = await requireProjectMember(slug);
  if (!ctx.ok) return ctx;

  // Membership is not enough. Shipping to production is the `promote`
  // capability, and a signed-in refusal is worth recording.
  const promote = await actorFor("promote");
  if (!promote.ok) {
    if (promote.actor) {
      await recordAudit({
        actor: promote.actor,
        action: "gate.denied",
        target: `${slug}@${version}`,
        metadata: { projectSlug: slug, version, capability: "promote" },
      });
    }
    return { ok: false, problem: promote.reason };
  }

  const release = await releaseByVersion(ctx.db, ctx.project.id, version);
  if (!release) return { ok: false, problem: `No existe la versión ${version}.` };

  const decision = await releaseDeployDecision(slug, version);
  if (decision.blocked) return { ok: false, problem: decision.message };
  if (decision.tone === "danger" && !opts.acceptWarn) {
    // A danger-toned warning is the deploy-an-older-version case. It is allowed,
    // but never on a single click.
    return { ok: false, problem: decision.message };
  }

  // Spec 0213 D: the control plane cannot deploy itself through Temporal. The
  // deploy restarts `launchpad-worker`, so an activity doing it would be killed
  // mid-flight and retried after the restart — a deploy loop — and it restarts
  // `launchpad-web`, so the request that started it dies before it can answer.
  // The work is handed to a DETACHED process that outlives both units, and the
  // release row is written by that process from the stamp and the health check,
  // never here from intent.
  if (ctx.project.kind === "platform") {
    // The units this deploy restarts are PRODUCTION's, hardcoded in
    // deploy-here.sh. Pressed on the staging twin it would build the staging
    // tree and then restart production — two environments damaged, neither told.
    // The twin is a byte-identical build, so nothing else would have caught it.
    if (isStagingControlPlane()) {
      return {
        ok: false,
        problem:
          "Estás en el staging del control plane. Desplegar producción se hace desde " +
          "launchpad.example.com, no desde aquí.",
      };
    }
    const repoRoot = ctx.project.repoRoot || process.env["LAUNCHPAD_REPO_ROOT"] || "";
    if (!repoRoot) return { ok: false, problem: "No sé dónde está el checkout de la plataforma." };
    // Spec 0219 A: the result is READ. The previous version fire-and-forgot the
    // spawn and answered ok regardless, so a second press during a running
    // deploy reported success and did nothing at all.
    let started;
    try {
      started = startPlatformDeploy({
        repoRoot,
        commitSha: release.commitSha,
        version: release.version,
        actor: promote.actor,
        slug,
      });
    } catch (err) {
      return { ok: false, problem: `No pude lanzar el despliegue: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!started.ok) return { ok: false, problem: started.problem };
    const { logPath } = started;
    // Spec 0219 C: when this moves production BACKWARDS, the row says so. The
    // deploy table would otherwise record it as an ordinary ship, and "who put
    // the old version back, and knowingly?" is a question the control plane has
    // to be able to answer.
    const liveNow = await deployedRelease(ctx.db, ctx.project.id);
    const reverts = liveNow && isNewer(liveNow.version, release.version) ? liveNow.version : null;
    await recordAudit({
      actor: promote.actor,
      action: "release.deploy",
      target: `${slug}@${version}`,
      metadata: {
        projectSlug: slug,
        version: release.version,
        commitSha: release.commitSha,
        logPath,
        ...(reverts ? { revertsFrom: reverts } : {}),
      },
    });
    revalidatePath(`/projects/${slug}/versiones`);
    return { ok: true };
  }

  try {
    const client = await getClient();
    await client.workflow.start<typeof deployReleaseWorkflow>(DEPLOY_RELEASE_WORKFLOW, {
      taskQueue: TASK_QUEUE,
      // One deploy per project at a time: a double click is a duplicate-id
      // refusal from Temporal, not a second deploy.
      workflowId: `release-deploy-${slug}`,
      args: [
        {
          projectSlug: slug,
          version: release.version,
          releaseId: release.id,
          commitSha: release.commitSha,
          deployedBy: promote.actor,
        },
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already started|Workflow execution already/i.test(message)) {
      return { ok: false, problem: "Ya hay un despliegue en curso para este proyecto." };
    }
    return { ok: false, problem: `No pude iniciar el despliegue: ${message}` };
  }

  await recordAudit({
    actor: promote.actor,
    action: "release.deploy",
    target: `${slug}@${version}`,
    metadata: {
      projectSlug: slug,
      version: release.version,
      commitSha: release.commitSha,
      productionKind: ctx.project.productionKind ?? "",
    },
  });
  revalidatePath(`/projects/${slug}/versiones`);
  return { ok: true };
}

/** The panel's data. Any member may read it. */
export async function listReleasesAction(slug: string) {
  const ctx = await requireProjectMember(slug);
  if (!ctx.ok) return { releases: [], live: null };
  return {
    releases: await listReleases(ctx.db, ctx.project.id),
    live: await deployedRelease(ctx.db, ctx.project.id),
  };
}
