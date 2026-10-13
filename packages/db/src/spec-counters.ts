/**
 * Allocating a spec id when more than one person is drafting (spec 0164).
 *
 * The old allocator read the specs directory and returned `max + 1`. That is a
 * read-then-write race, and the console's own comment admitted the assumption it
 * rested on — *"no concurrent sessions"*. With two chats drafting in one project
 * both callers see `0004`, both write `0005-<slug>.md`, and nothing refuses it:
 * `spec_files`' unique index is on `(project_id, name)`, and two different slugs
 * are two different names.
 *
 * So the number comes from the database, in ONE statement, and Postgres does the
 * serialising.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/** Width of a spec id on disk — `0005`, not `5`. */
const SPEC_ID_WIDTH = 4;

export function formatSpecId(n: number): string {
  return String(n).padStart(SPEC_ID_WIDTH, "0");
}

/**
 * Claim the next spec id for `projectId`, never returning at or below `floor`.
 *
 * `floor` is the highest id the caller can currently see on disk. It matters
 * because every project's specs predate this table: the platform is at 0164 with
 * no counter row, and a project's specs live outside its repo entirely (0141). The
 * same statement that allocates also corrects a counter that has drifted below
 * what is really on disk, so a hand-written spec file can never be overwritten.
 *
 * ```sql
 * INSERT INTO spec_counters (project_id, last_id) VALUES ($1, floor + 1)
 * ON CONFLICT (project_id) DO UPDATE
 *   SET last_id = GREATEST(spec_counters.last_id + 1, EXCLUDED.last_id)
 * RETURNING last_id;
 * ```
 *
 * First caller for a project gets `floor + 1`; a concurrent second gets
 * `floor + 2`, because the row is locked for the duration of the statement.
 *
 * THROWS rather than falling back to `max + 1` when the database is unreachable
 * (decision 3). A fallback is the original race wearing a disguise, and it would
 * fire exactly when things are already going wrong. A refused draft is
 * recoverable; two specs sharing an id is not.
 */
export async function allocateSpecId(db: Db, projectId: string, floor: number): Promise<string> {
  const wanted = Math.max(0, Math.trunc(floor)) + 1;
  const rows = await db.execute<{ last_id: number }>(sql`
    INSERT INTO spec_counters (project_id, last_id, updated_at)
    VALUES (${projectId}, ${wanted}, now())
    ON CONFLICT (project_id) DO UPDATE
      SET last_id = GREATEST(spec_counters.last_id + 1, EXCLUDED.last_id),
          updated_at = now()
    RETURNING last_id
  `);
  // `db.execute` shape differs between drivers (array vs `{ rows }`); read both
  // rather than assume, since getting this wrong returns `undefined` and we would
  // format "NaN" into a filename.
  const list = (Array.isArray(rows) ? rows : (rows as { rows?: { last_id: number }[] }).rows) ?? [];
  const allocated = list[0]?.last_id;
  if (typeof allocated !== "number" || !Number.isFinite(allocated)) {
    throw new Error(
      `allocateSpecId: the counter for project ${projectId} returned no id — refusing to guess ` +
        `(a filesystem fallback is the race this exists to remove)`,
    );
  }
  return formatSpecId(allocated);
}
