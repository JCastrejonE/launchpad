/**
 * The project workspace shell (spec 0157).
 *
 * A LAYOUT, so it renders once and stays mounted while you move between panels:
 * the header, the tab rail and the error banner do not re-render when the panel
 * changes, and neither does the chat's client runtime when you navigate away and
 * back within the same segment.
 *
 * It resolves the project through `requireProject`, which also enforces
 * membership (spec 0143) — but a layout does NOT gate its children in the App
 * Router (both render for the same request), so every panel page calls the same
 * function itself. One function, so the chrome and its contents can never
 * disagree about who may see this project.
 */
import { sessionChromeUser } from "../../chrome-user";
import { WorkspaceChrome } from "./WorkspaceChrome";
import { requireProject } from "./require-project";

export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id } = await params;
  // Spec 0152's error banner is NOT here: a layout receives no `searchParams`,
  // so each panel page renders `ActionErrorBanner` from its own `?error=`.
  const [project, user] = await Promise.all([requireProject(id), sessionChromeUser()]);
  return (
    <WorkspaceChrome project={project} user={user}>
      {children}
    </WorkspaceChrome>
  );
}
