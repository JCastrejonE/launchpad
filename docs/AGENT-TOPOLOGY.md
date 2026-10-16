# Agent topology — what we run, and the criteria that decide the next change

Written **2026-08-13, before runs 6 and 7**, deliberately. The question this
settles — does the initializer/coder split earn its keep? — is one we have been
answering with opinions because our own database could not answer it
(`agent_runs` holds one row per workflow). Spec 0194 fixed that. Pre-registering
the criteria means the answer cannot be fitted to whatever we hoped.

Related: `docs/DECISIONS.md` (2026-08-13) records why LangGraph, deepagents and
Open SWE are not adopted, and what we copy from them instead.

## What runs today (after spec 0197)

| role | model | prompt | spawned by | when |
|---|---|---|---|---|
| **supervisor** | `claude-opus-5` | `agents/supervisor.md` | the project chat (`/api/supervisor`) | every conversation |
| **spec-drafter** | `claude-fable-5` | `agents/spec-drafter.md` | the supervisor's `spawn_architect`, or the Temporal `draftSpec` activity | once per spec |
| **initializer** | `claude-opus-5` | `agents/initializer.md` | `runInitializer` | once per run |
| **coder** | `claude-opus-5` (`claude-haiku-4-5` for `[docs]` items) | `agents/coder.md` | `runCoder`, in the loop | 1..N per run |
| **fixer** | `claude-opus-5` | `agents/fixer.md` | `runRepair` | only on a failed session or CI red twice |

`uiux-coder` was deleted by spec 0197: nothing could reach it (no service, no
cron, no process — all three verified on the box), and it polished `apps/web`,
our own surface, not a customer's project.

The Temporal `draftSpec` activity is a no-op when the spec file already exists,
which is always true for a chat-drafted spec. So of the two drafting entry
points, only the in-UI one fires in the current flow.

## The open question

The research says separation pays when subtasks are **genuinely independent** and
parallel supervision adds value, and that **for simple, linear tasks a single
agent is more efficient**. Our Track-2 runs are one spec, sequential, on one
branch, with no independent slices. That is the collapse case on its face — and
the counter-evidence is real: LangChain's Open SWE, mirroring what runs at
Stripe/Coinbase/Ramp, keeps Planner and Programmer separate *and* adds a
Reviewer. It also takes arbitrary GitHub issues in cloud sandboxes, which is a
wider problem than ours.

Our own tell: **118 of 191 specs are Track 1** — we route most of our own work
around the machinery we built.

## The criteria, pre-registered

Read after run 7, over the sessions of runs 6 and 7 only (earlier runs have no
rows — `agent_sessions` shipped 2026-08-13).

```sql
-- Sessions per run, by role.
SELECT workflow_id, role, count(*) AS sessions,
       sum(seconds)/60 AS minutes, sum(turns) AS turns,
       sum(input_tokens + output_tokens) AS tokens
FROM agent_sessions
WHERE started_at > '2026-08-13'
GROUP BY workflow_id, role
ORDER BY workflow_id, role;

-- The number the decision turns on.
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY n) AS median_coder_sessions
FROM (SELECT workflow_id, count(*) AS n
      FROM agent_sessions
      WHERE role = 'coder' AND started_at > '2026-08-13'
      GROUP BY workflow_id) t;
```

**COLLAPSE** initializer + coder into one `builder` role if **all** hold:

1. **Median coder sessions per run ≤ 2.** At that grain the split is buying a
   context reset nobody needed, and charging a session startup (~30–45s of repo
   orientation) plus a handoff round-trip for it.
2. **The initializer's session is a meaningful share of the run's tokens** —
   say ≥25% of input tokens — since most of that is re-reading a codebase the
   coder is about to read again.
3. **No run needed the fixer.** A loop that never trips is a loop whose
   staging/handoff ceremony is not carrying weight.

> **CORRECTION, 2026-08-13 (spec 0199).** The criterion below — *median coder
> sessions ≥ 3* — is **confounded and must not be used**. The loop runs exactly
> one coder session per plan ITEM, so sessions-per-run measures the initializer's
> decomposition choice, not context pressure. Run 6 hit 3 sessions three times
> because every plan had 3 items; every session ended by finishing its item, and
> **none ended because context ran out**. I reported that number twice as
> evidence for keeping the split before noticing it answers a different question.
>
> **The honest criterion**: does a coder session ever end *because context bound*
> — a stall, a turn limit, a session that hands off mid-item? So far, never in
> three runs. Read runs 7+ against THAT, with plan granularity fixed by 0199 so
> item count no longer drives session count.

**KEEP the split** if any of:

1. ~~Median coder sessions ≥ 3~~ — **withdrawn, see the correction above.**
2. **The fixer fired and helped.** Then the roles are doing distinct jobs and the
   next investment is Open SWE's **Reviewer** — a preventive pass before the PR
   opens — rather than a merge.
3. **The initializer's plan was revised by a coder** (a `revise plan` commit). A
   plan good enough to be corrected rather than ignored is a plan worth writing
   separately.

**Either way, build the Reviewer** if run 6 or 7 produces another *4.5-shaped*
defect: correct code, green CI, and a feature that is not reachable — a component
nobody renders, a route nothing links to. Spec 0197 bought the cheap half of that
inside the coder (a written reachability answer in every handoff); if it escapes
anyway, prompt-level self-review is not enough and the independent channel is
worth its cost.

## What the collapse would and would not touch

- The `## Progress` checklist **survives** either way. It is the durable plan a
  later session resumes from, and collapsing the roles only means one session
  writes it and then starts working against it.
- `workflow.ts` changes, and it is a deterministic Temporal workflow with frozen
  replay fixtures — which is exactly why this decision waits for rows instead of
  riding on a view.
- The human gates, the drafter's execution-free tool set and the supervisor's
  Bash deny-list are **not** in scope. Those are boundaries, not ceremony. Spec
  0196 deleted a fence because it was a fake boundary; none of these are.

## The 0199 measurement — the plan is the throttle, not the split

Run between runs 6 and 7, on `cafeteria` spec 0005 (`owner/prueba-rechazo`), against the 0002/0003
baseline: same project, same shape of change, same models. Spec 0199 changed one thing — the
initializer prompt now carries what an item costs (~20–30 turns, 3–5 minutes, one full repo check)
and the rule that follows: pieces touching the same files, or unverifiable apart, are ONE item.

| | 0002 | 0003 | **0005 (after 0199)** |
|---|---|---|---|
| plan items | 3 | 3 | **1** |
| coder sessions | 3 | 3 | **1** |
| coder turns | 60 | 62 | **26** |
| coder minutes | ~9 | ~8 | **4.9** |
| total session turns | 76 | 76 | **35** |
| gate 1 → PR | ~13 min | ~12 min | **9m02s** |

Coder turns fell ~57% and coder time roughly halved, from a prompt edit — **no topology change**.
That is the result that matters for the open question: the cost the split appeared to impose was
mostly the initializer's decomposition, which is a prompt parameter, not an architectural one.

Two caveats, stated before they can be forgotten. **One run is not a result** — spec 0005 is a touch
simpler than `Reseñas`, so some of the drop is the change, not the prompt; run 7 is the second data
point. And this measurement was nearly lost: the role prompts were not reaching customer runs at all
(spec 0200 — `systemPromptFor` read `agents/<role>.md` from the customer checkout, which has no
`agents/`), so 0199 would have measured "no change" and produced the wrong conclusion from a real
experiment. The fix landed first; the box was confirmed at `504e89e` before the run.

Evidence the prompt arrived is indirect and worth naming as such: 0200's nominated proof (a Progress
item carrying its commit SHA) **cannot pass in a customer project**, because spec 0141 puts `specs/`
outside the repo. What we have instead is the coder reasoning explicitly about that impossibility —
*"la spec no entra en ningún commit… no hay commit de handoff"* — which is a rule that exists only in
`coder.md`. See `docs/VERIFICATION.md` #2's corollary.

## Log

| date | what | outcome |
|---|---|---|
| 2026-08-13 | criteria written, before run 6 | — |
| 2026-08-13 | **run 6 read against them** | 3 runs, `coder ×3` every time, fixer never fired. Sessions/run: 4, 4, 4. Coder time 17/9/8 min; tokens 64,048 / 55,263 / 55,951. Initializer = 24.4% of real input on run 1. **Originally read as KEEP-the-split — WITHDRAWN**: every plan had 3 items and the loop takes one session per item, so this measured decomposition, not context. See the correction above and spec 0199 |
| 2026-08-13 | **0199/0200 measurement** (`cafeteria` 0005, between runs 6 and 7) | 3 items → **1**, 3 coder sessions → **1**, 62–76 turns → **35**, ~12 min → **9m02s**. The throttle was the plan, not the split. Prerequisite: 0200, without which no role prompt reached any customer run |
| | run 7 read against them | |
| | decision | |

## One tool call per turn — measured on a real spec, not a prompt

The latency model in spec 0199 (turns ≈ wall clock) rests on agents emitting one tool call per turn.
That was asserted wrongly once (0197's first draft claimed the harness batches), then measured
synthetically (3/3 on Opus 5, told to parallelise). On 2026-08-14 it was measured on a **real coder
session against a real spec**, through the product's own `runAgentSession` with a counting `queryFn`
injected at the existing test seam — same role prompt via `promptRoot`, same model, same tool
surface, same `maxTurns`. Source: `floreria-bella` at `a48d380` (after spec 0002), spec 0003's
Progress reset so the work was genuinely undone, in a throwaway repo with no remote.

```
ok: true            sdkTurns: 15        assistantMessages: 42
toolCallingTurns: 14   totalToolCalls: 14   maxToolsInOneTurn: 1
histogram: { "1": 14 }
```

The session succeeded and produced the real commit, so this is a complete session rather than a
truncated one. **14 of 14 tool-calling turns carried exactly one tool call.**

Consequences, now on evidence rather than inference:

- Turns are tool calls. Wall clock is turns × ~12 s, so anything that removes a tool call removes
  time, and nothing about the model's own behaviour will amortise it.
- It is why 0199 worked at all: plan items → sessions → turns is the whole chain.
- It bounds the collapse decision. Merging initializer and coder recovers the ~22% role overhead —
  it does **not** touch the per-turn floor underneath, so the ceiling on that change is ~22%, not
  "half the run".
- Per-session bookkeeping (~5 turns of commit → amend → handoff → commit) is real time, not rounding.
  Already deferred in `PENDING.md`; this is the number that justifies revisiting it.

## Batching: available, on by default, and nothing to spend it on

The owner pushed back on an earlier claim of mine that parallel tool use was "not a knob we hold". He was
right and I was wrong: **parallel tool use is ON by default** at the API level, the off-switch is
`disable_parallel_tool_use` *inside* `tool_choice`, and we never set `tool_choice` at all. Nothing in
our stack suppresses it.

The Agent SDK does execute multiple blocks sequentially even when they are emitted
([issue #438](https://github.com/anthropics/claude-agent-sdk-python/issues/438), closed as not
planned) — but that only forfeits the tool-overlap saving. Emitting two tools in one turn would still
save a **model round-trip**, and inference is 69% of session time (0106, `docs/AGENT-PERFORMANCE.md`), so it would have
been the bigger half. Worth wanting.

So the question became: why do our agents never emit two? Answered by logging tool NAMES per turn —
the first harness counted blocks but not names, which could not distinguish "suppressed" from
"nothing to batch". Both sessions did their real work and committed.

**coder** (13 calls, 13 turns, `{1: 13}`):
`Read · Bash Bash Bash Bash · Write Write · Bash Bash · Edit Edit Edit · Bash`

**initializer** (11 calls, 11 turns, `{1: 11}`):
`Read · Bash Bash · Write · Bash Bash Bash Bash Bash Bash Bash`

24 tool calls across both roles, **one per turn, every time**. And the reason is in the mix, not in a
setting: **22 of 24 are stateful** — 16 × `Bash`, 3 × `Edit`, 3 × `Write`. Those are precisely the
tools the docs say run sequentially and warn against parallelising, because order *is* the semantics
(`cd`, git, build, an edit that depends on the read before it). There are exactly **two `Read` calls
in 24**, one per session, each alone.

The prediction that the initializer would be read-heavy — the one role where batching might pay — is
**wrong**. It explores by shelling out, not with `Read`: 9 of its 11 calls are `Bash`.

**Conclusion: one tool per turn is correct behaviour for this workload, not a suppressed capability.**
Enabling batching wins approximately zero here. The lever the data actually exposes is different and
smaller: the initializer issued **9 separate `Bash` calls**, several of which look like independent
inspections that could be one command. That is "fewer, larger tool calls", not parallelism — and it
trades against legibility, since one opaque combined command is harder to audit from a handoff than
nine named ones.

This replaces the earlier "hard SDK limit" reading in `docs/AGENT-PERFORMANCE.md` and
`docs/VERIFICATION.md` #5. The role prompts in `agents/` (initializer, coder, fixer) still carry that
earlier sentence, "This harness emits exactly ONE tool call per turn … Batching is not available to
you"; they are kept as the agents saw them, and the setup bake-off ran them unchanged.

Re-measure after any SDK upgrade: the harness is `/tmp/meas/measure3.mjs` in shape — inject a
counting `queryFn` at `runAgentSession`'s existing test seam, log `tool_use` block names per
assistant message, run against a scratch repo with no remote.
