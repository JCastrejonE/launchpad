/**
 * The **Agentes** panel (spec 0157).
 *
 * One route segment, one panel, so the per-run Temporal queries happen only when the run cards are on screen. Before this it was a branch inside a
 * client component that received every panel's data at once.
 */
import { requireProject } from "../require-project";
import { ActionErrorBanner, Agentes } from "../panels";
import { currentRole } from "../../../auth";
import { capabilityDenial } from "../../../../lib/capabilities";
import { loadRuns, withGateActions } from "../../../../lib/next-step-load";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const project = await requireProject(id);
  const runs = await withGateActions(await loadRuns(project.projectId), project.id);
  return (
    <>
      {error ? <ActionErrorBanner message={error} /> : null}
      <Agentes
        runs={runs}
        projectId={project.projectId}
        projectSlug={project.id}
        promoteDenial={capabilityDenial(await currentRole(), "promote")}
      />
    </>
  );
}
