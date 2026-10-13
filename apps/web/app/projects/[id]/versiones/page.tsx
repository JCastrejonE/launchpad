/**
 * The **Versiones** route segment (spec 0157's one-panel-one-route, spec 0170's
 * content).
 *
 * Membership-gated like every other panel via `requireProject`: a layout does not
 * gate its children in the App Router, so each page asks for itself.
 */
import { requireProject } from "../require-project";
import { ActionErrorBanner } from "../panels";
import { ReleasesPanel } from "./releases-panel";

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
      <ReleasesPanel slug={project.id} />
    </>
  );
}
