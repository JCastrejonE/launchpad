/**
 * The **Specs** panel (spec 0157).
 *
 * One route segment, one panel, so the specs directory and the RUNNING-workflow query are read only here. Before this it was a branch inside a
 * client component that received every panel's data at once.
 */
import { requireProject } from "../require-project";
import { ActionErrorBanner } from "../panels";
import { SpecsTab } from "../specs-tab";

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

  return (
    <>
      {error ? <ActionErrorBanner message={error} /> : null}
      <SpecsTab projectSlug={project.id} projectId={project.projectId} />
    </>
  );
}
