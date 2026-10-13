/**
 * The **Resumen** panel (spec 0157).
 *
 * One route segment, one panel, so the run projection and the fleet are built only when you are looking at them. Before this it was a branch inside a
 * client component that received every panel's data at once.
 */
import { requireProject } from "../require-project";
import { ActionErrorBanner, Overview } from "../panels";
import { currentRole } from "../../../auth";
import { capabilityDenial } from "../../../../lib/capabilities";
import { loadRuns, withGateActions, loadLatestRecap, loadPendingQuestion } from "../../../../lib/next-step-load";
import { listSpecs } from "../../../../lib/specs";
import { specsForProject } from "../../../../lib/spec-project";
import { FleetSection } from "../../../../components/hangar/FleetSection";

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
  const latestRecap = await loadLatestRecap(
    runs,
    specsForProject(await listSpecs(), project.id),
    await loadPendingQuestion(project.projectId),
  );
  // Spec 0085: the VPS fleet is a PLATFORM concern, so only its workspace gets
  // it — and now only on the panel that shows it.
  const fleetSlot = project.kind === "platform" ? <FleetSection /> : null;
  return (
    <>
      {error ? <ActionErrorBanner message={error} /> : null}
      <Overview
        project={project}
        vps={undefined}
        runs={runs}
        latestRecap={latestRecap}
        projectId={project.projectId}
        promoteDenial={capabilityDenial(await currentRole(), "promote")}
        fleetSlot={fleetSlot}
      />
    </>
  );
}
