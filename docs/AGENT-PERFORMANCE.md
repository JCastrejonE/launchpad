# Agent session performance — measured, not guessed

Source: the per-worktree session transcripts the Agent SDK writes to
`~/.claude/projects/-home-dev-launchpad-audited--worktrees-spec-NNNN/*.jsonl`.
They persist **every turn of every agent session**, including tool inputs and
timestamps, which makes them the repo's best (and until spec 0106, unused)
observability source for "why was that run slow".

Reproduce with the analysis in spec 0106's Handoff log: parse the JSONL, count
`tool_use` blocks per assistant message, and diff timestamps between an assistant
turn and its `tool_result` to separate inference time from tool time.

## Baseline (spec 0106, 2026-07-30)

Two comparable full runs, 237 turns total.

### Where a session's wall-clock goes — spec 0105, `claude-opus-4-8`

| session | wall | model thinking | tools running | thinking % |
|---|---|---|---|---|
| initializer | 555s | 345s | 109s | 62% |
| coder-1 | 658s | 493s | 64s | 75% |
| coder-2 | 228s | 123s | 59s | 54% |
| coder-3 | 418s | 302s | 38s | 72% |
| coder-4 | 382s | 282s | 37s | 74% |
| **total** | **2241s (37 min)** | **1545s (26 min)** | **308s (5 min)** | **69%** |

The tools column adds up to 307s; the 308s total is the figure spec 0106 recorded, and the
raw transcripts behind it are not in this snapshot, so the one-second gap (most likely rounding)
cannot be rechecked here. The role prompts in `agents/` quote inference as "69–80%" of a
session: 69% is this table's total, and no measurement behind the 80% upper bound
is recorded (the highest single session above is 75%).

**Turn count, not tool speed, is what makes a session slow.**

### Tool-call batching — the finding

| run | model | turns | calls/turn |
|---|---|---|---|
| 0097 | `claude-sonnet-5` | 112 | **1.00** |
| 0105 | `claude-opus-4-8` | 125 | **1.00** |
| 0107 | `claude-opus-4-8` | 177 | **1.00** |

Zero of **414** turns issued two tool calls — including spec 0107, run *after*
prompt guidance told the agents to batch. A direct probe gave the same result:
a session instructed *"issue all three Read calls in a SINGLE assistant turn, in
parallel"* returns `{1: 3}` on **both** Opus and Sonnet.

This section first concluded that the Agent SDK cannot emit parallel tool calls, a
hard constraint that no prompt could change. **That cause was wrong**, and is corrected
in `docs/AGENT-TOPOLOGY.md` ("Batching: available, on by default, and nothing to
spend it on"): parallel tool use is on by default and nothing in the stack turns it
off, and a later trace on a real spec found 22 of 24 calls were stateful `Bash`,
`Edit` or `Write` calls that depend on the one before, so there was little to batch.
The measurement stands.
The role prompts in `agents/` (initializer, coder, fixer) still carry the earlier
sentence, "This harness emits exactly ONE tool call per turn … Batching is not
available to you"; they are kept as the agents saw them.

The available lever is **fewer tool calls total**: one scripted multi-edit instead
of a queue of `Edit` calls, one wide read instead of several narrow ones. Spec 0107
still issued 34 `Edit` calls, so there is real room — roughly 26 turns ≈ 8 min at
Opus latency.

### Per-turn model latency

| model | s/turn | $/turn |
|---|---|---|
| `claude-sonnet-5` | 7.8s | $0.04 |
| `claude-opus-4-8` | 18.4s | $0.12 |

Opus is **2.4× slower and 3× dearer per turn**. Spec 0103 chose Opus for the coder
deliberately and recorded the money; this is the wall-clock half of that trade.
Override per role with `LAUNCHPAD_MODEL_CODER` etc. (`packages/agents/src/models.ts`).

## Costs that are NOT the problem

Measured and cleared, so nobody re-chases them:

| suspected cost | actual |
|---|---|
| the mandated `pnpm -r typecheck && pnpm -r test` gate | **22s** (7s + 15s) |
| one package's tests (the iteration check) | **~1s** |
| harness overhead between increments (checkout, commit, Progress, next-item) | **~40s** |
| spec 0083's `rm -rf dist` in every test script | negligible at this scale |

Sessions were nonetheless running the full gate 3–7 times each — the initializer
spent 28% of its tool time there. Hence the split check ladder in `coder.md`:
targeted test while iterating, full gate once before committing. **This one
worked:** full-gate runs per session went **4.2 → 3.0** between 0105 and 0107.
