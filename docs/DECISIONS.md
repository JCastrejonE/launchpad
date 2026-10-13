# Architecture Decision Records

## ADR-001: Docker on Hostinger VPS fleet (not K8s/PaaS)
One VPS per client, provisioned exclusively via the Hostinger API. Right-sized
for ~10 clients; strong per-client blast-radius isolation; no cluster ops.

## ADR-002: TypeScript monorepo, Next.js full-stack
One language across web, workflows, and integrations. Python stays in
Odoo-land (client modules), where agents write it under spec control.

## ADR-003: Temporal OSS (self-hosted) + Paperclip
Temporal (MIT, free self-hosted) gives the durable, signal-gated pipeline
state machine. Paperclip (MIT, self-hosted) manages agent sessions, per-client
budgets, cost tracking, and the immutable audit log. LangGraph considered;
Temporal chosen for multi-day human-gate waits and TS-native SDK.

> **ALIGNMENT (2026-07-22 — audit §4 doc-drift):** **Paperclip was never
> built** — no such component exists in the repo. Agent sessions run on the
> Claude Agent SDK (ADR-004); per-run budgets are the coder-iteration cap in
> `packages/pipeline/src/loop.ts` (ADR-018); cost/turn accounting is the SDK
> `SessionResult` (`costUsd`/`numTurns`); and the immutable audit log is the
> **`audit_log` table** (`@launchpad/db`, spec 0075). Read the Paperclip
> sentence as an unrealized early design note, not shipped architecture.

## ADR-004: Claude Agent SDK for agent execution
Headless sessions fit the long-running-agent pattern (initializer + incremental
coders with handoffs). Dual credential mode:
- Owner: Team-plan OAuth token (`claude setup-token`) — launchpad construction
  and owner's own runtime usage draw from plan limits (supported per Anthropic
  Help Center, verified 2026-07).
- Clients: BYO Anthropic API key (required for third-party production
  automation; bills to the client).

## ADR-005: Container-per-tenant + central Vault
Each client: own containers, own Postgres, own filestore volume on their VPS.
All secrets/env live in Vault on the launchpad VPS, namespaced per account,
injected at deploy/agent-run time. Nothing secret persists on client VPSes
beyond running-container env.

> **STATUS (amended):** Vault is NOT wired yet. Owner credentials come from
> `.env` (`packages/agents/src/credentials.ts`; tenant credentials throw
> `TODO(phase-5)`), and the dev-compose Vault container serves no reads.
> Agent-session secret hygiene is enforced by an env **allowlist** (spec 0069,
> `packages/agents/src/env-scrub.ts`), not Vault. Treat "central Vault / secret
> manager" as the phase-5 target (SPEC §13); until then `.env` is the sole
> secret store and must be protected accordingly.

> **UPDATE (2026-07-22 — spec 0076):** a minimal encrypted secret store now
> EXISTS — an AES-256-GCM `secrets` table (`@launchpad/db`, master key
> `LAUNCHPAD_SECRET_MASTER_KEY`), decrypted only in-worker (SPEC §13). **Tenant
> DB passwords live there** now; the world-readable `~/.launchpad/tenant-secrets.json`
> is a read-only legacy import source (its write path is gone). `.env` still
> holds the platform/owner credentials + the master key itself. A central
> Vault / Doppler / Infisical stays the deferred phase-5 target (SPEC §17
> leaves the provider open).

## ADR-006: Ephemeral env per approved spec
odoo.sh-style: fresh sanitized-snapshot env + `spec/<id>` branch + build URL
per spec; destroyed after promote/reject. Avoids staging collisions.

> **ALIGNMENT (2026-07-22 — audit §4 doc-drift):** the sanitized-snapshot env
> and per-spec build URL were **never built**. Real per-spec isolation is a
> **git worktree** on a `spec/<id>` branch (spec 0017), created by
> `provisionEphemeralEnv` and torn down after the run — no snapshot, no
> sanitizer, no build URL. Tenant deploys are vanilla stock Odoo (ADR-020).
> Read the snapshot/build-URL text as original intent, not shipped behavior.

## ADR-007: Two human gates — spec approval and PR review
Chosen over pre-promote-only: catches misunderstanding at the cheapest point
(spec) and reviews actual diffs (PR). CI green is a hard precondition to merge.

## ADR-008: Odoo version per client (17/18/19)
Version is a tenant parameter driving base image, snapshot tooling, and CI
matrix. Never hard-coded.

## ADR-009: GitHub App, client-connected
Clients connect their GitHub account and grant the App access to their
existing repo. Launchpad never stores user PATs; App installation tokens are
short-lived and scoped.

## ADR-010: UI stays simple; scaffold from existing building blocks
apps/web is a simple developer-grade UI, not a design project. Prefer
existing, proven scaffolds over bespoke work: shadcn/ui-style component
libraries, ready-made dashboard blocks (e.g. Tremor-style), and framework
defaults. Custom CSS/components only where no existing block fits. Velocity
over polish until Phase 5 productization.

> **ALIGNMENT (2026-07-22 — SPEC-ALIGNMENT §4/§7):** amended by ADR-017 for the
> core console, and now off the product roadmap. The SPEC adopts the **template
> mockup** as the front-end, so the "dev-grade vs polished" question is mooted
> by *replacing* the bespoke apps/web, not tuning its bar. Keep one impeccable
> copy for the mockup's polish; stop investing in the bespoke surface (audit §6).

## ADR-011: Chat-first surfaces with generative components
Where a feature involves describing, reviewing, or steering pipeline work,
prefer a chat-style interface (chatbot-ui-style layout) with generative UI
components (structured cards/forms rendered from model or pipeline output)
over static form pages. The plain-language "start a change" flow is the
product's core interaction; the UI should lean into it. Static pages remain
for inventories (spec inbox, fleet) where chat adds nothing.

## ADR-012: Gate 2 (code review) runs on GitHub PRs
The pipeline's PR gate moves from the local-diff web button to real GitHub
pull requests: spec branches are pushed, a PR is opened via the API, GitHub
Actions runs the same CI, and an approving PR review is the gate-2 signal
(delivered to Temporal via polling activity in dev; webhooks once the
launchpad has a public endpoint). Rationale: real review tooling for free
(diffs, comments, approvals, audit), and it is the exact machinery client
repos will use in Phase 4 — dogfooding it on the launchpad first. Gates 1
(spec approval) and 3 (promote) stay in the launchpad UI; promotion remains
human-gated in-app.

## ADR-013: Autonomous fleet operations, bounded by the sandbox allowlist
Claude Code (supervising sessions) and fleet tooling may execute remote SSH
commands and destructive Hostinger API operations (wipe, recreate, OS
reinstall, restart, snapshot create/delete, `docker compose down -v`, etc.)
autonomously — no per-action human confirmation — against VPS ids listed in
`infra/fleet-sandbox.json`. Rationale: bootstrap-from-zero and wipe-retest
loops are the fleet package's core iteration cycle; per-action consent was
the bottleneck in the 0012/0013 smokes.
Hard boundary: any VPS NOT in the allowlist is refused for every mutating
operation — API and SSH alike — regardless of who asks or why. 100002
(production erp.example.com) is the standing example. The allowlist is
changed only by human commits (the owner); agents and tooling must never edit it.
Fleet scripts and activities load the allowlist and enforce the refusal at
the lowest layer available, not only in entrypoint scripts.

## ADR-014: Bootstrapping exceptions — hand-applied fixes when the pipeline
## cannot fix itself
Rule 1 (no code without a spec) assumes the pipeline can always run. Some
defects break that assumption: the fix's own coder session would fail on the
very bug being fixed (first formal case: spec 0015's agent-session
heartbeat starvation — any coder running the mandated full test suite
starved the 60s event-driven heartbeat, so no coder could ever land the
timer fix). In exactly and only this situation, a fix may be HAND-APPLIED,
under all of the following:
1. The change is named in an approved-or-draft spec's scope (amended if
   needed) — it still belongs to a spec.
2. One conventional commit; full `pnpm -r typecheck && pnpm -r test` green.
3. The spec's Handoff log records what was applied, why the pipeline could
   not dogfood it, and by whom.
4. The commit lands on the active spec branch (or main if none), so it
   passes human gate-2 review with everything else — never silently.
Anything that CAN wait for a normal pipeline run must.

> **ALIGNMENT (2026-07-22 — SPEC-ALIGNMENT §8):** generalized by the **two-track
> execution model** (now in `CLAUDE.md`). A hand-applied fix is simply **Track 1**
> — direct authorship → PR → human review — for work the pipeline can't dogfood
> (foundation, security surgery, agent/pipeline self-modification). The four
> conditions above still hold; "ADR-014 exception" and "Track 1" are the same
> thing. Phase A (specs 0068–0076) was all Track 1.

## ADR-015: Two-role operating model — execution-free architect,
## sole-executor supervisor
Agent work on the launchpad itself is split between two roles with a hard
capability boundary between deciding and doing:
- **Supervisor** — the only pair of hands. Talks to the owner; prepares, verifies,
  and executes pipeline runs; watches workers, Temporal, and apps/web;
  performs live checks; writes run close-outs. The supervisor is the ONLY
  agent that clicks human gates, touches live infrastructure, or commits
  code — including committing the architect's drafts, verbatim, after the owner
  has reviewed them.
- **Architect** (runs on claude-fable-5) — the judgment. Drafts and amends
  specs, decides pivots (scope cuts, re-sequencing, ADR-014 hand-apply
  calls, failure-recovery strategy), and reviews postmortems. The architect
  returns everything as text in its final message; it never executes.

Rationale: separating decision authorship from execution keeps exactly one
accountable executor on live systems (one audit trail of clicks and
commits, consistent with ADR-013's blast-radius thinking) while letting a
stronger reasoning model own the expensive judgment calls without
inheriting execution risk or permissions. It also creates a reviewable seam:
every decision exists as a durable artifact the owner can read before anything
runs. Rejected alternative: one agent doing both — it conflates "decided"
with "done" and leaves no gap for the owner's review between the two.

Handoff contract: both directions travel as fenced ```json blocks appended
to the relevant spec's `## Handoff log` (extending CLAUDE.md rule 5), so
decisions and execution share one audit trail. Fields:
- supervisor->architect: `handoff`, `ts`, `spec` (NNNN or null), `type`
  (`draft_spec` | `pivot_decision` | `postmortem_review`), `situation`
  (facts only), `artifacts` (paths/shas/run-ids), `question`,
  `deadline_context`.
- architect->supervisor: `handoff`, `ts`, `model_self_report` (must be
  `claude-fable-5`), `spec`, `decision` (one sentence), `rationale`
  (including rejected alternatives), `spec_draft_path` (or null when text
  is delivered inline), `actions_for_supervisor` (ordered), `risks` (each
  with a tripwire), `defer`.
Handoffs with `"spec": null` (rare, meta-level — this ADR is the first)
are appended to `docs/HANDOFFS.md` instead, chronologically.

Hard boundaries:
1. The architect never executes: no gate clicks, no pipeline runs, no shell
   commands against live infrastructure, no git commits, no file writes.
   Architect output reaches the repo only through the supervisor, verbatim,
   after the owner's review. If the owner wants changes, the supervisor hands back to the
   architect; the supervisor never edits a draft in place.
2. Every architect->supervisor handoff self-reports model identity. Anything
   other than `claude-fable-5` invalidates the handoff: the supervisor
   discards the output unread and respawns.
3. ADR-014 hand-applies split along the same seam: the architect makes the
   call (and amends the spec's scope); the supervisor applies and commits
   it under ADR-014's four conditions.
4. The owner overrides both roles. Gates stay human (ADR-007); promotion stays
   human-gated; the ADR-013 allowlist is still changed only by the owner.

### Amendment (2026-07-14, the owner): the architect may write spec files to disk
Boundary 1 is relaxed for ONE artifact class: the architect MAY write spec
drafts directly to `specs/NNNN-slug.md` (create or amend). This removes the
supervisor's verbatim-transcription step — the avoidable-drift source
(entity-escaping, handoff-log assembly by hand). Everything else in boundary 1
stands: the architect still makes NO git commits, NO pushes, NO gate signals,
NO pipeline runs, NO shell against live infrastructure, and writes NO file
other than a `specs/*.md` draft (never code, config, `.env`, or other docs).
The supervisor remains the SOLE committer and still reviews the on-disk draft
WITH the owner before committing it — the reviewable seam (a durable artifact the owner reads
before anything runs) is unchanged; only who types the file changed. The
supervisor still never edits a draft in place: to change it, hand back to the
architect, which now edits the file itself. `spec_draft_path` becomes the
normal channel (the path the architect wrote, for the supervisor to `git add`
verbatim); inline text stays allowed for spec-less/meta handoffs. Rationale:
the transcription step added risk without adding review value — the owner reviews the
same artifact either way, and the architect writing it exactly is strictly
safer than the supervisor re-keying it. A `spec_review` handoff type is added
alongside `postmortem_review` for "audit shipped specs; write a correction spec
only if a real defect is found."

> **ALIGNMENT (2026-07-22 — SPEC-ALIGNMENT §10.A, audit §5):** two corrections.
> (1) Boundary 2's **`model_self_report` tripwire is not a real control** — a
> session can emit any string it likes. The actual control is the **spawn-time
> model pin** (`modelForRole` / the SDK `model` option); rely on that, not the
> self-report. (2) SPEC-ALIGNMENT calls to **collapse the architect and the
> Temporal `spec-drafter` into ONE guarded drafting role** — they produce the
> same one-file spec, and the redundancy is real (even though the audit refuted
> the separate "unguarded hole" claim, §8). The decide/execute *seam* stays; the
> two drafting roles should merge.

## ADR-016: Solo-maintainer gate 2 — human merge (or explicit signal) as the
## approval act; review-as-approval reserved for author ≠ reviewer

ADR-012's gate-2 signal — an approving PR review — is structurally
unproducible on the launchpad repo: the pipeline opens PRs with the owner's PAT, so
the PR author is owner-gh, GitHub forbids authors approving their own PRs,
and on a single-maintainer repo the only human reviewer IS the author (first
hit: spec 0017 run 7ff88592, parked at gate 2 with a green PR #3 nobody was
allowed to approve). Amendment, scoped to solo repos (PR author == the only
human reviewer):
- The GitHub PR remains the review surface — diff, comments, CI, audit —
  and green required checks on the PR head remain a hard precondition.
- The approval act is EITHER (a) the human merging the PR on GitHub:
  `awaitPrApproval` treats `merged: true` as approved (actor = the merge
  event's `merged_by` login) and `mergePullRequest` is idempotent when the
  PR is already merged (skips the API merge, still syncs local main); OR
  (b) the in-app/Temporal `prApproved` signal — the standing escape hatch,
  which additionally lets the pipeline perform its own merge.
- Branch protection on a solo repo requires green checks only, never
  approving reviews (a required-review rule would deadlock both paths).
Review-as-approval (ADR-012, unamended) remains the model wherever
author ≠ reviewer: Phase-4 client repos (App-authored PRs reviewed by client
humans) and any repo that gains a second maintainer.

**ALIGNMENT 2026-08-03 (spec 0115) — the merge is now the PROMOTION, not the
approval, wherever the merge deploys production.** This ADR reads "the approval act
is … the human merging the PR", which stays true for the dogfood repo. It stopped
being true in general: for an odoo.sh customer, `main` IS production — odoo.sh builds
and restarts the production server on every push to it — so a merge cannot double as
"I approve" without also meaning "ship it now". The owner's confirmed gate shape splits them:
gate 2 **records the tested commit SHA and does not merge**; gate 3 **merges, and that
merge is the deploy**.

What actually changed in code (spec 0115, behind `patched("promote-merges-0115")`):
`mergePullRequest` moved from immediately after gate 2 to after the promote signal.
Both of this ADR's approval acts still work, and the distinction between them is now
load-bearing rather than incidental — `awaitPrApproval` reports `via: "merge" |
"review"` so the workflow knows whether a merge is still outstanding:

- **(a) human merges on GitHub** — unchanged. The merge already happened, so the
  activity still runs at gate 2, where its remaining job is syncing the local
  checkout that `markSpec` commits to a moment later.
- **(b) in-app `prApproved` signal** — the merge now waits for gate 3.

The property this buys, which the old order could not offer: **until someone promotes,
`main` is untouched**, so a rejection at gate 3 un-ships nothing because nothing had
shipped. Tests `(p1)`/`(p2)` in `workflow.test.ts` pin both halves.
Rejected alternatives: a machine/bot account authoring PRs (a second
credential and collaborator to manage, buying only literal ADR-012
compliance — the substance, a human reading the diff before accepting, is
identical under merge-as-approval); pulling the Phase-4 GitHub App forward
(heavier, same effect); un-suppressing the in-app approve button in PR mode
(splits the single source of truth 0015 item 8 deliberately unified — GitHub
stays primary, the signal stays break-glass).

## ADR-017: Polished console surfaces — the core apps/web UI is held above
dev-grade (amends ADR-010 for the operator-facing pages)
ADR-010 set apps/web at "dev-grade, no bespoke design; scaffold from existing
component/dashboard libraries." That was right for throwaway internal pages,
but the console (home hub, spec inbox, spec detail, chat) is the product's
primary human surface, and letting it stay dev-grade produced a real defect:
spec 0016 imported Tailwind globally, whose Preflight reset stripped native
`<button>` styling from every un-migrated page — the gate buttons (Start /
Approve / Reject / Promote) rendered as plain text with nothing catching it,
because "dev-grade" set no bar to fall below.
Amendment: the CORE console surfaces are held to a deliberate, cohesive visual
standard (spec 0024): one design-token system in `apps/web/app/globals.css`
(dark + light, one accent, semantic state colors kept separate from the
accent), an app shell, and the shared component classes applied across every
page — no split between a styled surface and un-styled ones. "Reuse, don't
build" (ADR-010) still holds: the system is plain CSS variables + the existing
shadcn/Tailwind substrate, not a bespoke framework or heavy dependency.
Scope + guardrails:
1. This raises the bar for the operator console ONLY. Throwaway/one-off
   internal pages may still be dev-grade; Phase-4 client-facing product UI is
   out of scope here and will get its own direction.
2. Still no per-feature bespoke design language — additions extend the token
   system and component classes, they don't invent parallel ones.
3. Presentation changes to these surfaces must keep every server-action /
   data path intact and pass `pnpm -r typecheck && pnpm -r test && pnpm -r
   build` + a green `scripts/web-smoke.sh` (unchanged from spec 0020).
Process note: spec 0024 was implemented HANDS-ON by the supervisor (not the
initializer/coder pipeline) at the owner's explicit direction, iterating against the
live dev server and mockup — the fastest path to a genuinely polished result,
recorded as a spec + this ADR rather than run through the gates. The pipeline
remains the default for feature work; hands-on visual passes are a deliberate,
owner-directed exception.
Rejected alternatives: keeping ADR-010 unamended and running UI polish through
the coder pipeline (the sonnet coders produce exactly the dev-grade output
this amendment moves beyond — heavy review cycles for a worse result); a full
component library / design-system dependency (over-heavy for a dev console,
against ADR-010's reuse principle).

> **ALIGNMENT (2026-07-22 — SPEC-ALIGNMENT §4/§7):** off the product roadmap.
> The SPEC adopts the **template mockup** as the front-end, so the console-polish
> apparatus (impeccable ×3, per-edit hooks, the mandatory polish pass) polishes a
> surface slated for replacement. Direction: adopt the mockup IA, re-home the
> working console surfaces onto it, and keep exactly one impeccable copy for the
> mockup's own polish. Don't invest further in the bespoke design system.

## ADR-018: UI-only fast-path — a human-gated declaration, a diff-path fence,
and a budget cap, kept as three separate mechanisms (spec 0031)
The owner asked to make UI-only changes scope and execute faster without steering
each run by hand. The durable rule (spec 0031) is built from three
deliberately separate pieces, not one combined heuristic:
1. **Classification is a declaration, not detection.** A spec may set
   `ui_only: true` in frontmatter. `spec-drafter` may PROPOSE it when a
   request looks apps/web-only, but the human confirms or edits it at gate 1
   like any other field. No diff-path heuristic ever sets it automatically —
   at plan time no diff exists yet to inspect, and even post-hoc
   auto-detection would remove the human from a judgment call the pipeline
   is bad at (a "UI" change can still require a backend field, a migration,
   an API contract change).
2. **The cap is a budget, not a behavior change.** `uiOnly` lowers the
   coder-loop's effective `maxIterations` to `UI_ONLY_MAX_ITERATIONS` (6) and
   trims the initializer's plan size — `loop.ts`'s convergence logic and the
   coder/initializer roles themselves are unchanged. A UI-only run is the
   same pipeline, leaner.
3. **The fence is enforcement, and it is soft.** `uiOnlyViolations` checks
   the coder's already-computed diff against the `apps/web/` allowlist
   *after* the session, not before — cheaper, and no separate dry-run pass.
   A violation forces `progressed: false` plus a corrective `[ui-only]`
   handoff note; it never throws a hard `ApplicationFailure`. Two
   non-progressing rounds in a row fall through the EXISTING stall→gate-2
   valve (spec 0006), the same path an unrelated stuck coder would hit — a
   human sees the offending diff in the PR and decides whether the
   classification was wrong or the coder wandered.
The three stay separate on purpose: a spec can be correctly classified but
still need a fence catch (a coder reaches for a shared package); the cap
applies regardless of whether a violation ever happens. Collapsing them into
one "smart" heuristic would remove the human gate from (1) and turn a
scoping judgment into a hard failure in (3) — both rejected.
Determinism note: the flag flows from `provisionEphemeralEnv`'s activity
OUTPUT (`EphemeralEnv.uiOnly`), read once against the worktree's spec file,
never a `workflow.ts`-side file read — replay safety (no TMPRL1100), same
discipline as every other activity-sourced workflow input.
Rejected alternatives: diff-path heuristic as the classifier (circular — no
diff exists at plan time, and it removes the human gate); un-gated
initializer auto-detection from the request text alone (same gate-removal
problem, one layer later); a hard `ApplicationFailure` on a fence violation
(too brutal for what is often a legitimate scoping judgment, not a bug).

## ADR-019: Hangar / Forge product split — the naming, the target taxonomy,
and the reserved modes seam (spec 0035, docs-only contract for a 4-spec batch)
The monorepo splits into two named products, both living in this one
codebase: **Hangar** (the admin dashboard for the VPS fleet + Odoo tenant
deploys) and **Forge** (the chat-first UI that orchestrates and commits
changes for a target). This ADR is the contract the batch's later specs
implement against; it changes no code or behavior.

1. **The split + boundary.** Hangar owns the fleet/tenant admin surface:
   `/fleet` + the deploy form, `packages/fleet-hostinger`, `infra/tenant/`,
   `infra/fleet-sandbox.json`, and the fleet scripts. Forge owns the
   chat-first code pipeline: `/` chat + `/api/chat` + `/specs`,
   `packages/pipeline`, `packages/agents`, `packages/github`, `specs/`, and
   the supervisor scripts. One crossing is deliberate and retained: the
   Deploy-tenant form STARTING a `specPipeline` run is "Hangar invokes
   Forge" — this is the autopilot story (a fleet action kicking off a
   pipeline run), not a boundary violation.
2. **Target taxonomy: `self` replaces `launchpad`, plus a `product` facet.**
   The start-time `target` becomes `{kind:"self", repo}` (renamed from the
   literal `"launchpad"`) or `{kind:"tenant", …}`, unchanged. An
   `isSelfTarget()` shim also accepts the legacy `"launchpad"` literal, so
   in-flight runs stay wire-compatible across the rename (implemented in the
   next spec of the batch). Separately, a new human-gated frontmatter facet
   **`product: hangar | forge | both`** (self targets only) records which
   product a self-run changes. It is proposed by `spec-drafter`, confirmed
   or edited at gate 1 like any other field, and read via
   `provisionEphemeralEnv`'s activity OUTPUT — reusing exactly the channel
   ADR-018 proved for `ui_only` (activity-output → `EphemeralEnv`, never a
   `workflow.ts`-side file read). Rationale for a facet rather than a third
   target kind: a Hangar-change run and a Forge-change run are behaviorally
   identical (same repo, same credentials, same deploy path) — `product` is
   informational metadata about *what* changed, not a different *kind* of
   run, so it does not belong in the target-kind enum that drives runtime
   branching.
3. **Modes seam — RESERVED, not built here.** The batch anticipates future
   Forge scope-limiting modes (e.g. forge-self / hangar-app /
   fleet+tenants) that narrow what a run may touch. When built, a mode must
   flow ONLY through the same channel as `ui_only` and `product`: activity
   output → `EphemeralEnv` → activity behavior (prompt content, tool
   availability, path-fence enforcement) — never a `workflow.ts` file read
   and never a `target.kind` branch. This ADR reserves an unparsed `mode:`
   frontmatter key for that future work; no parser, no enforcement, no
   `EphemeralEnv` field yet. **Invariant, stated loudly so nobody smuggles
   around it:** a mode that would require a DIFFERENT GATE STRUCTURE (for
   example, skipping gate 2 for a narrowly-scoped run) is a
   Temporal-versioned `workflow.ts` change, full stop — it is not "just
   another mode" layered onto the existing activity-output channel. Modes
   may change what an activity does within the existing gates; they may
   never change which gates exist or fire.
4. **Amendment to ADR-011 / spec 0025: `/` becomes the Hangar dashboard;
   Forge chat moves to `/forge`.** Spec 0025 (ADR-011) made chat the front
   door at `/`, on the reasoning that "start a change" in plain language is
   the product's core interaction. This ADR reverses that routing decision:
   now that the monorepo is understood as two products, the web UI's root
   identity is Hangar (the admin/ops surface), and Forge's chat-first
   interaction moves to `/forge` as a section within it. ADR-011's
   *content* preference — chat-style, generative-component UI wherever a
   feature is about describing or steering pipeline work — is unchanged and
   still applies to Forge; only the route it lives at changes. The IA flip
   itself (redirects, branding, the `scripts/web-smoke.sh` route-list
   update) is implemented three specs later in this batch, not here.

Non-goals of this ADR (deferred to later specs in the batch, named so the
contract isn't mistaken for the implementation): the `launchpad → self`
rename + shim; the `readProduct()` parser, `EphemeralEnv.product`, the
drafter's proposal logic, and the `/specs` badge; the `/` → Hangar /
`/forge` → chat IA flip itself; any `mode:` parsing or enforcement; any
package-scope (`@launchpad/*`) rename (optional, deferred indefinitely —
"Launchpad" stays as the repo/env-var codename regardless of product
naming).
Rejected alternatives: a third target kind (`"hangar"` / `"forge"`) instead
of a facet — rejected because it would fork identical run behavior across
two kinds for a difference that is purely descriptive; building the modes
enforcement now alongside the naming — rejected because the naming and
taxonomy need to be agreed and stable before any scope-fence behavior is
built on top of them, and because collapsing "reserve the seam" with
"implement the seam" risks a mode sneaking in a gate-structure change
without the loud invariant above being checked against it.

> **ALIGNMENT (2026-07-22 — SPEC-ALIGNMENT §1/§4/§6):** the SPEC's central
> abstraction is a first-class **`Project` model** (`kind: odoo | odoo-next |
> custom | platform`), not the two hard-coded self/tenant targets. Direction:
> adopt the Project model + the mockup's project-centric IA (`/`, `/new`,
> `/connect`, `/projects/[id]`); Hangar becomes the fleet view within it and
> Forge chat becomes the workspace "Chats·sdd"/"Agentes" tabs. The **reserved
> `mode:` seam (§3) is exactly the speculative scaffolding SPEC-ALIGNMENT §7
> says to stop adding** — don't build it; the concrete Project data model
> replaces the need for it. The Hangar/Forge *names* stay useful; the
> two-hard-coded-targets *shape* is what the Project model supersedes.

## ADR-020: Tenant-scoped multi-deploy on one VPS + vanilla stock Odoo
## (spec 0046)
Spec 0045's sandbox tenant deploy collided: Odoo's DB init failed with
"password authentication failed for user odoo". Root cause, verified in
`packages/fleet-hostinger/src/stack.ts`: every `docker compose` invocation
passed only `-f <path>`, never `-p <project>`. Without an explicit project
name, Compose defaults the project to the compose file's parent-directory
basename — the STACK (`prod`) — so the container name (`prod-db-1`) and the
named volumes (`prod_odoo-db`, `prod_odoo-filestore`) are scoped to the
stack only, shared across every tenant deployed to that stack on a box.
Postgres only honors `POSTGRES_PASSWORD` on first init of an empty data
directory, so a volume left by a prior tenant's deploy keeps its OLD
password while the new deploy is handed a freshly generated one.

1. **Tenant-scoped compose project.** A pure `composeProjectName(tenantId,
   stack)` derives `<tenantId>-<stack>` (lowercased, non-`[a-z0-9_-]` chars
   collapsed to `-`), and one `composeBase(project, composePath)` prefix
   builder threads `-p <project> -f <path>` through EVERY `docker compose`
   call in `stack.ts` — `up -d db`, `tenantDbExists`, `initTenantDb`, the
   full `up -d`, `verifyStackHealthy`, and `checkOdooHttp` — so the flag can
   never drift between calls. With `-p` set, the template's bare volume keys
   (`odoo-db`, `odoo-filestore`) resolve to `<project>_odoo-db` /
   `<project>_odoo-filestore` automatically, with no template volume-name
   change. Traefik's router/service names and Host rule were already keyed
   by `${TENANT}-${STACK}` and needed no change. `deployProductionStack`'s
   public signature is unchanged (the project is derived internally from its
   existing `tenantId`/`stack` args), so `packages/pipeline` needed no
   change. This lets N tenants coexist on one sandbox VPS with isolated
   db+odoo pairs, volumes, and passwords.
2. **Vanilla stock Odoo, not the never-built seeded model.** The template
   (`infra/tenant/odoo-stack.tmpl.yml`) previously carried an `./addons`
   bind mount and comments describing a pg_dump-restore + neutralize +
   spec-branch-checkout seeding flow that was never implemented. That
   machinery is removed; a tenant deploy is now stock `odoo:${ODOO_VERSION}`
   + `postgres:16` + a fresh tenant DB (`initTenantDb` installs `base` into
   an empty DB — that IS vanilla, not a restore), pinned to the tenant DB via
   `-d ${DB_NAME} --db-filter=^${DB_NAME}$$`. The deploy form's free-text
   `request` field is removed to match: a vanilla deploy has no code
   request to describe, so the tenant `request` fed to the pipeline is now a
   deterministic, server-synthesized descriptor
   (`vanillaTenantRequest(tenantId, odooVersion)`) that explicitly tells the
   drafter to leave the spec's Progress checklist empty.
3. **Staging seam: RESERVED, not built.** `<stack>` already parameterizes
   the compose project, volumes, DB name, and Traefik routes end to end, so
   a future `staging` stack alongside `prod` for the same tenant is additive
   — no schema change. One-pass staging+prod provisioning is explicitly
   deferred (the owner's call); this ADR only notes the seam exists.
4. **Deferred: deploy-flow simplification.** A vanilla tenant deploy has no
   code change, so the honest flow is a lighter provision → deploy → verify
   path with the human gate at promote, skipping draft → gate-1 →
   coder-loop → gate-2 PR entirely. That is a DIFFERENT GATE STRUCTURE, which
   ADR-019 §3's invariant requires to be a Temporal-versioned `workflow.ts`
   change — too determinism-sensitive to fold into this mechanics refactor.
   It is scoped as its own follow-up (spec 0047). Interim (this spec): a
   vanilla tenant deploy still traverses the full pipeline; the synthesized
   empty-Progress request keeps the coder loop converging immediately, so
   gate 2 is a near-empty (spec-file-only) PR — functional but vacuous until
   0047 lands.
5. **Sandbox-only.** All of the above applies within ADR-013's sandbox
   allowlist (VPS 100001); the owner clicks every gate. The stale `prod`
   project/volume left on 100001 by the pre-fix scheme is not auto-cleaned
   by this spec — the new tenant-scoped project name means it is simply
   never reused, so it is inert (wasted disk only), reclaimable by the
   supervisor as a one-time sandbox live-op, not pipeline code.

Rejected alternatives: migrating existing stack data into the new
tenant-scoped volumes — rejected because the affected data lives only on a
throwaway sandbox box, so a migration path would add complexity for no real
data at risk; an automated `docker compose down -v` in the deploy path to
reclaim orphaned stacks — rejected as a destructive operation ADR-013 keeps
as a deliberate, human-invoked live-op rather than pipeline-automatic,
especially given the risk of a wrong project name ever compounding with
`-v`; building the lighter provision-only flow now alongside the mechanics
fix — rejected because it is a gate-structure change (ADR-019 §3) and
mixing it into a mechanics refactor risks a gate change landing without the
scrutiny that invariant demands.

## ADR-021: Tenant vanilla deploy — single promote gate, via the repo's first
## Temporal `patched()` version gate (spec 0047)
Spec 0046 fixed the tenant deploy's MECHANICS (tenant-scoped compose
project/volumes, vanilla stock Odoo) but left the FLOW unchanged: a vanilla
tenant deploy still traversed the full `specPipeline` (draft → gate 1 →
coder loop → gate-2 PR → merge → gate-3 promote → deploy), opening a
near-empty PR because a vanilla deploy has no code to write (ADR-020 §4).
This ADR simplifies the tenant flow to ONE human gate and records the
determinism-versioning precedent that made changing a live workflow safe.

1. **One gate, at PROMOTE/DEPLOY.** For `target.kind === "tenant"`, gate 1
   (spec approval) and gate 2 (PR review) are both removed. Gate 1 reviewed
   nothing a human decided — the deploy manifest is a deterministic function
   of inputs already supplied at the deploy form (tenant, VPS, Odoo version).
   Gate 2 reviewed a diff, and a vanilla deploy has no diff. The single
   remaining gate reuses the existing `promote` signal and
   `awaiting_promotion` phase; only the owner's Deploy click triggers any VPS side
   effect (`provisionClientVps` + `deployProductionStack`, both already
   inside `deployToProduction`). `specRejected` stays available at this gate.
2. **Auditability without a PR.** `draftSpec` (LLM) is replaced by a new
   deterministic, idempotent activity, `writeTenantDeployManifest`, which
   commits `specs/<id>-tenant-<tenantId>-deploy.md` to `main` directly —
   the same git-commit discipline `draftSpec` uses today, minus the
   `Co-Authored-By` trailer (no LLM session authored the content, so
   trailer coverage doesn't apply, mirroring `markSpec`'s existing
   trailer-exempt status-bump commits). Together with the `markSpec` status
   trail (draft → staged → promoted) and Temporal's immutable event history,
   this triad is the deploy's audit record in place of a PR. `provisionEphemeralEnv`,
   `runInitializer`, the coder loop, `runCi`, `openPullRequest`,
   `awaitPrApproval`, `mergePullRequest`, and `teardownEnv` are all skipped —
   the tenant branch returns before the self-body's try/finally, so no
   worktree is ever created or torn down; the deployed stack persists by
   design (reclaimed only via a supervisor sandbox live-op per ADR-013).
3. **The repo's first Temporal `patched()` version gate.** Changing which
   gates a live `workflow.ts` fires is exactly the case ADR-019 §3 flags as
   determinism-sensitive: in-flight AND closed histories replay against
   whatever code is deployed today, so a gate-structure change must be
   versioned or old histories throw `NonDeterminismError` on replay. This
   spec adds `patched("tenant-vanilla-deploy-0047")`, short-circuited behind
   the deterministic `target.kind === "tenant"` operand only (never a
   nondeterministic condition), gating a new `tenantVanillaDeploy` function.
   New tenant runs take the new single-gate path (marker recorded); a
   pre-0047 tenant history (spec 0045, spec 0034 — CLOSED runs, still
   replay-queried whenever their spec-detail page is opened) has no marker
   in its history and replays the OLD full-pipeline path unchanged. Self/code
   runs never evaluate the branch at all — byte-identical, no marker event
   ever recorded on self history. The old full-pipeline tenant branch is kept
   indefinitely for this replay; `deprecatePatch`/removing it is a
   far-future spec once no old tenant history can be queried (a
   `patched()` id, once shipped, is permanent — renaming or removing it
   strands recorded markers). Proven by two tests: a replay test that
   records a real pre-0047 tenant history against a frozen fixture of the
   old flow and replays it against current `workflow.ts` with no
   `NonDeterminismError`, and the untouched self-run regression test.
4. **apps/web needed no structural change.** `derivePhaseViewState` already
   gates coder-progress rendering on the `coding` phase and the PR card on
   `view.pr` being set; the tenant path emits neither, so no empty
   coder/PR blocks render with zero structural changes — only copy: a
   manifest summary row, a "Deploy tenant" gate label, and (since ADR-018's
   promote-guard note is keyed off `view.pr`, which is never set for
   tenant) a new tenant-specific note reading "No CI gate for a vanilla
   deploy — deploy on your judgment," with the gate left enabled
   throughout.

Rejected alternatives: a fully spec-less tenant run with no manifest/spec
page at all — rejected because `markSpec`/`findSpecFile`/the spec-detail
page/status frontmatter are load-bearing infrastructure, and a deterministic
manifest preserves all of it while still honoring "skip the LLM draft";
numeric `getVersion` ranges instead of `patched()` — rejected because this
is a single one-way behavior change, not a range of behaviors to select
between; a dedicated `deploy`-kind Temporal query or a new `PipelinePhase`
member — rejected because reusing existing phases keeps the union and every
phase reader (tests, apps/web) unchanged.

## ADR-022: Supervisor-in-UI — the two-role model as a product; the browser↔Claude-Code bridge
The supervisor workflow (today a human's chat driving scripts/supervise.mjs, the pipeline CLI, git, and SSH) moves INTO the Hangar/Forge UI as a self-driving, standalone product surface. The in-product 'supervisor' is an Opus Agent SDK session; it (in later phases) spawns the Fable 'architect' to write specs — so ADR-015's execution-free-architect / sole-executor-supervisor split becomes a PRODUCT feature, not only a construction-process convention.

1. Bridge mechanism. The browser↔Claude-Code bridge is the Claude Agent SDK query() (@anthropic-ai/claude-agent-sdk), the SAME primitive packages/agents/src/session.ts already uses (ADR-004), run host-side with the agent's Bash tool for command execution and streamed to the browser over SSE. Command execution is the crux the owner named ('the browser must communicate with a REAL Claude Code session'), and query() already provides structured message streaming, an AbortController, and an inactivity watchdog. Rejected: the raw `claude` CLI as a subprocess with stdout parsing (the SDK already wraps the CLI and gives typed streaming/abort/watchdog — re-parsing stdout is strictly worse); a bespoke websocket/RPC protocol (reinvents the SDK's streaming and schema); a browser-side MCP server (does not run host commands; over-engineered).

2. Distinct from /api/chat. The existing chat surface is the AI SDK (`ai` + @ai-sdk/anthropic) streamText: a thin, whitelisted, NO-SHELL tool-calling layer (chat-tools invariant: no gate signals, no command execution). The supervisor is a full Claude Code session WITH Bash/file tools and (later) sub-agent spawning. These are different surfaces; the supervisor console does not overload /api/chat.

3. Security / blast radius (ADR-013 lineage). A browser that can drive a host Claude Code session with Bash is remote code execution, so exposure is phased. Phase 1 is dev-local, localhost-only, single-user, disabled by default, on the owner credential (server-side only — no secret crosses to the browser), with NO raw-command passthrough from the browser (the browser sends natural-language prompts and structured card clicks only) and assertSandboxVps still enforced at the lowest layer for any infra op. Real auth, multi-user, the supervisor service on a host VPS, and git-paired execution are phase 5 and gate any non-localhost exposure.

> **ALIGNMENT (2026-07-22 — SUPERSEDES §3; specs 0073/0074, audit #2):** §3's
> security model is **obsolete**. The "localhost-only, single-user, no auth until
> phase 5" envelope and the loopback/`checkSupervisorAccessFromEnv` header guard
> are **gone**: deriving "localhost" from `X-Forwarded-For`/`Host` was spoofable
> (audit #2 — `curl -H "Host: 127.0.0.1"` yielded a host Bash session), so it was
> deleted and replaced by an **Auth.js OWNER session** gate — `supervisorAccess()`
> = `SUPERVISOR_CONSOLE_ENABLED` **AND** a signed-in OWNER (`app/auth.ts`).
> Authorization is the signed session cookie, never a request header. Every
> mention of `checkSupervisorAccessFromEnv`/loopback below (incl. the STATUS
> block) is stale terminology for that retired guard.

4. Gates stay human; the agent never signals. The supervisor agent renders gate cards; only the human's button click fires a gate signal through the existing signalGate path (ADR-007, and the ADR-015 boundary carried into the product). The agent's tool surface excludes gate signals (unit-tested, mirroring chat-tools).

5. Determinism boundary. The supervisor SESSION is an interactive agent, not a Temporal workflow — determinism does not bind it. Everything it triggers (cli start/start-tenant, supervise.mjs, gate signals) runs through the existing deterministic, human-gated Temporal pipeline; the supervisor-in-UI changes no workflow.ts.

6. Phasing. 1: bridge-first thin MVP (input → host session → streamed real command output → one wired gate). 2: architect handoff in-UI. 3: watcher spawn + follow, streaming phase/step/progress as interactive components. 4: full loop + promote + guided fixes with Hangar links. 5: auth + multi-user + host-VPS + git-paired execution. 6 (optional): retire the human supervisor chat. Rejected alternative: building the full choreography before proving the bridge — the bridge (host command execution steered from the browser) is the novel risk, so it is de-risked alone first.

STATUS (shipped): phase 1 = spec 0049 (bridge MVP); phase 2 = 0050 (architect handoff, review-only); phase 3 = 0052 (watcher spawn + follow — live stepper/activity/gate cues); phase 4 = 0054 (4a guided fixes — exception playbook + Diagnose handoff) + 0056 (4c start-a-run-from-console, watched) + 0057 (4b remediation cards — Recover/Resume-polished) + 0059 (4d Hangar/PR/spec deep-links). The full loop now lives in `/forge/supervisor`: describe → architect drafts a spec → human reviews → start-watched → follow → human gates → guided fixes on exceptions → remediation cards → context deep-links. Every step stayed human-gated (the agent never signals a gate) and localhost/`SUPERVISOR_CONSOLE_ENABLED`-bounded. REMAINING: phase 5 (auth + multi-user + host-VPS + git-paired execution — the only gate to any non-localhost exposure) and phase 6 (optional: retire the human supervisor chat). As of spec 0060, the console's home is `/forge` (chat is the gate-off fallback; `/forge/supervisor` is a `permanentRedirect` stub) — §3's security envelope is unchanged. STATUS amendment (spec 0067, phase 1 of a further phase plan 0067–0071): the console UI itself is rebuilt on `@assistant-ui/react` (`components/forge/ForgeChat.tsx`, replacing `SupervisorConsole.tsx`) over the SAME `/api/supervisor` bridge and marker→card contract; the bridge gains additive conversation continuity (`Options.resume` keyed by a new `{type:"session",sessionId}` event) and the console gains its first real persistence — owner-scoped threads/messages in the launchpad Postgres (new `pg` dependency, bootstrap-DDL schema, no ORM) with a history sidebar and replay. §3's envelope (loopback + `SUPERVISOR_CONSOLE_ENABLED`, `SUPERVISOR_ALLOWED_TOOLS`, gates-stay-human) is unchanged and every new thread route sits behind the same `checkSupervisorAccessFromEnv` gate. Phases 2–5 (memory, attachments, live-Hangar-state generative UI, agentic-loop parity polish) are specs 0068–0071.

> **ALIGNMENT (2026-07-22 — SPEC-ALIGNMENT §4/§7; roadmap):** this surface is
> **off the SPEC roadmap** — the SPEC never asks for a supervisor-in-UI console
> (it asks for per-project "Chats·sdd" + "Agentes" tabs). Decision: **freeze it**
> (stop extending past 0071 — the phase-2–5 plan named above is NOT pursued),
> **harvest its SSE bridge** as the transport for the SPEC's "Agentes"/"Chats·sdd"
> tabs, and **retire the standalone `/forge` console**. The role dissolves into
> "the chat that drives the per-project SDD pipeline" + "the Agentes tab reading
> Temporal." The A.4 Bash gate (spec 0070) and the 0074 session gate are kept as
> the security floor while it's harvested. Do not grow this surface.

## ADR-023: Durable core, ephemeral shell — the outage-recovery model and protocol
A power outage mid-run (spec 0050) proved the pipeline's survivability boundary empirically: everything the pipeline needs to make progress lives in the DURABLE layer — Temporal's persisted workflow state (docker volume), the worker's work-in-flight (activities retry idempotently; workflow.ts replays deterministically), git (local commits and origin), and the spec files. Everything that died was the EPHEMERAL shell — supervise.mjs watcher processes, the in-UI/chat supervisor session, the dev web server — plus one not-yet-pushed status commit. This layering is now a design rule: nothing required for pipeline progress may live only in the ephemeral layer.

Recovery protocol (5 steps): 1. Restore infra with idempotent preflight (never `preflight.sh restart` while a run is open — the main flow only starts what's missing and never swaps a live worker). 2. Enumerate open workflows in Temporal and read each one's status + pipelinePhase + gate state (Temporal is the source of truth after a crash). 3. Reconcile git and tolerate operator dirt: fast-forward behind-only, push ahead-only, HALT for a human on divergence (never merge, never force). Stray uncommitted edits are LEFT IN PLACE, not stashed — the code-16 dirty-main guard exists to catch PIPELINE-leaked writes (spec 0017 isolation), not the operator's scratch files, so the re-attached watcher tolerates any dirt present at its start (a start-time baseline, the same base-delta pattern it uses for other signals) and only trips on NEW pipeline dirt. Stray dirt is reported loudly (including any path under packages/ that a close-out rebuild would compile). 4. Converge watchers: kill all supervise watchers and re-attach exactly one tracked --no-start watcher per open workflow (ps is the discovery source of truth; no lockfiles). 5. Resume: no action — the durable worker + Temporal resume themselves.

Posture: recovery ACTS by default and reports what it did; report-only is the opt-out. Safe because every default action is idempotent (preflight), non-destructive (dirt is left untouched, never moved), or stateless (watcher kill/re-attach). Four boundaries never loosen: gates are human clicks (recovery only reports gate state), divergence always halts for a human, and uncommitted work is never destroyed OR moved (leaving it in the tree is the whole approach — there is no stash, hence no restore machinery and no way to lose it).

Automation: `scripts/supervise.mjs --recover` (spec 0051) implements steps 1–4; step 5 is inherent to the architecture. Design implication: watchers must stay stateless — any future watcher state must be derivable from Temporal/git rather than held in the ephemeral layer; the in-UI supervisor (ADR-022 phase 3+) invokes/replicates `--recover` on reconnect rather than growing a second recovery path. Rejected alternatives: making the watcher itself durable (a Temporal workflow or supervised daemon) — the watcher is deliberately disposable and durability belongs in Temporal alone; report-and-guide as the default posture — a diagnosis-only tool still leaves a human executing recovery by hand at the worst moment, the failure mode being codified away; stashing operator dirt aside with an automated deferred pop — a self-inflicted tension (popping re-trips the very guard the stash worked around), replaced by baseline-tolerating the dirt in place.

## ADR-024: Local CI as the promote-gate authority — GitHub Actions retired as the CI source (GitHub = VC + PRs); future per-repo VPS CI
GitHub Actions is retired for this account: no workflow run is created for any commit. That turned spec 0043's gate-3 guard into a permanent wall — `getPromoteCiState` → `getCommitChecksConclusion(mergeSha)` → `aggregateChecks`, where zero workflow runs reads "pending" → `decidePromoteGate` disables promote forever (confirmed live: 0 Actions runs on recent merge commits). Decision (the owner): CI runs LOCALLY on the dev host now, and a local CI pass satisfies the promote gate; GitHub remains the version-control and PR host only (gate 2's PR merge flow unchanged). Future: CI runs per-repo on a client's VPS — this ADR is the dev-local step, and `.github/workflows/ci.yml` is kept (marked retired) as the reference definition for that runner. Superseded by spec 0062: the keep-clause is dropped and `.github/workflows/ci.yml` is deleted outright — git history is the reference, not a retired file riding along.

1. Source, not gate, is what changed. The supervisor watcher's `postMerge()` (spec 0055's hook) runs the full local CI GH Actions used to run — packages build, `pnpm -r typecheck`, harness-inclusive skip-proof `pnpm -r test`, plus the existing web-smoke — on merged `main`, and records `.preflight/promote-ci-<mergeSha>.json` (`{schema, specId, branch, mergeSha, evaluatedSha, conclusion: success|failure, ranAt, steps}`), written on both outcomes and before any failing exit. `getPromoteCiState` reads that artifact for the PR's merge SHA (still obtained from `getPrState` — GitHub is still the PR host) instead of calling `getCommitChecksConclusion`.
2. Three-state semantics: green artifact → promote enabled; RED artifact → promote BLOCKED, in the UI and in the server-side `resolvePromoteSignalGuard` alike — the boundary that never loosens: local CI must actually pass, a red genuinely blocks; ABSENT artifact → allow-with-note ("local CI hasn't reported"), because there is no local "pending" — hard-blocking on absence would recreate the exact wall being removed. Absence is also the safety valve when the watcher cannot determine the merge SHA (it never writes a mis-keyed artifact).
3. Red→green recovery: the artifact is keyed by the immutable merge SHA but records `evaluatedSha` (the main tip actually tested); fixes land as new commits on main and a watcher re-run overwrites the same-keyed artifact green. Deliberate coverage delta from the retired workflow: no `next build`/fresh-checkout route-smoke on the primary checkout (`.next` corruption hazard, spec 0008) — pre-merge `runCi` on the ephemeral worktree plus post-merge web-smoke cover it until VPS CI restores full parity.
4. Gate 2: the watcher's GH-Actions verdict poll (exit 32) is retired — it could only ever read "pending" again. Pre-merge CI is the pipeline's own `runCi` activity (green before the PR opens) plus human diff review on GitHub; the gate-2 cue says so instead of advising a wait for a green that will never come.
5. Unchanged boundaries: gates remain human clicks (nothing in this design signals); `workflow.ts` untouched (the CI run is harness-side, the gate is apps/web); dev-local blast radius in the ADR-013 spirit (the artifact lives on the host, no secrets); `packages/github`'s `getCommitChecksConclusion`/`aggregateChecks` remain exported but unused by the promote path. Self-bootstrap was designed in: only gate 3 was walled, so spec 0058 lands its own fix through gates 1–2, the dev server hot-reloads the new gate, and the post-merge watcher re-launch writes 0058's own artifact — no dependency on the old gate to promote the fix.

Rejected alternatives: always-allow / removing the gate (loses the red-blocks guarantee that caught real failures); hard-block on artifact absence (recreates the wall for every run where the watcher hasn't reported); running `next build` locally for full ci.yml parity (corrupts the live dev server's `.next`; deferred to VPS CI); pointing the gate at a different hosted CI (the account constraint is CI hosting itself, and the VPS direction makes local-first the honest intermediate step).

## ADR-025: Bounded agents + a plain-script watcher + a tripwire-only supervisor (spec 0064)
The watcher (`scripts/supervise.mjs`) stays exactly what ADR-023 already
established it as — a plain, disposable script, never an agent running — and
this ADR names the operating model that follows from taking that literally as
automation grows: every step the watcher can resolve deterministically, it
does itself; every scoped job that needs judgment gets a bounded,
single-purpose agent the script spawns and waits on inline; only what neither
can resolve reaches the AI supervisor (ADR-022), and only on demand.

1. **The polish point is the second bounded-agent case, not a new pattern.**
   Spec 0018's `fixer` already proved the shape inside a workflow run
   (in-run coder failures/CI-red-streaks → a bounded repair session via the
   workflow's own `runRepair` activity). This spec adds its watcher-level
   sibling: at the exit-7 polish pause, `supervise.mjs` now spawns the
   `uiux-coder` (`agents/uiux-coder.md`) in-process instead of pausing for a
   human. Both are bounded (one job, one exit condition), spawned by
   machinery rather than a human, and never see the OTHER's scope — the fixer
   never handles watcher-level exceptions, and the uiux-coder never touches
   in-workflow repair. Neither reports to the AI supervisor; each reports
   back to the machinery that spawned it.
2. **The AI supervisor stops being a continuous co-pilot and becomes a
   tripwire responder.** ADR-022 built the supervisor as the human's
   conversational driver for the pipeline; that framing is amended here: with
   the watcher automating every deterministic step and bounded agents
   absorbing the two scoped jobs above, there is no remaining step that
   needs a resident AI in the loop. The supervisor is now invoked only when
   a tripwire fires — an exit code neither the script nor a bounded agent
   can auto-handle — or when the human wants to converse, start a run, or
   spawn the architect. `docs/SUPERVISOR.md`'s taxonomy table enumerates
   every `supervise.mjs` exit code exactly once across three buckets:
   script-auto-handled, bounded-agent (no exit, or a success path with no
   exit at all), and tripwire-to-supervisor. `agents/supervisor.md`'s
   preamble is reframed to this effect; none of its hard invariants change
   (ADR-022 §4's "gates stay human, the agent never signals" carries over
   unmodified).
3. **Failure always falls back to the pre-0064 behavior.** Any auto-polish
   failure (missing credential, stalled/failed session, dirty tree left
   behind, red re-checks, or `--no-push` blocking the push) exits 7 exactly
   as the old always-pause `polishPause()` did — the tripwire taxonomy makes
   this the ONE case where a bounded-agent path and a tripwire share an exit
   code: the agent's failure IS the tripwire. `--manual-polish` preserves
   today's always-pause behavior verbatim for runs where hands-on polish is
   wanted regardless.
4. **No workflow-hosted phase.** The polish target is `main` in the primary
   checkout (the run's own worktree is already merged and about to be torn
   down), so hosting this as a Temporal activity would mutate the primary
   checkout from inside a run — colliding with the 0017 isolation model the
   watcher's own exception detectors enforce — for zero determinism benefit,
   since the spawn is a side effect either way and the watcher already owns
   this exact moment. `packages/pipeline/src/workflow.ts` is untouched.

Rejected alternatives: a Temporal-hosted polish activity/phase (reason 4);
routing the polish point through the AI supervisor instead of a bounded agent
(the supervisor is meant to shrink to on-demand-only, not gain a new
continuous responsibility — a single-purpose spawned session is the leaner
fit, mirroring the fixer); collapsing the fixer and uiux-coder into one
generic "repair agent" role (they run in different contexts — in-workflow
worktree vs. primary-checkout main — and conflating them would blur the
0017 isolation boundary the fixer already respects).

> **ALIGNMENT (2026-07-22 — SPEC-ALIGNMENT §10.B/§7):** the supervisor-shrink
> direction here is right and continues: as the SPEC's "Agentes" tab reads
> Temporal directly and gates fire via UI signals (ADR-022 alignment note), the
> log-tailing watcher's job collapses toward "restart the worker on a bad build"
> — don't rebuild it bigger. The `uiux-coder` auto-polish is now fenced to
> `apps/web` (spec 0071); SPEC-ALIGNMENT §7 further recommends **retiring the
> watcher-spawned polish in favor of a normal Track-2 SDD spec**, which also
> retires the auto-push path.

---

## Orchestration: we keep Temporal + the Claude Code SDK (2026-08-13)

> **ALIGNMENT (2026-08-13 — the owner asked whether we are reinventing the black thread).**
> Researched before committing to more full A/B runs. The finding is that the industry
> converged on our shape, and that the two layers we run are the two we should run.
> Recorded here so it is not re-litigated without new facts.

**Not adopted: LangGraph.** It is a graph runtime whose durability is a *checkpointer* —
state snapshots per super-step. A LangGraph run lives in one process; a checkpoint restores
state but does not replay side effects, and the ecosystem's own literature says so plainly
("checkpoints are not durable execution"). We already run Temporal, whose event history is
strictly stronger, and the pattern the ecosystem recommends for side-effecting production
agents is *LangGraph for reasoning, Temporal for orchestration* — Temporal ships a LangGraph
plugin for exactly that split. Adopting LangGraph would replace our strongest layer with a
weaker one.

**Not adopted: deepagents.** LangChain's own positioning is that it is a Claude Code replica
— planning tool, filesystem, sandboxed shell, subagents, system prompt — whose selling point
is running on any tool-calling model. We run the original through the SDK (spec 0144). We
would be swapping the original for a third-party clone to buy model-agnosticism we do not
need.

**The confirming evidence: Open SWE.** LangChain's own coding agent (mirroring what is
deployed at Stripe, Coinbase and Ramp) is Manager → Planner → **human plan approval** →
Programmer → Reviewer → PR, in isolated sandboxes, driven from issues or a web UI. That is
our pipeline: spec draft → gate 1 → coder → CI → PR → gate 2 → merge. Its README states the
industry pattern in one sentence — *"Open SWE composes on the Deep Agents framework — similar
to how Ramp built on top of OpenCode."* Take an existing harness, compose your pipeline and
product around it. That is already our architecture, with Claude Code as the harness.

**What we copy instead** (none of it requires adopting anything):

1. **Session telemetry as first-class data** (spec 0194). LangSmith's real value is per-session
   observability. `agent_runs` records ONE row per workflow with no session or token data, so
   "is the initializer/coder split worth it?" was unanswerable from our own database. Fixed
   before it is argued about again.
2. **An optional reviewer pass before the PR opens** — Open SWE's Reviewer node. Run 4's
   `Contacto.tsx` was written and never mounted; a pre-PR reviewer is where that gets caught.
   Deferred until 0194's data says whether the loop needs it.
3. **`AGENTS.md` in customer repos** (spec 0196) — the de-facto convention file. Run 5's
   initializer noted `No hay CLAUDE.md en el checkout` and re-derived the conventions from
   scratch, on every run.

**And one deletion.** The `ui_only` scope fence goes (spec 0196). The guardrails literature is
unambiguous that a path allowlist is defense-in-depth and *not* a boundary — an agent routes
around it through any allowed code-runner — while the real boundaries are the OS and the diff
review. We already have four: a throwaway worktree, CI, a PR, and a human gate, with GitHub
branch protection under all of it. The fence bought nothing those do not, and charged a tax on
every customer run: it hardcodes `apps/web/`, so a customer project whose app is at `app/` has
every legitimate increment marked a violation (findings 5.1, and `gaming-tech/0001` blocked
for rounds).

**Open question, pre-registered rather than argued:** whether the initializer/coder split earns
its keep. The literature says single-agent fits sequential, stateful work and multi-agent pays
off when subtasks are genuinely independent — ours are sequential on one branch. Our own tell:
**118 of 191 specs are Track 1**, so we route most of our own work around the machinery. The
decision criteria are in spec 0194; the answer comes from `agent_sessions` rows after runs 6
and 7, not from a blog post.
