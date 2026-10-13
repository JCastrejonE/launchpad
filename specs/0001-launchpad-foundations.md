---
id: 0001
title: Launchpad foundations (dogfood spec zero)
tenant: launchpad
status: promoted
archived: true
track: 1
requested_by: owner@example.com
approved_by: owner@example.com
---

## Intent
Stand up the monorepo foundations so the spec-driven pipeline can build the
rest of the launchpad through this same process.

## Scope
Monorepo structure, docs/ADRs, spec format, agent conventions, package stubs
(pipeline, agents, fleet-hostinger, github, web), dev infra compose, tenant
stack template. Non-goals: real Hostinger calls, real GitHub App, production
Temporal deployment, any UI beyond a placeholder.

## Acceptance criteria
- [x] `pnpm install && pnpm -r typecheck` passes.
- [x] Dev compose boots Temporal, Postgres, Vault, Traefik.
- [x] A pipeline workflow can be started against a stub target and waits at the
  spec-approval signal. (Exceeded: on 2026-07-03 spec 0002 ran the *full*
  pipeline — draft → gate 1 → initializer → 5 coder increments → CI → gate 2 →
  merge → gate 3 → `promoted`, all three human gates honored, workflow
  COMPLETED.)

## Plan
- [x] Repo layout, docs, spec format, agent conventions
- [x] packages/pipeline: workflow skeleton + activities + spec types
- [x] packages/agents: credential provider (subscription | api-key) + session runner
- [x] packages/fleet-hostinger: typed Hostinger API client stub + provision plan
- [x] packages/github: GitHub App client stub (installs, branches, PRs)
- [x] apps/web: Next.js placeholder with health route
- [x] infra: dev compose + Odoo 17/18/19 tenant template

## Progress
(see Plan — scaffold delivered by initializer session 2026-07-02)

## Handoff log
- **2026-07-02 / initializer:** Scaffold created. Next: wire Temporal worker
  to a real dev server, implement `draftSpec` activity with a live LLM call,
  and run this spec's acceptance criteria end-to-end.
- **2026-07-02 / coder:** Phase 2 core implemented: file-backed spec store
  (+3 passing tests), git helpers, all activities implemented for
  launchpad-target (agent sessions via Claude Agent SDK ^0.3, local-git
  "PR"/merge, pnpm CI), env-fallback credentials (subscription OAuth or API
  key), Temporal worker + CLI (start / approve-spec / approve-pr / promote /
  reject / status). Typecheck green on all 4 packages. Next: boot dev compose,
  run the worker, and exercise a toy spec through all three gates end-to-end.
  Surprises: agent-sdk latest is 0.3.x (not 0.5); pipeline typecheck requires
  `pnpm --filter @launchpad/agents build` first (declaration resolution).
- **2026-07-03 / interactive (dogfood run 1):** Ran spec 0001's acceptance
  criteria end-to-end by driving spec 0002 ("spec inbox page") through the whole
  pipeline with the human at all three gates. Booted `infra/docker-compose.dev.yml`
  (Temporal healthy :7233, UI :8080, Postgres/Vault/Traefik up); `pnpm install`,
  built `@launchpad/agents` then `pnpm -r build`, `pnpm -r test` green; started
  the worker with `LAUNCHPAD_REPO_ROOT`. **Result: the pipeline ran clean on its
  first real run — no pipeline/harness fixes were needed.** The initializer wrote
  a 6-item Plan (checkboxes in `## Plan`, so `countUnchecked` converges), coders
  did one verified increment each, CI (`pnpm -r typecheck && pnpm -r test`) was
  green between every commit, gate-2 merge (`--no-ff`) and gate-3 promote both
  worked; `spec/0002` retained per teardown lifecycle.
  Verified (not fixed) the flagged weak spots against installed
  `@anthropic-ai/claude-agent-sdk@0.3.199`: `session.ts` reads the correct
  `SDKResultSuccess` fields (`type/subtype/result/total_cost_usd/num_turns`);
  `allowedTools` includes `Bash`, so headless sessions can `git commit`/run pnpm
  without a prompt; `draftSpec` created a well-formed spec first try.
  Surprises: (1) **this machine runs Node v20.20.2, not the repo-required Node
  22** — so `packages/agents`, `github`, `fleet-hostinger` test scripts
  (`node --test --experimental-strip-types`) silently run **zero** tests
  (`|| true`-guarded). Only `pipeline` (compile-then-test) and `apps/web` (the
  0002 coder switched it to compile-then-test) actually run tests. Worth a
  follow-up spec: either standardize on the compile-then-`node --test` pattern
  repo-wide or pin Node 22. (2) Nothing auto-loads `.env`; the worker/CLI need it
  sourced into their env (`set -a; source .env; set +a`) — fine for dev, but
  Vault injection (phase 5) will supersede this. (3) `next build` rewrites
  `apps/web/tsconfig.json` and emits `next-env.d.ts` (now gitignored) — expected
  Next 15 behavior; CI uses typecheck+test only, so it doesn't affect the pipeline.

## Phase 3 (Hostinger provisioning) — what it needs first
Ordered, concrete first steps to make `target.kind === "tenant"` work
(everything below currently throws `TODO(phase-3)`):
1. **Real Hostinger client** (`packages/fleet-hostinger/src/client.ts`): implement
   `listVps`/`createVps`/`getVps`/`restartVps`/`createSnapshot` against the VPS
   API; token from Vault `owner/hostinger` (read `HOSTINGER_API_TOKEN` for dev).
   Add a mock/contract test since we can't hit the live API in CI.
2. **VPS lifecycle** (`provision.ts::provisionClientVps` + `deployProductionStack`):
   create+bootstrap a VPS (cloud-init: docker, node agent, hardening), then
   `compose up` the prod stack from `infra/tenant/odoo-stack.tmpl.yml` over SSH,
   rendering `${TENANT}/${STACK}/${ODOO_VERSION}/${DOMAIN}` and injecting
   `${ODOO_DB_PASSWORD}` from Vault at deploy time.
3. **Ephemeral env for tenants** — the tenant branch of the same activities that
   already work for launchpad: `provisionEphemeralEnv` → `createEphemeralStack`
   (restore latest sanitized `pg_dump`+filestore snapshot, `odoo` neutralize,
   checkout `spec/<id>` into `./addons`, register Traefik route
   `spec-<id>.<client>.launchpad.<domain>`); `teardownEnv` → `destroyEphemeralStack`
   (`compose down -v` + drop route). Wire `EphemeralEnv.vpsId`/`buildUrl` through.
4. **Tenant CI** (`activities.ts::runCi`, currently `TODO(phase-4)`): Odoo module
   install/upgrade + unit tests against the ephemeral stack, per-`odooVersion`.
5. **Prod deploy** (`deployToProduction`): rolling redeploy of the prod stack on
   the tenant VPS from merged `main`.
Prereqs that unblock the above: snapshot/sanitizer tooling (nightly `pg_dump` +
filestore → S3, Odoo neutralized mode) and Vault namespace loading for tenants
(`credentials.ts::loadCredential`, currently `TODO(phase-5)` — needed for the
client BYO-api-key path). GitHub App (`@launchpad/github`, `TODO(phase-4)`) is
required before tenant PRs replace the dogfood local-branch "PR".
