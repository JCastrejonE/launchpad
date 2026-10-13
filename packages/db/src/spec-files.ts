/**
 * The durable record of a spec (spec 0129 A).
 *
 * `spec_files` has been in the schema since 0077 with no writer, because the spec
 * FILE in this repo was always the truth and it was in git. The owner's decision — specs
 * live in the customer's checkout but are excluded from their history — removes that
 * safety net: an excluded file is unversioned, so its only copy sits on one worker's
 * disk. A re-clone, a lost volume or a rebuilt box would take with it the record of
 * what was approved and by whom.
 *
 * So the split is: the FILE stays what agents and the pipeline read and write (no
 * change to how they work), and the ROW is what survives and what the UI lists from.
 * `body` is stored precisely so a lost file can be re-materialised — that is the
 * whole reason to keep it rather than just a status.
 */
import { and, eq, like } from "drizzle-orm";
import type { Db } from "./client.js";
import { projects, specFiles } from "./schema.js";

export type SpecFileRow = typeof specFiles.$inferSelect;

export interface SpecFileUpsert {
  projectId: string;
  /** File basename, e.g. `0129-one-launchpad-many-repos.md` — the routable key. */
  name: string;
  status: string;
  /** Full markdown. The reason a lost checkout is recoverable. */
  body: string;
  author?: string;
  version?: string;
  /** The chat thread that drafted this spec (spec 0135) — how a run started
   * from ANY button finds its branch (thread → branch). Only set when known;
   * a later status upsert without it must not blank it. */
  chatId?: string;
}

/** Upsert by `(project_id, name)` — migration 0009's unique index. A status change
 * must UPDATE the row, not append a second one: two rows would give "what is this
 * spec's status?" two answers. */
export async function upsertSpecFile(db: Db, input: SpecFileUpsert): Promise<void> {
  const values = {
    projectId: input.projectId,
    name: input.name,
    status: input.status,
    body: input.body,
    author: input.author ?? "",
    version: input.version ?? "",
    updatedAt: new Date(),
    ...(input.chatId ? { chatId: input.chatId } : {}),
  };
  await db
    .insert(specFiles)
    .values(values)
    .onConflictDoUpdate({
      target: [specFiles.projectId, specFiles.name],
      set: {
        status: values.status,
        body: values.body,
        author: values.author,
        version: values.version,
        updatedAt: values.updatedAt,
        // chatId only when the caller KNOWS it (the drafting chat) — the
        // pipeline's status upserts carry none and must not blank the link.
        ...(input.chatId ? { chatId: input.chatId } : {}),
      },
    });
}

/**
 * Locate a spec by its four-digit id ACROSS projects (spec 0135's "one way to
 * FIND a spec"): non-platform specs live as rows, and run start must resolve
 * them without a file in the launchpad's own tree. Names are `NNNN-slug.md`,
 * so the id is a name prefix. Newest row wins if two projects ever share an
 * id — possible in principle, and the caller-facing fields carry the project
 * so a wrong winner is visible, not silent.
 */
export async function specFileBySpecId(
  db: Db,
  specId: string,
  /**
   * Spec 0142: scope the lookup to ONE project's slug. Every project numbers
   * its specs from 0001, so an unscoped `0001-%` matches whichever project
   * happened to update last — a silent cross-project resolution. Callers that
   * know the project (the Specs tab, the chat, run start) must pass it;
   * omitting it keeps the old newest-wins behaviour for callers that cannot.
   */
  projectSlug?: string,
): Promise<(SpecFileRow & { projectSlug: string }) | null> {
  const rows = await db
    .select({ spec: specFiles, slug: projects.slug })
    .from(specFiles)
    .innerJoin(projects, eq(projects.id, specFiles.projectId))
    .where(
      projectSlug
        ? and(like(specFiles.name, `${specId}-%`), eq(projects.slug, projectSlug))
        : like(specFiles.name, `${specId}-%`),
    );
  const newest = rows.sort(
    (a, b) => b.spec.updatedAt.getTime() - a.spec.updatedAt.getTime(),
  )[0];
  return newest ? { ...newest.spec, projectSlug: newest.slug } : null;
}

/** A project's specs, newest name first (names are zero-padded ids, so this is
 * chronological without a date). */
export async function listSpecFilesForProject(db: Db, projectId: string): Promise<SpecFileRow[]> {
  const rows = await db.select().from(specFiles).where(eq(specFiles.projectId, projectId));
  return rows.sort((a, b) => b.name.localeCompare(a.name));
}

/** One spec by project + name, or null. */
export async function specFileByName(db: Db, projectId: string, name: string): Promise<SpecFileRow | null> {
  const rows = await db
    .select()
    .from(specFiles)
    .where(and(eq(specFiles.projectId, projectId), eq(specFiles.name, name)))
    .limit(1);
  return rows[0] ?? null;
}
