/**
 * Resolve a project and enforce membership — the two checks every workspace
 * route needs (spec 0157).
 *
 * Its own module, not the layout's export: in the App Router a layout and its
 * page render for the SAME request, so a layout cannot gate its children. Every
 * panel page calls this itself, and having one function means none of them can
 * gate differently from the chrome around it.
 */
import { notFound } from "next/navigation";
import { projectBySlug, projectCounts } from "@launchpad/db";
import { getDb } from "../../../lib/db";
import { isProjectMember } from "../../auth";
import { toProjectView, type ProjectView } from "../../../lib/project-view";

export async function loadProject(slug: string): Promise<ProjectView | null> {
  try {
    const db = getDb();
    const row = await projectBySlug(db, slug);
    if (!row) return null;
    const counts = await projectCounts(db);
    return toProjectView(row, counts.get(row.id));
  } catch {
    return null;
  }
}

/**
 * Resolve the project AND enforce membership, for a panel page.
 *
 * Every panel calls this rather than trusting the layout: a layout does not gate
 * its children in the App Router — both run for the same request — so a page
 * that skipped the check would serve its data to a non-member even though the
 * chrome around it refused.
 */
export async function requireProject(slug: string): Promise<ProjectView> {
  const project = await loadProject(slug);
  if (!project) notFound();
  if (!(await isProjectMember(project.projectId))) notFound();
  return project;
}

