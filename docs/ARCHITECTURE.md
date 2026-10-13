# Architecture

> **ALIGNMENT (2026-07-22 — Phase A + audit + SPEC-ALIGNMENT).** This doc
> predates Phase A (specs 0072–0076); read it with these corrections (details:
> the `docs/DECISIONS.md` alignment notes, `AUDIT-REPORT.md`, `SPEC-ALIGNMENT.md`):
> - **Auth exists.** Auth.js OWNER-session gating now guards every mutating
>   route/action (specs 0073/0074). The old header-derived "localhost/loopback"
>   guard was spoofable (audit #2) and is **deleted** — request headers are never
>   an authorization signal. Where this doc says "needs auth", "loopback", or
>   `SUPERVISOR_CONSOLE_ENABLED + loopback`, the real gate is a signed-in OWNER
>   session, and the recorded actor is the session email (`GATE_ACTOR_EMAIL`
>   retired).
> - **DB + audit + secrets shipped.** `@launchpad/db` (Drizzle) holds
>   `users`/`audit_log`/`secrets`; every effectful web action writes an
>   `audit_log` row (0075); tenant secrets live in an AES-256-GCM `secrets`
>   table (0076).
> - **Never built (don't read as current):** "Paperclip" (the audit log is the
>   DB table; the only budget is `loop.ts`'s coder-iteration cap), a central
>   "Vault" (a minimal encrypted store shipped instead — ADR-005 note), and the
>   snapshot/sanitizer/build-URL ephemeral envs (isolation is git worktrees).
>   The supervisor-in-UI console is frozen/off-roadmap (ADR-022 note).

## Components

```
┌─ Launchpad VPS (yours) ──────────────────────────────────────────┐
│  apps/web (Next.js)      dashboards, spec approval, Auth.js       │
│                          OWNER/MEMBER/VIEWER sessions (0073/0074)  │
│  Temporal OSS            durable pipeline state machine           │
│  Claude Agent SDK        agent sessions (no "Paperclip"; budgets  │
│                          = loop.ts cap; audit log = DB table)     │
│  Postgres + Drizzle      launchpad state: users, audit_log,       │
│  (@launchpad/db)         secrets (AES-256-GCM, 0076), chat threads│
│  .env                    owner creds + secret master key (no      │
│                          central Vault — ADR-005 note)            │
└──────────────┬───────────────────────────────────────────────────┘
               │ Hostinger API (exclusively)
┌─ Client VPS (one per client, Hostinger) ─────────────────────────┐
│  Traefik                 routes prod + spec-<id> build URLs      │
│  Production stack        odoo:{17|18|19} + postgres + filestore  │
│  Ephemeral spec stacks   cloned from sanitized prod snapshot     │
└──────────────────────────────────────────────────────────────────┘
```

## Product split: Hangar vs Forge (ADR-019)

The monorepo ships two named products out of this one codebase; the split
is a module/route ownership boundary, not a package or deploy boundary —
both still run on the single Launchpad VPS stack shown above.

| Product | Owns | Routes |
|---|---|---|
| **Hangar** | the VPS fleet + Odoo tenant deploy admin surface: `packages/fleet-hostinger`, `infra/tenant/`, `infra/fleet-sandbox.json`, the fleet scripts | `/fleet` + the deploy form |
| **Forge** | the chat-first code pipeline: `packages/pipeline`, `packages/agents`, `packages/github`, `specs/`, the supervisor scripts | `/forge` (`ForgeChat`, assistant-ui, when `SUPERVISOR_CONSOLE_ENABLED` + an OWNER session — spec 0074; else `ChatThread` — spec 0060/0067) + `/api/chat` + `/forge/specs` |

One crossing is deliberate and retained, not a boundary violation: the
Hangar Deploy-tenant form STARTING a `specPipeline` run is "Hangar invokes
Forge" — a fleet action kicking off a pipeline run (the autopilot story).
No other crossing exists between the two surfaces.

Per ADR-019's amendment to ADR-011/spec 0025, the IA flip has SHIPPED (spec
0038): `/` IS the Hangar dashboard, the Forge chat moved to `/forge`, and the
spec inbox moved to `/forge/specs`; `/fleet`, `/specs`, and `/chat` are now
308 redirect stubs. See "From chat to production" below. Per spec 0060,
`/forge` also IS the supervisor console's home: `SUPERVISOR_CONSOLE_ENABLED` +
a loopback request renders `ForgeChat` (`components/forge/ForgeChat.tsx`, spec
0067 — an `@assistant-ui/react` shell over the SAME `/api/supervisor` bridge,
now with owner-scoped thread persistence in the launchpad Postgres and
per-thread Claude Agent SDK session continuity via `Options.resume`, replacing
the retired `SupervisorConsole.tsx`); everyone else (the default) still gets
the Forge chat described below. `/forge/supervisor` is now a 308 redirect
stub to `/forge`, same pattern as `/fleet`/`/specs`/`/chat`.

## Pipeline (packages/pipeline, Temporal workflow)

`draftSpec → [signal: specApproved] → provisionEphemeralEnv → runInitializer
→ loop(runCoder → ci) → openPR → [signal: prApproved] → promote → teardown`

- Approvals are Temporal **signals** sent by apps/web — the workflow can wait
  days without burning resources.
- Every LLM/agent step is an **activity** (retryable, side-effectful).
- The same workflow runs with `target: {kind: "self", repo}` (dogfood) or
  `target: {kind: "tenant", …}` (product feature). Target decides repo, env,
  credentials. Per ADR-019, `self` renames the prior `"launchpad"` literal —
  the rename plus an `isSelfTarget()` shim that also accepts the legacy
  literal (in-flight-run wire compat) land in the next spec of this batch;
  today's code still uses `"launchpad"`. A human-gated `product: hangar |
  forge | both` frontmatter facet (self targets only, confirmed at gate 1,
  read via `provisionEphemeralEnv`'s activity OUTPUT — the same channel
  ADR-018 proved for `ui_only`) records which product a self-run changes; it
  is a facet, not a third target kind, because a Hangar-change run and a
  Forge-change run are behaviorally identical. A reserved, unparsed `mode:`
  frontmatter key anticipates future Forge scope-limiting modes (e.g.
  forge-self / hangar-app / fleet+tenants): per ADR-019 a mode may only flow
  activity output → `EphemeralEnv` → activity behavior (prompt/tool/path-fence),
  never a `workflow.ts` file read or a `target.kind` branch — and a mode
  requiring a different GATE STRUCTURE (e.g. skipping gate 2) is a
  Temporal-versioned workflow change, not "just a mode."

### Tenant-target MVP semantics (spec 0026)

`workflow.ts` never branches on `target.kind` — every difference lives in
`packages/pipeline/src/activities.ts`, so there are no Temporal
versioning/patching concerns. As of spec 0026 (MVP depth), a `target: tenant`
run (started via `cli start-tenant <specId> "<request>" --tenant <id>
--vps-id <n> [--odoo-version <17|18|19>]`) behaves as follows, gated
identically to a `launchpad` run at every step:

- **Repo/env/CI/PR (gates 1-2) — reuse launchpad, unchanged.** `repoRootOf`
  resolves tenant targets to `input.target.repo` (today, the launchpad
  checkout itself — tenant spec docs live in this repo's `specs/` per
  `docs/SPEC_FORMAT.md`'s `tenant:`/`odoo_version:` frontmatter).
  `accountIdOf` resolves the `"owner"` LLM credential for tenant runs (Vault
  per-tenant credentials are `TODO(phase-5)`; the real per-tenant value would
  hit `loadCredential`'s unimplemented throw). `provisionEphemeralEnv` gives
  tenant runs the same launchpad worktree (`buildUrl: "local"`), threading
  `env.vpsId` from `input.target.vpsId` for later use. `runCi` and
  `openPullRequest` run their launchpad bodies unconditionally — a tenant run
  is CI-verified and PR-reviewed exactly like a launchpad one. Real
  per-tenant repos (ADR-009), per-tenant Odoo module CI, and true ephemeral
  `spec-<id>` tenant stacks on the client VPS are `TODO(phase-4)`.
- **Deploy (gate 3) — the real thing, via the proven fleet layer.** For
  tenant targets, `deployToProduction` performs the exact sequence proven by
  `scripts/fleet-bootstrap-smoke.mjs` (specs 0011-0014): resolve the
  Hostinger token → `HostingerClient.getVps(vpsId)` for the IPv4 → build an
  `ExecSshRunner` from worker env `LAUNCHPAD_FLEET_SSH_IDENTITY` /
  `LAUNCHPAD_FLEET_SSH_USER` → `provisionClientVps` (bootstrap, idempotent) →
  `readOrCreateDbPassword(tenantId)` → `deployProductionStack` (Odoo DB init +
  the fleet layer's own HTTP readiness check). Fleet errors map through
  `toActivityFailure` (`@launchpad/fleet-hostinger`) to an `ApplicationFailure`
  with the correct retryable flag, so retries are safe (the fleet layer is
  idempotent) and a sandbox refusal (non-allowlisted `vpsId`) fails
  non-retryably without a second allowlist in this package. `domain` is a
  fixed cosmetic sandbox value (`TENANT_DEPLOY_DOMAIN`) — real DNS/Traefik
  domains are a later spec. Launchpad-target `deployToProduction` is
  unchanged: merge IS the deploy, and it returns immediately.
- **Deferred to later phases, not in this MVP:** real per-tenant repos and
  GitHub Apps, per-tenant Odoo CI, ephemeral tenant stacks and their destroy
  semantics, Vault-backed per-tenant credentials (LLM + Hostinger token stays
  env-resolved), and any apps/web surface for tenant deploys (needs auth).
  Gate discipline is unchanged throughout: every gate, including gate 3's
  live deploy, is a human click in apps/web — the supervisor never sends a
  gate signal.
- **New-spec drafting (spec 0029).** `draftSpec` harness-commits a
  newly-drafted spec to `main` at draft time (not just gate-1 approval time),
  so a `target: tenant` run's gate-1 worktree — cut from `main` before the
  agent session runs — always contains the spec file; the `/forge/specs/<id>`
  page shown right after submitting the /fleet Deploy form renders a
  "Drafting spec…" state that auto-refreshes until the file lands, instead of
  a 404.

## From chat to production (who runs what)

The chat surface (`/forge`, ADR-011) is a *steering* layer over the pipeline
above. It never edits code or advances a gate itself — it starts runs, reads
state, and renders gate cards whose buttons the human clicks. (Per spec 0060,
`/forge` renders this chat only when `SUPERVISOR_CONSOLE_ENABLED` is unset or
the request is non-loopback; the gated-on localhost owner instead gets the
supervisor console at the same URL — see the product-split section above.)
End to end:

1. **You type in the chat composer** (`/forge`). The browser POSTs to `/api/chat`.
   The **chat assistant** — `resolveChatModelId()`, default `claude-sonnet-5`
   (env `LAUNCHPAD_MODEL_CHAT`) — runs server-side on the **owner** credential
   (`loadCredential("owner")`). It is a thin tool-calling layer over 7
   whitelisted tools and can NEVER fire `specApproved`/`prApproved`/`promote`
   (invariant unit-tested in `apps/web/lib/chat-tools.ts`).
2. **Describe a change** → the assistant calls the `startPipeline` tool →
   `apps/web/lib/pipeline.ts startPipeline(specId, request)` → starts the
   Temporal `specPipeline` workflow (`workflowId spec-<id>`). (The
   `/forge/specs` page's "New change" button just links back here — chat is
   the single create surface, spec 0025.)
3. **Draft** — `draftSpec` runs the **spec-drafter** (`claude-sonnet-5`),
   writing `specs/NNNN-slug.md` (`status: draft`), then parks at **gate 1**.
4. **Gate 1 — spec approval (human)** — you approve/reject via a button (the
   spec page's gate bar or the chat's `renderSpecDraftCard` card); either
   sends `signalGate` stamped with your OWNER **session** email (spec 0074;
   `GATE_ACTOR_EMAIL` retired), and records an `audit_log` row (spec 0075).
5. **Build** — `provisionEphemeralEnv` → **initializer** (`claude-opus-4-8`)
   lays foundations + the Progress checklist → **coder** increments
   (`claude-sonnet-5`; `[docs]` items on `claude-haiku-4-5`), each CI-verified
   in a loop; a failed/stalled increment gets one **fixer** round
   (`claude-opus-4-8`, spec 0018).
6. **Gate 2 — PR review (human, on GitHub)** — `openPullRequest` opens a real
   PR; `awaitPrApproval` polls it. Per ADR-016 your **merge is the approval**
   (`prApproved` stays the in-app escape hatch); `mergePullRequest` then syncs
   `main` (and installs new deps, spec 0023).
7. **Gate 3 — promote (human)** — parks at `awaiting_promotion`; only your
   Promote click (spec page or the chat's `renderPromoteCard`) sends
   `promote` → deploy → `promoted` → `teardownEnv` (always runs).

So the chat model only orchestrates; the actual change is produced by the
pipeline roles (spec-drafter → initializer → coders → fixer), identical to any
other entry point.

## Agent credentials (packages/agents)

| Mode | Who | Mechanism | Bills to |
|---|---|---|---|
| `subscription` | Owner (launchpad construction + owner's own pipelines) | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, read from `.env` by `credentials.ts` (no Vault — ADR-005 note) | Claude Team plan usage limits |
| `api-key` | Clients | `ANTHROPIC_API_KEY` — tenant credentials are phase-4 (`loadCredential` throws today); per-project secrets use the encrypted `secrets` store (spec 0076) | Client's own Anthropic Console account |

Policy note (verified 2026-07): Agent SDK usage under a subscription currently
draws from plan usage limits and is officially supported; shared production
automation for third parties must use API keys — hence client mode is BYO key.

## Model policy (packages/agents)

Model choice is an explicit, per-role decision, not the account default.
`modelForRole(role, overrides?)` in `packages/agents/src/models.ts` resolves
it: an explicit override wins, else the role's documented default.

| Role | Default model | Rationale |
|---|---|---|
| `initializer` | `claude-opus-4-8` | Runs once per spec; its plan quality compounds downstream through every coder increment that follows — pay the premium. |
| `coder` | `claude-sonnet-5` | Runs many times on small, CI-verified increments — optimized for cost/quality at that grain, not one-shot plan quality. |
| `spec-drafter` | `claude-sonnet-5` | Output is human-gated at gate 1 (spec approval) before any code is written, so a mid-tier model is enough. |
| `fixer` | `claude-opus-4-8` | One repair round on a coder failure / CI-red-twice (spec 0018). Diagnosis quality compounds through the coder retry that follows, so it defaults to the initializer's premium model. |
| _docs coder_ | `claude-haiku-4-5` | `[docs]`-tagged plan items are pure-docs increments (spec 0007) — the cheapest tier is enough. Selected inside the coder role, not a separate `AgentRole`. |
| _chat assistant_ (apps/web) | `claude-sonnet-5` | Not an `AgentRole`: the `/api/chat` tool-calling layer, resolved by `resolveChatModelId()` (`lib/chat-model.ts`), env `LAUNCHPAD_MODEL_CHAT`. It only orchestrates tools — the real work is done by the pipeline roles above. |

Overrides, highest precedence first:

1. **Per-account**: `AccountLlmConfig.modelOverrides` (`Partial<Record<AgentRole, string>>`).
2. **Dev/owner env fallback**: `LAUNCHPAD_MODEL_INITIALIZER`, `LAUNCHPAD_MODEL_CODER`,
   `LAUNCHPAD_MODEL_SPEC_DRAFTER`, read by `loadCredential`'s owner fallback
   path via `modelOverridesFromEnv`.
3. Documented default above.

Non-goals (see spec 0004): dynamic per-task model routing, budget enforcement
(Paperclip, phase 5), UI for overrides (apps/web, phase 5).

## Ephemeral envs

> **STATUS: NOT BUILT (ADR-020).** The snapshot / sanitizer / build-URL design
> below was never implemented, and its template scaffolding was deleted. Tenant
> deploys are **vanilla stock Odoo on a fresh empty DB** — no snapshot restore,
> no neutralize, no `spec-<id>` build URL (see
> `packages/pipeline/src/activities.ts`, ADR-020/021). This section is retained
> as the phase-3/4 target, not current behavior.

1. Nightly backup: `pg_dump` + filestore snapshot → S3-compatible storage.
2. On spec approval: restore latest snapshot on client VPS, run sanitizer
   (neutralize crons/mail servers, scrub tokens — Odoo "neutralized" mode),
   start `spec-<id>` stack, register Traefik route
   `spec-<id>.<client>.launchpad.<domain>`.
3. On promote/reject: stack destroyed, volumes pruned; branch retained.

## Gates

1. **Spec approval** — human edits/approves the drafted spec in apps/web.
2. **PR review** — human reviews the agent's PR; CI must be green. (CI today is
   the launchpad `runCi`: build `packages/*` + `pnpm -r typecheck && pnpm -r test`;
   per-tenant Odoo module install/upgrade + unit tests is phase-4 TODO, not yet
   run — ADR-020.) Merge → eligible for promotion.
Promotion itself is a human click in apps/web; agents cannot call it.
