/**
 * The **Chats** panel (spec 0157).
 *
 * One route segment, one panel, so the branch list and the chat gate are read only here. Before this it was a branch inside a
 * client component that received every panel's data at once.
 */
import { requireProject } from "../require-project";
import { ActionErrorBanner, Chats } from "../panels";
import { supervisorAccess } from "../../../auth";
import { listBranchesForProject } from "@launchpad/db";
import { getDb } from "../../../../lib/db";

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
  // Spec 0135: the chat gate is scoped to THIS project — a member passes.
  const access = await supervisorAccess({ projectSlug: id });
  // Spec 0135 B: the new-chat picker's options — unmerged branches only.
  let branchNames: string[] = [];
  try {
    branchNames = (await listBranchesForProject(getDb(), project.projectId))
      .filter((b) => !b.mergedAt)
      .map((b) => b.name);
  } catch {
    branchNames = [];
  }
  return (
    <>
      {error ? <ActionErrorBanner message={error} /> : null}
      <Chats projectId={project.projectId} projectSlug={id} chatEnabled={access.ok} branchNames={branchNames} />
    </>
  );
}
