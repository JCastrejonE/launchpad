/**
 * Branch reads and writes (spec 0133 A) — the odoo.sh model's registry.
 *
 * The row is the branch's control-plane identity; git holds the commits and
 * GitHub holds the PR. Writers here are deliberately narrow: creation, the
 * PR-number cache, the staging lifecycle (stack name, host, status, and the
 * two attestation SHAs recorded at deploy time), and the terminal merge mark.
 * Nothing updates `name` — a renamed branch is a different branch.
 */
import { and, eq, isNull, like } from "drizzle-orm";
import type { Db } from "./client.js";
import { agentRuns, projectBranches, specFiles } from "./schema.js";

/** Staging lifecycle of a branch's server (spec 0134 drives the transitions). */
export type BranchStagingStatus = "none" | "deploying" | "ready" | "failed" | "destroying";

export interface ProjectBranchRow {
  id: string;
  projectId: string;
  name: string;
  createdBy: string;
  prNumber: number | null;
  stagingStack: string | null;
  stagingHost: string | null;
  stagingStatus: BranchStagingStatus;
  /** Spec 0195 B: why the last staging op failed, '' when it did not. */
  stagingNote: string;
  stagingSha: string | null;
  stagingBaseSha: string | null;
  mergedAt: Date | null;
  mergedBy: string;
  createdAt: Date;
}

/** A duplicate (project, name) is refused, never overwritten — the same
 * reasoning as `createProject`'s DuplicateProjectSlugError. */
export class DuplicateBranchError extends Error {
  constructor(name: string) {
    super(`la rama "${name}" ya existe en este proyecto`);
    this.name = "DuplicateBranchError";
  }
}

function toRow(r: typeof projectBranches.$inferSelect): ProjectBranchRow {
  const status = r.stagingStatus;
  return {
    ...r,
    stagingStatus:
      status === "deploying" || status === "ready" || status === "failed" || status === "destroying"
        ? status
        : "none",
  };
}

/**
 * Insert-only creation. `onConflictDoNothing` + an empty `returning` rather
 * than a pre-flight SELECT, which would race two concurrent creates of the
 * same name (the 0126 lesson, same shape).
 */
export async function createProjectBranch(
  db: Db,
  input: { projectId: string; name: string; createdBy: string },
): Promise<ProjectBranchRow> {
  const inserted = await db.insert(projectBranches).values(input).onConflictDoNothing().returning();
  const row = inserted[0];
  if (!row) throw new DuplicateBranchError(input.name);
  return toRow(row);
}

/** Every branch of a project, unmerged first, newest first within each group —
 * the order "Ramas & builds" renders. */
export async function listBranchesForProject(db: Db, projectId: string): Promise<ProjectBranchRow[]> {
  const rows = await db
    .select()
    .from(projectBranches)
    .where(eq(projectBranches.projectId, projectId))
    .orderBy(projectBranches.createdAt);
  return rows
    .map(toRow)
    .sort((a, b) => {
      const aMerged = a.mergedAt ? 1 : 0;
      const bMerged = b.mergedAt ? 1 : 0;
      if (aMerged !== bMerged) return aMerged - bMerged;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
}

/** One branch by its (project, name) identity, or null. */
export async function branchByName(
  db: Db,
  projectId: string,
  name: string,
): Promise<ProjectBranchRow | null> {
  const rows = await db
    .select()
    .from(projectBranches)
    .where(and(eq(projectBranches.projectId, projectId), eq(projectBranches.name, name)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

/** Cache the branch PR's number (best-effort caller — promote re-derives by
 * head when this is stale or missing). */
export async function setBranchPr(db: Db, branchId: string, prNumber: number): Promise<void> {
  await db.update(projectBranches).set({ prNumber }).where(eq(projectBranches.id, branchId));
}

/**
 * Record a staging transition. The attestation SHAs are only ever written
 * TOGETHER with a deploy (`status: "ready"`) — a partial pair would let a
 * promote compare a fresh head against a stale base and block or pass on a
 * fiction.
 */
export async function setBranchStaging(
  db: Db,
  branchId: string,
  staging:
    | {
        status: "deploying" | "destroying" | "failed";
        stack?: string | null;
        host?: string | null;
        /** Spec 0195 B: why, in words a reviewer can act on. */
        note?: string;
      }
    | { status: "ready"; stack: string; host: string; sha: string; baseSha: string },
): Promise<void> {
  if (staging.status === "ready") {
    await db
      .update(projectBranches)
      .set({
        stagingStatus: "ready",
        stagingStack: staging.stack,
        stagingHost: staging.host,
        stagingSha: staging.sha,
        stagingBaseSha: staging.baseSha,
        // Spec 0195 B: a healthy environment carries no reason. Clearing here
        // rather than at the call sites means the note cannot outlive the
        // failure it describes.
        stagingNote: "",
      })
      .where(eq(projectBranches.id, branchId));
    return;
  }
  await db
    .update(projectBranches)
    .set({
      stagingStatus: staging.status,
      ...(staging.stack !== undefined ? { stagingStack: staging.stack } : {}),
      ...(staging.host !== undefined ? { stagingHost: staging.host } : {}),
      // A transition that does not name a reason clears the previous one: the
      // note belongs to the LAST op, never to the last op that happened to fail.
      stagingNote: staging.note ?? "",
    })
    .where(eq(projectBranches.id, branchId));
}

/** A destroyed stack leaves no half-facts behind: name, host, status AND the
 * attestation SHAs all clear — stale attestation on a stackless branch would
 * read as evidence at promote time. */
export async function clearBranchStaging(db: Db, branchId: string): Promise<void> {
  await db
    .update(projectBranches)
    .set({
      stagingStatus: "none",
      stagingStack: null,
      stagingHost: null,
      stagingSha: null,
      stagingBaseSha: null,
      stagingNote: "",
    })
    .where(eq(projectBranches.id, branchId));
}

/**
 * The promote roll-up (spec 0136): every spec that RODE this branch (its runs
 * recorded `agent_runs.branch`) flips `staged → promoted` in `spec_files`.
 * Returns the spec ids flipped. Best-effort semantics belong to the caller —
 * the projection is fail-open by design (0129 A), and a roll-up miss is a
 * stale badge, never a lost merge.
 */
export async function rollUpPromotedSpecs(
  db: Db,
  projectId: string,
  branch: string,
): Promise<string[]> {
  const runs = await db
    .select({ workflowId: agentRuns.workflowId })
    .from(agentRuns)
    .where(and(eq(agentRuns.projectId, projectId), eq(agentRuns.branch, branch)));
  // Spec 0142 C: a workflow id is `spec-<id>` (platform, and every pre-0142
  // run) or `spec-<slug>-<id>`. Take the LAST segment — stripping the `spec-`
  // prefix yielded `ab-test-sandbox-0003`, whose `LIKE '…-%'` matched no spec
  // at all, so the FIRST namespaced promote merged to main and silently left
  // its spec on `staged`. The same inversion was fixed in
  // `listRunningPipelineTargets` and missed here; both now take the last
  // segment, which is correct for either shape.
  const specIds = [
    ...new Set(runs.map((r) => r.workflowId.split("-").pop() ?? r.workflowId)),
  ];
  const flipped: string[] = [];
  for (const specId of specIds) {
    const updated = await db
      .update(specFiles)
      .set({ status: "promoted", updatedAt: new Date() })
      .where(
        and(
          eq(specFiles.projectId, projectId),
          like(specFiles.name, `${specId}-%`),
          eq(specFiles.status, "staged"),
        ),
      )
      .returning({ name: specFiles.name });
    if (updated.length > 0) flipped.push(specId);
  }
  return flipped;
}

/** Terminal: the branch PR merged. Guarded on `merged_at IS NULL` so a repeated
 * promote's bookkeeping never rewrites who merged first. Returns whether THIS
 * call performed the mark. */
export async function markBranchMerged(
  db: Db,
  branchId: string,
  mergedBy: string,
): Promise<boolean> {
  const updated = await db
    .update(projectBranches)
    .set({ mergedAt: new Date(), mergedBy })
    .where(and(eq(projectBranches.id, branchId), isNull(projectBranches.mergedAt)))
    .returning({ id: projectBranches.id });
  return updated.length > 0;
}
