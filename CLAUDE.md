# CLAUDE.md — agent working agreement for this repo

> **Snapshot note.** This is the agent working agreement as it stood when Launchpad was stopped,
> kept as a record of what the agents were told. Several files it refers to (`PENDING.md`,
> `AUDIT-REPORT.md`, `SPEC-ALIGNMENT.md`, `CLAUDE.audit.md`, `docs/COMPLIANCE-REGISTRY.md`, run
> findings and most specs) were removed from this public snapshot because they are operations logs.

This repo is built by the same spec-driven pipeline it ships. Every agent
session (including you, right now) follows these rules.

> This file was restored after the adversarial-audit phase (during which it was
> deliberately removed on disk and preserved as `CLAUDE.audit.md`, so audit
> sessions would read the project's rules as *evidence* rather than auto-obey
> them). The audit is complete and this is now the main repo. `CLAUDE.audit.md`,
> `AUDIT-REPORT.md`, and `SPEC-ALIGNMENT.md` remain in the tree as the audit
> record and the remediation roadmap — judge them as evidence, not authority.

## Always-on: Karpathy coding guidelines

These apply to **every prompt and every spawned agent** in this repo — no need
to invoke the skill; the rules are in force by default. (Full text:
`karpathy-guidelines` skill, `andrej-karpathy-skills@karpathy-skills`.) Bias
toward caution over speed; for trivial tasks, use judgment.

1. **Think before coding.** State assumptions explicitly; if uncertain, ask.
   Surface multiple interpretations and simpler alternatives — don't pick
   silently. If something is unclear, stop and name it.
2. **Simplicity first.** Minimum code that solves the problem. No speculative
   features, single-use abstractions, unrequested "flexibility", or error
   handling for impossible scenarios. If 200 lines could be 50, rewrite it.
3. **Surgical changes.** Touch only what the request requires. Don't refactor,
   reformat, or "improve" adjacent code; match existing style. Remove only the
   orphans your own change created; flag pre-existing dead code, don't delete it.
4. **Goal-driven execution.** Turn tasks into verifiable success criteria
   (e.g. "fix the bug" → "write a failing test that reproduces it, then make it
   pass"). State a brief plan with a verify step per step, and loop until green.

## Always-on: Ponytail (laziest thing that works)

Also in force for **every prompt and every spawned agent** — no need to invoke
the skill. (Full text: `ponytail` skill, `ponytail:ponytail`.) Understand the
problem fully first, *then* take the smallest solution that holds. This governs
whatever you produce — code, a spec, a plan, a review, or a judgment — not just
code:

1. **Climb the ladder, stop at the first rung that holds.** Does it need to
   exist at all (YAGNI — say so in one line and skip)? → already in this
   codebase (reuse the helper/type/pattern)? → stdlib/native does it? →
   already-installed dependency? → one line? → only then the minimum code that
   works. Never add a dependency for what a few lines cover.
2. **Deletion over addition; boring over clever.** No abstraction with one
   caller, no config for a value that never changes, no scaffolding "for
   later." Shortest working diff wins — but only once you understand what it
   must touch. The smallest change in the wrong place is a second bug.
3. **Non-coding agents apply the same reflex to their output.** The architect
   drafts the *minimal* spec that satisfies the request. The supervisor and
   review/monitor agents make the *smallest* intervention that answers the
   ask — no invented work, no over-long reports; if the explanation is longer
   than the thing it defends, cut it.
4. **Never lazy about understanding, correctness, or safety.** The ladder
   shortens the solution, never the reading. Do not simplify away input
   validation at trust boundaries, error handling that prevents data loss,
   security, accessibility, or anything explicitly requested.

## Always-on: verification discipline (earned the hard way)

Also in force for **every prompt and every spawned agent**. These are not
principles; each one is a mistake this repo actually paid for, and the evidence is
in `docs/VERIFICATION.md`. **Admission bar:** an entry belongs here only if the
mistake was made **twice**, or cost real money, a live incident, or a false claim
that shipped. Anything weaker stays in its spec's handoff log — a list that grows
unchecked becomes boilerplate, and boilerplate dilutes the rules that were paid for.

1. **A fake proves the call you made, not the contract the world imposes.** When a
   test asserts the *argument you pass* to a boundary rather than the boundary's
   *response*, it proves intent, not function. Four instances (specs 0093, 0094,
   0097, 0099) shipped past green suites, including a permission gate that was
   broken for ~50 specs. Where a fake cannot reach, a live check is load-bearing —
   mark it `(human)`, never `(live)`/`(visual)`: only the literal `(human)` marker
   is excluded from the done-condition.
2. **Pick a check that can actually fail.** Before trusting a negative result, ask
   what a positive one would have looked like. And before trusting a new test
   green, break the thing it guards and watch it go red — with
   `scripts/break-check.sh`, not by hand. Hand-rolled breaks failed three times
   in one day and all three were the harness: one silently did not apply, one
   "restored" with `git checkout` and deleted the uncommitted fix under test, and
   one produced a compile error whose exit 2 merely looked like red. The script
   asserts the mutation landed, that the suite RAN and failed, and that the tree
   is green again after restoring from a byte snapshot. Its exit codes separate
   the two answers that must never be confused: `1` your test does not guard
   this, `2` the harness broke. It must also be able to
   **pass**: spec 0200's proof (a Progress item carrying its commit SHA) is
   impossible in a customer project, where spec 0141 puts `specs/` outside the
   repo — its absence was misread as the fix having failed.
3. **A dev-server RSC payload cannot be grepped.** `next dev` inlines source for
   HMR, so any string literal appears whether or not a code path runs. Use a
   production build, or call the function directly (0086, repeated in 0109).
4. **A Tailwind class is a string.** `tsc`, `next build` and `web-smoke` are all
   blind to a broken one. UI work needs a pixel check (`scripts/ui-shot.mjs`);
   "gate green" is a regression floor, never evidence the styling is right (0101
   nearly shipped with the entire base CSS deleted, fully green).
5. **A constant with zero variance is a constraint, not a habit.** Behaviour
   varies; an exact constant is a limit of the system. Do not ship a prompt fix
   for it without proving the mechanism first (0106).
6. **Verify that a config or prompt change was delivered** — via git ancestry into
   the tree that ran — not by searching a log that may never record it (0106).
7. **A generated directory outlives what generated it.** `dist/` kept deleted tests
   green (0083), `.next/types` kept a deleted route failing `tsc` (0122), and a
   production `.next` made `next dev` serve mismatched vendor chunks so one route
   500d while the rest looked fine (0123). Guard it in the tool — `preflight` now
   clears a production `.next` — and *measure* the marker you key on, since
   `next dev` writes several of the files that look build-only.
8. **A pipe reports the wrong exit code, in both directions.** `cmd | tail` exits
   with *tail's* status: three gate runs read `grep`'s status and pushed red gates
   (0122–0124), and `ssh host 'install…' | tail` returned 0 for a script that had
   aborted on its first line — "runtime installed, exit 0" was claimed about a box
   with no Node, pnpm or Docker on it (0125). The obvious fix has its own trap:
   under `pipefail`, `… | head -c 32` fails with SIGPIPE because `head` exits
   first. Capture `$?` from the command itself, then assert the **end state** —
   `node --version` on the box, the port listening, the row in the table. An exit
   code that travelled through a pipe is not a check that can fail (see #2).
9. **A UI action's path is not the function with the matching name.** Trace the
   button to the workflow, hop by hop, across package boundaries — *before*
   trusting a fix. The live A/B test failed twice on a run that reached the
   workflow via `web → supervise.mjs → cli start`, which hardcodes
   `LAUNCHPAD_REPO_ROOT`; the project-aware starter I had fixed was never in the
   path. Grepping one package proved nothing, and the four facts I verified were
   all true and all irrelevant (0129 D, 0131). Its twin: a fallback that looks
   identical to the deliberate case is not observable, so record the
   distinguishing fact (`agent_runs.repo_root`, spec 0131 C).

11. **An id's parts are not "the prefix and the rest."** A run's workflow id is
   `spec-<id>` for the platform and `spec-<slug>-<id>` for every other project, so the
   spec id is the LAST segment. Four files stripped the prefix instead; the platform
   case passes under both rules, so every test and every pre-0142 history stayed green
   while project runs got a dead spec link, a gate button signalling a workflow that
   does not exist, a promote roll-up that matched nothing, and a busy-production list
   that could not match a real id (0142, 0156). Parse from the END, and put it in one
   exported function at the second caller — the rule had been in a comment since 0142
   and three later sites still got it wrong. A comment is not a control.

12. **An optional parameter is silent at exactly the call site that is wrong.** Four defects in
   two days (0175, 0176, 0179, 0180) were one shape: a function grew an optional parameter and a
   second caller never passed it. Two of them had a correct, tested rule that could not fire because
   no call site supplied the argument. Grep every call site in the change that adds the parameter;
   when a rule *should* fire and does not, check the argument arrives before debugging the rule.
13. **A hidden browser tab is not a user.** The automation's tab is always
   `document.visibilityState === "hidden"`, and a screenshot forces a paint without changing it, so
   rAF and visibility-guarded polling legitimately stop. This was filed as the largest blocker to
   unattended operation and recommended as the next build; the API and the polling were both fine.
   Check `document.hidden` and the server's own answer before filing "the UI does not update".
   **It is not only paint — a hidden tab does no LAYOUT, and a click needs layout** (2026-08-18,
   the second time this rule was paid for). Three "the first click does nothing, the second works"
   observations, reported to the owner as a probable app defect, were measured instead:
   `getBoundingClientRect()` on the button was `{0,0,0,0}` and React was not attached; one
   screenshot later the rect was real, React was attached, and the tab was still hidden. A
   coordinate click had landed on nothing. **Screenshot after navigating and before the first
   click, always** — not for the picture, for the layout. When a click "does nothing", read the
   target's `getBoundingClientRect()` before blaming the app; zeros mean it never had anywhere to
   land.

10. **A minifier renames the function you passed by reference.** Across any
   boundary that identifies code by NAME — Temporal workflow/activity types, job
   names, anything reading `Function.name` — pass a string constant, never a
   function reference. `client.workflow.start(specPipeline, …)` became workflow
   type `"P"` in `apps/web`'s minified production bundle and retried on production
   for nine hours; no test can catch it, because nothing minifies a test (0131
   follow-up). Corollary, paid for in the same incident: never act on a check
   whose failure mode you have already named out loud — I terminated a healthy
   production run with a script I had just said was reading the wrong field.

14. **The instruments are not exempt.** Every rule above is about a check inside
   the product; none covered the throwaway `psql`/`curl`/`grep`/`until … sleep`
   commands a session writes to *observe* the system. Those are unreviewed and
   invisible, and in one day they cost 52 minutes (a poll waiting for a phase the
   run could not reach — a gate was unpressed), two silent deploys (`git bundle`
   from a base the box lacked; the pull errored, `systemctl restart` still said
   `active`, and spec 0199 was reported deployed against the old tree), and a
   wrong conclusion from a grep that matched RSC chunk ids instead of prices. One
   shape: **the instrument was written to confirm what I expected, not to
   distinguish outcomes.** So: a wait loop must say on every line which state it
   is in — working, blocked, or stalled; a negative from a grep or query is worth
   nothing until it has been run against a known positive; and **where a procedure
   repeats, write the script** — discipline dies at a context clean, a committed
   script does not. Use `scripts/deploy-control-plane.sh` (never hand-roll a
   bundle) and `scripts/run-watch.sh` (never hand-roll a run poll). Corollary from
   the same spec: `scripts/gate-watch.mjs` was cited as the existing tool for this
   and it points at `localhost:7233` and a checkout path that is not this repo —
   **do not cite a tool as working without running it.** Second corollary, paid for
   on 2026-08-14: **`docker compose up -d` in a stack directory is not that stack.**
   Compose takes the project name from the DIRECTORY, so running it in
   `/opt/launchpad/<slug>/prod` builds a new stack called `prod` with EMPTY volumes
   instead of starting `<slug>-prod` — `sushi.example.com` briefly served a blank
   Odoo, which is worse than down because it looks alive. Always pass
   `-p <slug>-prod`, and never add `-v` to a `down` there: with the right project
   name that is the one irreversible command on the fleet.

15. **A check that runs as root proves nothing about the user that runs the code.**
   We deploy as root into `/srv/launchpad/repo`; the units run as `launchpad`. Every
   deploy handed the box back with 97,460 paths the services could not write, and the
   first platform run after it died on `unable to append to '.git/logs/HEAD':
   Permission denied` — with HEAD, both units and `/api/health` all green, because
   root can write anything and a health check only reads (0210). Assert the property
   **under the identity that will exercise it** (`sudo -u <svc> test -w`). Two things
   make this sharp: git replaces nearly everything via `<file>.lock` + `rename()`,
   which needs the DIRECTORY — only the reflog is appended to IN PLACE, so a root-owned
   tree stages a spec perfectly and then cannot commit it; and **`git status` is not a
   read** — it rewrites the index, so the command run to *confirm* the repair re-broke
   it three minutes later. A repair confirmed with a mutating instrument is not
   confirmed. `scripts/deploy-control-plane.sh --verify-only` now answers "can the
   harness still commit?" — run it before concluding the box is healthy.

## Execution: two tracks (don't run everything through the pipeline)

The SDD pipeline shines on *additive, scoped, independently testable* work; it
struggles with foundations, security surgery, cross-repo adoption, and
self-modification (the ADR-014 lesson). Pick the track per SPEC-ALIGNMENT §8:

- **Track 2 — full pipeline.** A spec goes through the initializer/coder/fixer
  loop only if it is **additive, scoped to this repo, and independently
  testable** (connectors, provisioning steps, isolated features). The gate + CI
  genuinely catch problems there.
- **Track 1 — direct/supervised.** Everything else — foundation reshapes,
  security surgery, cross-repo adoption, pipeline/agent self-modification, and
  trivial docs — is authored directly by a single steered session → PR → human
  review. Keep the valuable human gate; drop the initializer/coder/stall
  machinery. (Phase A, specs 0068–0076, was all Track 1.)

Still spec-first on both tracks: no spec in `specs/`, no code.

## The pipeline pattern (Track 2)

- **Initializer agent** (`agents/initializer.md`) runs once per spec: reads the
  spec, lays complete foundations (files, stubs, tests, a feature checklist in
  the spec's `## Progress` section), then hands off.
- **Coder agents** (`agents/coder.md`) make *small, verified increments*: pick
  the next unchecked item, implement it, run checks, commit, update Progress,
  hand off cleanly. Never leave the repo in a broken state between commits.
- **UI/UX coder agent** (`agents/uiux-coder.md`, spec 0064) runs once per
  apps/web spec at the post-merge polish point; its commits are fenced to
  `apps/web/**` + the spec file before the auto-push (spec 0071).

## Hard rules

1. Work only inside the scope of an approved spec in `specs/`. No spec, no code.
2. One logical change per commit. Conventional commits: `feat(pipeline): ...`.
3. Before every commit: **`pnpm gate`** — which is `scripts/lp gate` (spec 0229:
   `lp` is the ONE way in, and it has no default mode). Red = don't commit.
   It is the ONE definition — build (so a stale `dist/` cannot answer `tsc`),
   typecheck, test, and the `apps/web` production build, which catches what
   `tsc` under the test config doesn't.

   `pnpm check` is the same minus the slow web build — a declared SUBSET, and a
   green there is not "green". `lp gate` also runs with `DATABASE_URL`,
   `AUTH_SECRET`, `GITHUB_TOKEN` and friends **scrubbed from the environment**, so
   a check that starts needing a service fails the day it is introduced rather
   than the day CI runs in a container with nothing.

   Spec 0227: these commands used to live in three places that had already
   drifted — the root `package.json` was missing `next build` entirely.
4. Update the spec's `## Progress` checklist in the same commit as the work.
   The checklist lives ONLY in `## Progress`; `## Plan` is prose (spec 0068).
5. Handoffs: end your session by appending to the spec's `## Handoff log` —
   what you did, what's next, anything surprising. See `agents/HANDOFF.md`.
6. Never touch secrets or `.env`. Agent sessions receive an **allowlisted**
   env only (spec 0069, `packages/agents/src/env-scrub.ts`) — host secrets
   never reach a spawned session. Credentials come from the harness
   (`packages/agents/src/credentials.ts`); per-project secrets come from the
   encrypted store (`@launchpad/db` secret-store, spec 0076), decrypted only
   in a worker/host process. Never hard-code a secret.
7. Production promotion is human-gated. Agents may prepare, never promote.
8. **Every `## Out of scope` item carries the trigger that would make us do it.**
   A deferral without a trigger is a wish, not a plan, and one that lives nowhere
   is a decision we re-make from scratch in a month.
   **Where it is written depends on who is writing** (spec 0219 F):
   - **A pipeline run never edits `PENDING.md`.** The deferral goes in the spec's
     `## Out of scope`, with its trigger, and stops there. `PENDING.md` is edited
     by both humans and by runs, so a run touching it means a merge conflict —
     two in one day while the owner and a teammate worked in parallel. The roll-up into
     `PENDING.md` happens at close-out, by the person who merges.
   - **A directly-steered session (Track 1) still updates `PENDING.md`** in the
     same commit, because it *is* the person who merges.
9. **Every recorded defect names the release it was found on** (the owner, 2026-08-18).
   A bug written down without a version cannot be told apart from one a later
   deploy already fixed, so the whole list has to be re-verified by hand before
   it can be trusted — which is exactly what happened re-reading `PENDING.md`
   after 1.0.7: four rows were stale, and finding that out cost more than the
   two real blockers underneath them. Write the version the defect was OBSERVED
   on (`found on 1.0.7`), not the version you think introduced it — the first is
   a fact you have, the second is a guess. When it predates versioning or comes
   from a run, say so and date it (`run 7, 2026-08-14; confirmed live on 1.0.7`).
   Same for the fix: when a defect is closed, record the release that closed it.

## Control plane (Phase A — auth, DB, audit, secrets)

Phase A added the SPEC §13 security backbone. It changes how the app runs:

- **Auth (specs 0073/0074/0117).** Real Auth.js (Credentials provider) with JWT
  role sessions (OWNER/MEMBER/VIEWER). The recorded actor is the verified
  session email. There is **no header-derived "localhost" trust** anymore —
  `X-Forwarded-For`/`Host` are never an authorization signal (audit #2).
- **Roles (spec 0117).** Policy lives in ONE pure file, `lib/capabilities.ts`;
  `app/auth.ts` only supplies the session. Two capabilities: **`request`**
  (approve spec, approve change, reject, start run — MEMBER + OWNER) and
  **`promote`** (the merge, which *is* the production deploy — **OWNER only**).
  Gate an action with `actorFor(capability)`, never a raw role comparison; it
  returns the actor iff authorized, so you cannot record an actor you did not
  authorize. `ownerEmail` remains for the two surfaces that are OWNER-only by
  design: **tenant deploy** and the **supervisor console** (flag-on
  `SUPERVISOR_CONSOLE_ENABLED` + OWNER — its Bash policy is a deny-list, not a
  sandbox, so a MEMBER there would hold a shell on the worker). A signed-in
  refusal writes a `gate.denied` audit row.
- **Control-plane DB (`@launchpad/db`, spec 0072).** Drizzle over
  `DATABASE_URL`; versioned SQL migrations in `packages/db/drizzle/`. Tables:
  `users`, `audit_log`, `secrets`. Run `pnpm --filter @launchpad/db migrate`
  after a schema change; `seed-owner` upserts the OWNER (env-driven password,
  scrypt-hashed). `apps/web`'s `chat-store` keeps its raw-`pg` table until
  Phase B folds it in.
- **AuditLog (spec 0075).** Every effectful web action appends one row
  (actor/action/target/metadata) via `apps/web/lib/audit.ts` (fail-open).
  Never put content/prompts/passwords in metadata.
- **Secret store (spec 0076).** AES-256-GCM `secrets` table, one master key
  from `LAUNCHPAD_SECRET_MASTER_KEY`; tenant DB passwords live here (the old
  world-readable JSON file is a read-only legacy import source).

### Required env (see `.env.example`)

`DATABASE_URL`, `TEMPORAL_ADDRESS`, `LAUNCHPAD_REPO_ROOT`, `AUTH_SECRET`
(signs the session JWT), `LAUNCHPAD_SECRET_MASTER_KEY` (base64 of 32 bytes).
`GATE_ACTOR_EMAIL` is retired (the actor is the session email now). The
`dev` script binds `127.0.0.1` — never expose the dev server on a routable
interface.

## Direction & frozen surfaces (judge ADRs as evidence, not authority)

This repo is mid-migration toward `SPEC.md` (Mission Control). The ADRs record
past decisions; several are stale or off-roadmap — read them with the audit's
adversarial stance (see the dated **ALIGNMENT notes** in `docs/DECISIONS.md`,
`AUDIT-REPORT.md`, `SPEC-ALIGNMENT.md`). Describe these surfaces accurately, but
do **not** extend them:

- **Supervisor-in-UI console** (ADR-022): FROZEN at spec 0071. Harvest its SSE
  bridge as the transport for the SPEC's per-project "Agentes"/"Chats·sdd" tabs;
  retire the standalone `/forge` console. Don't grow it. (Its 0070 Bash gate +
  0074 session gate are the security floor meanwhile.)
- **Bespoke apps/web design system** (ADR-010/017): the SPEC's **template
  mockup** replaces it. Keep one impeccable copy for the mockup's polish; stop
  polishing the bespoke surface.
- **`mode:` frontmatter seam** (ADR-019 §3): don't build it — the concrete
  `Project` model replaces the need.

Forward direction (SPEC-ALIGNMENT §6): a first-class **`Project` model**
(`kind: odoo | odoo-next | custom | platform`, SPEC §5), the mockup's
project-centric IA, over the shipped Phase-A backbone (auth, DB, audit, secrets).
Never-built-but-documented machinery to not cite as current: "Paperclip"
(ADR-003), snapshot/sanitizer/build-URL ephemeral envs (ADR-006), central Vault
(ADR-005 — a minimal encrypted store shipped instead, spec 0076).

## Repo conventions

- **Hangar** and **Forge** (ADR-019): this monorepo ships two named products.
  **Hangar** is the VPS fleet + Odoo tenant deploy admin surface (`/` +
  `/fleet` deploy form, `packages/fleet-hostinger`, `infra/tenant/`, fleet
  scripts). **Forge** is the chat-first code pipeline (`/forge` chat, or the
  supervisor console when `SUPERVISOR_CONSOLE_ENABLED` + an OWNER session
  (specs 0060/0074), + `/api/chat` + `/forge/specs`, `packages/pipeline`,
  `packages/agents`, `packages/github`, `specs/`). The one deliberate crossing
  — Hangar's Deploy-tenant form starting a pipeline run — is "Hangar invokes
  Forge." Use these names, not "launchpad" or "the pipeline," when describing
  which surface a change touches; "Launchpad" stays only as the repo/env-var
  codename. Per spec 0067 the Forge surface is
  `components/forge/ForgeChat.tsx` (`@assistant-ui/react` over the
  `/api/supervisor` bridge, owner-scoped thread persistence + per-thread SDK
  session continuity). `/fleet`, `/specs`, `/chat`, `/forge/supervisor` are
  `permanentRedirect` stubs.
- TypeScript strict mode everywhere; pnpm workspaces; Node 22.
- Temporal workflows are deterministic: side effects only in activities.
- Odoo tenant stacks are defined by `infra/tenant/` templates — version
  (17/18/19) is a parameter, never hard-coded.
- UI: core console surfaces follow `docs/DESIGN.md`; only genuinely throwaway
  pages stay dev-grade. Scaffold from existing component/dashboard patterns
  rather than bespoke design; prefer chat-first surfaces with generative
  components where the feature is about describing or steering pipeline work
  (ADR-010/011).
- Code review (gate 2) targets GitHub PRs (ADR-012); local-diff mode remains
  only as the offline fallback.
- Fleet live-ops: automated SSH and destructive Hostinger API operations are
  allowed WITHOUT per-action confirmation on VPS ids in
  `infra/fleet-sandbox.json` only (ADR-013). Any other VPS: hard refusal at
  the lowest layer. Agents never edit the allowlist.
- Specs touching apps/web require a green `scripts/web-smoke.sh` against the
  dev server before promote, recorded in the spec's Handoff log (spec 0020).

## Commands

```bash
pnpm gate                             # = scripts/lp gate. THE definition of green
pnpm check                            # = lp check. Gate minus the web build (SUBSET)
pnpm start                            # = lp start. Services, .env, worker, web
scripts/lp deployed <ref>             # does the box SERVE a tree containing <ref>?
pnpm -r typecheck                     # the pieces, when you want one of them
pnpm -r test
pnpm -r build
pnpm --filter @launchpad/web build    # apps/web changes: also verify bundling
pnpm --filter @launchpad/db migrate   # apply DB migrations
pnpm --filter @launchpad/db seed-owner  # upsert OWNER (env-driven password)
pnpm --filter @launchpad/db seed-user   # upsert a user at any role (spec 0117)
```
