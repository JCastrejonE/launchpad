/**
 * Where `/projects/<slug>` sends you (spec 0157).
 *
 * Pure, because it is the compatibility layer for every link written before the
 * panel became a route segment: bookmarks, the chat's reload target, and every
 * redirect specs 0152/0153 emitted with `?tab=`. Silently dropping someone on
 * Resumen is exactly the tab-drop 0153 fixed, so the old query is honoured on
 * the way through rather than ignored.
 */
/**
 * The panels, in rail order. This list is the ROUTE vocabulary — each id is a
 * directory under `app/projects/[id]/` — and it lives in a plain `.ts` module so
 * the test compiler can read it. `panels.tsx` keys its label+icon table by
 * `PanelId` with a `Record`, so adding a panel here without giving it a label
 * (or vice versa) is a type error rather than a missing tab.
 */
export const PANEL_IDS = [
  "overview",
  "chats",
  "agentes",
  "specs",
  "monitoreo",
  "logs",
  "repo",
  "ramas",
  "versiones",
  "terminal",
  "conexiones",
  "ajustes",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

/** The panel shown when none is named — the workspace's front page. */
export const DEFAULT_PANEL: PanelId = "overview";

export function isPanel(value: string | undefined): value is PanelId {
  return (PANEL_IDS as readonly string[]).includes(value ?? "");
}

export function panelRedirectPath(
  slug: string,
  query: { tab?: string; error?: string; chat?: string } = {},
): string {
  const panel = isPanel(query.tab) ? query.tab : DEFAULT_PANEL;
  const search = new URLSearchParams();
  if (query.error) search.set("error", query.error);
  // Spec 0144 C: the open chat thread lives in the URL too — carry it, or a
  // reload lands on a blank chat.
  if (query.chat) search.set("chat", query.chat);
  const qs = search.toString();
  return `/projects/${slug}/${panel}${qs ? `?${qs}` : ""}`;
}
