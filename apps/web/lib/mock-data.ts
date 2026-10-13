// ─────────────────────────────────────────────────────────────────────────
// Mission Control — capa de datos MOCK
// Todo esto es maquetado. El backend real (Temporal, GitHub, Hostinger,
// Cloudflare, Neon, Vercel...) lo conecta el socio sobre estas mismas formas.
// ─────────────────────────────────────────────────────────────────────────

export type Health = "operational" | "degraded" | "building" | "down" | "sleeping"
export type ProjectKind = "odoo" | "odoo-next" | "custom" | "platform"

export interface Integration {
  id: string
  name: string
  category: "infra" | "code" | "data" | "cdn" | "deploy" | "ai" | "comms" | "dns"
  status: "connected" | "action-needed" | "disconnected"
  detail: string
  accent: string
}

export interface Branch {
  name: string
  kind: "production" | "staging" | "dev"
  status: Health
  commit: string
  message: string
  author: string
  updated: string
  db: string // estado de la base de datos (neutralizada, prod, etc.)
}

export interface AgentRun {
  id: string
  agent: string
  task: string
  workflow: string // Temporal workflow id
  status: "running" | "queued" | "completed" | "failed" | "waiting-approval"
  phase: string
  progress: number
  started: string
  step: number
  totalSteps: number
}

export interface ChatThread {
  id: string
  title: string
  status: "spec" | "planning" | "building" | "review" | "merged"
  lastMessage: string
  updated: string
  messages: number
  spec?: string
}

export interface SpecFile {
  id: string
  name: string // ej. 0007-terminal-emergencia.md
  status: "draft" | "approved" | "implemented" | "superseded"
  version: string
  author: string // agente o humano que lo escribió
  updated: string
  summary: string
  body: string // contenido markdown del spec
  chatId?: string // hilo SPDD que lo originó
}

export interface Project {
  id: string
  name: string
  kind: ProjectKind
  client: string
  domain: string
  health: Health
  description: string
  accent: string
  stack: string[]
  vps?: string
  region: string
  version: string
  lastDeploy: string
  openChats: number
  activeAgents: number
  branches: Branch[]
  integrations: string[] // ids de Integration
  metrics: { label: string; value: string; sub?: string }[]
  chats: ChatThread[]
  specs: SpecFile[]
}

export const INTEGRATIONS: Integration[] = [
  { id: "github", name: "GitHub", category: "code", status: "connected", detail: "example-org · 14 repos", accent: "var(--color-foreground)" },
  { id: "hostinger", name: "Hostinger VPS", category: "infra", status: "connected", detail: "6 VPS · KVM", accent: "var(--color-purple)" },
  { id: "cloudflare", name: "Cloudflare", category: "cdn", status: "connected", detail: "8 zonas · WAF activo", accent: "var(--color-orange)" },
  { id: "neon", name: "Neon Postgres", category: "data", status: "connected", detail: "5 proyectos serverless", accent: "var(--color-brand)" },
  { id: "vercel", name: "Vercel", category: "deploy", status: "connected", detail: "9 deployments", accent: "var(--color-foreground)" },
  { id: "vercel-blob", name: "Vercel Blob", category: "data", status: "connected", detail: "12.4 GB almacenados", accent: "var(--color-blue)" },
  { id: "temporal", name: "Temporal", category: "ai", status: "connected", detail: "orquestador de agentes", accent: "var(--color-cyan)" },
  { id: "anthropic", name: "Claude / Anthropic", category: "ai", status: "connected", detail: "Opus 4.8 · agentes SPDD", accent: "var(--color-amber)" },
  { id: "hostinger-mail", name: "Hostinger Mail", category: "comms", status: "connected", detail: "correo transaccional", accent: "var(--color-purple)" },
  { id: "docker", name: "Docker Registry", category: "infra", status: "connected", detail: "imágenes odoo:18", accent: "var(--color-blue)" },
  { id: "odoo", name: "Odoo", category: "deploy", status: "connected", detail: "CE 18 · módulos base", accent: "var(--color-purple)" },
  { id: "namecheap", name: "Registro de dominios", category: "dns", status: "action-needed", detail: "2 dominios por renovar", accent: "var(--color-rose)" },
]

export function integrationById(id: string) {
  return INTEGRATIONS.find((i) => i.id === id)
}

export interface Vps {
  id: string
  label: string
  provider: "Hostinger"
  plan: string
  ip: string
  region: string
  status: Health
  cpu: number
  ram: number
  disk: number
  os: string
  docker: boolean
  assignedTo?: string
}

export const VPS_FLEET: Vps[] = [
  { id: "vps-01", label: "company-core", provider: "Hostinger", plan: "KVM 4", ip: "203.0.113.41", region: "São Paulo", status: "operational", cpu: 34, ram: 58, disk: 41, os: "Ubuntu 24.04", docker: true, assignedTo: "Mission Control" },
  { id: "vps-02", label: "odoo-client-e", provider: "Hostinger", plan: "KVM 8", ip: "203.0.113.42", region: "São Paulo", status: "operational", cpu: 62, ram: 71, disk: 55, os: "Ubuntu 24.04", docker: true, assignedTo: "Client E" },
  { id: "vps-03", label: "odoo-client-f", provider: "Hostinger", plan: "KVM 4", ip: "203.0.113.43", region: "México", status: "operational", cpu: 28, ram: 44, disk: 33, os: "Ubuntu 24.04", docker: true, assignedTo: "Client F" },
  { id: "vps-04", label: "odoo-client-g", provider: "Hostinger", plan: "KVM 2", ip: "203.0.113.44", region: "México", status: "degraded", cpu: 88, ram: 92, disk: 78, os: "Ubuntu 24.04", docker: true, assignedTo: "Client G" },
  { id: "vps-05", label: "pool-libre-a", provider: "Hostinger", plan: "KVM 4", ip: "203.0.113.45", region: "São Paulo", status: "sleeping", cpu: 2, ram: 8, disk: 12, os: "Ubuntu 24.04", docker: false },
  { id: "vps-06", label: "pool-libre-b", provider: "Hostinger", plan: "KVM 8", ip: "203.0.113.46", region: "México", status: "sleeping", cpu: 1, ram: 6, disk: 9, os: "Ubuntu 24.04", docker: false },
]

// Spec 0084 (C.4a): the mock `PROJECTS` array, `projectById()` and the
// `AGENT_RUNS` samples are DELETED. The Launchpad and the workspace read real
// `projects` rows now (via `lib/project-view.ts`), and nothing writes
// `agent_runs` until Phase D — so live runs render an honest empty state
// instead of samples. The interfaces above stay: they are the display contract
// the adapter targets.
//
// What remains below is still genuinely mock, and still consumed:
//   VPS_FLEET          → /connect + workspace infra      (real in C.4b)
//   INTEGRATIONS       → the platform integration catalogue
//                        (per-project state becomes real in Phase E)
//   BUSINESS_QUESTIONS → the /new wizard (input to provisionProjectWorkflow)

// Preguntas de negocio del wizard (estilo Hostinger Horizons)
export interface WizardQuestion {
  id: string
  q: string
  placeholder: string
  type: "text" | "textarea" | "choice"
  options?: string[]
}

export const BUSINESS_QUESTIONS: WizardQuestion[] = [
  { id: "giro", q: "¿A qué se dedica el negocio?", placeholder: "Ej. Distribuidora de gas LP con 3 sucursales…", type: "textarea" },
  { id: "empleados", q: "¿Cuántas personas lo van a usar?", placeholder: "", type: "choice", options: ["1–5", "6–20", "21–50", "50+"] },
  { id: "procesos", q: "¿Qué procesos quieres administrar?", placeholder: "", type: "choice", options: ["Ventas / CRM", "Inventario / Almacén", "Punto de venta (POS)", "Facturación electrónica (CFDI)", "Compras", "Contabilidad", "RRHH / Nómina", "Proyectos"] },
  { id: "cfdi", q: "¿Necesitas facturación electrónica (CFDI 4.0)?", placeholder: "", type: "choice", options: ["Sí, es indispensable", "Más adelante", "No"] },
  { id: "marca", q: "¿Tienes colores o logo de marca?", placeholder: "Ej. #7C3AED, logo en PDF adjunto", type: "text" },
]
