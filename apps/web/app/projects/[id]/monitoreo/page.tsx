/**
 * The **Monitoreo** panel (spec 0157).
 *
 * One route segment, one panel, which needs nothing beyond the project row. Before this it was a branch inside a
 * client component that received every panel's data at once.
 */
import { requireProject } from "../require-project";
import { ActionErrorBanner, Monitoreo } from "../panels";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  // Membership gate, not data: since spec 0214 the panel needs nothing from the row.
  await requireProject(id);

  return (
    <>
      {error ? <ActionErrorBanner message={error} /> : null}
      <Monitoreo />
    </>
  );
}
