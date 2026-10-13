
Repo del frontend git@github.com:example-org/mission-control-template.git
El proyecto debe poder ejecutarse en ambiente local usando docker pre-deployment.

---

## 1. Visión y objetivo

La empresa implementa Odoo y sistemas a medida. Hoy cada proyecto se levanta y mantiene a
mano. Hangar convierte eso en una **plataforma**:

1. **Un solo panel** (launchpad) con todos los proyectos, su salud, su infra y sus agentes.
2. **Arrancar proyectos con un botón** ("Magia"): del negocio del cliente a un Odoo
   en producción (VPS + dominio + Odoo + módulos + marca + correo) sin tocar una terminal.
3. **Conectar proyectos existentes** ("Armar proyecto"): anclar VPS, repos, Neon y Vercel.
4. **Modificar cualquier proyecto por chat** con agentes que siguen SDD y dejan
   especificaciones versionadas.
5. **Automejorarse**: Hangar + Forge es el primer proyecto de sí mismo; sus mejoras salen
   del mismo pipeline SDD.

### Métricas de éxito (v1)
- Tiempo "cero → Odoo en prod con correo" &lt; 30 min sin intervención manual.
- 0 acciones destructivas sin aprobación ni auditoría.
- Un cambio de complejidad media a un proyecto ("agrega filtro por marca") se entrega por
  chat sin que un humano abra un IDE.

---

## 2. Glosario

| Término | Definición |
|---|---|
| **Control plane** | La app Hangar (Next.js + API + Temporal + DB). Gobierna, no ejecuta cargas de clientes. |
| **Data plane** | Donde corren los proyectos: VPS Hostinger (Docker/Odoo), Vercel (front), Neon (DB). |
| **Proyecto** | Una unidad gobernada: un Odoo, un Odoo+Next o un sistema a medida. |
| **Kind** | Tipo de proyecto: `odoo`, `odoo-next`, `custom`, `platform` (Hangar). |
| **SDD** | Spec-Driven Development: pipeline spec → plan → build → review → merge. |
| **Agente** | Worker de Temporal que corre un modelo Claude con herramientas para ejecutar una fase SDD. |
| **Workflow** | Ejecución duradera en Temporal (tiene id, historial, reintentos, señales). |
| **Spec** | Archivo markdown versionado que describe un cambio; lo generan agentes o humanos. |
| **Rama de pruebas** | Copia del proyecto con base de datos **neutralizada** (sin correos/pagos reales). |
| **Neutralizar DB** | Anonimizar/desactivar side-effects de una copia de la BD para pruebas seguras. |
| **Conector** | Módulo que habla con una API externa (GitHub, Hostinger, etc.). |

---

## 3. Arquitectura

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CONTROL PLANE (Vercel)                          │
│                                                                        │
│  Next.js App Router ──────────────┐                                     │
│   · UI (launchpad, workspace)     │  llamadas tRPC/REST                 │
│   · Auth (NextAuth)               ▼                                     │
│  API layer (tRPC / route handlers) ── escribe ──► Postgres (Neon)      │
│   · projects, specs, chats, users, secretos (cifrados)                  │
│                                                                        │
│  Dispara workflows ▼ (Temporal Client)                                  │
└──────────────────────────────────────────────────────────────────────┘
                        │ gRPC
                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     TEMPORAL (orquestador)                              │
│  Workflows: provision, sddPipeline, createTestBranch, emergencyShell… │
│  Task queues ──► Workers                                                │
└──────────────────────────────────────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────────────────┐
        ▼               ▼                           ▼
┌──────────────┐ ┌──────────────┐          ┌──────────────────┐
│ Agent Workers│ │ Infra Workers│          │ Connector Workers │
│ (Claude SDK) │ │ (provisioning)│         │ GitHub/CF/Neon…   │
└──────────────┘ └──────────────┘          └──────────────────┘
        │                │                          │
        ▼                ▼                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       DATA PLANE (por proyecto)                         │
│  VPS Hostinger (Docker: odoo:18 + postgres)  ·  Vercel  ·  Neon         │
│  Cloudflare (DNS/WAF)  ·  Hostinger Mail  ·  Grafana/node-exporter      │
└──────────────────────────────────────────────────────────────────────┘
```

**Principios**
- El control plane es *stateless* salvo por Postgres. Todo lo duradero vive en Temporal + DB.
- Los conectores son **actividades de Temporal** idempotentes y con reintentos, nunca
  llamadas directas desde el request HTTP (los efectos externos no se hacen "en caliente").
- Los secretos por proyecto se guardan cifrados (sobre-cifrado con KMS/secret manager) y
  sólo se descifran dentro de un worker.

---

## 4. Stack tecnológico

| Capa | Elección | Notas |
|---|---|---|
| UI | Next.js 15 (App Router), React 19, Tailwind v4, framer-motion, lucide | Ya en el repo |
| Auth | NextAuth (Auth.js) | Igual que el sitio web de la empresa; passkeys opcional |
| API | tRPC (o route handlers) | Tipado extremo a extremo |
| DB control plane | Postgres (Neon) + Prisma o Drizzle | Migraciones versionadas |
| Orquestación | Temporal (self-host) | Workflows en TypeScript |
| Agentes | `@anthropic-ai/sdk` (o Agent SDK), Claude Opus 4.8 | Herramientas propias |
| Colas/estado | Temporal (no hace falta Redis para el core) | |
| Secretos | Doppler / Infisical / KMS | Nunca en la DB en claro |
| Observabilidad | Grafana + Prometheus (node-exporter, cAdvisor) por VPS | Embeds o proxy |
| Terminal | ssh efímero vía worker + `xterm.js` en el front (WebSocket) | Auditado |
| CI/CD del control plane | Vercel | Ya conectado |

---

## 5. Modelo de datos (control plane)

Esquema lógico (Prisma-ish). Los tipos ya existen en `lib/mock-data.ts` — esto los
formaliza y persiste.

```prisma
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String
  role      Role     @default(MEMBER)   // OWNER | MEMBER | VIEWER
  createdAt DateTime @default(now())
}

model Project {
  id           String   @id @default(cuid())
  slug         String   @unique          // "forge"
  name         String
  kind         Kind                      // odoo | odoo_next | custom | platform
  client       String
  domain       String?
  health       Health   @default(operational)
  description  String
  accent       String
  stack        String[]
  region       String
  version      String
  vpsId        String?
  createdAt    DateTime @default(now())
  branches     Branch[]
  chats        ChatThread[]
  specs        SpecFile[]
  connections  ProjectConnection[]
}

model Vps {
  id         String  @id @default(cuid())
  label      String
  provider   String  @default("hostinger")
  externalId String                    // id en Hostinger
  plan       String
  ip         String
  region     String
  os         String
  docker     Boolean @default(false)
  status     Health
  assignedTo String?                   // Project.id
}

model Integration {          // catálogo global de conectores disponibles
  id       String @id        // "github", "cloudflare"...
  name     String
  category String
}

model ProjectConnection {    // instancia de un conector para un proyecto
  id            String  @id @default(cuid())
  projectId     String
  integrationId String
  status        String                 // connected | action-needed | disconnected
  config        Json                   // repo, zone id, neon project id…
  secretRef     String?                // puntero al secret manager (NO el secreto)
}

model Branch {
  id        String @id @default(cuid())
  projectId String
  name      String
  kind      String                     // production | staging | dev
  status    Health
  commit    String
  message   String
  author    String
  db        String                     // produccion | neutralizada | snapshot
  updatedAt DateTime @updatedAt
}

model ChatThread {
  id          String @id @default(cuid())
  projectId   String
  title       String
  status      sddStatus               // spec | planning | building | review | merged
  createdBy   String
  messages    ChatMessage[]
  specs       SpecFile[]
  workflowId  String?                  // workflow sdd asociado
  createdAt   DateTime @default(now())
}

model ChatMessage {
  id        String   @id @default(cuid())
  threadId  String
  role      String                     // user | agent | system
  content   String
  toolCalls Json?
  createdAt DateTime @default(now())
}

model SpecFile {
  id        String @id @default(cuid())
  projectId String
  chatId    String?
  name      String                     // "0007-terminal-emergencia.md"
  status    String                     // draft | approved | implemented | superseded
  version   String
  author    String
  body      String                     // markdown
  updatedAt DateTime @updatedAt
}

model AgentRun {
  id         String @id @default(cuid())
  projectId  String
  agent      String                    // "Atlas" | "Nova" | "Orion"
  task       String
  workflowId String                    // id en Temporal
  status     String                    // running | queued | completed | failed | waiting-approval
  phase      String
  step       Int
  totalSteps Int
  startedAt  DateTime
}

model AuditLog {
  id        String   @id @default(cuid())
  actor     String                     // user o agente
  action    String                     // "vps.create", "domain.buy", "branch.merge"
  target    String
  metadata  Json
  createdAt DateTime @default(now())
}
```

> Nota: **secretos nunca en la DB en claro.** `secretRef` apunta al secret manager.
> Métricas y logs **no** se guardan aquí: se leen en vivo de Grafana/Loki por proyecto.

---

## 6. Módulos funcionales (por pantalla)

Cada módulo lista: propósito, requisitos, endpoints/acciones y criterios de aceptación.
La UI de referencia ya está en el repo.

### 6.1 Launchpad (`/`)
**Propósito:** panorama de todos los proyectos + entrada a los flujos de alta.
- Grid de proyectos (card con salud, kind, agentes activos, chats abiertos, versión).
- Tira superior: salud global, agentes activos, flotilla VPS, deploys hoy.
- Panel "Agentes en vivo" (Temporal) y "Conexiones · APIs".
- Botón **Agregar proyecto** → menú: *Nuevo proyecto* / *Armar proyecto*.
- **Datos**: `GET /api/projects`, `GET /api/agents/live`, `GET /api/integrations`.
- **Aceptación**: la salud y contadores reflejan estado real (poll cada 10–30 s o SSE).

### 6.2 Nuevo proyecto — "Magia" (`/new`)
**Propósito:** de cero a producción con un botón.
Wizard de 5 pasos (ya maquetado):
1. **Tipo** (`odoo` / `odoo-next` / `custom`).
2. **Preguntas de negocio** (giro, # usuarios, procesos, CFDI, marca) → alimentan el plan.
3. **Dominio + infra** (¿ya tiene dominio? / cómpralo; VPS sugerida del pool; correo).
4. **Confirmar** (resumen + plan de ejecución de agentes).
5. **Construir** (progreso del workflow de aprovisionamiento).
- **Acción**: `POST /api/projects/provision` → dispara `provisionProjectWorkflow` (§10).
- **Aceptación**: al terminar, existe un `Project`, la VPS/Neon/Vercel quedan operativas, el
  dominio apunta a Cloudflare, Odoo manda correo, y el repo de addons existe.

### 6.3 Armar proyecto (`/connect`)
**Propósito:** conectar algo existente.
- Elegir tipo → elegir VPS del pool → anclar repo GitHub → activar Neon/Vercel/Blob/CF.
- **Acción**: `POST /api/projects/connect` → `connectProjectWorkflow`: indexa repo, detecta
  si falta el repo de addons de Odoo, lee estado de Neon/Vercel, crea rama de pruebas.
- **Aceptación**: el proyecto aparece en el launchpad con sus conexiones verdes y su repo indexado.

### 6.4 Workspace del proyecto (`/projects/[id]`)
Tabs (todas maquetadas):

| Tab | Qué hace | Fuente de datos |
|---|---|---|
| **Resumen** | métricas, agentes, infra (medidores CPU/RAM/disco), ramas, accesos rápidos | DB + Grafana + Temporal |
| **Chats · sdd** | crear/continuar hilos; panel de **specs** del hilo y del proyecto; visor `.md` | DB + workflow sdd |
| **Agentes** | workflows de Temporal en vivo: pasos, fase, pausar/reintentar, aprobar | Temporal |
| **Monitoreo** | dashboard Grafana (CPU, RAM, red, disco, req/s, latencia) + rango | Grafana/Prometheus |
| **Logs** | stream `journalctl -f`, niveles, filtro, exportar | Loki/agente en VPS |
| **Repositorio** | árbol, rama prod, repo de addons auto-creado, abrir en GitHub | GitHub API |
| **Ramas & Builds** | crear rama de pruebas (Docker + DB neutralizada), merge, re-neutralizar | Temporal + GitHub |
| **Terminal** | shell SSH efímera auditada (timeout 15 min) | worker SSH + WebSocket |
| **Conexiones** | conectores del proyecto y su estado | DB |
| **Ajustes** | general + automatización (auto-PR, auto-merge, re-neutralizar, alertas) + zona peligro | DB |

---

## 7. Motor SDD (Spec-Driven Development)

Cada cambio a un proyecto pasa por un `ChatThread` con estado:

```
spec ──► planning ──► building ──► review ──► merged
  ▲          │            │           │
  └──── humano puede editar/rechazar en cualquier punto ──┘
```

**Fases y responsables**
1. **spec** — el agente convierte la petición en lenguaje natural en un `SpecFile` (markdown
   con objetivo, requisitos y criterios de aceptación). *Requiere aprobación humana.*
2. **planning** — el agente propone el plan técnico (archivos, migraciones, riesgos).
3. **building** — el agente ejecuta: edita el repo en una rama, corre tests/build.
4. **review** — abre PR; corre lint/tests/`code-review`; puede pedir aprobación.
5. **merged** — merge a `production` y deploy; el `SpecFile` pasa a `implemented`.

**Reglas**
- Todo cambio deja un `SpecFile` versionado en `spec/NNNN-slug.md` dentro del repo del proyecto.
- Los `SpecFile` se listan junto al chat (ya maquetado) y son navegables/aprobables.
- Flags por proyecto (Ajustes): *agentes pueden abrir PRs*, *auto-merge si pasan tests*.

---

## 8. Orquestación con Temporal

**Task queues:** `agents`, `infra`, `connectors`, `sdd`.

### Workflows principales
| Workflow | Dispara | Resumen |
|---|---|---|
| `provisionProjectWorkflow` | `/new` | Aprovisiona todo un proyecto nuevo (§10). |
| `connectProjectWorkflow` | `/connect` | Indexa y ancla un proyecto existente. |
| `sddPipelineWorkflow` | chat | Corre spec→plan→build→review→merge para un `ChatThread`. |
| `createTestBranchWorkflow` | Ramas | Docker + clon de DB neutralizada + rama. |
| `neutralizeDbWorkflow` | Ramas | Anonimiza/deshabilita side-effects de una copia. |
| `emergencyShellWorkflow` | Terminal | Abre sesión SSH efímera auditada, la cierra al expirar. |
| `deployWorkflow` | Redeploy/merge | Build + deploy (Vercel y/o Odoo restart). |
| `selfImproveWorkflow` | Forge | Igual que `sddPipeline` pero sobre el propio repo. |

### Patrones
- **Actividades idempotentes** con `idempotencyKey` (crear VPS 2 veces = 1 VPS).
- **Señales** para aprobación humana: `approveSpec`, `approveMerge`, `cancel`.
- **Heartbeats** en actividades largas (build, provisión) para detectar cuelgues.
- **Reintentos** con backoff en todos los conectores externos.
- **Queries** para que la UI lea el estado del workflow (fase, paso, progreso) sin polling agresivo.

### Contrato UI ↔ Temporal
- La tab **Agentes** hace `describeWorkflow`/query para pasos y fase.
- Los botones "Aprobar spec / Aprobar y continuar" envían una **señal** al workflow.
- `AgentRun` en la DB es una proyección para listar rápido; la verdad está en Temporal.

---

## 9. Conectores (integraciones)

Cada conector = conjunto de **actividades** de Temporal + credencial en el secret manager.
Operaciones mínimas por conector:

| Conector | Operaciones clave |
|---|---|
| **GitHub** | crear repo, crear repo de addons, ramas, commit/push, abrir PR, merge, leer árbol, webhooks |
| **Hostinger** | listar/crear/arrancar/dormir VPS, leer plan/IP/uso, ejecutar comando (SSH), instalar Docker |
| **Cloudflare** | crear zona, records DNS, apuntar dominio, reglas WAF, cache, analytics |
| **Neon** | crear proyecto/branch de DB, connection string, estado, autoscaling |
| **Vercel** | crear proyecto, env vars, disparar/leer deploys, dominios |
| **Vercel Blob** | subir/listar/borrar blobs, uso |
| **Odoo** | instalar módulos, crear DB, aplicar tema/color, config de correo (JSON-RPC/CLI) |
| **Docker** | levantar `odoo:18` + `postgres`, `docker ps`, logs, actualizar imagen |
| **Hostinger Mail** | crear buzón, credenciales SMTP, verificar envío |
| **Registrador dominios** | verificar disponibilidad, comprar, configurar nameservers |
| **Anthropic** | correr agentes (mensajes, tools) |

**Reglas de secretos:** cada `ProjectConnection.secretRef` apunta al secret manager;
las actividades reciben el secreto sólo en runtime; nada se loguea.

---

## 10. Flujo de aprovisionamiento (Magia)

`provisionProjectWorkflow(input)` — pseudo-pipeline (cada paso es una actividad idempotente
con su entrada en `AuditLog`):

```
1.  crear registro Project (health = building)
2.  seleccionar/reservar VPS del pool  (o crear VPS Hostinger)
3.  endurecer servidor + instalar Docker
4.  levantar Odoo 18 CE + Postgres en contenedor
5.  instalar módulos base según respuestas:
      sale, stock, point_of_sale, l10n_mx_edi (si CFDI), account, company_menu
6.  aplicar color/logo de marca (addons/company_theme)
7.  [si odoo-next|custom] crear proyecto Vercel + Neon + repo front; primer deploy
8.  dominio:
      · si lo tiene  → crear zona Cloudflare + records → apuntar
      · si lo compra → verificar disponibilidad → comprar → nameservers → zona → records
9.  correo: crear buzón Hostinger Mail → configurar SMTP en Odoo → enviar correo de prueba
10. crear repo de addons en GitHub (example-org/<slug>-addons)
11. crear rama de pruebas con DB neutralizada (createTestBranch)
12. Project.health = operational; notificar (correo + UI)
```

- **Punto de aprobación** opcional antes del paso 8 si implica gasto (comprar dominio/VPS).
- **Compensaciones (saga):** si falla el paso 8+, no se deja una VPS/dominio huérfano sin
  registrar; cada paso sabe deshacerse o marcar para revisión.

Variantes:
- `odoo` → pasos 1-6, 8-11 (sin Vercel/Neon).
- `odoo-next` → todos.
- `custom` → 1-3, 7-11 (VPS opcional; front Next + Neon el núcleo).

---

## 11. Ramas de prueba, DB neutralizada, addons

- **createTestBranchWorkflow**: instala Docker en la VPS si falta, levanta un Odoo idéntico,
  clona la BD de producción y corre `neutralizeDbWorkflow`.
- **Neutralizar** = desactivar servidores de correo salientes, pasarelas de pago y crons de
  facturación; opcionalmente anonimizar PII. Objetivo: probar sin efectos en el mundo real.
- **Repo de addons**: para `odoo`/`odoo-next`, Forge crea `…-addons` separado del
  core para trabajar sólo sobre los módulos; cada push despliega a la rama de pruebas.
- **Re-neutralizar**: acción en la tab Ramas para refrescar la copia neutralizada.

---

## 12. Terminal de emergencia

- `emergencyShellWorkflow`: crea credencial SSH efímera (o exec en el contenedor), abre un
  canal WebSocket entre el front (`xterm.js`) y un worker; timeout duro de **15 min**.
- **Auditoría**: toda la sesión (comandos + salida) se guarda y se referencia en `AuditLog`.
- **Alcance**: limitado al contenedor/proyecto; sin acceso lateral a otras VPS.

---

## 13. Seguridad y cumplimiento

- **Auth**: NextAuth; roles OWNER/MEMBER/VIEWER; acciones destructivas solo OWNER.
- **RBAC** por proyecto (fase 2): quién puede mergear, abrir terminal, comprar dominios.
- **Secretos**: secret manager + cifrado; rotación; nunca en logs ni en la DB en claro.
- **Auditoría**: `AuditLog` para toda acción con efectos (actor humano o agente).
- **Aprobaciones humanas**: specs, merges a prod, y cualquier gasto (VPS/dominio).
- **Aislamiento**: los agentes trabajan en ramas y DBs neutralizadas por defecto.
- **Rate limits / circuit breakers** en conectores externos.

---

## 14. Observabilidad

- **Grafana + Prometheus** por VPS (node-exporter + cAdvisor). La tab Monitoreo consume
  paneles (embed con token o proxy autenticado desde el control plane).
- **Logs**: agente en la VPS → Loki (o `journalctl` vía SSH); la tab Logs hace tail/stream.
- **Alertas**: reglas (CPU sostenido, 5xx, disco) → correo/UI; pueden **abrir un chat sdd**
  automáticamente (p. ej. "Diagnosticar CPU 88%").
- **Métricas del control plane**: uptime, workflows por estado, tiempo de aprovisionamiento.

---

## 15. API interna (borrador)

REST/tRPC. Todo lo que cause efectos externos responde con un `workflowId` para seguimiento.

```
GET    /api/projects
GET    /api/projects/:id
POST   /api/projects/provision        → { workflowId }
POST   /api/projects/connect          → { workflowId }
GET    /api/projects/:id/metrics      (proxy Grafana)
GET    /api/projects/:id/logs?level=  (stream)
GET    /api/projects/:id/branches
POST   /api/projects/:id/branches     (crear rama de pruebas) → { workflowId }
POST   /api/branches/:id/merge        → { workflowId }
GET    /api/projects/:id/specs
GET    /api/specs/:id
POST   /api/chats                     (nuevo hilo sdd)
POST   /api/chats/:id/messages        → dispara/continúa sddPipeline
POST   /api/workflows/:id/signal      { name, payload }   (approveSpec, approveMerge…)
GET    /api/workflows/:id             (fase, paso, progreso)
POST   /api/projects/:id/terminal     (abrir sesión) → { wsUrl, expiresAt }
GET    /api/vps
GET    /api/integrations
```

---

## 16. Roadmap por fases

**Fase 0 — Fundaciones (control plane real)**
- Migrar el mockup a datos reales: Postgres + Prisma, Auth, tRPC.
- Conectar GitHub y Hostinger (listar VPS, leer repos). Launchpad y Workspace con datos vivos.

**Fase 1 — sdd + Temporal**
- Temporal desplegado; `sddPipelineWorkflow` end-to-end en **un** proyecto piloto.
- Tab Agentes leyendo estado real; aprobaciones por señal; specs versionados en repo.

**Fase 2 — Aprovisionamiento**
- `provisionProjectWorkflow` para `odoo` simple (VPS + Docker + Odoo + módulos + marca + correo).
- Luego `odoo-next` y `custom`. Compra de dominio + Cloudflare.

**Fase 3 — Operación diaria**
- Monitoreo (Grafana), Logs (Loki), Terminal de emergencia, Ramas con DB neutralizada.
- Alertas que abren chats sdd.

**Fase 4 — Automejora y escala**
- `selfImproveWorkflow` sobre Forge. RBAC fino. Multi-usuario. Costos por VPS/proyecto.

---

## 17. Decisiones abiertas / preguntas

1. **Temporal**: ¿Cloud o self-host en una VPS de la empresa? (recomendado: Cloud al inicio).
2. **Secret manager**: Doppler vs Infisical vs KMS del proveedor.
3. **Grafana**: ¿un Grafana central multi-tenant o uno por VPS? (central + datasources por VPS).
4. **Modelo de agentes**: ¿Agent SDK de Anthropic o loop propio sobre Messages API?
5. **Odoo**: ¿siempre CE 18 en Docker, o soportar versiones por proyecto?
6. **Registrador de dominios**: ¿cuál API (Namecheap, Cloudflare Registrar, etc.)?
7. **Aislamiento de agentes**: ¿worktrees por rama, contenedores efímeros, o ambos?

---

## Apéndice A — Correspondencia mockup → real

| En el mockup (`lib/mock-data.ts`) | En real |
|---|---|
| `PROJECTS`, `projectById` | tabla `Project` + `GET /api/projects` |
| `AGENT_RUNS` | proyección de workflows de Temporal |
| `INTEGRATIONS` / `ProjectConnection` | catálogo + conexiones por proyecto (DB) |
| `getMetrics()` | proxy a Grafana/Prometheus |
| `getLogs()` | stream Loki / SSH `journalctl` |
| `SpecFile` | tabla `SpecFile` + archivos en `spec/` del repo |
| `VPS_FLEET` | Hostinger API + tabla `Vps` |
| `BUSINESS_QUESTIONS` | entrada del `provisionProjectWorkflow` |
```
