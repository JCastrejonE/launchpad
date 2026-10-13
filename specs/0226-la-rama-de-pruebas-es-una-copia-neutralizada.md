---
id: 0226
title: The test branch is a neutralized copy of production, not a clean Odoo
tenant: launchpad
product: hangar
status: promoted
track: 1
requested_by: owner@example.com
found_on: 1.0.10
---

## Intent

`/connect`'s confirm screen promises *"Crea la rama de pruebas con la base de datos
neutralizada"*, and `SPEC.md` §3 defines a **Rama de pruebas** as *"Copia del proyecto con base de
datos **neutralizada** (sin correos/pagos reales)"*. Neither exists.

**Measured, not assumed:** the word "neutraliz" appears in this repo only in prose. `staging.ts:316`
explains that odoo.sh gives you a neutralized duplicate; the tenant deploy manifest says, in
writing, *"Vanilla stock Odoo (no addons, no snapshot restore, no neutralize)"*. What branch
staging actually stands up is a **clean** Odoo with the branch's addons — useful, and not a copy of
anything.

The owner, 2026-08-19, chose to build the real thing rather than reword the promise.

## Why this is the product, not a nicety

A clean Odoo proves the code loads. It cannot answer *"does this change work against the
customer's actual data"* — the wrong-currency invoice, the 4,000-product catalogue, the chart of
accounts someone customised in 2019. That question is what a staging environment is FOR, and it is
what odoo.sh sells.

## The danger, stated first

A restored copy of production is production data on a second box, with production's cron jobs,
mail servers and payment credentials still in its tables. Un-neutralized, it will **email real
customers and charge real cards** the moment a scheduled action fires. Every design decision below
serves that.

**One measured complication.** Outgoing mail is currently unbuilt — on a live tenant
(`sushi_prod`) `ir_mail_server` has 0 rows and the `mail` module is `uninstalled` (spec 0225). So
the mail half of the scrub is a **no-op today**, which means it cannot be proven by observing that
no mail was sent. It is written anyway, because the day mail lands is not the day to discover the
scrub was never exercised. Its proof is owed, and named in Progress as such.

## Decisions

1. **The copy must never be reachable un-neutralized — and "attach Traefik last" does NOT achieve
   that.** (Corrected 2026-08-19 while implementing.) The Traefik labels are IN the compose file
   (`odoo-stack.tmpl.yml:64-79`), so there is no separate attach step to sequence around: the
   instant `docker compose up -d` runs, the router exists.

   The sequencing that DOES work uses compose's own service selection, because Traefik routes to
   the **odoo** service and nothing else:

   1. `docker compose up -d db` — Postgres only. Nothing is reachable; the router has no backend.
   2. Restore into it: `psql < dump.sql`, and the filestore into the volume. One artifact, so the
      two cannot disagree.
   3. `docker compose run --rm --no-deps odoo odoo neutralize -d <db>` — a ONE-OFF container. It
      carries the service's Traefik labels, which is harmless: `neutralize` is a CLI command that
      exits, so nothing is ever listening on 8069 in it.
   4. Assert `database.is_neutralized` from the branch DB.
   5. `docker compose up -d` — odoo starts, already neutralized.

   The un-neutralized copy therefore never has an HTTP server in front of it, by construction
   rather than by ordering luck.
2. **Fail closed: a scrub that errors destroys the stack.** A half-neutralized copy is worse than
   no copy, and worse than a failed job. Nothing is left running for someone to "fix later".
3. **Use ODOO'S OWN neutralization. Do not write our own.** (Revised 2026-08-19 after the owner asked how
   odoo.sh does this.) Odoo has shipped `odoo-bin neutralize` since v16, and odoo.sh runs it
   automatically every time a staging branch is created from production. **Verified in the image we
   actually run**: `docker exec sushi-prod-odoo-1 odoo neutralize --help` works.

   Reading Odoo's own `base/data/neutralize.sql` off that container is what settled it — my
   hand-written script would have been wrong in four ways:

   - it inserts a **dummy mail server** (`invalid:1025`) *after* deactivating the real ones,
     specifically to stop Odoo falling back to an SMTP server given on the command line. I would
     not have thought of that, and "we deleted the mail servers" would have felt sufficient;
   - it deactivates crons **except `autovacuum_job`** — killing that one degrades the database;
   - it neutralizes **webhooks** (`ir_act_server WHERE state = 'webhook'`), which was not on my list
     at all;
   - every installed module contributes its own `data/neutralize.sql` — payment providers, delivery
     carriers, IAP, bank sync — so Odoo covers modules we have never heard of, per version, and
     maintains it. A central script of ours would rot the first time a customer installs something.

   Our own addons get the same extension point: drop `data/neutralize.sql` in the module and Odoo
   runs it. That is where anything company-specific belongs.
4. **Do not scrub the data itself.** Odoo's approach is to make SENDING impossible, not to destroy
   addresses — which keeps the copy realistic to test against, and is what odoo.sh gives you. The
   earlier draft proposed rewriting `res_partner.email`; that is worse on both counts.
5. **Copy ONCE, at branch creation — never on a redeploy.** odoo.sh copies production when the
   staging branch is created and, on subsequent pushes, *"the database is not re-created"*. Our
   0134 auto-redeploys a branch's staging at gate-2 arrival, so restoring there would **wipe the
   tester's data every round** — the exact opposite of what a staging environment is for. The
   restore is bound to branch creation; a redeploy rebuilds the CODE against the copy that is
   already there.
6. **A branch stack is explicitly NOT backed up, and says so.** odoo.sh states plainly that dev and
   staging builds are not backed up and are not assumed to be used for persistent storage. We say
   nothing either way today, which reads as durability — and that gets worse the moment a branch
   stack holds a restored copy of production, because it will look like the most backed-up thing we
   own. It is the opposite: disposable by design, destroyed on promote or teardown, and its data is
   a copy whose original is the only one that matters. The branch card says this in words, next to
   the neutralized marker.
7. **Customer data lands only on the ADR-013 sandbox box.** Restoring a customer's production to a
   VPS outside the allowlist is a data-handling decision nobody has taken; this spec does not take
   it either.

## What `odoo neutralize` does — read from our own image, not from docs

`/usr/lib/python3/dist-packages/odoo/addons/base/data/neutralize.sql`, plus one file per installed
module (`get_neutralization_queries` walks them):

| what it does | why it matters |
|---|---|
| `UPDATE ir_mail_server SET active = false` | no real mail server |
| inserts a dummy server at `invalid:1025` | blocks the command-line SMTP **fallback** — the subtlety |
| `UPDATE ir_cron SET active = false` except `autovacuum_job` | unattended actions are the danger; autovacuum is not |
| `database.is_neutralized = true` in `ir_config_parameter` | **the marker to assert**, and what makes Odoo show its red banner |
| `ir_act_server` webhooks pointed at a dead URL | outbound webhooks are a channel I had not considered |
| per-module scripts | payment, delivery, IAP, bank sync — maintained by Odoo, per version |

The red banner is a bonus we get for free: anyone opening the branch sees immediately that it is
not production.

## Plan

**A. Use Odoo's own dump, and Odoo's own neutralize.** (Refined 2026-08-19: `restore_db` is a
Python function reachable only from a running Odoo or the DB-manager HTTP endpoint, and standing an
Odoo up to perform the restore is the very thing decision 1 forbids. So the RESTORE is `psql` plus
a filestore copy — which is trivial precisely because Odoo's dump is one consistent artifact — and
the NEUTRALIZE is Odoo's CLI in a one-off container.)

The original note stands on why not to write our own scrub: (Revised 2026-08-19, second pass.) Reading
`odoo/service/db.py` in the image we run:

- `dump_db(db, stream, backup_format='zip')` produces ONE artifact containing `dump.sql`, the
  whole `filestore/`, and a `manifest.json` with the version and module list. The DB and the
  filestore are captured together, so they cannot disagree — which was the hard half of the
  original plan.
- `restore_db(db, dump_file, neutralize_database=True)` restores that artifact **and neutralizes
  in the same operation** — `service/db.py:333`, calling `neutralize_database(cr)` at :377.

So the whole of the first draft's plan — `pg_dump`/`pg_restore` plumbing, a volume-to-volume
filestore copy, keeping the two consistent, and a separate neutralize step — collapses to: dump on
prod, move the zip (same box), restore with `neutralize_database=True`. This is the path odoo.sh's
own Backups tab uses.

`manifest.json` comes free and is worth reading: it names the Odoo version and installed modules,
which is the compatibility check we would otherwise have had to invent.

**B. Assert the marker, not the exit code.** Read `ir_config_parameter WHERE key =
'database.is_neutralized'` back **from the branch database**. The exit status of a container
command is exactly the kind of evidence `VERIFICATION.md` #8 exists about; the marker is the end
state, and Odoo's own red banner is driven by the same row.

**D.** Wire into branch staging: when the project has production and the branch asks for a
neutralized copy, do C then B before Traefik attaches. On any failure, destroy the stack (decision
2) and report why.

**E.** The branch card carries two facts, together: **neutralizada** (from the marker) and **no se
respalda** (decision 6). Both belong on the same card because they are the same message — this is a
copy for testing, not a place to keep anything. The UI stops saying "neutralizada" where it is not. **Only a branch-list marker on our
side** — Odoo already shows its own red banner inside a neutralized database, driven by the same
`database.is_neutralized` row, so building a banner would be duplicating a thing the tester will
see anyway.

## Out of scope / deferred

**Neutralizing a tenant whose production is not ours** (odoo.sh, a customer's own box). Decision 5.
→ `PENDING.md`. Trigger: a connected project with external production asks for a test branch.

**Anonymising personal data beyond contactability.** The scrub makes the copy unable to REACH
people; it does not pseudonymise names, addresses or RFCs. That is a different requirement (and a
legal one) → `PENDING.md`. Trigger: a customer asks, or we hold data for someone who is not the company.

## Progress

- [x] A (neutralize half) — `neutralizeRestoredDb`: Odoo's own `neutralize` in a one-off
      `run --rm --no-deps` container, compose project name always explicit
- [x] A (restore half) — `dumpProduction` / `restoreIntoBranch` / `assertRestored`. Production is
      read-only BY CONSTRUCTION and the tests assert it: every command touching the prod project
      must be a `pg_dump` or a `:ro` mount, and must match none of `PROD_WRITE_VERBS`
- [x] B — `assertNeutralized` reads `database.is_neutralized` back from the branch DB. Exported
      separately so it can be RE-asserted later: a branch stack outlives the run that made it, and
      "it was neutralized when we created it" is a claim about the past
- [x] C — `decideProductionCopy`: bound to branch CREATION only, so a gate-2 redeploy rebuilds the
      code and keeps the data (odoo.sh's rule). Every outcome carries a reason, because a run that
      skipped the copy and one that made it look identical afterwards
- [x] D — `deployProductionStack` gains an opt-in `restoreFromProduction`, called at the ONE
      moment `odoo` is not running (after `up -d db`, before `up -d`). Absent for every production
      deploy, so the shipping path is untouched. A hook that throws fails the deploy and `up -d`
      never runs — proven by moving the call after `up -d` and watching two tests go red
- [x] D2 — `deployBranchStagingStack` gains `copyProduction?`, builds the hook (it is the only
      layer that knows BOTH stacks) and destroys the branch stack if the copy throws
- [x] D3 — the composition tested as one thing: the default path never mentions production; with
      `copyProduction` the order is dump → restore → neutralize → PROVE → `up -d`; and a copy whose
      marker never reads true destroys the stack and never starts odoo
- [x] E — the card states BOTH: `copia de producción · neutralizada` only where the marker was
      PROVEN, and `no se respalda · se destruye al promover` unconditionally (decision 6)
- [x] E2 — carried on the fleet result → the `deployStaging` activity's ref → the workflow's own
      staging state → the card. **No migration:** `StagingState` comes from the workflow query, not
      the DB, so the truth travels the same path the host and the addons already do
- [x] Gate: `pnpm -r typecheck && pnpm -r test` (1814 pass, 0 fail) + `next build` green
- [ ] (human) Restore a tenant, then read from the BRANCH DB: `database.is_neutralized` true, every
      `ir_cron` inactive except autovacuum, the dummy `invalid:1025` mail server present, and the
      red banner visible in the browser
- [ ] (human, OWED) The mail half cannot be proven while outgoing mail is unbuilt (0 servers,
      `mail` uninstalled). When spec 0225's email work lands, re-run this against a tenant that
      CAN send and confirm nothing leaves.

## Handoff log

- 2026-08-19 (coder, no item to take — THIRD in a row) — Same finding as the two sessions below,
  so I will not restate their reasoning: every non-`(human)` item is checked, the two that remain
  are the live restore proof and the mail proof spec 0225 owes, and `agents/coder.md` forbids
  taking either. Handoff appended, committed, stop.

  **The one thing worth adding is the repetition itself.** Three consecutive spec-file-only,
  no-checkbox commits is exactly what the stall detector is built to escalate, and that is the
  correct outcome — this spec cannot advance without a person at a keyboard restoring a tenant. If
  a fourth session lands here, the answer is not another handoff: it is that the run should be
  closed or the `(human)` items should be worked by a human, because the pipeline has no move left.

  **What I checked, and what I deliberately did not.** I grepped for the six functions the Progress
  items claim (`dumpProduction`, `restoreIntoBranch`, `assertRestored`, `decideProductionCopy` in
  `packages/fleet-hostinger/src/prod-copy.ts`; `neutralizeRestoredDb`, `assertNeutralized` in
  `neutralize.ts`) — all six exist and are exported, so the checked items are not claims about
  code that was never written. That is a cheap structural check and I am calling it nothing more:
  it proves the symbols exist, not that they behave. I did NOT re-run the gate, for the reason the
  session below gives — no commit since `8c50a97`/`49cb2fa` touches code, so a re-run measures an
  unchanged tree at the cost of a full `pnpm install && pnpm -r build` first (VERIFICATION #7).

  **Reachable?** Nothing built, nothing to wire; reachability is still what D2/D3/E2 established
  and is still a code-path claim held by tests.

  **Does this satisfy the acceptance criteria?** No, and unchanged from below: **no database has
  been copied.** The suite is green and the evidence is owed. Do not read the green as done.

- 2026-08-19 (coder, no item to take) — Second consecutive session with nothing to build. Both
  remaining Progress items are `(human)`: the live tenant restore proof, and the mail proof that
  spec 0225 owes. `agents/coder.md` forbids taking either, and there is no non-`(human)` item to
  fall back to, so this session appends the handoff and stops. That the stall detector reads a
  spec-file-only commit as `progressed: false` is correct here — the run genuinely cannot advance
  without a person, and gate 2 tripping is the right way to surface that rather than something to
  route around.

  **What I did NOT do, stated plainly:** I did not re-run the gate. The initializer verified it
  green (typecheck 0, 1822 pass / 0 fail, `next build` 0) and the only commit since is `8c50a97`,
  which touches this spec file and nothing else — so re-running would be re-measuring a tree no
  code change has reached. If the next session needs a green gate for its own reasons, note that a
  fresh worktree needs `pnpm install && pnpm -r build` BEFORE `pnpm -r typecheck`, or it will fail
  in `tenant-secrets.*` on `Cannot find module '@launchpad/db'` (VERIFICATION #7, not a defect).

  **Reachable?** Nothing was built, so nothing new to wire. The feature's reachability was settled
  by D2/D3 (`deployBranchStagingStack` builds the hook and `deployProductionStack` calls it between
  `up -d db` and `up -d`) and E2 (the marker travels fleet result → `deployStaging` ref → workflow
  `StagingState` → card). Those are code-path claims verified by tests, not by a running system.

  **Does this satisfy the acceptance criteria?** No — and the gap is the whole point of the two
  `(human)` items. Every claim in this spec is currently held by unit tests over commands we
  *would* issue; **no database has been copied**. Until someone restores a tenant and reads
  `database.is_neutralized` back from the branch DB, this spec has a green suite and no evidence,
  which is precisely the shape VERIFICATION #1 warns about. Do not let the green gate read as done.

  One tree change, no code: removed an untracked `.gate-tc.log` left by the previous session's
  instrument (it captured the run where `node_modules` was missing, so it holds nothing worth
  keeping) — an uncommitted stray fails teardownEnv's dirty-tree guard, spec 0008.

- 2026-08-19 (initializer, nothing to initialize) — This spec arrived with every non-`(human)`
  Progress item already shipped and committed (`98fbe2f`…`30bb377`). There are no foundations to
  lay and no items to add: the only work left is the two `(human)` proofs, which no coder session
  can close. Adding a plan item here would be inventing work to look busy, so I verified the
  existing claim instead.

  **The gate is green in this worktree** — but only after `pnpm install` and `pnpm -r build`:
  typecheck exit 0, 1822 pass / 0 fail, `next build` exit 0. (Progress says 1814; the extra 8 are
  spec 0225's, which landed after.)

  Three instrument failures on the way there, all mine, recorded because the next session in a
  fresh worktree will hit the same ones:

  - **VERIFICATION #8, in the command I wrote to observe the gate.** I ran
    `pnpm -r typecheck 2>&1 | tail -5; echo "…${PIPESTATUS[0]}"` in the background and the harness
    reported *exit code 0*. That was the trailing `echo`'s status. The real exit was 1 and `tsc`
    had never run — the worktree had no `node_modules` at all. Had I stopped at the green, I would
    have written "gate verified" about a tree that had compiled nothing.
  - **A red typecheck that is not this spec's.** On a fresh worktree `pnpm -r typecheck` fails in
    `tenant-secrets.*` with `Cannot find module '@launchpad/db'` — unbuilt declaration files
    (VERIFICATION #7), not a defect. `pnpm -r build` first, then typecheck. Nothing in
    `neutralize.ts` / `prod-copy.ts` / `staging.ts` / `stack.ts` was ever implicated.
  - **Two greps returned empty and neither was information.** `^# pass` cannot match, because
    pnpm prefixes every line (`apps/web test: # pass 776`). I only got a real count after running
    the pattern against the log's actual shape — rule #14, twice in one session.

  Nothing here copied a database, so the spec's substantive proof is still entirely owed to the
  two `(human)` items.

- 2026-08-19 (E2 shipped) — Smaller than specced, because `StagingState` is workflow state rather
  than a DB row: the flag travels the path the host and addons already travel, and the migration I
  had assumed was unnecessary.

  The flag is a CONSEQUENCE, not an assertion: it is set from `restoreFromProduction` having been
  built, and reaching that return at all means `neutralizeRestoredDb` did not throw — which it does
  unless the marker read back true. Claiming it unconditionally turns a test red. And it is ABSENT
  rather than `false` when no copy ran, because the card reads absence as "clean Odoo" while a
  `false` would be a claim about a copy nobody attempted.

- 2026-08-19 (E shipped) — The two facts sit on the same card because they are one message. The
  disposable line is unconditional and needed no data at all, which is the whole of decision 6;
  `neutralizada` is gated on the PROVEN marker, and making it unconditional turns a test red — the
  point being that absent must read as "clean Odoo", never as "probably neutralized".

  Honest gap, listed as E2: `StagingRef` carries `neutralized` and the UI honours it, but nothing
  writes it yet — the deploy result has to reach `project_branches`. So the badge is
  correct-but-never-shown. I would rather ship a badge that cannot lie and is not yet reachable
  than one that appears on the strength of an inference.

  Also: the web typecheck failed once here on `Property 'neutralized' does not exist on type
  'StagingRef'` — the pipeline's `dist/` predating the field. VERIFICATION #7, third time this
  session. Rebuilt, clean.

- 2026-08-19 (D3 shipped) — The composition now has its own tests, and they assert the property
  rather than the plumbing. The middle one is the whole spec in one line:

      assert.ok(upAll > proved, "odoo must not start until the copy is provably neutralized")

  — an ordering over the commands that actually reached the host, not over the code's shape.

  Both guards broken and watched go red: building the hook regardless of the decision makes the
  default path touch production (and cascades through eleven other tests, which is itself
  informative — the default path is load-bearing everywhere); removing the destroy leaves the branch
  stack up after an unproven copy.

  With that, every piece of this spec is tested and the assembly is too. What remains is E (the
  branch card) and the two `(human)` items, which is where the real proof lives: nothing here has
  copied a database yet.

- 2026-08-19 (D2 wired) — The hook is built in `deployBranchStagingStack` rather than lower down
  because that is the only layer that knows both stacks: `deployProductionStack` is told what to
  do, never how to find production.

  Fail-closed is explicit. If the copy throws, the branch's `db` is up holding production data that
  may not be neutralized and `odoo` never started — so nothing serves it, but leaving it there is a
  copy of a customer's database sitting on the box. The stack is destroyed and the ORIGINAL error
  propagates: the cleanup is not the news. A cleanup that itself fails is logged loudly, because
  that is the one case where data really is left behind and it must not be silent.

  Not done, and listed rather than implied: the composition has no test of its own. Each piece is
  tested — the decision, the copy, the neutralize, the hook's placement — but "the hook is built
  only when asked, and a failed copy destroys the stack" is currently held by reading the code.

- 2026-08-19 (audit) — the owner asked for an audit of the pieces with a justification for each. Writing
  it found two things in my own code, and the second changed the design.

  **A guard disarmed in the same statement that declared it.** The filestore copy ran
  `cp -a /from/. /to/ 2>/dev/null || true` with an `if (code !== 0) throw` immediately after.
  `|| true` forces exit 0, so the branch was unreachable, and `2>/dev/null` blanked the stderr its
  message quotes. Both were there to tolerate an empty filestore, which `cp -a /from/.` already
  tolerates. VERIFICATION #2, written by the same hand that wrote the check.

  **`PROD_WRITE_VERBS` was a denylist, and denylists are the wrong shape here.** Its first version
  flagged our own read-only copy (`rm -` matches `docker run --rm -v`) while, by construction,
  missing anything not on the list. Replaced by `productionCommand`: a closed union of the TWO
  things this module may do to production, with the commands BUILT there — so the test enumerates
  every command that can possibly reach production and asserts each is a read, and a second test
  asserts nothing reached production that did not come from the builder. Letting a raw `psql` reach
  prod now turns that test red; under the denylist it passed.

  Writing the exhaustive test then exposed a third thing: `toPath`, `dbName` and `toVolume` are
  interpolated into a shell command, so "production cannot be changed by this module" was one
  semicolon from false. `productionCommand` now refuses any value a shell would interpret. Nothing
  real is refused today — every caller passes slugs and generated names — which is exactly when to
  add it rather than after someone wires a form to it.

- 2026-08-19 (D shipped) — The hook sits between `up -d db` and `up -d`, which is where
  `initTenantDb` has run since spec 0014. It REPLACES that init rather than joining it: a restored
  copy already has everything, and installing `base` over it would be a second source of truth.

  Three assertions, each about the safety property rather than the mechanics: a production deploy
  never restores (the hook is absent, and ordinary init still runs); with the hook, `up -d db`
  precedes the full `up -d` and init does NOT also run; and a hook that throws leaves `up -d`
  unexecuted, so odoo is never started over a copy whose neutralization could not be proven.

  Breaking it took three attempts — the first two "passes" were my own broken break-scripts, not
  the code, and one of them ran the test suite against an unmodified file while I read the green as
  meaningful. Moving the restore to after `up -d` finally turned two tests red, which is the
  property I actually wanted pinned.

- 2026-08-19 (C shipped) — And a test that proved nothing, caught by trying to break it.

  I wrote "the redeploy rule is checked BEFORE the flag" and asserted it, with a comment claiming
  that reading `wantsCopy` first is how copy-once quietly stops applying. Then I reordered the two
  branches and **every test still passed** — because both orders give the same DECISION and differ
  only in which reason comes back. The property I had written a test for was not real.

  What is real: deleting the `stackExists` branch entirely makes a redeploy copy production over a
  tester's work. That turns two tests red, and it is what the rewritten test pins. Kept the episode
  in the comment so the next person does not re-derive the wrong invariant from the ordering.

- 2026-08-19 (A restore half shipped) — The property this code exists to hold is not "it copies"
  but "production cannot be changed by it", so that is what the tests assert: every command issued
  against the prod project must be a `pg_dump` or a read-only mount, and must match none of
  `PROD_WRITE_VERBS`. Dropping the `:ro` on the filestore turns two tests red.

  **The check caught me before the code did, and the fix was to sharpen it rather than weaken it.**
  My first verb list was substrings, and `rm -` matches `docker run --rm -v` — so it flagged the
  read-only filestore copy as a write. The tempting move is to delete the assertion; the right one
  is regexes with word boundaries, plus a new test that proves the LIST still fires on a real write
  (`delete from res_partner`) while sparing docker's `--rm`. A guard that cries wolf gets weakened,
  and this one guards the only place we touch a customer's live database.

  The second guard is the failure that looks fine: a restore that lands in an EMPTY database
  neutralizes cleanly and serves an Odoo that passes every other check. `assertRestored` reads
  `ir_module_module` back and refuses a zero — non-retryable, because retrying a restore that
  produced nothing produces nothing again.

- 2026-08-19 (A/B shipped) — The `db`-first sequencing the third pass invented turned out to
  already exist: `stack.ts` has brought up Postgres alone and run a one-off
  `docker compose run --rm odoo` since spec 0014, for tenant DB init. So the corrected design is
  not new machinery, it is the pattern this module already uses — which is the best possible
  outcome for a safety property.

  Two guards, both broken on purpose and watched go red:

  - **trusting the exit code** instead of reading the marker turns three tests red. `docker compose
    run` returning 0 is a status that travelled through two layers of container plumbing (#8); the
    row in the database is the end state, and it is the same row that drives Odoo's red banner.
  - **using `exec` on the serving container** instead of `run --rm` turns two red. That is the
    difference between neutralizing a database nothing is serving and neutralizing one that is
    already answering on 8069.

  Error classification is deliberate and tested: a FAILED neutralize is retryable (Odoo's script
  upserts the flag and its UPDATEs are already-false-safe, so a second attempt is harmless), while
  a marker that reads false is NOT — that copy must be destroyed, not retried.

- 2026-08-19 (third pass, implementing) — The plan's decision 1 was wrong in a way that only shows
  up when you go to build it: **the Traefik labels are in the compose template**, so "restore, then
  attach Traefik" describes a step that does not exist. The instant the stack comes up, the router
  is there.

  What replaces it is better, because it is structural rather than sequential: bring up ONLY the
  `db` service, restore into it, neutralize with a one-off `odoo neutralize` container (a CLI
  command that exits — nothing ever listens on 8069 in it), assert the marker, and only then bring
  up `odoo`. The un-neutralized copy never has an HTTP server in front of it at all.

  One consequence: `restore_db(neutralize_database=True)`, which the second pass had made the
  centrepiece, needs a RUNNING Odoo to call it — exactly what must not exist yet. So the restore is
  `psql` plus a filestore copy after all. That is not a return to the first draft's plumbing: the
  hard part there was producing a consistent DB+filestore pair, and Odoo's dump already is one.

- 2026-08-19 (second pass) — the owner asked for every action to be compared against odoo.sh so we do not
  reinvent. Two more things fell out, both from reading `odoo/service/db.py` in our own image
  rather than from documentation:

  **`restore_db` takes `neutralize_database=True`.** So dump-and-restore and neutralize are ONE
  Odoo operation, and `dump_db`'s zip already carries the filestore alongside the SQL. The plan's
  three hardest steps became one call. What I had written as the spec's centre — plumbing pg_dump,
  copying a docker volume, and keeping them consistent — was all reimplementation.

  **odoo.sh copies production once, at branch creation.** On later pushes *"the database is not
  re-created"*. Our 0134 redeploys a branch's staging at gate 2, so restoring there would wipe the
  tester's data on every round — a bug I would have shipped, and one that only shows up when
  somebody is actually using the branch.

- 2026-08-19 (revised) — the owner asked how platforms like odoo.sh handle this, and the answer changed
  the spec: **Odoo already does it**, natively, since v16, and odoo.sh runs exactly that. The first
  draft's decision 3 — "a fixed SQL script in the repo" — was me about to reimplement a maintained
  thing badly. Reading `base/data/neutralize.sql` off our own running container showed four
  concrete misses (the SMTP fallback dummy, the autovacuum exception, webhooks, per-module scripts).
  The ponytail ladder's second rung, paid for by one search and one `docker exec`.

  What survives from the first draft is the part Odoo does NOT do: restoring safely (before Traefik
  attaches), failing closed, and staying on the sandbox box.

- 2026-08-19 — Written after the owner chose to build the real thing rather than reword the promise. The
  spec leads with the danger because that is the whole engineering problem: restoring is easy,
  and restoring safely is the spec. The mail-proof caveat is recorded as owed rather than passed,
  since a no-op scrub against a system that cannot send mail proves nothing about one that can.
