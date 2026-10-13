"use server";

/**
 * Ramas & builds → Crear rama (spec 0133 F).
 *
 * Creating a branch is REQUESTING work, not managing the project — so any
 * project member may do it (the `request`-capability philosophy, spec 0117),
 * and it runs on the SERVER token: a ref from main's tip is scaffolding, like
 * opening a PR. The promoter-credential rule (0128) applies to the merge, the
 * production act, never here.
 *
 * Order matters: the GitHub ref is created BEFORE the row. A row without a
 * ref would send the first run into `BranchMissingOnOrigin`; a ref without a
 * row is inert (nothing lists or runs it) and the next create adopts it —
 * `createBranchRef` treats 422 "already exists" as success.
 */
import { revalidatePath } from "next/cache";
import { GithubApiError, GithubClient } from "@launchpad/github";
import { branchStackName } from "@launchpad/fleet-hostinger";
import {
  branchByName,
  createProjectBranch,
  DuplicateBranchError,
  listBranchesForProject,
  markBranchMerged,
  membershipFor,
  projectBySlug,
  rollUpPromotedSpecs,
  setBranchPr,
  setBranchStaging,
  type ProjectBranchRow,
} from "@launchpad/db";
import { createCandidateForCommit } from "../../../lib/release-candidate";
import {
  isValidBranchName,
  decideBranchPromote,
  checkoutPathFor,
  projectSpecsDir,
  setStatusInDir,
  activities,
  BRANCH_STAGING_WORKFLOW_TYPE,
  TASK_QUEUE,
  type branchStagingOp,
  CI_STATUS_CONTEXT,
} from "@launchpad/pipeline";
import { currentViewer } from "../../viewer";
import { actorFor } from "../../auth";
import { recordAudit } from "../../../lib/audit";
import { getDb } from "../../../lib/db";
import { readUserGithubToken } from "../../../lib/user-github-token";
import {
  findRunningBranchRun,
  getClient,
  getPipelineViewStateSafe,
  listProductionBusySpecIds,
} from "../../../lib/pipeline";

export interface BranchActionResult {
  ok: boolean;
  problem?: string;
  /**
   * Spec 0195 A: what SUCCEEDED-but-incompletely. Promote runs three
   * best-effort steps after the merge (roll-up, on-disk marker, release
   * candidate) and a failure in any of them must not fail a merge that already
   * happened — but for two A/B runs it also meant nobody was told. `ok: true`
   * with notices is the honest shape: the thing you asked for happened, and
   * here is what did not.
   */
  notices?: string[];
}

/**
 * Spec 0166 sweep: membership AND the `request` capability.
 *
 * `requireProjectMember` answers "does this person belong here". It does not
 * answer "may this ROLE mutate", so a VIEWER holding a membership row passed it
 * and could create branches and destroy staging environments. Latent — no VIEWER
 * accounts exist yet — but it is the same missing-capability shape that let a
 * MEMBER reach promote, and it also means the audit row named an actor nobody
 * authorised (spec 0117's whole point).
 *
 * Returns the authorised actor so callers record THAT, not merely whoever was
 * signed in.
 */
async function requireProjectRequest(slug: string) {
  const ctx = await requireProjectMember(slug);
  if (!ctx.ok) return ctx;
  const check = await actorFor("request");
  if (!check.ok) return { ok: false as const, problem: check.reason };
  return { ...ctx, actor: check.actor };
}

/** Resolve the project and confirm the caller is a member (or platform OWNER). */
async function requireProjectMember(slug: string) {
  const viewer = await currentViewer();
  if (!viewer) return { ok: false as const, problem: "Sesión no válida." };
  const db = getDb();
  const project = await projectBySlug(db, slug);
  if (!project) return { ok: false as const, problem: `No existe el proyecto "${slug}".` };
  const membership = await membershipFor(db, project.id, viewer.userId);
  if (!viewer.isPlatformOwner && !membership) {
    return { ok: false as const, problem: "No eres miembro de este proyecto." };
  }
  return { ok: true as const, viewer, project, db };
}

export async function createBranchAction(slug: string, name: string): Promise<BranchActionResult> {
  const ctx = await requireProjectRequest(slug);
  if (!ctx.ok) return ctx;
  const branch = (name ?? "").trim();
  if (!isValidBranchName(branch)) {
    return {
      ok: false,
      problem: `Nombre de rama inválido: minúsculas, dígitos y ./-_ (sin main/master ni prefijo spec/).`,
    };
  }
  if (ctx.project.kind === "platform") {
    return { ok: false, problem: "El proyecto plataforma usa el flujo por spec, no ramas." };
  }
  const { repoOwner, repoName } = ctx.project;
  if (!repoOwner || !repoName) {
    return { ok: false, problem: "Este proyecto no tiene repositorio vinculado todavía." };
  }
  const token = process.env["GITHUB_TOKEN"];
  if (!token) return { ok: false, problem: "GITHUB_TOKEN no está configurado en el servidor." };

  const client = new GithubClient({ token, owner: repoOwner, repo: repoName });
  const mainSha = await client.getBranchHeadSha("main").catch(() => null);
  if (!mainSha) {
    return {
      ok: false,
      problem: `No pude leer main de ${repoOwner}/${repoName} — ¿existe el repo y tiene main?`,
    };
  }
  try {
    await client.createBranchRef(branch, mainSha);
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
  try {
    await createProjectBranch(ctx.db, {
      projectId: ctx.project.id,
      name: branch,
      createdBy: ctx.viewer.email,
    });
  } catch (err) {
    if (err instanceof DuplicateBranchError) {
      // The ref exists AND the row exists — the branch simply already exists.
      return { ok: false, problem: err.message };
    }
    throw err;
  }
  await recordAudit({
    actor: ctx.viewer.email,
    action: "branch.create",
    target: slug,
    metadata: { branch, sha: mainSha },
  });
  revalidatePath(`/projects/${slug}`);
  return { ok: true };
}

/**
 * Deploy or destroy a branch's staging server (spec 0134) — starts the
 * worker-side `branchStagingOp` workflow: the fleet SSH identity and the
 * Hostinger token are worker-only env and must stay that way. Started by
 * STRING CONSTANT (docs/VERIFICATION.md #10). The workflowId keys on
 * project+stack so a double click is a Temporal duplicate-id refusal, not a
 * second deploy.
 */
async function startBranchStagingOp(
  slug: string,
  branch: string,
  op: "deploy" | "destroy",
): Promise<BranchActionResult> {
  // Spec 0166 sweep: deploying or destroying a staging stack is a mutation, so
  // it needs `request` and not merely membership.
  const ctx = await requireProjectRequest(slug);
  if (!ctx.ok) return ctx;
  const row = await branchByName(ctx.db, ctx.project.id, branch);
  if (!row) return { ok: false, problem: `La rama "${branch}" no existe en este proyecto.` };
  if (op === "deploy" && row.mergedAt) {
    return { ok: false, problem: "La rama ya fue promovida — no tiene sentido un staging nuevo." };
  }
  if (row.stagingStatus === "deploying" || row.stagingStatus === "destroying") {
    return { ok: false, problem: `Ya hay una operación de staging en curso (${row.stagingStatus}).` };
  }
  if (op === "destroy" && row.stagingStatus === "none") {
    return { ok: false, problem: "Esta rama no tiene servidor de staging." };
  }
  const stack = branchStackName(branch);
  try {
    const client = await getClient();
    await client.workflow.start<typeof branchStagingOp>(BRANCH_STAGING_WORKFLOW_TYPE, {
      taskQueue: TASK_QUEUE,
      workflowId: `branch-staging-${ctx.project.slug}-${stack}`,
      args: [{ op, projectSlug: ctx.project.slug, branch }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already started|Workflow execution already/i.test(message)) {
      return { ok: false, problem: "Ya hay una operación de staging en curso para esta rama." };
    }
    return { ok: false, problem: message };
  }
  // Optimistic status so the tab shows movement immediately; the activity is
  // the authoritative writer (deploying → ready | failed).
  await setBranchStaging(ctx.db, row.id, {
    status: op === "deploy" ? "deploying" : "destroying",
    ...(op === "deploy" ? { stack } : {}),
  });
  await recordAudit({
    // The AUTHORISED actor, not just the signed-in one (spec 0117).
    actor: ctx.actor,
    action: op === "deploy" ? "branch.staging.create" : "branch.staging.destroy",
    target: slug,
    metadata: { branch, stack },
  });
  revalidatePath(`/projects/${slug}`);
  return { ok: true };
}

export async function createBranchStagingAction(
  slug: string,
  branch: string,
): Promise<BranchActionResult> {
  return startBranchStagingOp(slug, branch, "deploy");
}

export async function destroyBranchStagingAction(
  slug: string,
  branch: string,
): Promise<BranchActionResult> {
  return startBranchStagingOp(slug, branch, "destroy");
}

export interface PromoteBranchResult {
  ok: boolean;
  problem?: string;
  /** Spec 0195 A: it merged, and here is what the bookkeeping after it could
   * not do. `ok: true` with notices is the honest shape. */
  notices?: string[];
  /** A warn-shaped guard outcome (spec 0136): the promote MAY proceed, but
   * only on an explicit second click that passes `acceptWarn`. */
  warned?: string;
  prUrl?: string;
}

/**
 * Promote a main (spec 0136): merge the branch's accumulated PR with the
 * PROMOTING USER's own GitHub credential — the merge IS the production act,
 * and GitHub enforcing it (branch protection, required reviews, CODEOWNERS)
 * is stronger than any role check of ours (0128 decision 2). No workflow:
 * everything needed is the row's attestation, three GitHub reads, one
 * Temporal scan and one merge. Double-promote safety is GitHub's own 405 on
 * a merged PR, short-circuited by the idempotent-recovery branch below.
 */
export async function promoteBranchAction(
  slug: string,
  branch: string,
  opts: { acceptWarn?: boolean } = {},
): Promise<PromoteBranchResult> {
  const ctx = await requireProjectMember(slug);
  if (!ctx.ok) return ctx;
  // Spec 0166: membership is NOT enough for this one. Merging a branch to main
  // IS the production change (CLAUDE.md: "`promote` — the merge, which is the
  // production deploy — OWNER only"), and this action only ever checked that the
  // caller belonged to the project. Proven live: a MEMBER session saw three
  // enabled "Promote a main" buttons and the server would have honoured them.
  //
  // The spec page's promote has always been gated; spec 0136 built this second
  // promote surface later and never picked the gate up — the rule applied where
  // it was written rather than everywhere it was needed (VERIFICATION #11).
  const promote = await actorFor("promote");
  if (!promote.ok) {
    // A signed-in refusal is itself worth recording: "who tried to promote" is a
    // question a three-person control plane has to be able to answer (spec 0117).
    if (promote.actor) {
      await recordAudit({
        actor: promote.actor,
        action: "gate.denied",
        target: `${slug}#${branch}`,
        metadata: { projectSlug: slug, branch, capability: "promote" },
      });
    }
    return { ok: false, problem: promote.reason };
  }
  const { project, db, viewer } = ctx;
  const row = await branchByName(db, project.id, branch);
  if (!row) return { ok: false, problem: `La rama "${branch}" no existe en este proyecto.` };
  if (row.mergedAt) return { ok: false, problem: "Esta rama ya fue promovida." };
  const { repoOwner, repoName } = project;
  if (!repoOwner || !repoName) {
    return { ok: false, problem: "Este proyecto no tiene repositorio vinculado." };
  }

  // An in-flight run on the branch blocks: promoting under a run that is
  // about to push more commits would merge a tree nobody validated.
  const repoRoot = project.repoRoot ?? checkoutPathFor(project.slug);
  const inFlight = await findRunningBranchRun(repoRoot, branch);
  if (inFlight) {
    // Spec 0179: "espera a que termine" is a dead end when the run is waiting
    // for the PERSON READING IT. That is what happened on the first real drive:
    // the run sat at gate 2 waiting for the merge, promote refused because a run
    // was active, and both refusals were correct. Say which gate is waiting.
    const waiting = await getPipelineViewStateSafe(inFlight, "approved", undefined, undefined, project.slug).catch(
      () => null,
    );
    const atGate2 = waiting?.state === "waiting_at_gate" && waiting.gate === "pr";
    return {
      ok: false,
      problem: atGate2
        ? `El run ${inFlight} está esperando TU aprobación en la compuerta 2 (revisión del cambio). ` +
          `Apruébalo en la spec ${inFlight} y vuelve a promover — promover no puede adelantarse a un run activo.`
        : `Hay un run en curso en esta rama (spec ${inFlight}) — espera a que termine.`,
    };
  }

  const serverToken = process.env["GITHUB_TOKEN"];
  if (!serverToken) return { ok: false, problem: "GITHUB_TOKEN no está configurado en el servidor." };
  const reader = new GithubClient({ token: serverToken, owner: repoOwner, repo: repoName });

  // Resolve the PR: cache → live state → reconcile by head (a closed-not-
  // merged PR gets superseded by whatever is open now).
  let prNumber = row.prNumber;
  let prState = prNumber ? await reader.getPrState(prNumber).catch(() => null) : null;
  if (!prState || (prState.state === "closed" && !prState.merged)) {
    const found = await reader.findOpenPrByHead(branch, "main").catch(() => null);
    if (found) {
      prNumber = found.number;
      prState = await reader.getPrState(found.number).catch(() => null);
      if (row.prNumber !== found.number) await setBranchPr(db, row.id, found.number);
    }
  }
  if (!prNumber || !prState) {
    return { ok: false, problem: "Esta rama no tiene PR abierto — corre al menos un spec en ella primero." };
  }

  // Idempotent recovery: the merge already happened (a half-finished promote,
  // or someone merged on GitHub) — do the bookkeeping and report success.
  if (prState.merged) {
    // Spec 0170: the merge happened elsewhere, so the candidate's commit comes
    // from the PR's own `merge_commit_sha` rather than from a merge we performed.
    await finishPromoteBookkeeping(
      db, project, row.id, branch, viewer.email, prNumber, row,
      prState.mergeCommitSha ?? "",
    );
    revalidatePath(`/projects/${slug}`);
    return { ok: true };
  }

  // The pure guard (spec 0136), fed with LIVE facts — heads from the GitHub
  // API, never local refs.
  const [branchHead, mainHead] = await Promise.all([
    reader.getBranchHeadSha(branch).catch(() => null),
    reader.getBranchHeadSha("main").catch(() => null),
  ]);
  const busyRuns = await listProductionBusySpecIds(repoRoot);
  // Spec 0188 C: is there any CI to be pending? A scaffolded project has no
  // Actions, and `aggregateChecks` reads "no runs" as "pending" — which warned
  // on every promote until someone stopped reading warnings. Unreachable
  // GitHub leaves it undefined, which keeps the warn (absence of an answer is
  // not an answer).
  const checksConfigured =
    prState.checks === "pending" ? await reader.hasAnyWorkflows().catch(() => undefined) : undefined;
  const productionBuild =
    project.productionKind === "odoosh" && mainHead
      ? await activities.readOdooShBuild(`${repoOwner}/${repoName}`, mainHead).catch(() => undefined)
      : undefined;
  // Spec 0228 E: OUR CI's verdict on the branch head. A separate reading from
  // `checks`, which is Actions and which this org does not run. Read here rather
  // than left as an optional the decision could never see — an argument no call
  // site supplies is the defect shape this repo has paid for six times
  // (docs/VERIFICATION.md #12). Unreachable GitHub leaves it undefined, and
  // absence deliberately says nothing.
  const gateStatus = branchHead
    ? await reader
        .getCommitStatuses(branchHead)
        .then((all) => all.find((st) => st.context === CI_STATUS_CONTEXT)?.state)
        .catch(() => undefined)
    : undefined;
  const decision = decideBranchPromote({
    branchHead: branchHead ?? undefined,
    mainHead: mainHead ?? undefined,
    stagingSha: row.stagingSha,
    stagingBaseSha: row.stagingBaseSha,
    checks: prState.checks,
    checksConfigured,
    gateStatus,
    busyRuns,
    productionBuild,
  });
  if (decision.blocked) return { ok: false, problem: decision.message };
  if (decision.message && !opts.acceptWarn) {
    // Warn-shaped: promotable, but only on an explicit second click — absence
    // of evidence is the person's call, never a silent pass.
    return { ok: false, warned: decision.message };
  }

  // The merge, as the PROMOTER. A missing token names the fix; a GitHub
  // refusal with the user token names whose access failed. NEVER the bot.
  const userToken = await readUserGithubToken(viewer.email);
  if (!userToken) {
    return {
      ok: false,
      problem:
        "No tengo un token de GitHub tuyo — cierra sesión y vuelve a entrar con GitHub para " +
        "almacenarlo, y asegúrate de tener permiso de merge en el repo.",
    };
  }
  // Spec 0170: the commit main moves TO — what a release candidate points at.
  let mergedSha = "";
  try {
    const merger = new GithubClient({ token: userToken, owner: repoOwner, repo: repoName });
    // Spec 0142: the branch PR is opened as a DRAFT so GitHub's merge button
    // cannot bypass this function's checks. Promote is the one place allowed to
    // take it out of draft, and it does so only AFTER every guard above passed.
    // Best-effort: a PR that was already ready (pre-0142, or marked by hand)
    // must still merge, so a failure here is logged and the merge attempted —
    // if it really is still a draft, GitHub refuses the merge and that refusal
    // is the honest error to surface.
    await merger.markPrReadyForReview(prNumber).catch((err: unknown) => {
      console.warn(`[promote] could not mark PR #${prNumber} ready (may already be):`, err);
    });
    mergedSha = await merger.mergePr(prNumber);
  } catch (err) {
    if (err instanceof GithubApiError && (err.kind === "auth" || err.kind === "not_found")) {
      return {
        ok: false,
        problem:
          `GitHub rechazó el merge con TU credencial (${viewer.email}): pide acceso de escritura ` +
          `a los dueños del repositorio ${repoOwner}/${repoName}.`,
      };
    }
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }

  const notices = await finishPromoteBookkeeping(
    db,
    project,
    row.id,
    branch,
    viewer.email,
    prNumber,
    row,
    mergedSha,
  );
  revalidatePath(`/projects/${slug}`);
  return notices.length > 0 ? { ok: true, notices } : { ok: true };
}

/** Bookkeeping after a merge is REAL on GitHub: terminal mark (guarded on
 * merged_at IS NULL — a repeat never rewrites who merged first), the
 * staged→promoted roll-up, and the audit row with both attestation SHAs. */
async function finishPromoteBookkeeping(
  db: ReturnType<typeof getDb>,
  /** The project ROW, not just its id: spec 0170 needs its kind, repo coordinates
   * and Odoo series to read the release version from the manifests at the merged
   * commit. Spec 0141's slug (the specs directory is keyed by it) comes from here
   * too, so the two can never disagree. */
  project: { id: string; slug: string; kind: string | null; repoOwner: string | null; repoName: string | null; version: string | null },
  branchRowId: string,
  branch: string,
  actor: string,
  prNumber: number,
  row: ProjectBranchRow,
  /** The commit main moved to — what a release candidate would ship. */
  mergedSha: string,
): Promise<string[]> {
  const notices: string[] = [];
  const marked = await markBranchMerged(db, branchRowId, actor);
  let promotedSpecs: string[] = [];
  try {
    promotedSpecs = await rollUpPromotedSpecs(db, project.id, branch);
  } catch (err) {
    console.warn("[promoteBranch] spec roll-up skipped:", err);
    notices.push(`No pude marcar las specs como promovidas: ${problemText(err)}`);
  }
  // Spec 0141/0142: the roll-up writes the ROW; the FILE is what the Specs tab
  // reads first (0141 — the file is the working copy, the row the durable
  // record). Writing only the row left 0003 showing `staged` in the UI while
  // its change was already in main — the same split-truth the checkout symlink
  // fixed for `markSpec`. Best-effort and per-spec: a promote that merged must
  // never fail on bookkeeping, and one unwritable file must not skip the rest.
  for (const specId of promotedSpecs) {
    try {
      // Spec 0193 B: `setStatusInDir`, not `setStatus`. The latter takes a repo
      // ROOT and appends `specs` itself, so passing the specs DIRECTORY scanned
      // `/srv/launchpad/specs/<slug>/specs` and failed ENOENT on every promote —
      // the row said `promoted` and the file on disk never moved. One argument,
      // two meanings, silent at the call site that is wrong
      // (docs/VERIFICATION.md #12).
      await setStatusInDir(projectSpecsDir(project.slug), specId, "promoted");
    } catch (err) {
      console.warn(`[promoteBranch] could not mark spec ${specId} promoted on disk:`, err);
      notices.push(`La spec ${specId} quedó marcada en la base pero no en su archivo.`);
    }
  }
  // Spec 0170: main just moved, so a release CANDIDATE exists — "if you shipped
  // now, this is what would go". Recorded here rather than at deploy time
  // because this is the moment we learn the trunk changed, and a candidate that
  // only appears when someone opens a panel would miss merges nobody watched.
  //
  // Best-effort, like the roll-up above and for the same reason: a promote that
  // already merged must never fail on bookkeeping.
  try {
    // No sha, no candidate. A release row pointing at "" would be a version you
    // cannot point at, which is the one thing this table exists to prevent.
    if (!mergedSha) throw new Error("GitHub did not report a merge commit sha");
    await createCandidateForCommit(db, {
      projectId: project.id,
      commitSha: mergedSha,
      // Odoo kinds read their version from the manifests at this commit rather
      // than being assigned one (spec 0170 decision 1, revised).
      kind: project.kind,
      repoOwner: project.repoOwner,
      repoName: project.repoName,
      ...(project.version ? { odooSeries: Number(project.version.split(".")[0]) } : {}),
      githubToken: process.env["GITHUB_TOKEN"],
      notes: `Promote de ${branch}`,
      createdBy: actor,
    });
  } catch (err) {
    console.warn("[promoteBranch] release candidate not recorded:", err);
    notices.push(
      `La rama se promovió pero NO se creó una versión en Versiones: ${problemText(err)}`,
    );
  }

  if (marked) {
    await recordAudit({
      actor,
      action: "branch.promote",
      target: branch,
      metadata: {
        pr: prNumber,
        stagingSha: row.stagingSha ?? "",
        stagingBaseSha: row.stagingBaseSha ?? "",
        promotedSpecs,
      },
    });
  }
  return notices;
}

/** An error's message, trimmed for a row under a button. */
function problemText(err: unknown, limit = 200): string {
  const text = (err instanceof Error ? err.message : String(err)).trim().replace(/\s+/g, " ");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** The project's branches for the tab — any member may read them. */
export async function listBranchesAction(slug: string): Promise<ProjectBranchRow[]> {
  const ctx = await requireProjectMember(slug);
  if (!ctx.ok) return [];
  return listBranchesForProject(ctx.db, ctx.project.id);
}

/** One branch row (the picker's validation read, spec 0135 consumes it). */
export async function branchRowAction(slug: string, name: string): Promise<ProjectBranchRow | null> {
  const ctx = await requireProjectMember(slug);
  if (!ctx.ok) return null;
  return branchByName(ctx.db, ctx.project.id, name);
}
