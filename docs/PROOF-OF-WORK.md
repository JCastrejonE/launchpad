# Proof of work

*A development model derived from Launchpad's own defect record, 2026-09-30. Nothing in it is inherited from what the repo told its agents to do; every rule points at the data that demands it.*

> The raw defect record (a 140-row compliance registry, run findings and an open-work ledger) is not included in this snapshot: it is full of production operations detail. The counts below were taken from it before it was removed.

## 1. What the record says

225 defects, deduplicated from the compliance registry (73 defect rows), `VERIFICATION.md`, `PENDING.md`, the A/B findings, spec intents that name an earlier spec as broken, and 95 `fix(` commits since 07-31.

| What detected the defect | Count | Share |
|---|---|---|
| Running the real thing and reading its state | 119 | 53% |
| The author noticing their own instrument was wrong (always after a wrong conclusion) | 43 | 19% |
| A person reading code or docs | 31 | 14% |
| A user hitting it | 16 | 7% |
| The gate (all build/typecheck/lint, none behavioural) | 7 | 3% |
| Breaking the code and watching a test go red | 4 | 2% |
| A reviewer agent | 2 | 1% |
| An outage | 2 | 1% |
| Spec review | 1 | <1% |
| **A unit test going red** | **0** | **0%** |

Three more facts:

- **173 of 178 product defects (97%) were introduced under an approved spec.** Spec-first is fully in force and does not change whether a defect is introduced or caught.
- **The next two largest shapes, after wrong assumptions in a plan (55 defects, §4), are invisible to the current gate by construction.** *An instrument that confirms what its author expected* (47 defects) lives in throwaway shell inside tool calls, which no checked-in test ever sees. *A second caller or consumer never wired* (35 defects, including 17 optional-parameter cases) is exactly what a unit test with a fake cannot notice, because the test calls the function directly.
- **The only mechanisms that demonstrably closed a recurring shape were compile-time** (a required union, a typed value). Not tests, not prose, not review.

**What the record says about the current model:** it optimises the wrong stage. It spends its effort before code (specs, tracks, handoff logs, roughly 715k words of prose against 57k lines of code) and at the gate (tests that assert the call the code made), while every defect that mattered was caught by running the system afterwards, often by a user or an outage. The strength worth keeping is elsewhere: the repo *records* its failures honestly and specifically. That is the only reason this analysis is possible.

## 2. How it compares to what exists

No existing model does exactly this, but every one that gets speed and a guarantee together rests on the same thing: **a check that can fail independently of the author's claim, plus cheap undo.**

| Model | Its guarantee | What it is blind to | What this model borrows |
|---|---|---|---|
| Trunk-based CD (Google, Meta, Shopify) | presubmit + canary metrics + two-click rollback; 70% of outages are caused by live changes | slow-burn, low-traffic defects | small changes, staged exposure, rollback as the primary safety |
| Mutation testing at Google | 17M mutants; kill rate is coupled to real faults | missing features, misread intent | break every new test before trusting it |
| AWS formal methods | model checker finds bugs after stress tests pass | implementation drifting from the model | executable acceptance checks, not prose |
| Anthropic long-running-agent harness | feature list with `passes:false`, browser-as-user test, one feature per session | the agent grading itself; no published numbers | the per-item pass flag, but flipped by a mechanism, not by the agent |
| Spec-driven development for agents (Spec Kit, Kiro) | prose the agent reads | aggregate rules: 31% violated over 117 days in the one field audit; "if a rule cannot be violated in one edit, it needs a tool" | nothing; this is what the record says does not work |
| Codex / Copilot coding agent | container, test loop, human diff review; Codex's own risk table lists "falsely claims completion", mitigation: you | whatever the reviewer skims | never let the author's report be the evidence |

The name: **proof of work**. A change is accepted on evidence it produces, never on a description of what it does.

## 3. The model

### 3.1 The unit of work is a claim, and a claim is executable

There are no specs. A change begins as a list of **claims**: sentences a user could verify, each paired with the command that verifies it. The claim file is short, lives in the repo next to the code it describes, and is the only planning artefact.

```yaml
# claims/branch-staging-copy.yaml
- claim: A branch created with "copy production" serves the production data, neutralised
  verify: node tests/journeys/branch-copy.test.mjs
  kind: journey          # runs against a real stack
- claim: A branch created without it serves an empty database
  verify: node tests/journeys/branch-empty.test.mjs
  kind: journey
- claim: The branch card says "copia de producción · neutralizada" only when it is one
  verify: node tests/ui/branch-card.test.mjs
  kind: browser
- claim: Both callers of deployBranchStagingStack pass copyProduction through
  verify: tsc --noEmit    # copyProduction is required, not optional
  kind: compile
```

Rules for a claim:

- **It names an observable effect, never a call.** "Installs the module" is a claim; "calls `installTenantModules`" is not. This is the direct answer to the nine assert-the-call defects and to spec 0226, whose "built" items were all true and whose feature nothing could reach.
- **Its verify command must be able to fail.** Before a claim counts, its check is broken on purpose and must go red (`breakcheck`). Four defects were caught this way (three by hand-rolled breaks, a fourth on the first run of `scripts/break-check.sh`); more importantly, hand-rolled breaks failed three times in one day (one of the three twice), each time in the harness rather than the idea, which is why the break is done by a tool and not by hand.
- **A claim that can only be checked live says so** (`kind: live`) and is checked live before the change is accepted. Not marked `(human)` and forgotten: 76 of the 225 defects could only be caught by a live system, so the live check is part of the definition of done, not an exemption from it.

Why claims instead of specs: 97% of defects were introduced under a spec, and spec review caught one. The claim file keeps the one thing a spec did well, a written list of what "done" means, and drops the 20 sections around it. Writing a claim takes a minute. Writing the check takes longer, and that is where the time should go.

### 3.2 Wiring is proven by the type system, not by a test

35 defects, the third-largest family, were code that was built, tested, and never reached. Tests cannot catch this: a test calls the function, so the function is reached. The only mechanisms in the record that closed instances of this shape were compile-time.

So:

- **No optional parameters on a boundary that a second caller might cross.** A new input is required, and the compiler lists every call site that now fails. Spec 0226's `copyProduction?: boolean` would have been `copyProduction: boolean`, and both callers in `activities.ts` would have failed to compile until they passed it.
- **A value that is produced but never consumed is a lint error**, in the style of `lint-boundaries`, extended to "exported and called by nothing outside its own tests".
- **Every new activity, route, action and workflow needs a journey test that reaches it from the outside** (a request, a click, a Temporal start), not a unit test that imports it.

### 3.3 Instruments are code

47 defects, the second-largest family, were in the throwaway shell a session wrote to *observe* the system: a poll that could not say which state it was in, a grep that matched chunk ids as prices, a `docker compose up` in the wrong directory that built an empty stack, a break harness that restored the wrong bytes. None of it was committed; none of it could be reviewed or reused; 36 of the 47 were caught only when the author noticed a conclusion was wrong.

Rule: **an observation that will be made twice is a script in `scripts/`, with a known-positive test.** A poll prints its state on every line. A grep is run against an input known to match before its negative means anything. A deploy check asserts the end state under the identity that runs the code. This is already half-written in `VERIFICATION.md` #14; the model makes it a lint (`lint-instruments` exists) and a habit: the session's *first* move when it needs to observe something is to look for the script.

### 3.4 Guarantees compound and never shrink

The answer to "does it still work after a huge change" is not a bigger spec. It is a body of executable claims that grows with every change and every defect, and a gate that runs them all.

- **Every accepted claim stays in the suite.** A refactor is judged by whether the existing claims still hold, not by whether its own description sounds right.
- **Every defect adds a claim** that would have caught it on introduction. 108 of the 225 could have been caught by a behavioural check at introduction; today most of them have a regression test that asserts the fix rather than the behaviour.
- **Every claim's break is recorded** (`breakcheck.yaml`) and re-run in CI. A test that quietly stops guarding its code after a refactor turns CI red instead of staying green for weeks (rows 1–3, 97, 143, 182, 185 all stayed green over live bugs).
- **The gate is the union of every `kind`**: compile, unit, browser, journey against a real stack. "Green" means all of them ran. Today's `lp check` is a declared subset, and the smoke suite that would have caught A's unwired pointer handler in the bake-off never ran under `npm test`.

Latency: a journey suite against a real stack is minutes, not seconds. That is the trade. Google's presubmit averages 11 minutes and is the reason a change has a 95% chance of surviving everything after it.

### 3.5 Long sessions are made safe by mechanisms, not by memory

The current rulebook assumes an agent remembers 15 verification rules across context compaction. The record shows it does not: on one day (2026-08-19) the pipe-exit-code mistake was made four times and the optional-parameter mistake seven, each after its rule was written down.

- **A session commits at every green claim.** Losing a session loses one claim, not a day. Undo is `git revert` of one small commit, which is the cheapest guarantee there is and the one every fast shop relies on.
- **A Stop hook refuses to end a session while the gate is red or a claim is unverified.** Claude Code hooks are deterministic; CLAUDE.md is advisory (Anthropic's own words). Today `.claude/` has no hooks at all.
- **A pre-commit hook requires a green gate.** Three red gates were pushed in one day because the gate read `grep`'s exit status through a pipe (`VERIFICATION.md` #8), and a later push went out on a red gate because it was chained with `;` instead of `&&`.
- **Session state is one file, `STATE.md`, rewritten rather than appended:** the goal, the claims and their status, the next step, anything surprising. It replaces the handoff log, which grew without bound and was read by nobody: the language rule was in a handoff before it was in a prompt, and the coder still committed in English.
- **The author never grades itself.** At a milestone, a fresh-context reviewer with a browser checks the claims against the running system. In the bake-off, this is what found the real bugs in every setup that had it, and the record shows the author's report is the least reliable input: "Codex falsely claims to have completed a task; mitigation: user transparency."
- **Prompts are portable.** A rule that applies to every session lives in one place and is enforced by a hook or a lint; it is not repeated across five agent prompts (five defects came from a rule present in one prompt and absent from its siblings).

### 3.6 Humans decide, they do not review

One human gate remains: **promote to production**, the irreversible act. Everything before it is machine-checked. A human is also asked, in a ten-line decision note rather than a spec, when a change is irreversible, spends money, touches security, or changes what the product is. That is the only prose that survives, and it is written because the decision is the human's, not because the process requires a document.

### 3.7 What is deleted

- Specs, tracks, `## Progress` checklists, handoff logs, the `(human)` marker as an exemption.
- `PENDING.md` as a hand-maintained ledger. Open claims *are* the ledger; a failing claim is an open item.
- The 15 numbered verification rules as prose. Each one either becomes a lint, a hook, a type, or a claim, or it is an anecdote and goes to `docs/`.
- Any prompt line that describes the harness rather than the task (in the setup bake-off, the run on these prompts made 0 parallel tool-call batches against 12 for plain Claude Code, because its prompt said "one tool call per turn"; on Launchpad's own sequential work this cost little, see `docs/AGENT-TOPOLOGY.md`).

## 4. How this would have changed the record

| Family | Count | Under this model |
|---|---|---|
| Instrument confirms expectation | 47 | scripted observation with a known-positive test (§3.3); the ad-hoc shell that produced 36 wrong conclusions is not written |
| Second caller never wired | 35 | required parameter or lint at compile time (§3.2); the 17 optional-parameter cases do not compile |
| Wrong assumption in plan | 55 | unchanged at introduction, but caught by the journey claim before merge instead of by a user or an outage; 31 of these were found live, 8 in production |
| Assert-the-call test | 9 | the claim names the effect; breakcheck refuses a check that does not go red when the effect is removed |
| Environment / deploy drift | 19 | `kind: live` claims run under the deploying identity; end state asserted (`node --version` on the box, the row in the table) |
| Record says done before the world is | 8 | a status is written by the check that observed the state, never by the step that requested it |

The six families cover 173 of the 225 defects; the other 52 are not broken down by family here.

Two things this model does not fix. **Wrong assumptions about the world** (Odoo installs modules only at DB init; Actions billing locked; a live ERP on a "disposable" box) are found by running the real thing, and the model only guarantees that this happens before merge rather than after. **Judgement calls** (what to build, whether the page is beautiful, whether a customer's data may leave a box) stay with a person, and the model's contribution is to stop asking that person to also be the test suite.

## 5. Cost, and how to know if it is right

**Cost.** Writing a check for every claim is slower than writing a sentence. Journey tests need a real stack, which means CI minutes and a box. Making parameters required makes some refactors noisier. These are the same costs every fast shop pays; the record says the alternative costs more, in a 12-hour outage and seven-time repeat defects.

**Where it could be wrong.** Journey tests on infrastructure can be flaky, and a flaky gate is ignored. The claim file could grow ceremony of its own. Compile-time wiring only helps in typed code and does not help for shell or SQL.

**The test.** Take one large change with a long session, retiring Forge's agent loop is the obvious one, and run it under both models from the same commit, with a hidden set of journey checks written beforehand and a handful of planted defects. Measure wall-clock, human interventions, planted defects caught, and hidden failures afterwards. The bake-off harness already does the measuring. If the claim model is not faster *and* does not catch more of the planted defects, it is not right.

---

*Sources: the project's compliance registry, `docs/VERIFICATION.md`, its open-work ledger and run findings, and 148 spec intents (not all included here); the setup bake-off of 2026-09-29 (`docs/SETUP-BAKEOFF.md`); SWE at Google ch. 23; Google SRE book; Petrović et al., "Practical Mutation Testing at Scale" (TSE 2021); Newcombe et al., "How AWS Uses Formal Methods" (CACM 2015); Anthropic, "Effective harnesses for long-running agents" (2025) and Claude Code best practices; OpenAI Codex system card (2025); heym.run SDD audit (2026); Böckeler, "Exploring Gen AI: SDD tools" (2025).*
