/**
 * Releases — a version you can point at (spec 0170).
 *
 * "What is in production" was folklore. Nothing recorded that version N is a
 * particular commit, or which version is live, so gate 3 asked "promote?" about
 * an unnamed thing and the only answer was a click.
 *
 * A merge to main records a `candidate` here; deploying is a separate, refusable
 * decision about a NAMED version.
 *
 * ## Two invariants the database enforces, not the callers
 *
 * - `(project_id, version)` is unique, so allocation cannot hand two people the
 *   same number — the race spec 0164 paid for with spec ids.
 * - `(project_id, commit_sha)` is unique, so a replayed merge (Temporal will
 *   replay) cannot mint a second release of the same tree. `recordCandidate`
 *   returns the existing row instead of failing, which is what makes it safe to
 *   call from an activity.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { projectReleases } from "./schema.js";

export type ReleaseStatus = "candidate" | "deployed" | "superseded" | "failed";

export interface ReleaseRow {
  id: string;
  projectId: string;
  version: string;
  commitSha: string;
  notes: string;
  status: ReleaseStatus;
  createdBy: string;
  createdAt: Date;
  deployedBy: string;
  deployedAt: Date | null;
  deployRef: string;
}

function toRow(r: typeof projectReleases.$inferSelect): ReleaseRow {
  const status = r.status;
  return {
    ...r,
    status:
      status === "deployed" || status === "superseded" || status === "failed"
        ? status
        : "candidate",
  };
}

/** Newest first — both "what is live?" and "what is newest?" read this way. */
export async function listReleases(db: Db, projectId: string, limit = 50): Promise<ReleaseRow[]> {
  const rows = await db
    .select()
    .from(projectReleases)
    .where(eq(projectReleases.projectId, projectId))
    .orderBy(desc(projectReleases.createdAt))
    .limit(limit);
  return rows.map(toRow);
}

/**
 * The release currently in production, or null.
 *
 * Reads the STATUS rather than "the newest release", because the newest thing
 * cut is not the thing running — that gap is the entire point of this table.
 */
export async function deployedRelease(db: Db, projectId: string): Promise<ReleaseRow | null> {
  const rows = await db
    .select()
    .from(projectReleases)
    .where(and(eq(projectReleases.projectId, projectId), eq(projectReleases.status, "deployed")))
    .orderBy(desc(projectReleases.deployedAt))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function releaseByVersion(
  db: Db,
  projectId: string,
  version: string,
): Promise<ReleaseRow | null> {
  const rows = await db
    .select()
    .from(projectReleases)
    .where(and(eq(projectReleases.projectId, projectId), eq(projectReleases.version, version)))
    .limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Record the candidate for `commitSha`, or return the one already recorded.
 *
 * `ON CONFLICT (project_id, commit_sha) DO NOTHING` then re-read: an activity
 * that runs twice — a retry, a replay — must not produce a second release of the
 * same tree, and must not throw when it does not.
 *
 * The version is the caller's to compute (`nextVersion`), because the bump level
 * is a decision and this is a table.
 */
export async function createCandidate(
  db: Db,
  input: { projectId: string; version: string; commitSha: string; notes?: string; createdBy?: string },
): Promise<ReleaseRow> {
  await db
    .insert(projectReleases)
    .values({
      projectId: input.projectId,
      version: input.version,
      commitSha: input.commitSha,
      notes: input.notes ?? "",
      createdBy: input.createdBy ?? "",
    })
    .onConflictDoNothing();
  const existing = await db
    .select()
    .from(projectReleases)
    .where(
      and(
        eq(projectReleases.projectId, input.projectId),
        eq(projectReleases.commitSha, input.commitSha),
      ),
    )
    .limit(1);
  const row = existing[0];
  if (!row) {
    // The insert did nothing AND nothing is there: the only way is a version
    // collision with a DIFFERENT commit, which means the caller's `nextVersion`
    // was computed from a stale read. Refuse rather than invent a number.
    throw new Error(
      `createCandidate: version ${input.version} already exists for project ${input.projectId} ` +
        `on another commit — recompute from the current highest version`,
    );
  }
  return toRow(row);
}

/**
 * The highest version currently recorded, or null for a project with none.
 *
 * Sorted in SQL by the three numeric components, not lexically: `"1.10.0"` sorts
 * BELOW `"1.9.0"` as text, which would hand out a version that already exists
 * the first time a project reaches double digits.
 */
export async function highestVersion(db: Db, projectId: string): Promise<string | null> {
  const rows = await db.execute<{ version: string }>(sql`
    SELECT version FROM project_releases
     WHERE project_id = ${projectId}
     ORDER BY string_to_array(version, '.')::int[] DESC
     LIMIT 1
  `);
  const list = (Array.isArray(rows) ? rows : (rows as { rows?: { version: string }[] }).rows) ?? [];
  return list[0]?.version ?? null;
}

/**
 * Mark a release deployed, and demote whatever it replaced to `superseded`.
 *
 * One statement per change inside one call so the two never disagree: a project
 * showing two `deployed` rows would be a worse answer to "what is live" than the
 * folklore this replaces.
 */
export async function markDeployed(
  db: Db,
  input: { projectId: string; releaseId: string; deployedBy: string; deployRef?: string },
): Promise<void> {
  await db
    .update(projectReleases)
    .set({ status: "superseded" })
    .where(
      and(eq(projectReleases.projectId, input.projectId), eq(projectReleases.status, "deployed")),
    );
  await db
    .update(projectReleases)
    .set({
      status: "deployed",
      deployedBy: input.deployedBy,
      deployedAt: new Date(),
      ...(input.deployRef === undefined ? {} : { deployRef: input.deployRef }),
    })
    .where(eq(projectReleases.id, input.releaseId));
}

/** A deploy that failed. The release stays pointable — knowing that 1.4.2 failed
 * is worth as much as knowing 1.4.1 is live. */
export async function markDeployFailed(
  db: Db,
  releaseId: string,
  deployedBy: string,
): Promise<void> {
  await db
    .update(projectReleases)
    .set({ status: "failed", deployedBy, deployedAt: new Date() })
    .where(eq(projectReleases.id, releaseId));
}
