"use client"

import { useState } from "react"
import Link from "next/link"
import { motion, AnimatePresence } from "framer-motion"
import {
  Plus, Sparkles, Cable, Boxes, Cpu, MessageSquare, Activity,
  Server, Search, ArrowUpRight, Bot, Wand2, X,
} from "lucide-react"
import { INTEGRATIONS } from "@/lib/mock-data"
import { UNKNOWN } from "@/lib/project-view"
import type { ProjectView } from "@/lib/project-view"
import { chromeDisplayName, type ChromeUser } from "@/lib/chrome-user"
import { TopBar, Card, Label, Dot, StatusPill, Btn } from "@/components/ui"

const KIND_LABEL: Record<string, string> = {
  platform: "Plataforma",
  odoo: "Odoo simple",
  "odoo-next": "Odoo + Next",
  custom: "A medida",
}

/** Live fleet counts, or an explicit "could not ask" (spec 0085). Kept as a
 * discriminated union so the UI cannot accidentally render an unreachable
 * Hostinger API as a fleet of zero hosts. */
export type FleetStat = { available: false } | { available: true; total: number; running: number };

/** Client half of the Launchpad (spec 0084, C.4a). `projects` are real rows
 * adapted by `lib/project-view.ts`; the server half (`page.tsx`) reads them,
 * plus the live fleet counts (spec 0085, C.4b). */
export function Launchpad({
  projects,
  fleet,
  user,
}: {
  projects: ProjectView[]
  fleet: FleetStat
  user: ChromeUser | null
}) {
  // Signed out ⇒ null ⇒ we greet with no name at all, never a placeholder
  // person (spec 0209).
  const greetingName = chromeDisplayName(user)
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState("")

  const filtered = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.client.toLowerCase().includes(query.toLowerCase())
  )

  // Real: summed from the same rows the grid renders (0 for every project
  // until Phase D's agent_runs projection writer exists — the truth, not a
  // placeholder). The other three strip stats have no source yet and render
  // UNKNOWN rather than the mockup's invented 99.4% / 12 deploys.
  const runningAgents = projects.reduce((n, p) => n + p.activeAgents, 0)

  return (
    <div className="min-h-screen mc-grid-bg">
      <TopBar user={user} />

      <main className="mx-auto max-w-[1400px] px-5 pb-24 pt-8">
        {/* Hero row */}
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.25em] text-brand">
              <span className="mc-live-dot">●</span> Launchpad maestro
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
              {greetingName ? `Buenos días, ${greetingName}` : "Buenos días"}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {projects.length} proyectos orquestados · {runningAgents} agentes trabajando
            </p>
          </motion.div>

          {/* Add project */}
          <div className="relative">
            <Btn variant="primary" onClick={() => setMenuOpen((v) => !v)} className="px-4 py-2.5">
              <Plus className="h-4 w-4" /> Agregar proyecto
            </Btn>
            <AnimatePresence>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <motion.div
                    initial={{ opacity: 0, y: 6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 6, scale: 0.98 }}
                    transition={{ duration: 0.15 }}
                    className="absolute right-0 z-50 mt-2 w-[340px] overflow-hidden rounded-xl border border-border-strong bg-card shadow-2xl"
                  >
                    <Link href="/new" className="group flex gap-3 border-b border-border p-4 hover:bg-card-hover">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-brand/40 bg-brand/10">
                        <Wand2 className="h-5 w-5 text-brand" />
                      </span>
                      <div>
                        <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                          Nuevo proyecto <span className="rounded bg-brand/15 px-1.5 py-0.5 text-[9px] text-brand">MAGIA</span>
                        </p>
                        <p className="mt-0.5 text-xs text-muted">
                          Arranca de cero con un botón: VPS, dominio, Odoo, módulos y correo configurados por agentes.
                        </p>
                      </div>
                    </Link>
                    <Link href="/connect" className="group flex gap-3 p-4 hover:bg-card-hover">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-cyan/40 bg-cyan/10">
                        <Cable className="h-5 w-5 text-cyan" />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-foreground">Armar proyecto</p>
                        <p className="mt-0.5 text-xs text-muted">
                          Conecta algo que ya existe: elige una VPS, ancla un repo de GitHub, Neon y Vercel.
                        </p>
                      </div>
                    </Link>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Fleet strip */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.05 }}
          className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4"
        >
          {/* Only stats the control plane can actually answer are numbers.
              Projects + agents are real (agents stay 0 until Phase D's
              agent_runs writer); the fleet is live from Hostinger (spec 0085)
              and shows UNKNOWN when the API cannot be reached; "Salud global"
              still needs Grafana (Phase F). None of the mockup's invented
              99.4% / 12-deploys literals survive. */}
          <Stat icon={Boxes} accent="text-brand" label="Proyectos" value={String(projects.length)} sub="en el control plane" />
          <Stat icon={Bot} accent="text-cyan" label="Agentes activos" value={String(runningAgents)} sub="en Temporal" />
          <Stat
            icon={Server}
            accent="text-purple"
            label="Flotilla VPS"
            value={fleet.available ? String(fleet.total) : UNKNOWN}
            sub={fleet.available ? `${fleet.running} encendidas` : "Hostinger no disponible"}
          />
          <Stat icon={Activity} accent="text-amber" label="Salud global" value={UNKNOWN} sub="pendiente Grafana" />
        </motion.div>

        {/* Projects grid */}
        <div className="mt-10 flex items-center justify-between">
          <Label>Proyectos</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar proyecto o cliente…"
              className="w-56 rounded-lg border border-border bg-surface py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-faint outline-none focus:border-brand/40"
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p, i) => (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.05 * i }}
            >
              <Link href={`/projects/${p.id}`}>
                <Card hover className="group relative h-full overflow-hidden p-0">
                  {p.kind === "platform" && (
                    <div className="absolute right-0 top-0 rounded-bl-lg border-b border-l border-brand/30 bg-brand/10 px-2 py-1 text-[9px] uppercase tracking-widest text-brand">
                      Se automejora
                    </div>
                  )}
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <span
                          className="grid h-11 w-11 place-items-center rounded-lg border text-lg font-bold"
                          style={{ color: p.accent, borderColor: p.accent + "44", background: p.accent + "12" }}
                        >
                          {p.name[0]}
                        </span>
                        <div>
                          <p className="font-semibold leading-tight text-foreground group-hover:text-white">{p.name}</p>
                          <p className="text-xs text-muted">{p.client}</p>
                        </div>
                      </div>
                      <ArrowUpRight className="h-4 w-4 text-faint transition-colors group-hover:text-brand" />
                    </div>

                    <p className="mt-3.5 line-clamp-2 h-9 text-xs leading-relaxed text-muted">{p.description}</p>

                    <div className="mt-3 flex flex-wrap gap-1.5">
                      <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-muted">
                        {KIND_LABEL[p.kind]}
                      </span>
                      {p.stack.slice(0, 2).map((s) => (
                        <span key={s} className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-faint">
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-t border-border px-5 py-3 text-[11px]">
                    <StatusPill status={p.health} live={p.health === "building"} />
                    <div className="flex items-center gap-3 text-faint">
                      {p.activeAgents > 0 && (
                        <span className="flex items-center gap-1 text-cyan">
                          <Cpu className="h-3 w-3" /> {p.activeAgents}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <MessageSquare className="h-3 w-3" /> {p.openChats}
                      </span>
                      <span className="hidden sm:inline">{p.version}</span>
                    </div>
                  </div>
                </Card>
              </Link>
            </motion.div>
          ))}

          {/* New project tile */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: 0.05 * filtered.length }}
          >
            <Link href="/new">
              <div className="group flex h-full min-h-[200px] flex-col items-center justify-center rounded-xl border border-dashed border-border-strong bg-transparent p-5 text-center transition-colors hover:border-brand/50 hover:bg-brand/[0.03]">
                <span className="grid h-12 w-12 place-items-center rounded-full border border-border-strong bg-surface transition-colors group-hover:border-brand/50">
                  <Sparkles className="h-5 w-5 text-brand" />
                </span>
                <p className="mt-3 text-sm font-medium text-foreground">Crear con Magia</p>
                <p className="mt-1 text-xs text-muted">Un botón: del negocio al Odoo en producción.</p>
              </div>
            </Link>
          </motion.div>
        </div>

        {/* Two-column: live agents + integrations */}
        <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <Label>Agentes en vivo · Temporal</Label>
            {/* Honest empty state: nothing writes `agent_runs` until Phase D's
                projection writer, so there are no live runs to list. The
                mockup's five sample runs are gone rather than shown as real. */}
            <Card className="p-8 text-center text-sm text-muted">
              Sin agentes corriendo.
              <span className="mt-1 block text-xs text-faint">
                La proyección de workflows de Temporal llega en la fase D.
              </span>
            </Card>
          </div>

          <div>
            <Label>Conexiones · APIs</Label>
            <Card className="grid grid-cols-2 gap-px overflow-hidden bg-border sm:grid-cols-3">
              {INTEGRATIONS.map((it) => (
                <div key={it.id} className="flex items-center gap-2 bg-card p-3">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      background:
                        it.status === "connected" ? "var(--color-brand)" : it.status === "action-needed" ? "var(--color-amber)" : "var(--color-faint)",
                    }}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-[12px] text-foreground">{it.name}</p>
                    <p className="truncate text-[10px] text-faint">{it.detail}</p>
                  </div>
                </div>
              ))}
            </Card>
          </div>
        </div>
      </main>
    </div>
  )
}

// ── SIGUIENTE PASO · cross-project (spec 0107 item 3) ────────────────────────
// The DERIVED next step (lib/next-step.ts) for every spec that needs a PERSON —
// a gate to approve or a pending (human) item — across ALL projects. Computed on
// read, stored nowhere; page.tsx filters to those kinds and tags each row with
// its project. This is the one genuinely cross-project view the IA wants: open
// the app cold and see what needs you, everywhere, first. Each row links into

function Stat({ icon: Icon, accent, label, value, sub }: any) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-widest text-faint">{label}</span>
        <Icon className={`h-4 w-4 ${accent}`} />
      </div>
      <p className={`mt-2 text-2xl font-semibold ${accent}`}>{value}</p>
      <p className="text-[11px] text-muted">{sub}</p>
    </Card>
  )
}

function AgentBadge({ status }: { status: string }) {
  const map: Record<string, { t: string; c: string }> = {
    running: { t: "corriendo", c: "text-cyan border-cyan/30 bg-cyan/10" },
    queued: { t: "en cola", c: "text-muted border-border bg-surface" },
    completed: { t: "completado", c: "text-brand border-brand/30 bg-brand/10" },
    failed: { t: "falló", c: "text-rose border-rose/30 bg-rose/10" },
    "waiting-approval": { t: "aprobar", c: "text-amber border-amber/30 bg-amber/10" },
  }
  const m = map[status] ?? map.queued!
  return <span className={`shrink-0 rounded border px-2 py-0.5 text-[10px] ${m.c}`}>{m.t}</span>
}
