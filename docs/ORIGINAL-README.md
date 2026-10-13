# Odoo Launchpad

Deployment platform for custom Odoo instances (odoo.sh-style), with agent-driven
change management as the headline feature: describe a change in plain language →
LLM drafts a spec → human approves → agents implement it on an ephemeral staging
env → CI + PR review → promote to production.

**Core design bet:** one reusable spec-driven pipeline (`packages/pipeline`),
used twice — first to build this launchpad itself (dogfooding), then as the
product's runtime feature for clients.

## Architecture (approved 2026-07-02)

| Decision | Choice |
|---|---|
| Hosting | Launchpad on own general VPS; one VPS per client, provisioned **exclusively via Hostinger API** |
| Isolation | Container-per-tenant (Odoo + Postgres + filestore volume); tenant secrets in the encrypted `secrets` store (spec 0076), `.env` for owner creds (no Vault — see STATUS below) |
| Stack | TypeScript monorepo: Next.js (web) + Auth.js, Temporal OSS self-hosted (workflows), Claude Agent SDK (agents), Postgres + Drizzle (`@launchpad/db`). ("Paperclip" was never built — see STATUS below) |
| Odoo versions | Per-client: 17 / 18 / 19 |
| Git | Client connects GitHub account (GitHub App); existing repo per client; `production` + `spec/<id>` branches |
| Staging | Ephemeral env per approved spec, from sanitized prod snapshot, routed build URL, destroyed on promote/reject |
| Gates | Human approves (1) the spec, (2) the PR. CI: Odoo module install/upgrade + unit tests per commit |
| LLM billing | **Owner mode:** Claude Team plan via OAuth token (`claude setup-token`) — covers launchpad construction and the owner's own pipelines. **Client mode:** BYO Anthropic API key per client |

See `docs/ARCHITECTURE.md` and `docs/DECISIONS.md`.

> **STATUS (2026-07-22 — Phase A shipped; audit + SPEC-ALIGNMENT).** The table
> above is the original 2026-07-02 plan; corrections since (see the
> `docs/DECISIONS.md` alignment notes, `AUDIT-REPORT.md`, `SPEC-ALIGNMENT.md`):
> **auth/DB/audit/secrets now exist** — Auth.js OWNER-session gating on every
> mutating route (specs 0073/0074), `@launchpad/db` (Drizzle:
> `users`/`audit_log`/`secrets`), an `audit_log` write per effectful action
> (0075), and an AES-256-GCM secret store (0076). **Never built** (don't read as
> current): "Paperclip" (audit log is the DB table; the only budget is
> `loop.ts`'s cap), a central Vault (the encrypted `secrets` store replaced it),
> and snapshot/build-URL staging envs (isolation is git worktrees). Per-tenant
> Odoo CI is still phase-4.

## Layout

```
apps/web                 Next.js control plane (dashboard, spec approval, build URLs)
packages/pipeline        Temporal workflow: draft → approve → code → stage → test → PR → promote
packages/agents          Agent harness (Claude Agent SDK) + credential provider (subscription | api-key)
packages/fleet-hostinger Hostinger API adapter: provision/manage client VPSes, tenant stacks
packages/github          GitHub App: repo access, branches, PRs, checks
infra/                   Dev docker-compose (Temporal, Postgres, Vault, Traefik) + tenant stack template
specs/                   Spec documents (the pipeline's unit of work). 0001 = build the launchpad
agents/                  Agent role prompts + handoff conventions (long-running-agent pattern)
docs/                    Architecture, ADRs, spec format
```

## Phases

1. **Foundations** — this scaffold.
2. **Pipeline core, dogfooded** — run `specs/0001` through the pipeline against this repo.
3. **Tenant infra** — Hostinger provisioning, ephemeral envs, build URLs, backups.
4. **Git + CI gates** — GitHub App, Odoo test CI, PR gate, promote.
5. **Productize** — client dashboard, BYO-key onboarding, budgets + audit
   (audit log shipped in Phase A, spec 0075; budgets remain `loop.ts`'s cap),
   rollout to ~10 clients. Per SPEC-ALIGNMENT, this converges on the SPEC's
   `Project` model + mockup IA.

## Dev quickstart

Recommended Node: **22** (see `.nvmrc`, `nvm use`). Test scripts run
`tsc && node --test dist/*.test.js` (no `--experimental-strip-types`), so
`pnpm -r test` runs real, truthful tests on both Node 20 and Node 22 — this
dev machine currently runs Node 20.20.2 by design, and CI must never lie
about that by silently skipping tests.

CI is **local, not GitHub Actions**: `.github/workflows/ci.yml` was removed
(spec 0062 / ADR-024) and GitHub Actions runs nothing for this repo. The real
gates are (1) the pre-PR `runCi` activity on the ephemeral worktree
(`packages/pipeline/src/activities.ts`) — it builds `packages/*` (never
`apps/web`; see `scripts/preflight.sh`'s stale-dist/restart notes on why
`next build` is kept out of routine rebuilds), then runs `pnpm -r typecheck`
and `pnpm -r test` with `TEMPORAL_TEST=1` + `HARNESS_EXEC_COUNT_FILE` skip-proof
mechanics (spec 0010) — and (2) the watcher's post-merge local CI, which writes
the `.preflight/promote-ci-<mergeSha>.json` artifact the gate-3 promote check
reads (ADR-024). A `TEMPORAL_TEST=1` run that silently re-gates the workflow
harness back to all-skipped fails `runCi` instead of looking green.

```bash
pnpm install
cp .env.example .env                        # set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)
pnpm --filter @launchpad/agents build       # pipeline typecheck needs agents' declarations
pnpm -r build && pnpm -r test

./scripts/preflight.sh                      # docker compose up, Temporal reachable, worker running
pnpm --filter @launchpad/web dev            # spec inbox + detail pages at localhost:3000/specs
```

`scripts/preflight.sh` is idempotent — safe to re-run any time you sit down to
work; it only starts what isn't already up (compose services, the worker) and
fails fast with a clear message if `.env`/`CLAUDE_CODE_OAUTH_TOKEN` or
Temporal reachability aren't in place. The worker logs its build id (short
git HEAD sha) at startup; if `preflight.sh` finds a worker process it doesn't
recognize (its own pidfile disagrees with a `pgrep` cross-check), it refuses
to start a second one — a mixed-version pair of workers polling the same
queue was the root cause of a bad merge in spec 0008 — pass `--force` to
override. As of spec 0005, driving the pipeline
(start → approve spec → approve PR → promote, all with reject options) is
done from `apps/web`'s spec inbox and detail pages — the CLI
(`packages/pipeline/dist/cli.js`) still works and is useful for scripting or
exception handling, but is no longer the primary way to run a spec.

### Stale dist / restarting the worker after a pull

Spec 0006 hit a chicken-and-egg: a worker left running across a `git pull`
keeps executing whatever `packages/*/dist` it loaded at startup, with nothing
telling you the checked-out source has moved on. `scripts/preflight.sh` now
guards against this (spec 0007, step 5/6): it compares `packages/pipeline/dist`'s
newest file mtime against the latest commit touching
`packages/{pipeline,agents}/src`, warns if the dist looks older, and — in an
interactive terminal — offers to `pnpm -r build` and stop the tracked worker
process so the next preflight step starts a fresh one.

For the "just get me back to one known-good worker" case (e.g. right after
merging a PR), skip the prompt and run `./scripts/preflight.sh restart`
(spec 0008 item 5): it kills every worker process it can find — its own
tracked pidfile plus any untracked one a `pgrep` cross-check turns up —
rebuilds `packages/*` only (never `apps/web`; its `next build` corrupts the
dev server's `.next` directory), starts exactly one worker, and prints its
build id. It assumes docker/Temporal are already up (skips those checks) and
loads `.env` the same as the rest of the script.

**New semantics after a rebuild+restart only apply going forward.** A workflow
execution that's already running doesn't need to be restarted itself — Temporal
replays its history deterministically against whatever code the worker has
registered and simply resumes with the new code on its next workflow task (the
next signal, timer, or activity completion). But that also means: if you're
mid-way through verifying a behavior change (e.g. spec 0007's `pipelinePhase`
query or its signal-hygiene fix) and only just rebuilt+restarted, an execution
that was started before the restart will only exhibit the new behavior from
that point onward, not retroactively for phases it already passed through.

### Stopping the worker: pause vs. kill

The agent-session activities (`draftSpec`, `runInitializer`, `runCoder`) run
under `AGENT_ACTIVITY_OPTIONS` (`packages/pipeline/src/activity-options.ts`),
which declares a `heartbeatTimeout` of `AGENT_HEARTBEAT_TIMEOUT` (60s) and
heartbeats once per streamed SDK message (`packages/agents/src/session.ts`'s
`onHeartbeat`, wired up in `activities.ts`). This changes how the two ways of
stopping the worker behave, since spec 0005's pausing incident (a force-killed
worker stalled an in-flight activity for the full 30-minute
`startToCloseTimeout` before anything noticed):

- **Graceful stop (preferred): `SIGTERM` / `Ctrl-C`.** The Temporal SDK's
  default signal handling lets the worker finish delivering its current
  activity task and shut down cleanly. No work is lost; a session's
  in-progress commits and handoff notes are preserved as normal. Prefer this
  whenever you're stopping the worker deliberately (e.g. to redeploy or
  restart with new code).
- **Force-kill (`SIGKILL`, crash, OOM): now safe.** Because agent-session
  activities heartbeat every ~60s while streaming, Temporal detects a
  force-killed worker within ~2× the heartbeat timeout (i.e. within roughly
  two minutes) instead of waiting out the 30-minute
  `startToCloseTimeout`. The activity is marked failed and retried once a
  worker (the same one restarted, or another) picks it back up — no manual
  intervention or spec editing required. The trade-off is by design: any
  uncommitted work from the in-flight agent session (a coder session that
  hadn't yet committed, for example) is lost and the retried activity starts
  that session over from the spec's last committed state. If you need to
  preserve partial progress from a specific session, stop gracefully instead.
