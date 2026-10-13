"use client";

/**
 * The workspace shell: header, tab rail, error banner, live-poll wiring
 * (spec 0157).
 *
 * The tabs are `<Link>`s now, not `onClick` handlers. That is the whole point of
 * making the panel a route segment: the URL is the selector, so the server knows
 * which panel it is rendering and builds only that panel's data. Before, the tab
 * was `useState` mirrored into `?tab=` with `replaceState` (spec 0143) — a URL
 * the server never saw, which is why every request rendered all eleven panels
 * including the one that SSHes into a VPS.
 *
 * Client, for three small reasons only: `usePathname` to mark the active tab,
 * the dismissible banner's local state, and `PanelLive`'s interval. All the data
 * comes from the server layout above it.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquare, Globe } from "lucide-react";
import { TopBar, StatusPill } from "@/components/ui";
import type { ProjectView } from "@/lib/project-view";
import type { ChromeUser } from "@/lib/chrome-user";
import { PanelLive } from "@/components/PanelLive";
import { TABS } from "./panels";

export function WorkspaceChrome({
  project,
  user,
  children,
}: {
  project: ProjectView;
  user: ChromeUser | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const base = `/projects/${project.id}`;
  // `/projects/<slug>/<panel>` → the panel. A deeper path (a spec detail) keeps
  // the rail highlighted on its panel but must NOT start a second poller — the
  // detail page runs its own.
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).split("/").filter(Boolean) : [];
  const panel = rest[0] ?? "overview";
  const isPanelRoot = rest.length === 1;

  return (
    <div className="min-h-screen">
      <TopBar crumbs={[{ label: "Proyectos", href: "/" }, { label: project.name }]} user={user} />
      {isPanelRoot ? <PanelLive projectSlug={project.id} panel={panel} /> : null}

      {/* Project header */}
      <div className="border-b border-border bg-surface/40">
        <div className="mx-auto max-w-[1400px] px-5 py-5">
          <div className="flex flex-wrap items-center gap-4">
            <span
              className="grid h-12 w-12 place-items-center rounded-lg border text-xl font-bold"
              style={{ color: project.accent, borderColor: project.accent + "44", background: project.accent + "12" }}
            >
              {project.name[0]}
            </span>
            <div className="mr-auto">
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-semibold text-foreground">{project.name}</h1>
                <StatusPill status={project.health} live={project.health === "building"} />
              </div>
              <div className="mt-1 flex items-center gap-3 text-xs text-muted">
                <a className="flex items-center gap-1 hover:text-foreground" href={`https://${project.domain}`} target="_blank" rel="noreferrer">
                  <Globe className="h-3 w-3" /> {project.domain}
                </a>
                <span className="text-faint">·</span>
                <span>{project.version}</span>
                <span className="text-faint">·</span>
                <span>último deploy {project.lastDeploy}</span>
              </div>
            </div>
            {/* Spec 0137: "Nuevo chat" opens the Chats panel — a real link now. */}
            <Link
              href={`${base}/chats`}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-brand/50 bg-brand/15 px-3.5 py-2 text-[13px] font-medium text-brand transition-colors hover:bg-brand/25"
            >
              <MessageSquare className="h-4 w-4" /> Nuevo chat
            </Link>
          </div>
        </div>
      </div>

      <div className="mx-auto flex max-w-[1400px] gap-0 px-5">
        {/* Sidebar tabs */}
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-52 shrink-0 border-r border-border py-6 pr-4 md:block">
          <nav className="space-y-1">
            {TABS.map((t) => (
              <Link
                key={t.id}
                href={`${base}/${t.id}`}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-colors ${
                  panel === t.id ? "bg-brand/10 text-brand" : "text-muted hover:bg-card-hover hover:text-foreground"
                }`}
              >
                <t.icon className="h-4 w-4" />
                {t.label}
                {t.id === "chats" && project.openChats > 0 && (
                  <span className="ml-auto rounded bg-surface px-1.5 text-[10px] text-faint">{project.openChats}</span>
                )}
                {t.id === "agentes" && project.activeAgents > 0 && (
                  <span className="ml-auto h-1.5 w-1.5 rounded-full bg-cyan mc-live-dot" />
                )}
              </Link>
            ))}
          </nav>
        </aside>

        {/* Mobile tab scroller */}
        <div className="md:hidden fixed bottom-0 left-0 right-0 z-30 flex gap-1 overflow-x-auto border-t border-border bg-background/95 p-2 backdrop-blur">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={`${base}/${t.id}`}
              className={`flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-[10px] ${
                panel === t.id ? "text-brand" : "text-muted"
              }`}
            >
              <t.icon className="h-4 w-4" /> {t.label.split(" ")[0]}
            </Link>
          ))}
        </div>

        {/* Content */}
        <section className="min-w-0 flex-1 py-6 pb-24 md:pl-6">{children}</section>
      </div>
    </div>
  );
}
