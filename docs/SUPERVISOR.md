# SUPERVISOR — operating playbook + CLI reference

The supervisor's working manual: the commands and tools used to drive a
`specPipeline` run end-to-end, recover from crashes, and keep the box healthy.
Grounded in the actual code (`packages/pipeline/src/cli.ts`,
`scripts/*.mjs|*.sh`) — flags and exit codes here are exact. This is a
reference for the **human/chat supervisor** and the **in-UI supervisor**
(`agents/supervisor.md`); keep it in sync with those sources when they change.

> **ALIGNMENT (2026-07-22 — ADR-022/025 notes; specs 0070/0074).** The in-UI
> supervisor console is **frozen / off-roadmap** (SPEC-ALIGNMENT §4/§7): don't
> extend it — its SSE bridge is to be harvested for the SPEC's per-project
> "Agentes" tab, then the standalone console retired. Security floor kept
> meanwhile: the supervisor's Bash tool runs behind a `canUseTool` deny-list
> (spec 0070 — no pipeline gate verbs, no `git push`, no file-write redirection)
> and every console route requires a signed-in **OWNER session** (spec 0074 — the
> old loopback/header guard is deleted). So where this playbook says
> `SUPERVISOR_CONSOLE_ENABLED` + loopback or `GATE_ACTOR_EMAIL`, the real gate is
> flag + OWNER session and the actor is the verified session email.

## Hard rules (never violated)

1. **The supervisor NEVER clicks or signals a gate.** Gate 1 (approve spec),
   gate 2 (approve/merge PR — on GitHub), gate 3 (promote) are the human's, in
   apps/web or GitHub. Tools only *cue* gates. The pipeline CLI *has*
   `approve-spec`/`approve-pr`/`promote` verbs (bootstrap/testing only) — do
   not use them to advance a real run.
2. **Specs come from the architect** (Fable 5, execution-free, ADR-015). The
   supervisor executes/commits; it does not write specs.
3. **Never touch secrets / `.env` / the secret store.** Credentials come from
   the harness (`credentials.ts`); per-project secrets from the encrypted
   `secrets` store (`@launchpad/db`, spec 0076). (No Vault — ADR-005 note.)
4. **Fleet mutations only on sandbox VPS** in `infra/fleet-sandbox.json`
   (ADR-013). Prod (100002) is a hard refusal; sandbox is 100001.
5. **Keep `main == origin` and the tree clean before/through a run** — a dirty
   primary checkout or local-only commits break `mergePullRequest`
   (see the memory notes).

## The run cadence (end-to-end)

1. **Preflight:** `bash scripts/preflight.sh` (infra + worker + dev server).
2. **Clean check:** `git status --porcelain` empty, `main == origin`.
3. **Start + watch:** launch `supervise.mjs <specId>` as a tracked background
   task. It starts the run, parks at gate 1, and cues each gate.
4. **The owner clicks gate 1** (Approve spec) in apps/web → coder loop runs.
5. **The owner clicks gate 2** (approve + merge the PR on **GitHub**). The watcher
   runs a mechanical review first; its CI note names the pipeline's pre-PR
   `runCi` (build+typecheck+skip-proof test, already green before the PR
   opened) as the pre-merge check — GitHub Actions is retired as a CI source
   (spec 0058, ADR-024) and is no longer polled here.
6. **Polish point** (apps/web specs only): by default (spec 0064) the watcher
   auto-spawns the bounded `uiux-coder` agent in place, which does the
   impeccable polish pass, commits to `main`, and hands back; the watcher
   re-runs `postMerge()` (below) on the polished tip and pushes, all in one
   process — no pause, no hands-on step. Only with `--manual-polish` does the
   watcher still exit 7 for a hands-on pass (do the impeccable pass yourself,
   commit+push, re-launch `supervise.mjs <specId> --polished --no-start`,
   which also runs `postMerge()` if it hasn't already). Any auto-polish
   failure (no credential, stalled/failed session, dirty tree, red re-checks,
   `--no-push`) falls back to the same exit-7 pause, named in the flag file.
7. **The owner clicks gate 3** (Promote — the gate reads the local promote-CI
   artifact, not GitHub CI; see below) → deploy + teardown → the watcher
   closes out (Handoff commit + push + worker restart if `packages/` changed).

## Tripwire taxonomy (spec 0064, ADR-025)

The watcher is and stays a plain script — never an agent running. Every
between-gate step it can do deterministically, it does itself; a scoped job
gets a bounded, single-purpose agent it spawns and waits on; only what
neither can resolve reaches the AI supervisor, and only on demand (never
resident). Every exit code `supervise.mjs` defines appears exactly once below.

| Handling | Exit code(s) | What happens |
|---|---|---|
| Script auto-handles | `0` | Run completed (promoted) + closed out; benign gate-wait. |
| Script auto-handles | `2` | Usage error (invalid CLI args) — printed, no run affected. |
| Script auto-handles | `18` | `/api/health` non-200 — logged as a soft warning, never fatal. |
| Bounded agent, script-spawned | *(no exit — in-run)* | In-workflow coder failures / CI-red streaks → the `fixer`, via the workflow's own `runRepair` activity. Already automated, inside the run, on the run's worktree; it never sees watcher-level exceptions. |
| Bounded agent, script-spawned | *(no exit on success)* | The polish point → the `uiux-coder` (this spec), auto-spawned in place of the old pause; on success it re-runs `postMerge()` and pushes, then falls through to the gate-3 cue with no exit at all. |
| Tripwire → AI supervisor | `7` | Auto-polish failed (or `--manual-polish` was passed) — the one polish-point failure the bounded agent couldn't resolve itself. |
| Tripwire → AI supervisor | `10`, `11`, `12`, `13` | Temporal + worker anomalies (nondeterminism, heartbeat timeout, gate-2 poll failure, worker pid changed). |
| Tripwire → AI supervisor | `14` | Worker died. |
| Tripwire → AI supervisor | `15`, `16` | Primary-checkout isolation breaches (left main / dirty outside drafting). |
| Tripwire → AI supervisor | `17` | An unprotected activity attempt failed. |
| Tripwire → AI supervisor | `20` | Workflow reached a terminal non-success state. |
| Tripwire → AI supervisor | `30`, `31`, `33`, `34` | Red post-merge checks / gate-2 mechanical review fence breach. |
| Tripwire → AI supervisor | `40` | `main` diverged from origin — needs a human. |
| Tripwire → AI supervisor | `41` | Spec file missing / malformed. |
| Tripwire → AI supervisor | `50` | A relied-on shell step failed unexpectedly. |
| Retired | `32` | Was "gate-2 GitHub Actions CI red" (spec 0058) — never reused or renumbered. |

Delivery needs no new machinery: the flag file + the console follow card's
"Diagnose in console" button (spec 0054 guided fixes) already compose the
failure into a supervisor session — that IS the tripwire invocation. The
supervisor diagnoses read-only and proposes steps; gates and fixes stay
human-clicked/run (`agents/supervisor.md`'s hard invariants, unchanged).

## CLI reference

### Pipeline CLI — `node packages/pipeline/dist/cli.js <verb> …`

The dev interface to the Temporal pipeline. Requires `LAUNCHPAD_REPO_ROOT` and
`TEMPORAL_ADDRESS` (default `localhost:7233`) in the env. **Invoke by absolute
path** (`node packages/pipeline/dist/cli.js …`) — NOT `pnpm exec cli` (there is
no `cli` bin script; the package bin is `launchpad-pipeline` → `dist/cli.js`).
`supervise.mjs` calls it as `${REPO}/packages/pipeline/dist/cli.js`.

| Verb | Form | Purpose |
|---|---|---|
| `start` | `start <specId> "<request>"` | Begin a self/code run; parks at gate 1 after draft. Reuses an existing `specs/<id>-*.md` (draftSpec skips when the file exists). |
| `start-tenant` | `start-tenant <specId> "<request>" --tenant <id> --vps-id <n> [--odoo-version 17\|18\|19]` | Begin a tenant Odoo deploy run (gate 3 = live deploy). Default version 18. |
| `approve-spec` | `approve-spec <specId> <email>` | Gate 1 signal — **human/UI only, not the supervisor.** |
| `approve-pr` | `approve-pr <specId> <email>` | Gate 2 signal — **human/UI only.** |
| `promote` | `promote <specId> <email>` | Gate 3 signal — **human/UI only.** |
| `reject` | `reject <specId> <email> "<reason>"` | Reject the run. |
| `status` | `status <specId>` | Print the workflow's status name. |

Gate 2 in practice is a **GitHub PR approval** (ADR-012), detected by the
`awaitPrApproval` activity — not a Temporal signal in normal runs. CI at this
gate is the pipeline's pre-PR `runCi` (already green before the PR opens);
GitHub Actions is retired as a CI source (spec 0058, ADR-024) and is not
polled here.

### `scripts/supervise.mjs` — the orchestrator watcher

Drives ONE run end-to-end, automating every deterministic between-gate step;
NEVER signals a gate. Launch as a **tracked background task**.

```
node scripts/supervise.mjs <specId> [--request "..."]
     [--tenant <id> --vps-id <n> [--odoo-version 17|18|19]]  # tenant run
     [--no-push]     # never push; a needed push becomes an exception
     [--no-start]    # attach to an already-started run (don't start it)
     [--polished]    # set on re-launch AFTER a manual polish pass so gate 3
                     #   cues promote instead of pausing again
     [--manual-polish]  # opt OUT of auto-spawning the uiux-coder at the
                     #   polish point; pause (exit 7) for a hands-on pass
                     #   instead, as before spec 0064
     [--events]      # additive: append NDJSON judgment events to
                     #   .preflight/supervise-<specId>.events.ndjson (spec 0052)

node scripts/supervise.mjs --recover [specId] [--report-only] [--no-push]
     [--events]
     # ADR-023 outage recovery (spec 0051). No specId = all open workflows.
     # Restarts infra (idempotent preflight, never `restart`), reconciles
     # main==origin (ff-pull --autostash / ahead-only push / HALT on divergence),
     # converges watchers (kill all, re-attach one --no-start per open run).
     # Stray dirt is LEFT in the tree + reported (never stashed).
     # --report-only = assess + print the plan, change nothing.
     # --events (spec 0057) is PROPAGATE-ONLY: the recover process itself
     #   still never truncates the events file or emits its own records —
     #   it only appends --events to each re-attached watcher's argv, so
     #   the run's events channel survives a console-clicked recovery.
     #   Without --events, --recover is byte-identical to before this flag.
```

**Exit codes:** `0` done (promoted + closed out) · `2` usage · **`7` polish
pause** — since spec 0064, a TRIPWIRE: the auto-spawned `uiux-coder` failed
(no credential, stalled/failed session, dirty tree, red re-checks, or
`--no-push` blocking the push), OR `--manual-polish` was passed; either way,
do the impeccable pass by hand, re-launch `--polished --no-start` · `10`
nondeterminism (TMPRL1100) · `11` heartbeat timeout · `12`
gate-2 poll failure · `13` worker pid changed · `14` worker died · `15` primary
left main · `16` primary dirty (outside drafting) · `17` an activity attempt
failed (incl. `mergePullRequest` ff-only / `UnexpectedDirtyTree`) · `18`
`/api/health` down · `20` terminal non-success · `30` web-smoke red post-merge ·
`31` gate-2 mechanical review failed · `32` **RETIRED** (spec 0058 — was
"gate-2 GitHub Actions CI red"; GitHub Actions produces zero runs for this
account now, so the poll it fired from could never see a truthful red again.
Not renumbered, not reused.) · `33` `packages/*` rebuild failed before
post-merge local CI (spec 0055) · `34` local CI (typecheck / harness-inclusive
skip-proof test) red post-merge (spec 0058) · `40` main diverged (needs a
human) · `41` spec missing · `50` a relied-on shell step failed. `--recover`
uses only `0`/`14`/`40`.

**Gate 3 = local CI, not GitHub CI (spec 0058, ADR-024).** Post-merge,
`postMerge()` now runs the FULL local CI on merged `main` for every
non-tenant run — `packages/*` build (exit 33 on red) → `pnpm -r typecheck` →
harness-inclusive, skip-proof `pnpm -r test` (both fold into exit 34 on red)
→ the existing conditional `web-smoke.sh` (exit 30 on red, when the batch
touches `apps/web/` or the changed-file list is unknown) — mirroring
`ci.yml`'s job minus `next build`/fresh-checkout route-smoke (deliberately
excluded: `next build` corrupts the running dev server's shared `.next/`,
spec 0008 item 5; the pipeline's own pre-PR `runCi` already covered
build+typecheck+skip-proof-test on the branch's ephemeral worktree, and
web-smoke covers the running routes post-merge). On BOTH outcomes — and, on
any red step, BEFORE that step's `fail(...)` exit — it writes
`.preflight/promote-ci-<mergeSha>.json` (`{schema, specId, branch, mergeSha,
evaluatedSha, conclusion: "success"|"failure", ranAt, steps[]}`). The merge
SHA is resolved before running anything: the branch head cached at gate 2
(`git rev-parse origin/<branch>`) matched against the second parent of a
`git log --merges origin/main` entry (token-less primary), or
`getPrState(pr.number).mergeCommitSha` when `GITHUB_TOKEN` is present
(preferred, also covers a human squash-merge). If the SHA can't be resolved,
NO artifact is written (logged loudly) rather than risk a mis-keyed file.

`apps/web/lib/pipeline.ts`'s `getPromoteCiState` reads that artifact keyed by
`getPrState().mergeCommitSha` — GitHub is still the merge-SHA source, but the
CI *conclusion* comes from the local file, not `getCommitChecksConclusion`.
Green artifact → gate 3 enabled ("Local CI green"); red artifact → gate 3
BLOCKED ("Local CI red — cannot promote"), a genuine block; artifact absent
(not run yet, or SHA undeterminable) → allow-with-note ("Local CI hasn't
reported for this merge commit... promoting on your judgment") — never a
wall. **Red→green recovery:** fix lands on `main` (the merge SHA never
changes) → re-run the watcher (`node scripts/supervise.mjs <specId>
--no-start`) → `postMerge()` re-runs against current `main` (recorded as
`evaluatedSha`) and OVERWRITES the same-keyed artifact green.

### `scripts/preflight.sh` — one-command box setup

`bash scripts/preflight.sh` — 8 idempotent steps: docker compose up (start only
what's missing) → Temporal reachable → `.env` present → build packages if
`dist/` missing → **stale-dist guard** (offers rebuild+worker-restart if
`packages/pipeline/dist` is older than src) → start the worker (refuses a 2nd
unless `--force`) → start apps/web `next dev` on **:3000**, supervised → warm
the Temporal test-server cache. Sets `LAUNCHPAD_REPO_ROOT` (defaults to repo
root) and loads `.env` for the worker + dev server.

`bash scripts/preflight.sh restart` — kill every worker, rebuild `packages/*`
(never apps/web here — `.next` contention), start exactly one worker on the
known-good build, print its build id. **Refuses while a run is RUNNING** unless
`--force` (mid-run worker swaps caused the 0015 TMPRL1100 crash). Use after a
merge/pull, or when the worker is stale, with no run open.

### `scripts/web-smoke.sh [BASE_URL]`

Whenever a merged batch's post-merge step runs web-smoke (batch touches
`apps/web/`, or the changed-file list is unknown), `postMerge()` first rebuilds
`packages/*` dist only (`pnpm --filter='./packages/*' -r build`, never
`next build`) so web-smoke never sees stale `@launchpad/*` dist; a red build
is fatal (`fail(33, ...)`) instead of a confusing web-smoke failure (spec 0055).

Page-render smoke against a running server (default `http://localhost:3000`).
Asserts `/`, `/forge`, `/forge/specs`, `/forge/specs/<first-spec>`,
`/api/health` = 200 and `/fleet` `/specs` `/chat` `/forge/supervisor` = 3xx.
`/forge` is 200 in BOTH gate states (spec 0060): it renders `ForgeChat`
(assistant-ui, spec 0067) when `SUPERVISOR_CONSOLE_ENABLED` + an OWNER session
(spec 0074), else the gate-off `ChatThread` — the smoke asserts status only,
never which surface rendered. The recorded
spec-0020 gate for apps/web specs.

### Other scripts

- `node scripts/open-pipeline-workflows.mjs` — list open `specPipeline`
  workflows (empty output = none open). Used to gate `preflight.sh restart`.
- `scripts/gate-watch.mjs` — the lighter gate-only watcher (predecessor to
  supervise.mjs; terminal phases: promoted/failed/rejected).
- `scripts/warm-temporal-test-server.mjs` — pre-cache the test-server binary.
- `scripts/fleet-bootstrap-smoke.mjs`, `scripts/hostinger-smoke.mjs` — fleet
  live smokes (sandbox only).

### pnpm (the pre-commit gate)

```
pnpm -r typecheck      # must pass before commit
pnpm -r test           # must pass before commit
pnpm -r build          # rebuild all dist/
pnpm --filter @launchpad/agents test    # one package (tsc && node --test dist/*.test.js)
pnpm --filter @launchpad/web dev         # start just the web dev server
```

**Build-before-typecheck after a merge:** apps/web typechecks against the built
`@launchpad/*` dist. After a merge that adds cross-package exports, a stale dist
makes `apps/web typecheck` fail with phantom "has no exported member" errors.
Run `pnpm -r build` FIRST, then typecheck. (Bit spec 0050 and 0052.)

## Recurring one-liners

### Inspect a workflow (Temporal is source of truth after a crash)

```js
node -e '
const { createRequire } = require("module");
const req = createRequire("/home/dev/launchpad/apps/web/index.js");
const { Connection, Client } = req("@temporalio/client");
(async () => {
  const c = new Client({ connection: await Connection.connect({ address: "localhost:7233" }) });
  const h = c.workflow.getHandle("spec-<ID>");
  const d = await h.describe();
  console.log("status:", d.status.name);
  try { console.log("phase:", await h.query("pipelinePhase")); } catch {}
  // history: iterate getWorkflowExecutionHistory events —
  //   type 26 = WORKFLOW_EXECUTION_SIGNALED (signalName + payload: who clicked a gate)
  //   type 10 = ACTIVITY_TASK_SCHEDULED (activityType.name: the activity order)
  //   type 13 = ACTIVITY_TASK_FAILED, type 3 = WORKFLOW_EXECUTION_FAILED (failure.message)
  process.exit(0);
})();
'
```

Use this to confirm **who signalled each gate** (`approvedBy`/`promotedBy`),
the activity sequence, and the exact failure message on a FAILED run. The
`createRequire(".../apps/web/index.js")` shim is how scripts reach
`@temporalio/client` without a local dep.

### Recover `main` after a divergence (supervisor's own commits vs a worker push)

```
git fetch origin
git rev-list --left-right --count origin/main...main   # left=origin-only right=local-only
git rebase origin/main    # linearize local commits on top (NOT merge, NOT force)
git push origin main
```

If a real divergence can't be linearized, HALT for a human (the `--recover`
rule). Never force-push.

### Dev server / env gotchas

- The web env check requires `LAUNCHPAD_REPO_ROOT`, `TEMPORAL_ADDRESS`, and
  `AUTH_SECRET` (spec 0073; `GATE_ACTOR_EMAIL` was retired by spec 0074).
  Preflight sets `LAUNCHPAD_REPO_ROOT` automatically; a bare
  `next dev` without it fails the check (`{"ok":false,"checks":{"env":false}}`).
  Non-preflight start: `set -a; . ./.env; set +a; export
  LAUNCHPAD_REPO_ROOT=/home/dev/launchpad; pnpm --filter @launchpad/web dev`.
- Canonical web port is **3000** (preflight, web-smoke, supervise cues).
- Only ONE web-supervisor loop should exist; a stale one from a previous
  session can pin the server to 3001. Kill `bash scripts/preflight.sh
  __web-supervisor` + `next dev`/`next-server`, clear `.preflight/web*.pid`,
  then re-preflight for a clean single server on 3000.

## Recovery from a crash/outage

`node scripts/supervise.mjs --recover` (see flags above). The durable layer
(Temporal state, worker, git, specs) survives; only the ephemeral shell
(watchers, dev server, unpushed commits) dies. Steps 1–4 are automated; step 5
(resume the coder loop) is inherent to the durable worker + Temporal. See
ADR-023.
