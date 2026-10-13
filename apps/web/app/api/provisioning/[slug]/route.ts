/**
 * Run-follow route for the odoo-next provisioning workflow (spec 0161 F3).
 *
 * GET only, no side effects: reads `provisioningPhase` + `provisioningFailedPhase`
 * + the execution status for `provision-<slug>` via `getProvisioningRunState`,
 * which degrades to `null` when Temporal is unreachable (the run-follow posture).
 *
 * Membership-gated exactly like the workspace and the live-digest route
 * (spec 0143/0144 E): the state leaks a project's provisioning progress, which
 * is project data — a non-member gets the same 404 as an unknown slug.
 */
import { projectBySlug } from "@launchpad/db";
import { getDb } from "../../../../lib/db";
import { isProjectMember } from "../../../auth";
import { getProvisioningRunState } from "../../../../lib/provisioning-follow";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const project = await projectBySlug(getDb(), slug).catch(() => null);
  if (!project) return Response.json({ error: "not found" }, { status: 404 });
  if (!(await isProjectMember(project.id))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json(await getProvisioningRunState(slug), {
    headers: { "cache-control": "no-store" },
  });
}
