"use client"

/**
 * The workspace PANELS (spec 0157).
 *
 * This file used to also own the shell and the tab state — one client component
 * that received every panel's data as props, so the server had to build all of
 * it on every request no matter which tab you were on. The panel is a route
 * segment now (`/projects/<slug>/<panel>`), so each panel's page loads only its
 * own data and renders only its own body from here. The shell lives in
 * `layout.tsx` + `WorkspaceChrome.tsx`.
 *
 * Panels whose data has no backing yet render from the adapter's honest empties
 * (`branches: []`, `metrics: []`, …) rather than mock rows.
 */

import { useActionState, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import dynamic from "next/dynamic"
import {
  LayoutDashboard, MessageSquare, Bot, GitBranch, TerminalSquare, Cable,
  Rocket,
  Settings, Cpu, Boxes, Database, Globe, Shield, Server, Plus, Send,
  GitCommitHorizontal, RotateCcw, CheckCircle2, CircleDot,
  ShieldCheck, HardDrive, Package, Sparkles, ChevronRight, Activity,
  ScrollText, ExternalLink, Filter, FileText,
} from "lucide-react"
import { integrationById } from "@/lib/mock-data"
import { PANEL_IDS, type PanelId } from "@/lib/panel-route"
import type { ProjectView } from "@/lib/project-view"
import type { ProjectLogsResult } from "@/lib/fleet"
import type { AgentRunView } from "@/lib/agent-run-view"
import { UNKNOWN } from "@/lib/project-view"
import { Card, Label, StatusPill, Dot, Btn } from "@/components/ui"
import { GATE_ACTION_LABEL, type GateSignal } from "@/lib/gate-actions"
import type { Gate3Evidence } from "@/lib/gate3-evidence"
import type { StagingView } from "@/lib/staging-view"
import type { RunRecap } from "@/lib/run-recap"
import { phaseLabel, PLATFORM_DEPLOY_HINT } from "@/lib/run-follow-card"
import { PLATFORM_PROJECT_SLUG } from "@/lib/spec-project"
import { linkProjectRepoAction, mergeGatePrAction, signalGateAction, startSpecRunAction } from "./actions"

// Lazy: the chat pulls in @assistant-ui/react, and "Chats · sdd" is one of ten
// tabs (the default is Resumen) — importing it eagerly put ~110 kB of chat
// runtime in the first load of every workspace visit. Client-only anyway, so
// there is no SSR to lose.
const ForgeChat = dynamic(() => import("@/components/forge/ForgeChat").then((m) => m.ForgeChat), {
  ssr: false,
  loading: () => <Card className="p-8 text-center text-sm text-muted">Cargando chat…</Card>,
})

/** Spec 0157: the ids are the ROUTE segments, defined once in `lib/panel-route`.
 * A `Record` keyed by `PanelId` means a panel cannot gain a route without a
 * label, or a label without a route — the compiler enforces both directions. */
export type Tab = PanelId

const PANEL_META: Record<PanelId, { label: string; icon: any }> = {
  overview: { label: "Resumen", icon: LayoutDashboard },
  chats: { label: "Chats", icon: MessageSquare },
  agentes: { label: "Agentes", icon: Bot },
  // Spec 0122: the owner asked for Specs "on the left" — this rail is the only left nav.
  specs: { label: "Specs", icon: FileText },
  monitoreo: { label: "Monitoreo", icon: Activity },
  logs: { label: "Logs", icon: ScrollText },
  repo: { label: "Repositorio", icon: GitBranch },
  ramas: { label: "Ramas & Builds", icon: Boxes },
  // Spec 0170: shipping is a different decision from merging, so it gets its own
  // surface rather than a button buried in another panel.
  versiones: { label: "Versiones", icon: Rocket },
  terminal: { label: "Terminal", icon: TerminalSquare },
  conexiones: { label: "Conexiones", icon: Cable },
  ajustes: { label: "Ajustes", icon: Settings },
}

export const TABS = PANEL_IDS.map((id) => ({ id, ...PANEL_META[id] }))

// ── OVERVIEW ───────────────────────────────────────────────────────────────
export function Overview({ project, vps, runs, latestRecap, projectId, promoteDenial, fleetSlot }: any) {
  return (
    <div className="space-y-6">
      {/* Spec 0112: recap FIRST. A cold open asks "what happened and what needs
          me" — that is the recap. The per-spec next-step list below it is
          reference, and on the platform project it runs to ~100 rows, which
          buried the recap entirely when it came second. */}
      {latestRecap && <RecapCard specId={latestRecap.specId} title={latestRecap.title} recap={latestRecap.recap} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {project.metrics.map((m: any) => (
          <Card key={m.label} className="p-4">
            <p className="text-[11px] uppercase tracking-widest text-faint">{m.label}</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">{m.value}</p>
            {m.sub && <p className="text-[11px] text-muted">{m.sub}</p>}
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div>
            <Label>Actividad de agentes</Label>
            {runs.length === 0 ? (
              <Card className="p-6 text-center text-sm text-muted">Sin agentes trabajando ahora mismo.</Card>
            ) : (
              <Card className="divide-y divide-border">
                {runs.map((a: any) => (
                  <div key={a.id} className="p-4">
                    <div className="flex items-center gap-2">
                      <Bot className="h-4 w-4 text-cyan" />
                      <p className="text-[13px] text-foreground">{a.task}</p>
                      <span className="ml-auto text-[11px] text-faint">{a.started}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface">
                        <div className="h-full rounded-full bg-cyan" style={{ width: `${a.progress}%` }} />
                      </div>
                      <span className="text-[11px] text-muted">{a.phase}</span>
                    </div>
                  </div>
                ))}
              </Card>
            )}
          </div>

          <div>
            <Label>Ramas</Label>
            <Card className="divide-y divide-border">
              {project.branches.map((b: any) => (
                <BranchRow key={b.name} b={b} />
              ))}
            </Card>
          </div>
        </div>

        <div className="space-y-6">
          {/* Spec 0085 (C.4b): the real VPS fleet, server-rendered upstream and
              passed in as a slot. Platform project only — SPEC §6.4 puts infra
              in Resumen, and the fleet is a platform-level concern. */}
          {fleetSlot}

          {vps && (
            <div>
              <Label>Infraestructura</Label>
              <Card className="p-4">
                <div className="flex items-center gap-2">
                  <Server className="h-4 w-4 text-purple" />
                  <span className="text-sm text-foreground">{vps.label}</span>
                  <span className="ml-auto text-[11px] text-faint">{vps.plan}</span>
                </div>
                <p className="mt-1 text-[11px] text-muted">Hostinger · {vps.region} · {vps.ip}</p>
                <div className="mt-4 space-y-2.5">
                  <Meter label="CPU" value={vps.cpu} />
                  <Meter label="RAM" value={vps.ram} />
                  <Meter label="Disco" value={vps.disk} />
                </div>
                <div className="mt-4 flex items-center gap-2 border-t border-border pt-3 text-[11px] text-muted">
                  {vps.docker ? <ShieldCheck className="h-3.5 w-3.5 text-brand" /> : <HardDrive className="h-3.5 w-3.5" />}
                  {vps.docker ? "Docker instalado · Odoo en contenedor" : "Sin Docker"}
                </div>
              </Card>
            </div>
          )}

          <div>
            <Label>Stack</Label>
            <Card className="flex flex-wrap gap-2 p-4">
              {project.stack.map((s: string) => (
                <span key={s} className="rounded border border-border bg-surface px-2 py-1 text-[11px] text-muted">{s}</span>
              ))}
            </Card>
          </div>

          <div>
            <Label>Acceso rápido</Label>
            <Card className="divide-y divide-border">
              {[
                { icon: Globe, t: "Abrir sitio en vivo" },
                { icon: Shield, t: "Reglas Cloudflare (WAF)" },
                { icon: Database, t: "Consola Neon Postgres" },
                { icon: GitBranch, t: "Abrir en GitHub" },
              ].map((x) => (
                <button key={x.t} className="flex w-full items-center gap-2.5 p-3 text-left text-[13px] text-muted hover:bg-card-hover hover:text-foreground">
                  <x.icon className="h-4 w-4" /> {x.t} <ChevronRight className="ml-auto h-3.5 w-3.5 text-faint" />
                </button>
              ))}
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── SIGUIENTE PASO (spec 0107) ───────────────────────────────────────────────
// The DERIVED next action per spec (lib/next-step.ts) — a pure function of state
// already true, computed on read and stored nowhere. One row per spec; Start (a
// draft with no run) and the gate buttons (a run parked at a gate) act inline
// through the existing workspace server actions, so a cold open lands on exactly
// what to do next. page.tsx already floats actionable rows above the done ones.

/** Spec 0112: the four-part recap for the most recently active spec. Every line is
 * prose an agent already wrote into the `## Handoff log` — nothing here is
 * generated.
 *
 * Spec 0122 removed the "requiere tu atención" line (the owner's call for the v0 UI): it
 * duplicated what the Agentes tab's gate buttons already say, in a place you could
 * not act on it. `recap.needsYou` is still computed by `deriveNextStep`; it simply
 * is not rendered here. */
function RecapCard({
  specId,
  title,
  recap,
}: {
  specId: string;
  title: string;
  recap: RunRecap;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Label>Resumen de actividad</Label>
        <span className="ml-auto font-mono text-[10px] text-faint">spec {specId}</span>
      </div>
      <Card className="p-4">
        <p className="truncate text-[13px] text-foreground">{title}</p>
        {recap.empty ? (
          <p className="mt-2 text-[12px] text-muted">
            Sin entradas en el historial todavía.
          </p>
        ) : (
          <div className="mt-3 space-y-3 text-[12px]">
            {recap.did.length > 0 && (
              <RecapSection label="Se hizo" items={recap.did} />
            )}
            {recap.found.length > 0 && (
              <RecapSection label="Hallazgos" items={recap.found} accent="text-amber" />
            )}
            {recap.next && (
              <p className="text-muted">
                <span className="text-faint">Siguiente (según el último agente) · </span>
                <span className="text-foreground">{recap.next}</span>
              </p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function RecapSection({
  label,
  items,
  accent = "text-muted",
}: {
  label: string;
  items: string[];
  accent?: string;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.2em] text-faint">{label}</p>
      <ul className="mt-1 space-y-1">
        {items.map((t, i) => (
          <li key={i} className={`flex gap-2 ${accent}`}>
            <span className="text-faint">·</span>
            <span className="min-w-0">{t.replace(/\*\*/g, "")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}


function Meter({ label, value }: { label: string; value: number }) {
  const color = value > 85 ? "bg-rose" : value > 65 ? "bg-amber" : "bg-brand"
  return (
    <div>
      <div className="flex justify-between text-[11px]"><span className="text-muted">{label}</span><span className="text-faint">{value}%</span></div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface"><div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} /></div>
    </div>
  )
}

function BranchRow({ b }: { b: any }) {
  const kindColor = b.kind === "production" ? "text-brand" : b.kind === "staging" ? "text-cyan" : "text-muted"
  return (
    <div className="flex items-center gap-3 p-3.5">
      <GitBranch className={`h-4 w-4 ${kindColor}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] text-foreground">{b.name}</span>
          <span className={`rounded border border-border bg-surface px-1.5 py-0.5 text-[9px] uppercase ${kindColor}`}>{b.kind}</span>
          {b.db === "neutralizada" && (
            <span className="rounded border border-amber/30 bg-amber/10 px-1.5 py-0.5 text-[9px] text-amber">DB neutralizada</span>
          )}
        </div>
        <p className="truncate text-[11px] text-faint">
          <GitCommitHorizontal className="mr-1 inline h-3 w-3" />{b.commit} · {b.message} · {b.author}
        </p>
      </div>
      <div className="text-right">
        <StatusPill status={b.status} live={b.status === "building"} />
        <p className="text-[10px] text-faint">{b.updated}</p>
      </div>
    </div>
  )
}

// ── CHATS · sdd (spec 0081, C.2) ────────────────────────────────────────────
// The REAL Forge chat (assistant-ui over the /api/supervisor SSE bridge, spec
// 0067), scoped to this project. Replaces the mockup's thread-list/chat-pane/
// specs-panel markup, which is deleted along with the helpers only it used
// (SPEC_STATUS, SPEC_STATE, SpecRow, SpecModal, Msg) — orphans of this change.
// The tab's spec panel + .md viewer (SPEC §6.4) return in C.4 wired to real
// SpecFile rows; the real spec reader lives at /forge/specs meanwhile.
export function Chats({
  projectId,
  projectSlug,
  chatEnabled,
  branchNames,
}: {
  projectId: string | null
  /** Spec 0224: the URL slug, which the follow card must send with its poll. */
  projectSlug: string
  chatEnabled: boolean
  branchNames?: string[]
  /** Spec 0152: why the last action failed, from `?error=`. Rendered as a
   * dismissible banner — the alternative was what shipped before: a redirect to
   * a 404 with the reason unread in the query string. */
  actionError?: string | null
}) {
  if (!chatEnabled) {
    return (
      <Card className="p-8 text-center text-sm text-muted">
        Necesitas ser miembro de este proyecto (o OWNER) para usar sus chats.
        <span className="mt-1 block text-xs text-faint">
          Requiere además la bandera SUPERVISOR_CONSOLE_ENABLED.
        </span>
      </Card>
    )
  }
  if (!projectId) {
    return (
      <Card className="p-8 text-center text-sm text-muted">
        Este proyecto todavía no existe en el control plane, así que no puede tener hilos propios.
        <span className="mt-1 block text-xs text-faint">
          Los proyectos maquetados se conectan a datos reales en C.4.
        </span>
      </Card>
    )
  }
  // Spec 0137: the specs sidebar is gone — the Specs TAB is the one specs
  // surface, and the chat fills its own tab.
  return <ForgeChat projectId={projectId} projectSlug={projectSlug} branches={branchNames} />
}

// ── AGENTES (Temporal) ──────────────────────────────────────────────────────
// Real gate buttons (spec 0095) replace the mock Pause/Play/RotateCcw controls
// and the do-nothing "Aprobar y continuar"/"Ver diff" block: Temporal has no
// pause, and retry here would mean starting a new run — neither is a real
// capability, so nothing stands in for them. `a.gateActions` is only
// populated while a run is actually parked at a gate; a running/closed run
// renders no buttons. The spec link restores the reachability Phase C lost —
// `/forge/specs` remains the deep pipeline surface for full detail/handoffs.
export function Agentes({
  runs,
  projectId,
  projectSlug,
  promoteDenial,
}: {
  // NOTE: this restates `RunWithGate` (lib/next-step-load.ts) by hand instead of
  // importing it, so every new field has to be added twice. Spec 0207's
  // `gateUnreadable` is the second time that has bitten; left as-is here because
  // deduplicating it is not this fix's job — flagged in PENDING.md.
  runs: (AgentRunView & { specId: string; gateActions: GateSignal[]; gate3?: Gate3Evidence; staging?: StagingView; gateUnreadable?: boolean; canMergeGatePr?: boolean })[]
  projectId: string
  /** Spec 0142 C: workflow ids are namespaced by slug, so the gate form says
   * which project's spec it is signalling. */
  projectSlug: string
  promoteDenial?: string | null
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Label>Orquestador · Temporal</Label>
        <span className="flex items-center gap-1.5 text-[11px] text-cyan"><span className="mc-live-dot">●</span> conectado a wf.example.com</span>
      </div>
      {runs.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">No hay workflows para este proyecto.</Card>
      ) : (
        <div className="space-y-3">
          {runs.map((a) => (
            <Card key={a.id} className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-lg border border-cyan/40 bg-cyan/10 text-cyan"><Bot className="h-4.5 w-4.5" /></span>
                <div className="mr-auto">
                  <p className="text-[13px] text-foreground">{a.task}</p>
                  <p className="text-[11px] text-faint">{a.agent} · {a.workflow} · inició {a.started}</p>
                  {/* Spec 0131 C: the checkout the run actually worked in. A run
                      that fell back to the platform's own repo used to look
                      exactly like a deliberate platform run — this is the line
                      that would have shown it in seconds. */}
                  {a.repoRoot ? (
                    <p className="mt-0.5 truncate font-mono text-[10px] text-faint" title={a.repoRoot}>{a.repoRoot}</p>
                  ) : null}
                </div>
                <RunBadge status={a.status} />
                {/* Spec 0149: ONE spec page for every project, the platform
                    included — this used to fork on the slug. */}
                <Link
                  href={`/projects/${projectSlug}/specs/${a.specId}`}
                  className="flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
                >
                  Ver spec <ExternalLink className="h-3 w-3" />
                </Link>
              </div>

              {/* Step timeline */}
              <div className="mt-4 flex items-center gap-1">
                {Array.from({ length: a.totalSteps }).map((_, i) => (
                  <div key={i} className="flex flex-1 items-center gap-1">
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[9px] ${
                      i < a.step ? "bg-brand/20 text-brand" : i === a.step && a.status === "running" ? "bg-cyan/20 text-cyan" : "bg-surface text-faint"
                    }`}>
                      {i < a.step ? <CheckCircle2 className="h-3 w-3" /> : i === a.step && a.status === "running" ? <CircleDot className="h-3 w-3 mc-live-dot" /> : i + 1}
                    </span>
                    {i < a.totalSteps - 1 && <span className={`h-px flex-1 ${i < a.step ? "bg-brand/40" : "bg-border"}`} />}
                  </div>
                ))}
              </div>
              {/* Spec 0212: the LABEL, not the raw phase. A platform run ends at the
                  merge — `deployToProduction` returns immediately for a self target and
                  0170 took it off the path — so "promoted" here meant "shipped" to a
                  reader and "merged" in fact. phaseLabel() carries that one exception
                  and falls back to the raw string for a phase it does not know. */}
              <p className="mt-2 text-[11px] text-muted">Fase actual: <span className="text-foreground">{phaseLabel(a.phase, projectSlug)}</span> · paso {Math.min(a.step + 1, a.totalSteps)}/{a.totalSteps}</p>
              {projectSlug === PLATFORM_PROJECT_SLUG && a.phase.startsWith("promoted") && (
                <p className="mt-1 text-[11px] text-amber">{PLATFORM_DEPLOY_HINT}</p>
              )}

              {/* Spec 0111: gate-3 evidence BEFORE the click. Present only when a
                  promote gate is actually open. `canPromote: false` disables the
                  button here, matching the old /forge/specs page so the two
                  surfaces agree instead of drifting — the guard inside
                  runWorkspaceGateAction still refuses regardless, this just stops
                  the reason being discoverable only by clicking. */}
              {/* Spec 0119: the environment this change can be tested on, shown
                  from gate 2 onward — before the approve/promote buttons below,
                  because looking at it is what should inform the click. Absent
                  entirely when there is nothing real to show. */}
              {a.staging && <StagingPanel s={a.staging} />}

              {a.gate3 && <Gate3Panel e={a.gate3} />}

              {/* Spec 0207: the run is parked on a human and Temporal could not
                  say which actions are open. Saying so beats rendering the card
                  as if nothing were waiting — which is exactly how the missing
                  project slug stayed invisible. */}
              {a.gateUnreadable && (
                <p className="mt-3 text-[11px] text-amber">
                  Esta corrida espera una aprobación y no pude leer sus acciones desde Temporal.
                  Recarga; si sigue igual, el orquestador no responde para este workflow.
                </p>
              )}

              {/* Spec 0225 D: gate 2 IS the merge here (ADR-016), and the app had
                  no way to perform it — so the run parked until someone opened
                  GitHub. Same `promote` capability as the merge it performs. */}
              {a.canMergeGatePr && (
                <div className="mt-3">
                  <form action={mergeGatePrAction.bind(null, projectId, a.specId, projectSlug)}>
                    <Btn
                      type="submit"
                      variant="primary"
                      disabled={promoteDenial !== null}
                      className={promoteDenial ? "pointer-events-none opacity-50" : ""}
                      title={promoteDenial ?? "Fusionar el PR es la aprobación de la compuerta 2"}
                    >
                      Fusionar PR
                    </Btn>
                  </form>
                </div>
              )}

              {a.gateActions.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {a.gateActions.map((action) => {
                    // Two independent reasons a promote can be off the table, and
                    // the ROLE one is reported first: it is true regardless of CI,
                    // so telling a MEMBER "CI is red" would send them to fix the
                    // wrong thing (spec 0117).
                    const reason =
                      action !== "promote"
                        ? null
                        : (promoteDenial ?? (a.gate3?.canPromote === false ? a.gate3.verdict : null));
                    const blocked = reason !== null;
                    return (
                      <form key={action} action={signalGateAction.bind(null, projectId, a.specId, action, projectSlug)}>
                        <Btn
                          type="submit"
                          variant={action === "specRejected" ? "danger" : "primary"}
                          disabled={blocked}
                          className={blocked ? "pointer-events-none opacity-50" : ""}
                          title={reason ?? undefined}
                        >
                          {GATE_ACTION_LABEL[action]}
                        </Btn>
                      </form>
                    );
                  })}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

/** Spec 0119: the environment this change can be tested on. Everything shown
 * comes from the pure `deriveStagingView`; this only paints it.
 *
 * The host renders as a LINK only when `href` is set — which
 * `stagingHostIsResolvable` withholds while the domain is `.test`. A link that
 * cannot resolve would look like a broken environment rather than a missing DNS
 * record, so the reason is shown as text instead. */
function StagingPanel({ s }: { s: StagingView }) {
  const tone = {
    ok: "border-brand/40 bg-brand/10 text-brand",
    warn: "border-amber/40 bg-amber/10 text-amber",
    info: "border-cyan/40 bg-cyan/10 text-cyan",
  }[s.tone];
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border bg-surface p-3">
      <p className="text-[10px] uppercase tracking-[0.2em] text-faint">Entorno de prueba</p>
      <p className={`rounded-md border px-2 py-1 text-[12px] ${tone}`}>{s.headline}</p>
      {s.host && (
        <p className="text-[12px] text-muted">
          <span className="text-faint">Host · </span>
          {s.href ? (
            <a className="inline-flex items-center gap-1 text-foreground hover:text-brand" href={s.href} target="_blank" rel="noreferrer">
              {s.host} <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            <span className="text-foreground">{s.host}</span>
          )}
        </p>
      )}
      {s.detail && <p className="text-[12px] text-muted">{s.detail}</p>}

      {/* Spec 0226 E: two facts about what this environment IS, always together,
          because they are one message — a copy for testing, not a place to keep
          anything. `neutralizada` appears only when the marker was PROVEN; its
          absence means a clean Odoo, never "probably neutralized". */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {s.neutralized && (
          <span className="rounded-md border border-cyan/40 bg-cyan/10 px-2 py-0.5 text-[11px] text-cyan">
            copia de producción · neutralizada
          </span>
        )}
        <span className="text-[11px] text-faint">no se respalda · se destruye al promover</span>
      </div>
    </div>
  );
}

/** Spec 0111: the three questions gate 3 owes you before you promote — may I,
 * what will actually run, and can it be undone. All three come from the pure
 * `deriveGate3Evidence`; this only paints them. */
function Gate3Panel({ e }: { e: Gate3Evidence }) {
  const tone = {
    ok: "border-brand/40 bg-brand/10 text-brand",
    danger: "border-rose/40 bg-rose/10 text-rose",
    warn: "border-amber/40 bg-amber/10 text-amber",
    info: "border-cyan/40 bg-cyan/10 text-cyan",
  }[e.tone];
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border bg-surface p-3">
      <p className="text-[10px] uppercase tracking-[0.2em] text-faint">Antes de publicar</p>
      <p className={`rounded-md border px-2 py-1 text-[12px] ${tone}`}>{e.verdict}</p>
      <div className="space-y-1 text-[12px]">
        <p className="text-muted">
          <span className="text-faint">Qué se ejecuta · </span>
          <span className="text-foreground">{e.willRun}</span>
        </p>
        <p className="text-muted">
          <span className="text-faint">Reversible · </span>
          <span className="text-foreground">{e.reversibility}</span>
        </p>
      </div>
    </div>
  );
}

function RunBadge({ status }: { status: string }) {
  const map: Record<string, { t: string; c: string }> = {
    running: { t: "corriendo", c: "text-cyan border-cyan/30 bg-cyan/10" },
    queued: { t: "en cola", c: "text-muted border-border bg-surface" },
    completed: { t: "completado", c: "text-brand border-brand/30 bg-brand/10" },
    failed: { t: "falló", c: "text-rose border-rose/30 bg-rose/10" },
    "waiting-approval": { t: "esperando aprobación", c: "text-amber border-amber/30 bg-amber/10" },
  }
  const m = map[status] ?? map.queued!
  return <span className={`rounded border px-2 py-0.5 text-[10px] ${m.c}`}>{m.t}</span>
}

// ── MONITOREO ───────────────────────────────────────────────────────────────
/** Spec 0214: an honest empty state, because nothing measures this project.
 *
 * What was here: six time series generated from the project id by a seeded
 * function in `lib/mock-data` — including a "Latencia p95 · 820ms" that
 * appeared whenever `health` was "degraded" — under a "● en vivo" dot, a range
 * selector, an "Abrir Grafana" button (there is no Grafana) and a "datasource:
 * node-exporter + cAdvisor" line. Nothing measured any of it, so the scenery
 * goes with the generator.
 *
 * Deliberately NOT a zero, a dash or a flat chart: those read as "we measured,
 * and it was nothing". Real series need historical time-series storage
 * (Prometheus/Grafana, Fase 3 · SPEC §16), deferred with its trigger in
 * PENDING.md.
 */
export function Monitoreo() {
  return (
    <div className="space-y-5">
      <Label>Monitoreo</Label>
      <Card className="p-8 text-center">
        <Activity className="mx-auto h-6 w-6 text-faint" />
        <p className="mt-3 text-sm text-foreground">No hay ninguna fuente de métricas conectada.</p>
        <p className="mx-auto mt-2 max-w-md text-[12px] leading-relaxed text-muted">
          Las gráficas de CPU, memoria, red y latencia necesitan almacenamiento histórico de
          series de tiempo (Prometheus/Grafana), que todavía no existe. Por eso este panel no
          muestra ningún número: un 0 o una gráfica plana se leerían como una medición, y no
          lo serían.
        </p>
        <p className="mt-4 text-[11px] text-faint">Métricas reales · Fase 3 (SPEC §16)</p>
      </Card>
    </div>
  )
}

// ── LOGS ────────────────────────────────────────────────────────────────────
/**
 * Spec 0214: real container logs, read over SSH by `logs-panel.tsx` and handed
 * down as plain data. What is GONE, and deliberately: the invented lines from
 * the mock layer, the "journalctl -f · streaming" header (nothing streams — the
 * read is one bounded `docker compose logs` per stack), the info/warn/error
 * level chips (compose lines carry no structured level; parsing one out would be
 * a guess painted as a fact) and the dead "Exportar" button.
 *
 * The three outcomes stay visibly different — lines, a failed read with its
 * stderr, and "no hay stack legible" with the reason — because a fallback that
 * looks like the deliberate case is not observable (verification rule #9).
 */
export function Logs({ logs }: { logs: ProjectLogsResult }) {
  const router = useRouter()
  const [q, setQ] = useState("")

  if (logs.state === "none") {
    return (
      <div className="space-y-4">
        <Label>Logs del servidor</Label>
        <Card className="p-6 text-sm text-muted">{logs.reason}</Card>
      </div>
    )
  }

  const needle = q.toLowerCase()
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Label>Logs del servidor</Label>
        <span className="text-[11px] text-faint">leído {logs.readAt} (hora del servidor)</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Filter className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filtrar…" className="w-40 rounded-lg border border-border bg-surface py-1.5 pl-8 pr-3 text-[11px] text-foreground placeholder:text-faint outline-none focus:border-brand/40" />
          </div>
          <Btn variant="ghost" onClick={() => router.refresh()}><RotateCcw className="h-3.5 w-3.5" /> Releer</Btn>
        </div>
      </div>

      {logs.entries.map((entry) => {
        if (entry.state === "error") {
          return (
            <Card key={entry.project} className="space-y-1 border-rose/40 p-4">
              <p className="text-[12px] text-rose">No se pudieron leer los logs de {entry.project}.</p>
              <p className="text-[11px] leading-relaxed text-muted">{entry.message}</p>
            </Card>
          )
        }
        const rows = entry.lines.filter((l) => l.toLowerCase().includes(needle))
        return (
          <div key={entry.project} className="overflow-hidden rounded-xl border border-border bg-[#050607]">
            <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5 text-[11px] text-faint">
              <TerminalSquare className="h-3.5 w-3.5" /> {entry.project} · docker compose logs
              <span className="ml-auto">{rows.length} de {entry.lines.length} líneas</span>
            </div>
            <div className="max-h-[520px] space-y-0.5 overflow-y-auto p-3 font-mono text-[12px] leading-relaxed">
              {entry.truncated && (
                <p className="px-1 pb-2 text-[11px] text-amber">
                  Mostrando las últimas {logs.tail} líneas por servicio; hay líneas más antiguas.
                </p>
              )}
              {entry.lines.length === 0 && <p className="p-6 text-center text-muted">Este stack no ha escrito ninguna línea.</p>}
              {entry.lines.length > 0 && rows.length === 0 && <p className="p-6 text-center text-muted">Sin líneas para este filtro.</p>}
              {rows.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap break-all rounded px-1 py-0.5 text-foreground hover:bg-white/[0.02]">{l}</div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── REPO ────────────────────────────────────────────────────────────────────
/** Spec 0137: exactly one thing, working — "Abrir en GitHub" as a real link
 * built from the linked repo's own identity. The fabricated file tree, the
 * string-built `example-org/…` name and the "repo de addons generado" card are
 * DELETED, not kept: every one of them asserted something nothing observes
 * (the owner: no dir tree is needed now). */
export function Repo({ project }: { project: ProjectView }) {
  const linked = project.repoOwner && project.repoName
  const repoUrl = linked ? `https://github.com/${project.repoOwner}/${project.repoName}` : null
  return (
    <div className="space-y-6">
      <Label>Repositorio</Label>
      {linked ? (
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <GitBranch className="h-4 w-4 text-foreground" />
          <span className="text-[13px] text-foreground">
            {project.repoOwner}/{project.repoName}
          </span>
          <a
            className="ml-auto inline-flex items-center gap-2 rounded-lg border border-brand/50 bg-brand/15 px-3.5 py-2 text-[13px] font-medium text-brand transition-colors hover:bg-brand/25"
            href={repoUrl!}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="h-4 w-4" /> Abrir en GitHub
          </a>
        </Card>
      ) : (
        <LinkRepoForm projectId={project.projectId} projectSlug={project.id} />
      )}
    </div>
  )
}


/**
 * Spec 0151: link a repository to a project that has none.
 *
 * What was here: "vincúlalo al crear el proyecto" — advice a project created
 * without a repo can never act on, and the reason the owner could not start runs on
 * `client-b`. The action verifies the repo against GitHub before writing the
 * row, so a bad paste is refused here instead of at gate 2.
 *
 * `useActionState` rather than a redirect: the project page does not render
 * `?error=`, so a redirecting failure would be silent.
 */
function LinkRepoForm({ projectId, projectSlug }: { projectId: string; projectSlug: string }) {
  const [state, action, pending] = useActionState(
    linkProjectRepoAction.bind(null, projectId, projectSlug),
    null,
  )
  return (
    <Card className="space-y-3 p-6">
      <p className="text-sm text-muted">
        Este proyecto no tiene repositorio vinculado todavía. Sin él no se pueden iniciar corridas.
      </p>
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input
          name="repo"
          required
          placeholder="owner/repo, o pega la URL de GitHub (https o ssh)"
          className="min-w-[280px] flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-foreground placeholder:text-faint"
        />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-lg border border-brand/50 bg-brand/15 px-3.5 py-2 text-[13px] font-medium text-brand transition-colors hover:bg-brand/25 disabled:opacity-50"
        >
          <GitBranch className="h-4 w-4" /> {pending ? "Verificando…" : "Vincular"}
        </button>
      </form>
      {state && !state.ok ? <p className="text-[12px] text-rose">{state.problem}</p> : null}
      <p className="text-[11px] leading-relaxed text-faint">
        Verificamos que el servidor pueda hacer push y que TÚ tengas escritura antes de guardarlo.
        La primera corrida clona el repo por su cuenta.
      </p>
    </Card>
  )
}


/** Spec 0152: the reason an action refused, where the user can see it.
 *
 * Dismissible because the 8s auto-refresh keeps the URL, so a banner with no way
 * out would follow you around the workspace. Stripping the param client-side
 * (replaceState) costs no round-trip and leaves no history entry. */
export function ActionErrorBanner({ message }: { message: string }) {
  const [shown, setShown] = useState(true)
  if (!shown) return null
  return (
    <div className="border-b border-rose/40 bg-rose/10">
      <div className="mx-auto flex max-w-[1400px] items-start gap-3 px-5 py-3">
        <p className="mr-auto text-[13px] text-rose">{message}</p>
        <button
          type="button"
          onClick={() => {
            const url = new URL(window.location.href)
            url.searchParams.delete("error")
            window.history.replaceState(null, "", url)
            setShown(false)
          }}
          className="text-[12px] text-muted hover:text-foreground"
        >
          Cerrar
        </button>
      </div>
    </div>
  )
}

// ── RAMAS & BUILDS ──────────────────────────────────────────────────────────
/** Spec 0121: the real deployed environments, read off the VPS server-side and
 * passed in as a slot.
 *
 * What was here before: `project.branches` (an honest empty array since spec 0084)
 * rendered with four `MiniBtn`s — "Abrir preview", "Ver commits", "Merge a
 * producción", "Re-neutralizar DB" — none of which had a handler. They are gone
 * rather than kept: a button that does nothing is worse than no button, because it
 * implies a capability that does not exist. The "Crear rama de pruebas" button went
 * for the same reason; a staging environment is created by a pipeline run reaching
 * gate 2 (spec 0119), not by a button here.
 *
 * The explanatory card also went: it described cloning a *neutralized production
 * database*, which is not what happens. Spec 0119 deploys a FRESH database (`base`
 * plus the change's addons) precisely because we cannot copy a customer's
 * production data off odoo.sh. Leaving that text would have been a fabricated
 * promise. */
export function Ramas({
  deployedStacksSlot,
  branchesSlot,
}: {
  deployedStacksSlot?: React.ReactNode
  branchesSlot?: React.ReactNode
}) {
  return (
    <div className="space-y-6">
      <Label>Ramas & builds</Label>
      {/* Spec 0134: the branch registry — create a branch, drive its staging
          server, see its PR. The odoo.sh model: rama = entorno = unidad de
          promoción. */}
      {branchesSlot ?? (
        <Card className="p-6 text-sm text-muted">Ramas no disponibles en este contexto.</Card>
      )}
      <Label>Entornos desplegados</Label>
      {deployedStacksSlot ?? (
        <Card className="p-6 text-sm text-muted">Inventario no disponible en este contexto.</Card>
      )}
      <p className="text-[11px] leading-relaxed text-faint">
        El servidor de una rama (<code>br-…</code>) arranca con una base de datos nueva
        (<code>base</code> más los addons de la rama) y vive hasta que lo destruyas aquí. Los
        entornos por spec (<code>spec-NNNN</code>) los crea una corrida del pipeline al llegar a la
        aprobación del cambio, y se destruyen al promover o rechazar.
      </p>
    </div>
  )
}


// ── TERMINAL ────────────────────────────────────────────────────────────────
export function Terminal({ project, vps }: any) {
  const lines = [
    { p: "$", t: `ssh ops@${vps?.ip ?? "vps"} · sesión de emergencia (timeout 15 min)`, c: "text-faint" },
    { p: ">", t: "docker ps --filter name=odoo", c: "text-foreground" },
    { p: "", t: "CONTAINER   IMAGE      STATUS         PORTS", c: "text-muted" },
    { p: "", t: `a1b2c3d4    odoo:18    Up 6 days      0.0.0.0:8069->8069/tcp`, c: "text-muted" },
    { p: "", t: `e5f6a7b8    postgres   Up 6 days      5432/tcp`, c: "text-muted" },
    { p: ">", t: "odoo-bin -u company_theme -d prod --stop-after-init", c: "text-foreground" },
    { p: "", t: "INFO prod odoo.modules.loading: Modules loaded.", c: "text-brand" },
    { p: ">", t: "systemctl status odoo | head -3", c: "text-foreground" },
    { p: "", t: "● odoo.service - Odoo ERP  (active: running)", c: "text-brand" },
  ]
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Label>Terminal de emergencia</Label>
        <span className="ml-auto flex items-center gap-1.5 rounded-md border border-amber/30 bg-amber/10 px-2 py-1 text-[11px] text-amber">
          <ShieldCheck className="h-3 w-3" /> sesión auditada · expira en 14:32
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-[#050607]">
        <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
          <span className="h-3 w-3 rounded-full bg-rose/70" />
          <span className="h-3 w-3 rounded-full bg-amber/70" />
          <span className="h-3 w-3 rounded-full bg-brand/70" />
          <span className="ml-2 text-[11px] text-faint">{project.id} · {vps?.label ?? "sin-vps"} · bash</span>
        </div>
        <div className="space-y-1 p-4 text-[12.5px] leading-relaxed">
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              {l.p && <span className="select-none text-brand">{l.p}</span>}
              <span className={l.c}>{l.t}</span>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <span className="text-brand">$</span>
            <span className="mc-cursor text-brand">▍</span>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-faint">
        La terminal es efímera y queda registrada. Ideal para hotfixes: reiniciar Odoo, revisar logs, correr migraciones.
      </p>
    </div>
  )
}

// ── CONEXIONES ──────────────────────────────────────────────────────────────
export function Conexiones({ project }: any) {
  const ITEMS = project.integrations.map((id: string) => integrationById(id)).filter(Boolean)
  const catIcon: Record<string, any> = { infra: Server, code: GitBranch, data: Database, cdn: Shield, deploy: Boxes, ai: Bot, comms: Send, dns: Globe }
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Label>Conexiones del proyecto</Label>
        <Btn variant="ghost"><Plus className="h-4 w-4" /> Conectar API</Btn>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ITEMS.map((it: any) => {
          const Icon = catIcon[it.category] ?? Cable
          return (
            <Card key={it.id} className="flex items-center gap-3 p-4">
              <span className="grid h-9 w-9 place-items-center rounded-lg border border-border bg-surface" style={{ color: it.accent }}>
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] text-foreground">{it.name}</p>
                <p className="truncate text-[11px] text-faint">{it.detail}</p>
              </div>
              <span className={`ml-auto flex items-center gap-1.5 text-[11px] ${it.status === "connected" ? "text-brand" : it.status === "action-needed" ? "text-amber" : "text-faint"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${it.status === "connected" ? "bg-brand" : it.status === "action-needed" ? "bg-amber" : "bg-faint"}`} />
                {it.status === "connected" ? "conectado" : it.status === "action-needed" ? "requiere acción" : "desconectado"}
              </span>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

// ── AJUSTES ─────────────────────────────────────────────────────────────────
export function Ajustes({ project, membersSlot }: any) {
  return (
    <div className="max-w-2xl space-y-6">
      {/* Spec 0128 E: first, because "who can see this project" is the setting
          people actually come here to change. */}
      <div>
        <Label>Miembros</Label>
        {membersSlot ?? (
          <Card className="p-6 text-center text-sm text-muted">Miembros no disponibles en este contexto.</Card>
        )}
      </div>
      <div>
        <Label>General</Label>
        <Card className="divide-y divide-border">
          <Row k="Nombre del proyecto" v={project.name} />
          <Row k="Cliente" v={project.client} />
          <Row k="Dominio" v={project.domain} />
          <Row k="Tipo" v={project.kind} />
          <Row k="Región" v={project.region} />
        </Card>
      </div>
      <div>
        <Label>Automatización</Label>
        <Card className="divide-y divide-border">
          <Toggle k="Agentes pueden abrir PRs" on />
          <Toggle k="Auto-merge si pasan los tests" />
          <Toggle k="Re-neutralizar DB en cada rama" on />
          <Toggle k="Alertas por correo (Hostinger Mail)" on />
        </Card>
      </div>
      <div>
        <Label>Zona de peligro</Label>
        <Card className="space-y-3 p-4">
          <Btn variant="danger" className="w-full">Poner proyecto a dormir (liberar VPS)</Btn>
          <Btn variant="danger" className="w-full">Archivar proyecto</Btn>
        </Card>
      </div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex items-center justify-between p-3.5 text-[13px]"><span className="text-muted">{k}</span><span className="text-foreground">{v}</span></div>
}
function Toggle({ k, on }: { k: string; on?: boolean }) {
  return (
    <div className="flex items-center justify-between p-3.5 text-[13px]">
      <span className="text-foreground">{k}</span>
      <span className={`flex h-5 w-9 items-center rounded-full p-0.5 ${on ? "bg-brand/40" : "bg-surface border border-border"}`}>
        <span className={`h-4 w-4 rounded-full transition-transform ${on ? "translate-x-4 bg-brand" : "bg-faint"}`} />
      </span>
    </div>
  )
}
