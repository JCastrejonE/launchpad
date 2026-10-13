/**
 * "Did this panel's data change?" — the whole live-update protocol (spec 0155).
 *
 * The workspace used to answer that question by re-rendering the entire route
 * every 8 seconds and letting React sort it out. This route answers it with one
 * short string, so the expensive part happens only when something actually
 * moved.
 *
 * Deliberately narrow:
 *  - GET only, no side effects, nothing written;
 *  - membership-gated exactly like the page (spec 0143/0144 E) — the digest
 *    leaks spec ids, statuses and branch names, which is project data;
 *  - unknown or static panel ⇒ 400, so a typo shows up instead of silently
 *    polling forever against nothing;
 *  - `no-store`, because a cached digest is a digest that never changes.
 *
 * It loads through the SAME functions the panels render from, so the digest
 * cannot drift from what the user sees.
 */
import { listBranchesForProject, projectBySlug } from "@launchpad/db";
import { getDb } from "../../../../../lib/db";
import { isProjectMember } from "../../../../auth";
import { listRunningSpecIds } from "../../../../../lib/pipeline";
import { loadRuns } from "../../../../../lib/next-step-load";
import { loadSpecsForPanel } from "../../../../projects/[id]/specs-tab";
import {
  branchesDigest,
  isLivePanel,
  runsDigest,
  specsDigest,
} from "../../../../../lib/panel-digest";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: slug } = await params;
  const panel = new URL(request.url).searchParams.get("panel") ?? "";
  if (!isLivePanel(panel)) {
    return Response.json({ error: "unknown panel" }, { status: 400 });
  }
  const project = await projectBySlug(getDb(), slug).catch(() => null);
  if (!project) return Response.json({ error: "not found" }, { status: 404 });
  if (!(await isProjectMember(project.id))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  let digest = "";
  try {
    if (panel === "specs") {
      const [specs, running] = await Promise.all([
        loadSpecsForPanel(slug, project.id),
        listRunningSpecIds(slug),
      ]);
      digest = specsDigest(specs, running);
    } else if (panel === "ramas") {
      digest = branchesDigest(await listBranchesForProject(getDb(), project.id));
    } else {
      // overview + agentes both render the run projection.
      digest = runsDigest(await loadRuns(project.id));
    }
  } catch {
    // A loader failure must not make the panel look changed — an unchanged
    // digest means "no refresh", which is the safe direction. The panel itself
    // will report the outage when the user next loads it.
    return Response.json({ digest: null }, { headers: { "cache-control": "no-store" } });
  }
  return Response.json({ digest }, { headers: { "cache-control": "no-store" } });
}
