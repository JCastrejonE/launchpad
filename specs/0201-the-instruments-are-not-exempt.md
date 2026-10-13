---
id: 0201
title: The instruments are not exempt
tenant: launchpad
product: forge
status: completed
track: 1
requested_by: owner@example.com
approved_by: owner@example.com
ui_only: false
---

## Intent

The owner: *"What you say is discipline needs to be recorded as well in this repo's CLAUDE.md else we will
stump with past problems on context clean. Also write the scripts so you don't forget procedures,
especially deploy."*

Every rule in `docs/VERIFICATION.md` is about a check inside the product. None of them is about the
**instruments** — the throwaway `psql`, `curl` and `until … sleep … done` commands a session writes
to observe the system. Those are unreviewed, uncommitted, invisible, and this session alone they
produced:

| instrument | what it did | cost |
|---|---|---|
| a poll for an initializer session row | waited for a phase the run could not reach — gate 1 was unpressed | **52 minutes** |
| a poll on `provisioning_status` | column does not exist; the inner query errored, printed nothing, so `!= "running"` was instantly true and the loop exited having measured nothing | a run reported as finished that had not started |
| `git bundle` from a base the box lacked | remote `git pull` errored; `systemctl restart` still reported `active` | **twice**; the second time spec 0199's prompt fix was reported deployed while the box ran the old tree |
| `grep -oE '[$][0-9]+'` on an RSC payload | matched React chunk ids (`$1`, `$12`), not prices | prices reported missing from a page that rendered them |
| `s.created_at`, ambiguous `name` | queries referencing columns that do not exist | two aborted measurements |

The shared shape: **the instrument was written to confirm what I expected, not to distinguish
outcomes.** A wait loop that cannot say *why* it is still waiting. A negative grep never tried
against a known positive. A deploy declared done because a service said `active`.

Two of these are not discipline problems at all, and that is the part worth fixing in code:

- **There is no deploy script.** The procedure lives in one table row in `PENDING.md` and in the
  session's head. A procedure that is re-derived from prose every time will be got wrong again; it
  already was, twice.
- **There is no way to ask a production run why it is waiting.** Every A/B run got a hand-rolled
  poll, and the hand-rolled polls are where the failures are.

**A claim this spec made and then disproved, kept because the correction is the point.** The first
draft asserted that `scripts/gate-watch.mjs` already solved the wait-loop problem — its header says
it exits at the gate-parked phases — and that I had merely reached past it because line 51 strips
every non-digit (`cafeteria-0005` → `spec-0005`, a workflow that does not exist). The id bug is real
and is `docs/VERIFICATION.md` #11 for the fifth time. The claim around it was not: `gate-watch.mjs`
connects to `localhost:7233` and is pinned to `/home/dev/launchpad`, a checkout that is not even
this repo. Production Temporal is deliberately not exposed off-box, so the tool **could not have
watched any A/B run**, id bug or no. The hand-rolled polls were not laziness about an available
tool; they were the only thing available. What was wrong with them is the missing liveness check.

I nearly shipped "the tool was already there and correct" — inside the spec about not trusting an
instrument I had not run.

## The correction this spec also records

Spec 0200 nominated its `(human)` proof as *"a Progress item carrying its commit SHA."* That check
**cannot pass in a customer project**, and not by accident: spec 0141 deliberately puts the spec
outside the repo (`specs/` is a symlink to `/srv/launchpad/specs/<slug>`, not a git repo), so
`agents/coder.md` step 6 — commit the work and the checked-off item together, then append that
commit's short SHA — is describing something the repo shape forbids. I nominated an impossible
proof and read its absence as evidence of failure.

The prompt did arrive. The coder said so, in the only way left to it:

> *"La spec no entra en ningún commit: `specs/` en el checkout es un symlink a
> `/srv/launchpad/specs/cafeteria`, que no es un repo git… y no hay commit de handoff."*

That is reasoning about a rule which exists **only** in `coder.md`. `docs/VERIFICATION.md` #2 says
pick a check that can actually fail; its silent half is that a check must also be able to **pass**.

Consequence beyond the proof: `coder.md` steps 6 and 7 are written for the platform repo and are
impossible in every customer project. The prompt should say which half applies where, rather than
asking for something the shape forbids and spending the model's turns on the contradiction.

## Plan

**A. Record the rule where a context clean cannot lose it.** `CLAUDE.md` gets verification entry
**#14** (the instruments are not exempt); `docs/VERIFICATION.md` gets the evidence table above.
Entry **#2** gains the one-line corollary about a check that cannot pass, sourced to 0200.
`CLAUDE.md` is composed into every agent session's system prompt, so this reaches the coders too.

Admission bar, checked before writing: the deploy failure happened **twice** and produced a false
claim that shipped ("0199 deployed" against a box running the old tree); the wait-loop failure cost
52 minutes of a launch-critical run. It qualifies on both counts.

**B. `scripts/deploy-control-plane.sh` — the procedure, with the end state asserted.** One command,
idempotent, and built so both observed failure modes are structurally impossible:

- The bundle base is **read from the box**, never assumed — `git rev-parse HEAD` over ssh — so a
  bundle can never be cut from a commit the box lacks.
- `git merge-base --is-ancestor` refuses to deploy when the box holds commits we do not, instead of
  producing a bundle that will fail to apply.
- Every remote step runs under `set -euo pipefail`, and the ssh exit status is read from
  `PIPESTATUS[0]`, never through the pipe (`docs/VERIFICATION.md` #8).
- It ends by asserting the **end state**, not the action: the box's `HEAD` equals the commit we
  pushed, both units report `active`, and `/api/health` answers 200. `--verify-only` runs just that.

**C. `scripts/run-watch.sh` — why is this run not finished?** Reads the control-plane DB over ssh
(the same data the UI shows) and always answers with one of three states, never "waiting":

- **PARKED** — a gate is open, nothing is running, a human must click. The 52-minute state.
- **WORKING** — a session is in flight, with role, minutes and turns.
- **STALLED** — no gate, no live session past a threshold. Investigate.

`--watch` polls, and every line carries the state, so a silent wait is impossible by construction.

**D. `gate-watch.mjs` accepts a project run.** `0020` → `spec-0020` (unchanged), `cafeteria-0005` →
`spec-cafeteria-0005`, full id → passthrough. It prepends `spec-` when absent and never strips a
prefix, so #11 cannot recur here. This does not make it usable against production — see above — it
keeps the local-dev tool honest about the id rule.

## Out of scope

Rewriting `coder.md` steps 6 and 7 for the two repo shapes. Real — it is a contradiction the model
currently pays turns to resolve — but it is a prompt change that wants its own measurement against
run 7's baseline, not a rider on a tooling spec. → `PENDING.md` deferred table (CLAUDE.md rule 8).

Retiring or re-pointing `gate-watch.mjs`. It is stale (a dev checkout path that no longer exists) but
it is the local-dev watcher and nothing depends on it being production-capable. Re-pointing it is a
bigger change than run-watch was, for a surface I do not currently use.

A general-purpose wait/poll helper. The remaining polls are one-offs where the fix is the rule in A.

## Progress

- [x] A — `CLAUDE.md` #14 + `docs/VERIFICATION.md` #14; #2 gains the cannot-pass corollary
- [x] B — `scripts/deploy-control-plane.sh`, end state asserted, exercised against the live box
- [x] C — `scripts/run-watch.sh`, exercised against parked / terminal / missing runs
- [x] D — `gate-watch.mjs` names a project run
- [x] E — the deferred `coder.md` item recorded in `PENDING.md`
- [x] Gate: `pnpm -r typecheck && pnpm -r test`
- [ ] (human) `run-watch.sh` prints **WORKING** against a live session — the one branch no current
      run could exercise, since nothing was in flight while it was written. Confirm on run 7's first
      initializer session.

## Handoff log

- 2026-08-13 — Written from the owner's instruction after the 0199/0200 measurement.

  Both scripts were exercised before being claimed. `--verify-only` was pointed at a box one commit
  behind and went **red on the HEAD check while reporting both units `active` and health 200** —
  which is the 2026-08-13 failure reproduced exactly, and the reason to trust its green.
  `run-watch.sh` was run against a parked run (`cafeteria-0005`, 81m at `awaiting_pr_approval`), two
  terminal runs and a nonexistent id; the parked line is the sentence whose absence cost 52 minutes.
  WORKING is the one branch nothing could exercise today, so it is a `(human)` item rather than a
  claim.

  The uncomfortable part is in the Intent: the first draft cited `gate-watch.mjs` as the tool that
  was already there and already correct. It connects to `localhost:7233` and to a checkout path that
  is not this repo, and production Temporal is not exposed — so it could never have watched an A/B
  run. Caught by running it. In the spec about not trusting an instrument I had not run.
