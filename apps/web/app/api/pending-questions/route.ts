/**
 * "Is anyone waiting on me?" — the one query behind the TopBar chip (spec 0220).
 *
 * The pending question lives in `run-registry`'s in-process map and, since this
 * spec, in a `pending_questions` row. Neither alone is the answer: the row
 * survives a restart the run does not, so this returns their INTERSECTION —
 * unresolved AND still live here. Anything else is the stale "requiere tu
 * atención" line spec 0122 deleted, and it would earn the same deletion.
 *
 * Deliberately narrow, like `/api/projects/[id]/live`:
 *  - GET only, nothing written;
 *  - membership-scoped (spec 0143/0144 E) — a question's summary and the person
 *    it was asked of are project data;
 *  - `no-store`, because a cached "nobody is waiting" is the failure mode;
 *  - any failure answers "no questions" rather than 500: this is polled every 8
 *    seconds by every open tab, and a chip that cannot render is not an outage.
 */
import { listProjectsFor, listUnresolvedPendingQuestions } from "@launchpad/db";
import { getDb } from "../../../lib/db";
import { actionablePendingQuestions } from "../../../lib/pending-questions";
import { pendingQuestionThreadIds } from "../../../lib/run-registry";
import { isPlatformMember } from "../../auth";
import { currentViewer } from "../../viewer";

export async function GET(): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  try {
    const viewer = await currentViewer();
    if (!viewer) return Response.json({ questions: [] }, { headers });
    // The common case by far, and the map is the cheap half of the intersection:
    // no live question means no query at all, on a route every tab polls.
    const liveThreadIds = pendingQuestionThreadIds();
    if (liveThreadIds.length === 0) return Response.json({ questions: [] }, { headers });

    const db = getDb();
    const [rows, projects, platform] = await Promise.all([
      listUnresolvedPendingQuestions(db),
      listProjectsFor(db, viewer.userId, { isPlatformOwner: viewer.isPlatformOwner }),
      isPlatformMember(),
    ]);
    const questions = actionablePendingQuestions({
      rows,
      liveThreadIds,
      projects,
      viewerEmail: viewer.email,
      isPlatformMember: platform,
    });
    return Response.json({ questions }, { headers });
  } catch {
    return Response.json({ questions: [] }, { headers });
  }
}
