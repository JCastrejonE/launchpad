"use client"

import { useState } from "react"
import { fromUiKind } from "@/lib/project-view"
import type { Project } from "@/lib/mock-data"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import {
  Wand2, Boxes, Layers, Cpu, Check, ArrowRight, ArrowLeft, Globe,
  Server, Package, Database, ShieldCheck, Sparkles,
  Loader2, CheckCircle2, CircleDot, Rocket, Mail,
} from "lucide-react"
import { BUSINESS_QUESTIONS } from "@/lib/mock-data"
import { TopBar, Card, Btn } from "@/components/ui"
import type { ChromeUser } from "@/lib/chrome-user"
// Spec 0126 C: the last step stopped being a mockup.
import { createProjectAction, startProvisioningAction } from "./actions"
import { suggestSlug } from "@/lib/slug"
// Spec 0161 E2b: the branding logo — validated at the boundary here, base64'd
// into the payload the provisioning workflow commits into the front repo.
import { validateLogoUpload } from "@/lib/logo-upload"
// Spec 0205: the versions we have actually verified, from the one table that
// records them — so the picker and the validator can never offer different sets
// (an option the validator refuses is a dead button). Imported from the DEDICATED
// subpath, never via `@/lib/project-create`: that module reaches `@launchpad/db`,
// and pulling it into this client component drags `pg` into the browser bundle
// and fails `next build` with "Can't resolve 'fs'".
import { SUPPORTED_ODOO_VERSIONS, DEFAULT_ODOO_VERSION } from "@launchpad/pipeline/procesos-modules"
import type { LogoCommit, OdooVersion } from "@launchpad/pipeline"

const SYSTEM_TYPES = [
  {
    id: "odoo",
    icon: Boxes,
    accent: "var(--color-purple)",
    title: "Odoo simple",
    desc: "ERP Odoo CE listo: ventas, inventario, POS y facturación. Rápido y económico.",
    time: "~15 min",
    // Spec 0205: no version here — it is chosen in step 3, and this chip claimed
    // 18 before anyone was asked.
    includes: ["VPS Hostinger + Docker", "Odoo CE", "Postgres en contenedor"],
  },
  {
    id: "odoo-next",
    icon: Layers,
    accent: "var(--color-cyan)",
    title: "Odoo + Front Next",
    desc: "Odoo como backend + un front personalizado en Next.js (catálogo, portal, e-commerce).",
    time: "~30 min",
    includes: ["Todo lo de Odoo simple", "Front Next.js en contenedor", "Repo propio en GitHub", "Certificado automático"],
  },
  {
    id: "custom",
    icon: Cpu,
    accent: "var(--color-amber)",
    title: "Sistema a medida",
    desc: "Software 100% a la medida. Normalmente Next.js, con o sin Odoo por API.",
    time: "~45 min",
    includes: ["Arquitectura a medida", "Repo propio en GitHub", "Integración Odoo opcional"],
  },
]

// Spec 0161 E2b: extension per allowed logo MIME (validateLogoUpload guarantees
// the type is one of these), so the committed file keeps a sensible name.
const LOGO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/webp": "webp",
}

/** Read a browser File as raw base64 (no `data:` prefix) — the shape LogoCommit
 * and commitFileToRepo expect. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.slice(result.indexOf(",") + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

type Step = "type" | "questions" | "domain" | "review"

/**
 * Spec 0218: how long a step or question transition is in flight, in ms — the
 * window in which `mode="wait"` keeps the OUTGOING panel mounted and clickable
 * while the nav buttons, which never animated at all, still accept presses. Two
 * fast presses of *Siguiente* used to increment `qIndex` twice and skip a
 * question outright. Covers the longer of the two declared durations (`Panel`
 * 0.25s below, the question panel 0.2s) — keep it >= both.
 *
 * A timer releases it, NOT a framer-motion callback: a callback that never
 * arrives (interrupted exit, reduced motion) would disable every nav control
 * forever and leave the first screen a new user sees unusable — worse than the
 * bug being fixed. A timer cannot stick.
 */
const TRANSITION_MS = 250

export function NewProject({ user }: { user: ChromeUser | null }) {
  const [step, setStep] = useState<Step>("type")
  const [type, setType] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [qIndex, setQIndex] = useState(0)
  // Spec 0218: a transition is in flight — the nav controls of BOTH scopes (the
  // outer panel `AnimatePresence` and the inner question one) are disabled.
  const [busy, setBusy] = useState(false)
  const [domain, setDomain] = useState<"have" | "buy" | null>(null)
  const [domainName, setDomainName] = useState("")
  const [projName, setProjName] = useState("")
  // Spec 0126 C: what a project actually needs to exist — its identifier, its
  // repo, and where production lives.
  const [slug, setSlug] = useState("")
  const [slugEdited, setSlugEdited] = useState(false)
  const [repo, setRepo] = useState("")
  const [prodKind, setProdKind] = useState<"none" | "odoosh" | "fleet">("none")
  const [prodHost, setProdHost] = useState("")
  // Spec 0205: the Odoo series to provision. Asked here because the wizard used
  // to STATE it ("Odoo 18 CE") while `projects.version` stayed blank and every
  // tenant got 18 whatever the customer needed.
  const [odooVersion, setOdooVersion] = useState<OdooVersion>(DEFAULT_ODOO_VERSION)
  // Spec 0161 E2b: the branding logo, base64-encoded and ready for the
  // provisioning workflow. Only odoo_next provisions a front repo to hold it.
  const [logo, setLogo] = useState<LogoCommit | null>(null)
  const [logoName, setLogoName] = useState<string | null>(null)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  /** Spec 0218: take a navigation step, refusing further nav input for the
   * window in which the outgoing content is still mounted and clickable. */
  function go(advance: () => void) {
    setBusy(true)
    advance()
    setTimeout(() => setBusy(false), TRANSITION_MS)
  }

  // Validate at the boundary (spec 0148 E2a) BEFORE the bytes are carried into
  // the payload, then base64-encode an accepted file. The re-validation in the
  // start action stays the load-bearing trust check; this one is the fast reason
  // a person sees the moment they pick a bad file.
  async function onLogoFile(file: File | undefined) {
    setLogo(null)
    setLogoName(null)
    setLogoError(null)
    if (!file) return
    const check = validateLogoUpload({ type: file.type, size: file.size })
    if (!check.ok) {
      setLogoError(check.problem)
      return
    }
    setLogo({ path: `public/logo.${LOGO_EXT[file.type] ?? "png"}`, contentBase64: await fileToBase64(file) })
    setLogoName(file.name)
  }

  // The slug follows the name until someone edits it, then it is theirs. It is a
  // SUGGESTION, never a correction: createProject refuses an invalid slug rather
  // than rewriting it, so a project is never addressed by a name nobody chose.
  const effectiveSlug = slugEdited ? slug : suggestSlug(projName)

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await createProjectAction({
      name: projName.trim(),
      slug: effectiveSlug,
      kind: fromUiKind(type as Project["kind"]),
      client: projName.trim(),
      domain: domainName.trim() || null,
      repo: repo.trim() || null,
      productionKind: prodKind,
      productionHost: prodKind === "odoosh" ? prodHost.trim() || null : null,
      // Spec 0191: the five answers, as given. They were collected, shown on the
      // confirm step and dropped here — so "recorded only" recorded nothing.
      intake: answers,
      // Spec 0205. Sent for every kind; the validator drops it for `custom`,
      // which runs no Odoo.
      odooVersion: String(odooVersion),
    }, "derive")
    if (res.ok && res.slug) {
      // Spec 0161 F2/F3b: odoo_next is the only kind that provisions a front
      // stack — kick off the provisioning workflow (carrying the accepted logo)
      // and redirect to its progress view, not the project workspace.
      if (type === "odoo-next") {
        const prov = await startProvisioningAction(res.slug, logo ?? undefined)
        if (!prov.ok) {
          setSubmitting(false)
          setError(prov.problem ?? "No pude iniciar el aprovisionamiento.")
          return
        }
        router.push(`/provisioning/${res.slug}`)
        return
      }
      router.push(`/projects/${res.slug}`)
      return
    }
    setSubmitting(false)
    setError(res.problem ?? "No pude crear el proyecto.")
  }

  const selectedType = SYSTEM_TYPES.find((s) => s.id === type)

  return (
    <div className="min-h-screen mc-grid-bg">
      <TopBar crumbs={[{ label: "Proyectos", href: "/" }, { label: "Nuevo proyecto" }]} user={user} />

      <main className="mx-auto max-w-3xl px-5 pb-24 pt-8">
        {/* Progress header */}
        <div className="mb-8 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-brand">
          <Wand2 className="h-4 w-4" /> Magia
        </div>
        <Steps step={step} />

        <AnimatePresence mode="wait">
          {/* STEP 1 — TYPE */}
          {step === "type" && (
            <Panel key="type">
              <h1 className="text-2xl font-semibold text-foreground">¿Qué vamos a construir?</h1>
              <p className="mt-1 text-sm text-muted">Elige el tipo de sistema. Los agentes se encargan del resto.</p>
              <div className="mt-6 space-y-3">
                {SYSTEM_TYPES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setType(s.id)}
                    className={`flex w-full gap-4 rounded-xl border p-4 text-left transition-all ${
                      type === s.id ? "border-brand/50 bg-brand/[0.06]" : "border-border bg-card hover:border-border-strong"
                    }`}
                  >
                    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border" style={{ color: s.accent, borderColor: s.accent + "44", background: s.accent + "12" }}>
                      <s.icon className="h-6 w-6" />
                    </span>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-foreground">{s.title}</p>
                        <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-faint">{s.time}</span>
                        {type === s.id && <Check className="ml-auto h-4 w-4 text-brand" />}
                      </div>
                      <p className="mt-1 text-[12px] text-muted">{s.desc}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {s.includes.map((inc) => (
                          <span key={inc} className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-faint">{inc}</span>
                        ))}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              <Nav onNext={() => go(() => setStep("questions"))} nextDisabled={!type} busy={busy} />
            </Panel>
          )}

          {/* STEP 2 — QUESTIONS */}
          {step === "questions" && (
            <Panel key="questions">
              <h1 className="text-2xl font-semibold text-foreground">Cuéntanos del negocio</h1>
              <p className="mt-1 text-sm text-muted">
                {/* Spec 0182 made this line say the answers were only RECORDED,
                    which was true and is no longer: spec 0205 C maps `procesos` to
                    Odoo modules and installs them. The rest still is context, and
                    CFDI is refused by name (it needs a third-party addon), so the
                    copy promises exactly the one thing that happens. */}
                Los <span className="text-brand">procesos</span> que elijas se instalan como módulos de Odoo. El resto queda registrado como contexto para quien trabaje tu <span className="text-brand">{selectedType?.title}</span>.
              </p>

              <div className="mt-5 flex items-center gap-1.5">
                {BUSINESS_QUESTIONS.map((_, i) => (
                  <div key={i} className={`h-1 flex-1 rounded-full ${i <= qIndex ? "bg-brand" : "bg-border"}`} />
                ))}
              </div>

              <AnimatePresence mode="wait">
                <motion.div key={qIndex} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2 }} className="mt-6">
                  <Question
                    q={BUSINESS_QUESTIONS[qIndex]}
                    value={answers[BUSINESS_QUESTIONS[qIndex]!.id] ?? ""}
                    onChange={(v) => setAnswers((a) => ({ ...a, [BUSINESS_QUESTIONS[qIndex]!.id]: v }))}
                  />
                </motion.div>
              </AnimatePresence>

              <div className="mt-8 flex items-center justify-between">
                <Btn variant="ghost" disabled={busy} onClick={() => go(() => (qIndex === 0 ? setStep("type") : setQIndex((i) => i - 1)))}>
                  <ArrowLeft className="h-4 w-4" /> Atrás
                </Btn>
                <span className="text-[11px] text-faint">{qIndex + 1} de {BUSINESS_QUESTIONS.length}</span>
                <Btn variant="primary" disabled={busy} onClick={() => go(() => (qIndex === BUSINESS_QUESTIONS.length - 1 ? setStep("domain") : setQIndex((i) => i + 1)))}>
                  {qIndex === BUSINESS_QUESTIONS.length - 1 ? "Continuar" : "Siguiente"} <ArrowRight className="h-4 w-4" />
                </Btn>
              </div>
            </Panel>
          )}

          {/* STEP 3 — DOMAIN + INFRA */}
          {step === "domain" && (
            <Panel key="domain">
              <h1 className="text-2xl font-semibold text-foreground">Dominio e infraestructura</h1>
              <p className="mt-1 text-sm text-muted">Dónde vive y con qué nombre lo van a encontrar.</p>

              <p className="mt-6 mb-2 text-[11px] uppercase tracking-widest text-faint">Nombre del proyecto</p>
              <input value={projName} onChange={(e) => setProjName(e.target.value)} placeholder="Ej. Distribuidora Client-C"
                className="w-full rounded-lg border border-border bg-card px-3.5 py-2.5 text-[14px] text-foreground placeholder:text-faint outline-none focus:border-brand/40" />

              <p className="mt-6 mb-2 text-[11px] uppercase tracking-widest text-faint">¿Ya tienes dominio?</p>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => setDomain("have")} className={`rounded-xl border p-4 text-left ${domain === "have" ? "border-brand/50 bg-brand/[0.06]" : "border-border bg-card hover:border-border-strong"}`}>
                  <Globe className="h-5 w-5 text-brand" />
                  <p className="mt-2 text-[13px] font-medium text-foreground">Sí, ya lo tengo</p>
                  <p className="text-[11px] text-muted">Lo apuntamos en Hostinger.</p>
                </button>
                <button onClick={() => setDomain("buy")} className={`rounded-xl border p-4 text-left ${domain === "buy" ? "border-brand/50 bg-brand/[0.06]" : "border-border bg-card hover:border-border-strong"}`}>
                  <Sparkles className="h-5 w-5 text-amber" />
                  <p className="mt-2 text-[13px] font-medium text-foreground">Cómpralo por mí</p>
                  <p className="text-[11px] text-muted">Te cotizamos y lo compramos (pronto).</p>
                </button>
              </div>

              {domain && (
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-4">
                  <input value={domainName} onChange={(e) => setDomainName(e.target.value)}
                    placeholder={domain === "buy" ? "client-c.example (revisamos disponibilidad)" : "erp.client-c.example"}
                    className="w-full rounded-lg border border-border bg-card px-3.5 py-2.5 text-[14px] text-foreground placeholder:text-faint outline-none focus:border-brand/40" />
                  {domain === "buy" && domainName && <p className="mt-2 text-[11px] text-brand">✓ {domainName} disponible · $199 MXN/año — se registra al construir</p>}
                </motion.div>
              )}

              {/* Spec 0205: a choice, not a statement. The wizard used to assert
                  "Odoo 18" and store nothing, so every tenant got 18 — including
                  the ones whose addons (docs/ODOO-ADDONS.md) only exist for 19. */}
              {type !== "custom" && (
                <>
                  <p className="mt-6 mb-2 text-[11px] uppercase tracking-widest text-faint">Versión de Odoo</p>
                  <div className="flex flex-wrap gap-2">
                    {SUPPORTED_ODOO_VERSIONS.map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setOdooVersion(v)}
                        className={`rounded-lg border px-3.5 py-2 text-[13px] ${odooVersion === v ? "border-brand/50 bg-brand/[0.06] text-foreground" : "border-border bg-card text-muted hover:border-border-strong"}`}
                      >
                        Odoo {v} CE
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-faint">
                    Se instala esta serie y no se cambia después sin una migración. Los complementos
                    de la empresa (CFDI, tema tipo Enterprise) están hechos para la 19.
                  </p>
                </>
              )}

              <div className="mt-6 rounded-xl border border-border bg-card p-4">
                <p className="mb-3 text-[11px] uppercase tracking-widest text-faint">Infraestructura</p>
                <div className="space-y-2.5 text-[12px]">
                  {/* What the deploy actually stands up. Neon, Cloudflare and
                      Hostinger email used to be listed here and none of them are
                      wired to anything. */}
                  <InfraRow icon={Server} t="VPS Hostinger del pool" note="compartida" />
                  <InfraRow icon={ShieldCheck} t={`Docker + Odoo ${odooVersion} en contenedor`} note="auto" />
                  <InfraRow icon={Database} t="Postgres en la misma VPS, en contenedor" note="auto" />
                  {/* Spec 0225: measured on a live tenant — `ir_mail_server` has 0
                      rows and the `mail` module is `uninstalled`. The step used to
                      promise "mandando correos desde el minuto cero"; nothing sends
                      mail, so it says so instead. The owner, 2026-08-19: do not send mail
                      yet, stop claiming we do. */}
                  <InfraRow icon={Mail} t="Correo saliente: NO configurado" note="pendiente" />
                  {type === "odoo-next" && (
                    <InfraRow icon={Layers} t="Front Next.js en contenedor, con certificado" note="auto" />
                  )}
                </div>
              </div>

              <Nav onBack={() => go(() => setStep("questions"))} onNext={() => go(() => setStep("review"))} nextDisabled={!projName || !domain} busy={busy} />
            </Panel>
          )}

          {/* STEP 4 — REVIEW */}
          {step === "review" && (
            <Panel key="review">
              <h1 className="text-2xl font-semibold text-foreground">Confirma el plan</h1>
              <p className="mt-1 text-sm text-muted">Esto es lo que los agentes van a ejecutar de principio a fin.</p>

              <Card className="mt-6 divide-y divide-border">
                <Summary k="Proyecto" v={projName || "Nuevo proyecto"} />
                <Summary k="Tipo de sistema" v={selectedType?.title ?? ""} />
                {type !== "custom" && <Summary k="Versión de Odoo" v={`${odooVersion} CE`} />}
                <Summary k="Giro" v={answers.giro || "—"} />
                <Summary k="Procesos" v={answers.procesos || "Ventas / CRM"} />
                <Summary k="CFDI 4.0" v={answers.cfdi || "Sí, es indispensable"} />
                <Summary k="Dominio" v={domain === "buy" ? `${domainName || "por definir"} (se compra)` : domainName || "existente"} />
                <Summary k="Marca" v={answers.marca || "—"} />
              </Card>

              {/* Spec 0126 C: the facts a Project needs in the control plane.
                  The repo is VERIFIED against GitHub on submit, so a wrong value
                  fails here instead of at gate 2 an hour into a run. */}
              <div className="mt-5">
                <p className="mb-2 text-[11px] uppercase tracking-widest text-faint">Conexiones</p>
                <Card className="flex flex-col gap-3 p-4">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-muted">Identificador</span>
                    <input
                      value={effectiveSlug}
                      onChange={(e) => { setSlugEdited(true); setSlug(e.target.value) }}
                      placeholder="client-c"
                      className="w-full rounded-lg border border-border bg-card px-3.5 py-2 font-mono text-[13px] text-foreground placeholder:text-faint outline-none focus:border-brand/40"
                    />
                    <span className="text-[11px] text-faint">Se usa en la URL y en el nombre de la base de datos: minúsculas, números y guiones.</span>
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-muted">Repositorio de GitHub <span className="text-faint">(opcional)</span></span>
                    <input
                      value={repo}
                      onChange={(e) => setRepo(e.target.value)}
                      placeholder="example-org/launchpad"
                      className="w-full rounded-lg border border-border bg-card px-3.5 py-2 font-mono text-[13px] text-foreground placeholder:text-faint outline-none focus:border-brand/40"
                    />
                    <span className="text-[11px] text-faint">Verificamos que exista y que el token pueda escribir en él.</span>
                  </label>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-muted">Producción</span>
                    <div className="flex flex-wrap gap-2">
                      {([
                        ["none", "Aún no"],
                        ["odoosh", "odoo.sh del cliente"],
                        ["fleet", "Nuestra flota"],
                      ] as const).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setProdKind(value)}
                          className={`rounded-lg border px-3 py-1.5 text-[12.5px] ${prodKind === value ? "border-brand/50 bg-brand/[0.06] text-foreground" : "border-border bg-card text-muted hover:border-border-strong"}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {prodKind === "odoosh" && (
                      <>
                        <input
                          value={prodHost}
                          onChange={(e) => setProdHost(e.target.value)}
                          placeholder="client@example.com"
                          className="mt-1 w-full rounded-lg border border-border bg-card px-3.5 py-2 font-mono text-[13px] text-foreground placeholder:text-faint outline-none focus:border-brand/40"
                        />
                        <span className="text-[11px] text-faint">Solo para diagnóstico: el deploy lo confirma el estado <code>ci/odoo.sh</code> del commit, no SSH.</span>
                      </>
                    )}
                  </div>
                </Card>
              </div>

              {/* Spec 0161 E2b: the branding logo, only for the odoo_next flow
                  that provisions a front repo to commit it into. */}
              {type === "odoo-next" && (
                <div className="mt-5">
                  <p className="mb-2 text-[11px] uppercase tracking-widest text-faint">Logo de marca <span className="text-faint">(opcional)</span></p>
                  <Card className="flex flex-col gap-2 p-4">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[12px] text-muted">Se sube al repo del front. PNG, JPG, SVG o WebP, máximo 2 MB.</span>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/svg+xml,image/webp"
                        onChange={(e) => onLogoFile(e.target.files?.[0])}
                        className="text-[12.5px] text-muted file:mr-3 file:rounded-lg file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-[12.5px] file:text-foreground hover:file:border-border-strong"
                      />
                    </label>
                    {logoName && !logoError && <p className="text-[12px] text-brand">✓ {logoName}</p>}
                    {logoError && <p className="text-[12px] text-rose">{logoError}</p>}
                  </Card>
                </div>
              )}

              <div className="mt-5">
                <p className="mb-2 text-[11px] uppercase tracking-widest text-faint">
                  {type === "odoo-next" ? "Qué va a correr" : "Qué pasa al crearlo"}
                </p>
                <Card className="divide-y divide-border">
                  {BUILD_PLAN(type, odooVersion).map((s, i) => (
                    <div key={i} className="flex items-center gap-3 p-3 text-[12.5px]">
                      <span className="grid h-6 w-6 place-items-center rounded-full bg-surface text-[10px] text-faint">{i + 1}</span>
                      <s.icon className="h-4 w-4 text-brand" />
                      <span className="text-foreground">{s.t}</span>
                    </div>
                  ))}
                </Card>
              </div>

              {error && (
                <p className="mt-5 rounded-lg border border-rose/30 bg-rose/[0.06] px-3.5 py-2.5 text-[12.5px] text-rose">
                  {error}
                </p>
              )}

              <div className="mt-8 flex items-center justify-between">
                <Btn variant="ghost" disabled={busy} onClick={() => go(() => setStep("domain"))}><ArrowLeft className="h-4 w-4" /> Atrás</Btn>
                <Btn
                  variant="primary"
                  className={`px-5 py-2.5 ${submitting ? "pointer-events-none opacity-60" : ""}`}
                  onClick={submit}
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                  {submitting ? "Creando…" : "Crear proyecto"}
                </Btn>
              </div>
            </Panel>
          )}

        </AnimatePresence>
      </main>
    </div>
  )
}

/**
 * What actually happens when you press the button.
 *
 * This used to promise ten steps — provision a VPS, harden Docker, install CFDI
 * modules, deploy to Vercel, create a Neon database, configure Cloudflare, set
 * up Hostinger email — for every project type. None of that existed. The
 * odoo-next flow runs FIVE phases (`PROVISIONING_PHASES`), and the other two
 * types run no provisioning at all: they create the project and land you in its
 * workspace.
 *
 * Keep this list honest against the phase model. A wizard that overstates what
 * it does is how someone waits for a VPS that is never coming.
 */
function BUILD_PLAN(type: string | null, odooVersion: OdooVersion) {
  // The five phases of `provisionProject`, in order, in the words of what each
  // one does rather than what we wish it did.
  if (type === "odoo-next") {
    return [
      { icon: Package, t: "Crear el repositorio privado en GitHub con el front inicial" },
      { icon: Globe, t: "Apuntar <proyecto>.example.com y <proyecto>.odoo.example.com al servidor" },
      // Spec 0205: the version the customer picked. This line said "Odoo 18" on a
      // confirm screen that had just shown them "Odoo 19 CE" three rows above.
      { icon: Boxes, t: `Levantar Odoo ${odooVersion} + Postgres con certificado` },
      { icon: Layers, t: "Construir y desplegar el front Next.js conectado a ese Odoo" },
      { icon: ShieldCheck, t: "Verificar que ambos nombres resuelven y que el front lee de Odoo" },
    ]
  }
  // odoo simple / a medida: no automated provisioning exists yet. Saying so is
  // better than listing steps nobody runs.
  return [
    { icon: Server, t: "Registrar el proyecto en el control plane" },
    { icon: Package, t: "Vincular su repositorio de GitHub, si diste uno" },
    { icon: Layers, t: "Abrirte su espacio de trabajo: chats, specs, ramas y despliegues" },
    { icon: ShieldCheck, t: "El aprovisionamiento automático de servidor todavía no existe para este tipo — se hace desde el chat del proyecto" },
  ]
}


function Steps({ step }: { step: Step }) {
  // Four steps, not five: the old "Construir" step showed a mocked agent plan
  // advancing on a click. Creating the project now redirects to its real
  // workspace, so a fake progress screen would be a step backwards.
  const order: Step[] = ["type", "questions", "domain", "review"]
  const labels: Record<Step, string> = { type: "Tipo", questions: "Negocio", domain: "Dominio", review: "Confirmar" }
  const idx = order.indexOf(step)
  return (
    <div className="mb-8 flex items-center gap-2">
      {order.map((s, i) => (
        <div key={s} className="flex flex-1 items-center gap-2">
          <div className={`flex items-center gap-2 ${i <= idx ? "text-brand" : "text-faint"}`}>
            <span className={`grid h-6 w-6 place-items-center rounded-full border text-[10px] ${i < idx ? "border-brand bg-brand/20" : i === idx ? "border-brand" : "border-border"}`}>
              {i < idx ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span className="hidden text-[11px] sm:inline">{labels[s]}</span>
          </div>
          {i < order.length - 1 && <span className={`h-px flex-1 ${i < idx ? "bg-brand/40" : "bg-border"}`} />}
        </div>
      ))}
    </div>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}>
      {children}
    </motion.div>
  )
}

function Nav({ onBack, onNext, nextDisabled, busy }: { onBack?: () => void; onNext: () => void; nextDisabled?: boolean; busy: boolean }) {
  return (
    <div className="mt-8 flex items-center justify-between">
      {onBack ? <Btn variant="ghost" onClick={onBack} disabled={busy}><ArrowLeft className="h-4 w-4" /> Atrás</Btn> : <Link href="/"><Btn variant="ghost">Cancelar</Btn></Link>}
      <Btn variant="primary" onClick={onNext} disabled={busy || nextDisabled}>
        Continuar <ArrowRight className="h-4 w-4" />
      </Btn>
    </div>
  )
}

function Question({ q, value, onChange }: { q: any; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <h2 className="text-lg font-medium text-foreground">{q.q}</h2>
      {q.type === "textarea" && (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={q.placeholder} rows={4}
          className="mt-4 w-full resize-none rounded-lg border border-border bg-card px-3.5 py-3 text-[14px] text-foreground placeholder:text-faint outline-none focus:border-brand/40" />
      )}
      {q.type === "text" && (
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={q.placeholder}
          className="mt-4 w-full rounded-lg border border-border bg-card px-3.5 py-2.5 text-[14px] text-foreground placeholder:text-faint outline-none focus:border-brand/40" />
      )}
      {q.type === "choice" && (
        <div className="mt-4 flex flex-wrap gap-2">
          {q.options.map((o: string) => {
            const selected = value.split("|").includes(o)
            return (
              <button key={o} onClick={() => {
                const cur = value ? value.split("|").filter(Boolean) : []
                onChange(selected ? cur.filter((x) => x !== o).join("|") : [...cur, o].join("|"))
              }}
                className={`rounded-lg border px-3 py-2 text-[13px] transition-colors ${selected ? "border-brand/50 bg-brand/[0.08] text-brand" : "border-border bg-card text-muted hover:border-border-strong hover:text-foreground"}`}>
                {selected && <Check className="mr-1 inline h-3 w-3" />}{o}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function InfraRow({ icon: Icon, t, note }: { icon: any; t: string; note: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon className="h-4 w-4 text-purple" />
      <span className="text-foreground">{t}</span>
      <span className="ml-auto text-[11px] text-faint">{note}</span>
    </div>
  )
}

function Summary({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-4 p-3.5 text-[13px]">
      <span className="w-32 shrink-0 text-muted">{k}</span>
      <span className="text-foreground">{v.replace(/\|/g, ", ")}</span>
    </div>
  )
}
