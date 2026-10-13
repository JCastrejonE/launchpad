/**
 * `/projects/<slug>` — the workspace's front door (spec 0157).
 *
 * The panel is a route segment now, so this redirects to the default one rather
 * than rendering a workspace that has to decide for itself. `?tab=` from the old
 * client-state world is honoured on the way through: bookmarks, the chat's
 * reload target and every pre-0157 redirect used it, and silently dropping
 * someone on Resumen is exactly the tab-drop spec 0153 just fixed.
 */
import { redirect } from "next/navigation";
import { panelRedirectPath } from "../../../lib/panel-route";

export default async function ProjectIndex({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; error?: string; chat?: string }>;
}) {
  const { id } = await params;
  redirect(panelRedirectPath(id, await searchParams));
}
