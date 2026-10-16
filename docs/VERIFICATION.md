# Verification discipline — the evidence

`CLAUDE.md`'s **Always-on: verification discipline** section carries the rules. This
file carries what each one cost, so a rule can be audited instead of taken on faith,
and so a future reader can judge whether it still earns its place.

**Admission bar** (also stated in CLAUDE.md): a lesson gets promoted only if the
mistake was made **twice**, or cost real money, a live incident, or a false claim
that shipped. Everything else stays in its spec's `## Handoff log`.

Why here and not only in handoff logs: 22 specs contain a stated lesson, and they
are read once. `CLAUDE.md` is composed into **every** agent session's system prompt
(`packages/agents/src/session.ts`), so it is the only place a lesson reaches the
coders as well as the human. Spec 0086 documented the RSC-payload trap and spec
0109 walked into it anyway — that gap is what this file exists to close.

---

## 1. A fake proves the call you made, not the contract the world imposes

Four instances, all past a green suite:

| spec | what the fake blessed | what was actually wrong |
|---|---|---|
| 0093 | `DeployResult.modules` | reported modules it had not installed |
| 0094 | re-deploy behaviour | `initTenantDb` is skipped when the DB exists, so a re-deploy installs nothing |
| 0097 | 97 passing tests | a missing `mkdir` for the addon dir — invisible because `FakeSshRunner.writeFile` is a `Map.set` |
| 0099 | `deepEqual(result, {behavior:"allow"})` | the SDK's runtime schema requires `updatedInput`; every *allowed* write failed for ~50 specs, so the in-UI drafter could never write a spec |

Sharp form: **when a test asserts the argument you pass to a boundary rather than
the boundary's response, it proves intent, not function.**

Consequence: where a fake cannot reach, the live check is load-bearing. Mark it
`(human)` — `HUMAN_ITEM_RE` (`apps/web/lib/specs.ts`, mirrored in the pipeline's
`store.ts`) recognises only that literal marker when excluding an item from the
done-condition. `(live)`, `(visual)` and `(functional)` read fine to a person and
are invisible to the harness, which would leave a run unable to finish.

Track record: `(human)` steps caught 0097's fake-verified claim, 0101's deleted base
CSS, and both spec-0109 defects — none of which the 961-test suite saw.

## 2. Pick a check that can actually fail

Twice in one session I ran a check whose negative result was meaningless:

- Searched the agent session transcripts for a system prompt **they do not
  persist**, and briefly concluded the prompt never reached the session. A control
  string that had been in `coder.md` for months was equally absent.
- Grepped a dev-server RSC payload (see rule 3).

Both were withdrawn within a minute, but both produced a wrong conclusion first.
Before trusting a negative, ask what a positive would have looked like.

The positive form of this, already practised: **prove a new test can fail.** Spec
0105's fence test was verified by disabling the fence and watching it go red before
the green was trusted.

## 3. A dev-server RSC payload cannot be grepped

`next dev` inlines source for HMR, so any string literal in the module graph appears
in the payload whether or not a code path runs.

- **0086:** the platform page looked like it leaked all 85 spec bodies (2.1 MB,
  `## Intent` ×97). The same route under `next build && next start` was **64 KB with
  zero bodies**.
- **0109:** `"Start run"` appeared 30 times in the payload after the fix that
  removed every such row. The authoritative checks were calling `deriveNextStep`
  directly against real spec files, and a screenshot.

Use a production build, or test the function directly.

## 4. A Tailwind class is a string

`tsc` cannot type-check a class name, `next build` only catches bundling, and
`web-smoke` proves a route returns 200, not that it looks right.

**0101** cut the legacy CSS dialect and, because spec 0080 had merged the template's
*own base rules* below the legacy block, the cut removed `html`/`body`/`*`, the
scrollbar and every `mc-*` helper. typecheck, 432 tests and `next build` were all
green with the app's entire base styling missing. Only a screenshot could see it.

So: UI work needs a pixel check (`scripts/ui-shot.mjs` writes PNGs that can be read
back), and "gate green" is a regression floor, never evidence about appearance.

## 5. A constant with zero variance is a constraint, not a habit

**0106:** tool calls per turn measured exactly **1.00 across 237 turns** of two
separate runs. I read that as a prompt gap and shipped batching guidance to four
role files. It changed nothing — 177 more turns, still exactly 1.00 — and a direct
probe then showed both Opus and Sonnet emit one call per turn even when told bluntly
to parallelise. I then called it a hard SDK limit, and that was wrong too: parallel
tool use is on by default, and a later trace that logged tool names showed the work
itself was sequential, 22 of 24 calls stateful `Bash`, `Edit` or `Write`
(`docs/AGENT-TOPOLOGY.md`, "Batching"). The role prompts in `agents/` still carry
the "hard limit" sentence, as the agents saw it.

Behavioural tendencies vary. An exact constant is a property of the system. Prove
the mechanism before shipping a fix for it.

## 6. Verify that a config or prompt change was delivered

Delivery is a git question, not a log question. For 0106 the check that mattered was
`git merge-base --is-ancestor <prompt-commit> <run-base>` — confirming the guidance
was in the tree the run was cut from — because the transcripts do not record system
prompts at all (rule 2).

## 7. A generated directory outlives what generated it

Three times now, a generated artifact stayed behind and a check read it as truth.

- **0083:** `dist/` kept tests whose source files were deleted, so `node --test dist/*.test.js`
  went on running them. Test counts were inflated for weeks and every suite was green.
  Fixed by prefixing `rm -rf dist &&` in all six workspaces.
- **0122:** deleting an App Router route left `.next/types/app/<route>/page.ts` behind, and
  `apps/web` typecheck failed on a route that no longer existed.
- **0123:** a `next build` left production output in `apps/web/.next`; `next dev` started on top
  of it and `/projects/platform` 500d with `Cannot find module './vendor-chunks/@temporalio+proto…'`
  while lighter routes stayed 200 — which is what made it look like an app bug rather than a
  stale artifact.

The pattern: the artifact is *newer* than the thing that should have invalidated it, so nothing
looks stale. A doc warning did not prevent 0123 — PENDING §7 already said "`next build`
overwrites `.next`", and the warning was followed; the damage came from starting dev
**afterwards**.

**Guard it in the tool, not in a doc.** `preflight` now removes `apps/web/.next` when it carries
`BUILD_ID`/`required-server-files.json` (spec 0123), the same shape as its existing
`packages/*/dist` staleness guard. And when you pick the marker, measure it: `next dev` also
writes `prerender-manifest.json` and `routes-manifest.json`, so a guard keyed on either would
have deleted the dev cache on every run.

## 8. A pipe reports the wrong exit code, in both directions

`cmd | tail` exits with **tail's** status. Every failure upstream of the pipe disappears, and the
shell reports success.

- **Gate runs (three times, spec 0122–0124):** `pnpm -r typecheck | grep -c error && pnpm -r test`
  read `grep`'s status, so a red typecheck read as green and red gates were pushed. Fixed by
  capturing `$?` from each command separately.
- **Host provisioning (spec 0125):** `ssh host 'install script' | tail -18` returned **0** while
  the script had aborted on its first command. The claim "runtime installed, exit code 0" was made
  about a box with no Node, no pnpm and no Docker on it. The output file held one line — that was
  the only clue, and it was easy to read as buffering.

And the inverse, because the obvious fix has its own trap: under `set -o pipefail`,
`tr -dc … < /dev/urandom | head -c 32` **fails**, because `head` exits first and the producer dies
of `SIGPIPE` (exit 141). A password generator built that way aborts a `set -e` script before it
prints anything. Read a bounded amount and truncate afterwards (`head -c 400 … | tr … | cut -c1-32`).

**What to do:** capture `$?` from the command you care about, not from a pipeline; then assert the
**end state** instead of any exit code — `node --version` on the box, the container listening, the
row in the table. Rule 2 says pick a check that can fail; this is its shell-level twin, and an exit
code that travelled through a pipe is not that check.

## 9. A UI action's path is not the function with the matching name

Spec 0129 D's live A/B test failed **twice, identically**: both runs worked on the launchpad's own
repository with `input.project = null`, when the whole point was to run against a customer repo.
Between the two attempts I verified four things and every one of them was correct:

| I checked | it was | and it was |
|---|---|---|
| the resolver code (`resolveRunTargetForSpec`) | correct | never called |
| the project row (`repo_owner`/`repo_name` present) | correct | never read on this path |
| the worker build (fresh `dist`, right commit) | correct | irrelevant — the caller was `apps/web` |
| the worker process (restarted, new pid) | correct | irrelevant, same reason |

The path was: **Start button → `POST /api/supervisor/run/<id>` → `spawnStartWatcher` →
detach-spawn `scripts/supervise.mjs` → `cli start` → `target: {kind:"self", repo:
process.env.LAUNCHPAD_REPO_ROOT}`**. The UI reached the workflow through a shell script invoking a
CLI in another package, and that CLI hardcoded the platform's own checkout. `apps/web`'s
project-aware starter — the code I had fixed, tested and rebuilt — was on a different path
entirely.

What went wrong in the *checking*, not the code: I grepped `workflow.start` call sites **within
`apps/web`**, found the one with the matching name, and stopped. A path that leaves the package is
invisible to that search, and four true facts about the wrong path read exactly like four facts
about the right one.

**What to do:** trace the button to the workflow — one hop at a time, across package boundaries —
*before* trusting a fix. Then prove the trace with something the running system emits: a log line
naming the resolved repo, or a recorded field (`agent_runs.repo_root`, spec 0131 C). And note the
second half of why this was expensive: a fallback to the platform checkout is byte-identical to a
deliberate platform run, so no surface could tell them apart. Rule 2 again — if a wrong answer and
a right answer look the same, you do not have a check.

## 10. A minifier renames the function you passed by reference

`client.workflow.start(specPipeline, …)` identifies the workflow by **the function's `.name`**.
`apps/web`'s production bundle is minified, so `specPipeline.name` there is `"P"`, and every run
started from the deployed web app registered as workflow type `P`:

```
TypeError: Failed to initialize workflow of type 'P': no such function is exported
by the workflow bundle
```

It retried on production for **nine hours** (2026-08-05, 05:57 → 15:00). The line type-checks, reads
correctly, and is what the SDK's own documentation shows.

Three things made it survive everything we had:

- **Every test passes.** Nothing minifies a unit test, so `specPipeline.name` is `"specPipeline"` in
  the suite and always will be. A test asserting it proves a rename didn't happen — never that the
  deployed bundle agrees.
- **`next build` is happy.** Minification is what it is *for*.
- **It was latent for months and then armed by an unrelated fix.** While only `cli start` (plain,
  unminified Node) started runs, the identical line in `apps/web` was only reached by the
  tenant-deploy form, which nobody had exercised against a production build. Spec 0131 A routed the
  UI's Start button through `apps/web` — a correct fix — and armed it.

**What to do:** across any boundary that identifies code by name — Temporal workflow/activity types,
job names, DI tokens, `Function.name` anywhere — pass a **string constant**, never a function
reference. `SPEC_PIPELINE_WORKFLOW_TYPE` is that constant, and it lives next to `TASK_QUEUE` because
"remember not to write the natural thing" is not a control.

### And the part that was worse than the bug

Diagnosing it, I wrote a script that read the workflow type as `e.type?.name`. The field is a plain
string, so it evaluated to `undefined`, and my "is this runnable?" test — `type !== "specPipeline"` —
was true for **every** workflow. I noticed, said so, wrote a corrected script, had it blocked by a
permission prompt, and then ran the **broken one** with `--terminate` because it was already there.
It killed the healthy run alongside the poisoned one.

The bug cost nine hours of retries on a run that was already dead. Acting on a check I had *already
established was broken* cost a live run that wasn't. Rule 2 is not only about trusting a green
result — it is about never acting on a check whose failure mode you have already named.

## 11. An id's parts are not "the prefix and the rest"

Temporal workflow ids for a pipeline run are `spec-<id>` for the platform and `spec-<slug>-<id>` for
every other project (spec 0142 C). Both **end** in the spec id. Four separate files nevertheless
recovered it with `workflowId.replace(/^spec-/, "")`, which on a namespaced id yields
`<slug>-<id>` — not a spec id anywhere:

| site | what shipped |
|---|---|
| `listRunningPipelineTargets` | fixed in 0142, with a comment stating the rule |
| `rollUpPromotedSpecs` (`@launchpad/db`) | the branch promote roll-up matched nothing, so no spec was ever marked promoted |
| `withGateActions` | a dead `Ver spec` link (`/specs/ab-test-sandbox-0003`) and a gate button that signalled `spec-<slug>-<slug>-<id>` |
| `activeRunSpecIdOnBranch` / `listProductionBusySpecIds` | the "branch busy" refusal named a spec that does not exist; the promote guard's busy list could not match a real id |

**Why it survives every test.** The platform case — the one anybody writes a test for, and the one
every pre-0142 history uses — passes under *both* rules. `spec-0147` strips to `0147` and its last
segment is `0147`. Only a namespaced id separates them, and namespaced ids only exist for customer
projects, which is precisely the path nobody exercises while building.

**What to do:** parse from the end, and put it in **one exported function** the moment there is a
second caller (`specIdFromWorkflowId`, spec 0156). The rule had been written down in a comment since
0142 and three later call sites still got it wrong — a comment is documentation, not a control.
More generally: when an id is `<fixed>-<variable>-<value>`, the variable part makes prefix-stripping
wrong and suffix-taking right, and the case that proves it is the one with the variable part
present.

## 12. An optional parameter is silent at exactly the call site that is wrong

Four defects in two days (2026-08-11/12) had one shape: a function grew an optional parameter and a
second caller never passed it.

- **0175** — `deployToFleet` omitted `host`/`certResolver`; a release re-rendered production Odoo on
  `prod.<slug>.<domain>`, the customer's hostname went 404, and the name it moved to had no DNS.
- **0176** — modules installed only at database init, so every release after a project's first copied
  the addon to disk and never installed it. The case that proved the mechanism — a first deploy onto a
  fresh database — is the only case that does not exercise the path.
- **0179** — `suppressDuplicateApprove` had exempted branch runs since spec 0142, and **neither** call
  site passed `branch`, so gate 2's approve was hidden on every branch run. A correct, tested rule
  that could not fire.
- **0180** — the gate-2 staging refresh omitted the front deps spec 0172 added, so a branch's front
  served whatever it was built from at creation while its Odoo carried four new commits.

Grep every call site in the same change that adds the parameter. When a rule *should* fire and does
not, check that its argument arrives before debugging the rule. Prefer a required parameter; where
that is not worth it, guard the call site (see `activities.test.ts`'s 0180 guard) and break it once.

## 13. A hidden browser tab is not a user

UI driven by the automation tools runs in a tab whose `document.visibilityState` is `"hidden"`, and a
screenshot forces a paint without changing that. Anything on `requestAnimationFrame`, or polling
guarded on `document.hidden`, legitimately stops.

Cost: the provisioning progress view was filed as the single largest blocker to unattended operation
and recommended as the next thing to build. The API answered correctly the whole time and the
component polled correctly; a person with the tab on screen saw it advance. The same artifact had
been suspected for the wizard's step transitions hours earlier and the suspicion was not applied.

Check `document.hidden` and the server's own answer before filing "the UI does not update" — and keep
diagnosing, because real defects hide in there (the mount-time poll *was* wrongly skipped).

**Second helping, 2026-08-18 — it is not only paint. A hidden tab does no LAYOUT, and clicks need
layout.** Three times in one session the first click after a navigation did nothing and the second
worked, and I reported it to the owner as a probable app defect worth a deliberate test. Measured instead:

| | before a screenshot | after a screenshot |
|---|---|---|
| `getBoundingClientRect()` | `{0,0,0,0}` | `x 1245.7, y 316.5, 134.8×36` |
| React props on the button | absent | **attached** |
| `document.hidden` | true | still true |

The element existed in the DOM with **no coordinates**, so a coordinate click landed on nothing;
hydration was gated behind the same missing layout. The screenshot forces layout and unblocks both.
Every button I screenshotted BEFORE clicking worked on the first try — the deploy button, every
time — which is the control I already had and did not read.

**So: screenshot after navigating and before the first click, always.** Not for the picture — to
force the layout the click needs. And the discriminator when a click "does nothing" is one line:
`getBoundingClientRect()` on the target. Zeros mean the page was never laid out and the click never
had anywhere to land.

Corollary: this is very likely the same root cause as *"a11y-`ref` clicks do not reliably fire"*
(run 8, finding 8.2), which was filed with cause unknown after a `ref` click returned success and
did nothing while a coordinate click worked. A `ref` resolved against a zero-size element has the
same problem.

## 14. The instruments are not exempt

Rules 1–13 are all about checks inside the product. Nothing here covered the **instruments** — the
throwaway `psql`, `curl`, `grep` and `until … sleep … done` commands a session writes to observe the
system. They are unreviewed, uncommitted and invisible, and on 2026-08-13 alone they produced:

| instrument | what it did | cost |
|---|---|---|
| poll for an initializer session row | waited for a phase the run could not reach — gate 1 was unpressed | **52 minutes** |
| poll on `provisioning_status` | column does not exist; the inner query errored, printed nothing, so `!= "running"` was instantly true and the loop exited having measured nothing | a run reported finished that had not started |
| `git bundle` from a base the box lacked | remote pull errored; `systemctl restart` still said `active` | **twice**; the second time spec 0199's prompt fix was reported deployed while the box ran the old tree |
| `grep -oE '[$][0-9]+'` on an RSC payload | matched React chunk ids (`$1`, `$12`), not prices | prices reported missing from a page that rendered them |
| `s.created_at`, ambiguous `name` | columns that do not exist | two aborted measurements |

One shape: **the instrument was written to confirm what was expected, not to distinguish outcomes.**
A wait loop that cannot say *why* it is still waiting. A negative grep never tried against a known
positive. A deploy declared done because a service said `active`.

The rule has three parts, and the third is the one that actually holds:

1. A wait loop must name which state it is in — working, blocked, or stalled — on every line. If it
   cannot tell "an agent is running" from "a gate needs a click", it is not a check.
2. Before trusting a negative from a grep or a query, run it against a case you know is positive.
3. **Where a procedure is repeated, write the script.** Discipline degrades under a context clean;
   a committed script does not. Spec 0201 wrote `scripts/deploy-control-plane.sh` (reads the bundle
   base off the box, refuses a non-ancestor, asserts the end state) and `scripts/run-watch.sh`
   (PARKED / WORKING / STALLED, never a silent wait).

And the trap found while writing them: `scripts/gate-watch.mjs` was assumed to be the existing tool
for this, and cited as such in the spec's first draft. It connects to `localhost:7233` against a
checkout path (`/home/dev/launchpad`) that is not even the current repo, so it can only watch a
local dev run — production Temporal is deliberately not exposed. **Do not cite a tool as working
without running it**, least of all in the spec that is about not doing that.

### Corollary to rule 2: a check must also be able to *pass*

Spec 0200 nominated its `(human)` proof as "a Progress item carrying its commit SHA". That cannot
happen in a customer project: spec 0141 puts `specs/` outside the repo (a symlink to
`/srv/launchpad/specs/<slug>`), so `agents/coder.md` step 6 — commit the work and the checked-off
item together, then append the SHA — describes something the repo shape forbids. The absence was
read as evidence the fix had failed. It had not; the coder said so explicitly in its handoff, and
the plan-granularity result was real. Ask what a passing run would look like, in the exact
environment the check will run in.

## 15. A check that runs as root proves nothing about the user that runs the code

*Spec 0210, 2026-08-17. Two users blocked; both runs dead on the same line.*

`scripts/deploy-control-plane.sh` deploys as **root** into `/srv/launchpad/repo`, and the units
run as **`launchpad`**. Every deploy therefore handed the box back with 97,460 paths the services
could not write — including `refs/heads/main`, `packed-refs` and `.git/logs/HEAD`. The first
platform run after the 2026-08-16 deploy died with:

```
fatal: cannot update the ref 'HEAD': unable to append to '.git/logs/HEAD': Permission denied
```

**Every end-state assertion was green while this was true.** HEAD was the right commit, both units
were `active`, `/api/health` answered 200 off-box. All four are satisfiable by a box the pipeline
cannot commit on: root can write anything, and a health check only reads. *The one identity that
could not write was the only identity that needed to, and no check had ever run as it.* Assert the
property under the identity that will exercise it — `sudo -u <svc> test -w`, not `ls -l` read as root.

### Why weeks of root-owned files broke nothing until they did

Git replaces almost everything through `<file>.lock` + `rename()`, which needs write on the
**directory**, not the file. The reflog is **appended to in place**. So a root-owned tree lets
`git add` succeed and leaves the spec neatly staged, then refuses the commit. "git works but commit
doesn't" starts here — and the intermittency is not intermittent, it is the one non-atomic write.

### The instrument re-armed it in three minutes

After `chown -R` repaired the tree, `.git/index` was root-owned again at `21:29:30`. The command
was the `git status` run **to verify the repair**: `git status` refreshes and rewrites the index.
So the damage source is not the deploy alone — it is any root `git` in a tree a service owns,
including the most likely command anyone types on that box. Rule 14 says the instruments are not
exempt; this is the sharper version — **`git status` is not a read**, and a repair confirmed with
a mutating instrument is not confirmed. Only re-measuring caught it.

### What ships instead of discipline

The deploy chowns the tree back inside `set -e` before the restart, and `--verify-only` now answers
"can the harness still commit?" in one command. Ownership is reported as a *note*, never a failure:
a root-owned file that stays writable is harmless, and a check that reddens for something harmless
gets trained away.
