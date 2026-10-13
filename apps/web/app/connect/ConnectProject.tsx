"use client"

/**
 * Armar proyecto — connect something that already exists (spec 0225 C2/G).
 *
 * What this used to be: a four-step mockup over `lib/mock-data`, with a
 * hardcoded list of four repos, a VPS picker, four service toggles that wrote
 * nowhere, and a confirm screen promising four things — two of which are not
 * built for ANY project. "Anclar proyecto" was a `<Link href="/">`.
 *
 * What it is now: two steps and a confirm that claims only what it does. The
 * services step is gone (the owner: skip Neon and Vercel; no connector exists — the
 * Conexiones tab still renders `lib/mock-data`). The VPS picker is gone too:
 * Stage 1 never writes to the box, so asking someone to pick one from a mock
 * fleet would be collecting an answer to discard.
 */
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { motion } from "framer-motion"
import {
  Cable, Check, ArrowRight, ArrowLeft,
  Cpu, Globe, Layers, Boxes, Rocket, AlertTriangle,
} from "lucide-react"
import { TopBar, Card, Btn } from "@/components/ui"
import type { ChromeUser } from "@/lib/chrome-user"
import { connectProjectAction } from "./actions"
import type { PreflightFinding } from "@/lib/connect-preflight"
import { fromUiKind } from "@/lib/project-view"
import { SUPPORTED_ODOO_VERSIONS, DEFAULT_ODOO_VERSION } from "@launchpad/pipeline/procesos-modules"
import type { OdooVersion } from "@launchpad/pipeline"
import type { Project } from "@/lib/mock-data"

const KINDS: { id: Project["kind"]; icon: typeof Boxes; accent: string; t: string; d: string }[] = [
  { id: "odoo", icon: Boxes, accent: "var(--color-purple)", t: "Odoo simple", d: "Sólo Odoo. Sin repo de front." },
  { id: "odoo-next", icon: Layers, accent: "var(--color-cyan)", t: "Odoo + Front", d: "Odoo más un repo de front en GitHub." },
  { id: "custom", icon: Cpu, accent: "var(--color-amber)", t: "A medida (Next)", d: "Sólo un repo de GitHub." },
]

type Step = "kind" | "sources" | "confirm"

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

export function ConnectProject({ user }: { user: ChromeUser | null }) {
  const router = useRouter()
  const [step, setStep] = useState<Step>("kind")
  const [kind, setKind] = useState<Project["kind"] | null>(null)
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugEdited, setSlugEdited] = useState(false)
  const [repo, setRepo] = useState("")
  const [domain, setDomain] = useState("")
  const [prodKind, setProdKind] = useState<"fleet" | "odoosh" | "none">("fleet")
  const [prodHost, setProdHost] = useState("")
  const [odooVersion, setOdooVersion] = useState<OdooVersion>(DEFAULT_ODOO_VERSION)
  const [problem, setProblem] = useState<string | null>(null)
  const [findings, setFindings] = useState<PreflightFinding[]>([])
  const [connected, setConnected] = useState<{ slug: string; warnings: PreflightFinding[] } | null>(null)
  const [pending, start] = useTransition()

  const effectiveSlug = slugEdited ? slug : slugify(name)
  const runsOdoo = kind === "odoo" || kind === "odoo-next"

  function connect() {
    setProblem(null); setFindings([])
    start(async () => {
      const res = await connectProjectAction({
        name: name.trim(), slug: effectiveSlug, kind: fromUiKind(kind!), client: name.trim(),
        repo: repo.trim(),
        domain: domain.trim() || null,
        productionKind: prodKind === "none" ? null : prodKind,
        productionHost: prodHost.trim() || null,
        ...(runsOdoo ? { odooVersion: String(odooVersion) } : {}),
      })
      if (!res.ok) { setProblem(res.problem); setFindings(res.findings ?? []); return }
      // Spec 0225 F built four preflight checks. Two are non-blocking, and this
      // line navigated straight past them: `findings` was only ever set on
      // FAILURE, so `no_ci_toolchain` and `odoo_kind_without_addons` were
      // computed on every successful connect and thrown away — nobody had seen
      // one. Proven the hard way: the first project chat rediscovered "this repo
      // has no Odoo addons" by reading the tree, which is exactly what the
      // discarded warning says. A warning nobody reads is not a check.
      if (res.warnings.length) { setConnected({ slug: res.slug, warnings: res.warnings }); return }
      router.push(`/projects/${res.slug}`)
    })
  }

  return (
    <div className="min-h-screen mc-grid-bg">
      <TopBar crumbs={[{ label: "Proyectos", href: "/" }, { label: "Armar proyecto" }]} user={user} />

      <main className="mx-auto max-w-3xl px-5 pb-24 pt-8">
        <div className="mb-6 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-cyan">
          <Cable className="h-4 w-4" /> Armar proyecto · conectar lo existente
        </div>

        {step === "kind" && (
          <Panel>
            <h1 className="text-2xl font-semibold text-foreground">¿Qué vas a conectar?</h1>
            <p className="mt-1 text-sm text-muted">El tipo decide qué esperamos encontrar en el repo.</p>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del proyecto (ej. Client-D)"
              className="mt-5 w-full rounded-lg border border-border bg-card px-3.5 py-2.5 text-[14px] text-foreground placeholder:text-faint outline-none focus:border-brand/40" />
            <div className="mt-4 space-y-3">
              {KINDS.map((k) => (
                <button key={k.id} onClick={() => setKind(k.id)}
                  className={`flex w-full items-center gap-3 rounded-xl border p-4 text-left ${kind === k.id ? "border-brand/50 bg-brand/[0.06]" : "border-border bg-card hover:border-border-strong"}`}>
                  <span className="grid h-10 w-10 place-items-center rounded-lg border border-border bg-surface" style={{ color: k.accent }}><k.icon className="h-5 w-5" /></span>
                  <div className="min-w-0">
                    <p className="text-[14px] text-foreground">{k.t}</p>
                    <p className="text-[12px] text-faint">{k.d}</p>
                  </div>
                  {kind === k.id && <Check className="ml-auto h-4 w-4 text-brand" />}
                </button>
              ))}
            </div>
            <Nav onNext={() => setStep("sources")} nextDisabled={!kind || !name.trim()} back={<span />} />
          </Panel>
        )}

        {step === "sources" && (
          <Panel>
            <h1 className="text-2xl font-semibold text-foreground">Dónde vive hoy</h1>
            <p className="mt-1 text-sm text-muted">
              El repositorio es lo único imprescindible: es donde el pipeline va a commitear.
            </p>

            <label className="mt-6 flex flex-col gap-1.5">
              <span className="text-[12px] text-muted">Repositorio de GitHub</span>
              <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="example-org/taqueria-sol"
                className="w-full rounded-lg border border-border bg-card px-3.5 py-2 font-mono text-[13px] text-foreground placeholder:text-faint outline-none focus:border-brand/40" />
              <span className="text-[11px] text-faint">Verificamos que exista, que se pueda escribir en él, y que no traiga su propio <code>specs/</code>.</span>
            </label>

            <label className="mt-4 flex flex-col gap-1.5">
              <span className="text-[12px] text-muted">Identificador</span>
              <input value={effectiveSlug} onChange={(e) => { setSlugEdited(true); setSlug(e.target.value) }} placeholder="taqueria-sol"
                className="w-full rounded-lg border border-border bg-card px-3.5 py-2 font-mono text-[13px] text-foreground placeholder:text-faint outline-none focus:border-brand/40" />
              <span className="text-[11px] text-faint">Se usa en la URL y en el checkout. Si ya existe un proyecto con este identificador, te lo decimos.</span>
            </label>

            <label className="mt-4 flex flex-col gap-1.5">
              <span className="text-[12px] text-muted">Dominio del cliente <span className="text-faint">(opcional)</span></span>
              <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="client-d.example"
                className="w-full rounded-lg border border-border bg-card px-3.5 py-2 font-mono text-[13px] text-foreground placeholder:text-faint outline-none focus:border-brand/40" />
              <span className="text-[11px] text-faint">Se guarda como dato. Conectar no toca DNS.</span>
            </label>

            {/* A CONNECTED tenant already runs a version — a fact to read off the
                server, not a choice. `/connect` never asked, so validateProjectInput
                silently applied DEFAULT_ODOO_VERSION and the row claimed a version
                nobody checked. Right for taqueria-sol by luck; for a tenant on the
                other series it is a wrong fact that decides the staging image. */}
            {runsOdoo && (
              <div className="mt-5">
                <p className="mb-2 text-[12px] text-muted">¿Qué versión de Odoo corre hoy?</p>
                <div className="flex flex-wrap gap-2">
                  {SUPPORTED_ODOO_VERSIONS.map((v) => (
                    <button key={v} type="button" onClick={() => setOdooVersion(v)}
                      className={`rounded-lg border px-3.5 py-2 text-[13px] ${odooVersion === v ? "border-brand/50 bg-brand/[0.06] text-foreground" : "border-border bg-card text-muted hover:border-border-strong"}`}>
                      Odoo {v} CE
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-faint">
                  Decide con qué imagen se levantan los entornos de prueba. Si no coincide con el
                  servidor, el staging no se va a parecer a producción.
                </p>
              </div>
            )}

            <div className="mt-5">
              <p className="mb-2 text-[12px] text-muted">Producción</p>
              <div className="flex flex-wrap gap-2">
                {([["fleet", "Nuestra flota"], ["odoosh", "odoo.sh del cliente"], ["none", "Todavía ninguna"]] as const).map(([id, label]) => (
                  <button key={id} onClick={() => setProdKind(id)}
                    className={`rounded-lg border px-3 py-2 text-[13px] ${prodKind === id ? "border-brand/50 bg-brand/[0.06] text-foreground" : "border-border bg-card text-muted hover:border-border-strong"}`}>
                    {label}
                  </button>
                ))}
              </div>
              {prodKind === "odoosh" && (
                <input value={prodHost} onChange={(e) => setProdHost(e.target.value)} placeholder="client-d.odoo.com"
                  className="mt-3 w-full rounded-lg border border-border bg-card px-3.5 py-2 font-mono text-[13px] text-foreground placeholder:text-faint outline-none focus:border-brand/40" />
              )}
              {/* No host field for the fleet, and none recorded either. `/new`
                  derives `<slug>.odoo.example.com` because provisioning CREATES
                  that name and writes its DNS, so the row and the DNS cannot
                  disagree (spec 0225 E). Connecting provisions nothing, so the
                  same derivation would invent a name that will never resolve —
                  which is what it did for taqueria-sol. `production_kind` records
                  that production is on our fleet; WHERE is a Stage 2 fact, and
                  null is the honest answer until we look. */}
              {prodKind === "fleet" && (
                <p className="mt-2 text-[11px] text-faint">
                  <Globe className="mr-1 inline h-3 w-3" />
                  Ya vive en nuestra flota. Conectar no despliega nada ni registra dónde —
                  eso se descubre cuando Mission Control toque el servidor.
                </p>
              )}
            </div>

            <Nav onBack={() => setStep("kind")} onNext={() => setStep("confirm")} nextDisabled={!repo.trim() || !effectiveSlug} />
          </Panel>
        )}

        {step === "confirm" && (
          <Panel>
            <h1 className="text-2xl font-semibold text-foreground">Revisar y anclar</h1>
            <p className="mt-1 text-sm text-muted">Esto no despliega nada ni toca el servidor del cliente.</p>

            <Card className="mt-5 divide-y divide-border">
              <Row k="Proyecto" v={name || "—"} />
              <Row k="Identificador" v={effectiveSlug || "—"} />
              <Row k="Tipo" v={KINDS.find((k) => k.id === kind)?.t ?? "—"} />
              <Row k="Repositorio" v={repo || "—"} />
              {runsOdoo && <Row k="Odoo" v={`${odooVersion} CE`} />}
              <Row k="Dominio" v={domain || "—"} />
              {/* Echo the host, not just the kind: E2 made it settable for fleet and this
                  row 12 lines below still showed only "Nuestra flota", so the confirm
                  could not be checked against what gets recorded. Same second-call-site
                  shape as the defect it fixes. */}
              <Row k="Producción" v={
                prodKind === "fleet" ? "Nuestra flota (ya existente)"
                  : prodKind === "odoosh" ? (prodHost.trim() || "odoo.sh")
                  : "Todavía ninguna"} />
            </Card>

            {/* Spec 0225 G. What this used to promise: indexing plus creating the
                Odoo addons repo, a test branch with a NEUTRALIZED database,
                reading Neon/Vercel state, and an emergency terminal. Two of those
                are not built for any project — the Conexiones tab renders
                mock-data and Terminal() is a hardcoded script — and the
                neutralized branch is spec 0226. It now lists what it does. */}
            <Card className="mt-4 border-cyan/25 bg-cyan/[0.04] p-4">
              <p className="text-[11px] uppercase tracking-widest text-cyan">Al anclar, Mission Control</p>
              <ul className="mt-2 space-y-1.5 text-[12.5px] text-muted">
                <li className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-cyan" /><span>Comprueba que el repositorio exista y que se pueda escribir en él — el tuyo y el del servidor.</span></li>
                <li className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-cyan" /><span>Lee el repo para ver si trae su propio <code>specs/</code> (eso lo bloquea) y con qué se puede verificar.</span></li>
                <li className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-cyan" /><span>Crea el proyecto, te deja como owner y habilita chats y specs.</span></li>
                <li className="flex gap-2"><Check className="h-4 w-4 shrink-0 text-cyan" /><span>El checkout se clona solo en la primera corrida, no ahora.</span></li>
              </ul>
              <p className="mt-3 text-[11px] text-faint">
                Los entornos de prueba con base de datos neutralizada llegan aparte (spec 0226).
              </p>
            </Card>

            {problem && (
              <Card className="mt-4 border-danger/40 bg-danger/[0.04] p-4">
                <p className="flex gap-2 text-[13px] text-danger"><AlertTriangle className="h-4 w-4 shrink-0" /> {problem}</p>
              </Card>
            )}
            {findings.filter((f) => !f.blocking).map((f) => (
              <Card key={f.code} className="mt-3 border-amber/40 bg-amber/[0.04] p-4">
                <p className="text-[12.5px] text-muted">{f.problem}</p>
              </Card>
            ))}

            {connected && (
              <Card className="mt-4 border-amber/40 bg-amber/[0.04] p-4">
                <p className="text-[11px] uppercase tracking-widest text-amber">Conectado · revisa esto</p>
                <ul className="mt-2 space-y-1.5 text-[12.5px] text-muted">
                  {connected.warnings.map((w) => (
                    <li key={w.code} className="flex gap-2">
                      <AlertTriangle className="h-4 w-4 shrink-0 text-amber" />
                      <span>{w.problem}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[11px] text-faint">
                  El proyecto ya quedó creado. Nada de esto lo bloquea.
                </p>
              </Card>
            )}

            <div className="mt-8 flex items-center justify-between">
              <Btn variant="ghost" onClick={() => setStep("sources")} disabled={Boolean(connected)}>
                <ArrowLeft className="h-4 w-4" /> Atrás
              </Btn>
              {connected ? (
                <Btn variant="primary" className="px-5 py-2.5"
                  onClick={() => router.push(`/projects/${connected.slug}`)}>
                  Continuar al proyecto <ArrowRight className="h-4 w-4" />
                </Btn>
              ) : (
                <Btn variant="primary" className="px-5 py-2.5" onClick={connect} disabled={pending}>
                  <Rocket className="h-4 w-4" /> {pending ? "Anclando…" : "Anclar proyecto"}
                </Btn>
              )}
            </div>
          </Panel>
        )}
      </main>
    </div>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>{children}</motion.div>
}

function Nav({ onBack, onNext, nextDisabled, back }: { onBack?: () => void; onNext: () => void; nextDisabled?: boolean; back?: React.ReactNode }) {
  return (
    <div className="mt-8 flex items-center justify-between">
      {onBack ? <Btn variant="ghost" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Atrás</Btn> : back}
      <Btn variant="primary" onClick={onNext} className={nextDisabled ? "pointer-events-none opacity-40" : ""}>Continuar <ArrowRight className="h-4 w-4" /></Btn>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex gap-4 p-3.5 text-[13px]"><span className="w-28 shrink-0 text-muted">{k}</span><span className="text-foreground">{v}</span></div>
}
