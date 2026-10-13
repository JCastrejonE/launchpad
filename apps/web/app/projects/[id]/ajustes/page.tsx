/**
 * The **Ajustes** panel (spec 0157).
 *
 * One route segment, one panel, so the membership list is read only here. Before this it was a branch inside a
 * client component that received every panel's data at once.
 */
import { requireProject } from "../require-project";
import { ActionErrorBanner, Ajustes } from "../panels";
import { MembersPanel } from "../members-panel";

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
      <Ajustes project={project} membersSlot={<MembersPanel slug={project.id} />} />
    </>
  );
}
