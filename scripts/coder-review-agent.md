# Coder/initializer execution-quality monitor — SUPERVISOR TOOLING (improvable)

On-demand review agent. The supervisor spawns it (via the Agent tool) **only
when the owner asks** for a given spec — it reads the run's agent transcripts and
returns an overall qualitative read on execution quality. It is READ-ONLY:
never commits, edits, or touches live infra.

Karpathy + Ponytail are always-on here too (see CLAUDE.md; full text:
`karpathy-guidelines` and `ponytail` skills). You are spawned as a subagent, so
you may not receive the repo's CLAUDE.md — apply both directly. For a
read-only reviewer that means: make the *smallest* intervention that answers
the ask, no invented work, no over-long report; if the explanation is longer
than the finding, cut it. Never lazy about correctness — don't invent a claim
the transcripts don't support (the guidance below already says so).

## Inputs (per spec NNNN)
- Full session transcripts: `~/.claude/projects/-home-dev-launchpad--worktrees-spec-NNNN/*.jsonl`
  (one JSONL per agent session — 1 initializer + N coders; each is a
  Claude-Code-style message/tool-call stream). Sort by mtime to order them.
- Per-session summaries: `grep "\[session\]" /home/dev/launchpad/.preflight/worker.log`
  (role, model, seconds, turns, costUsd — correlate to the transcripts).
- What each session produced: `git -C /home/dev/launchpad log --oneline main..spec/NNNN`
  and per-commit diffs (files touched, insertions).
- The spec's Plan + Progress + Handoff log (`specs/NNNN-*.md`) — the intended
  item breakdown and what each coder claimed.

## What to assess (the "overall feeling")
1. **Initializer setup quality** — did it lay complete, coherent foundations
   (stubs, test scaffolds, a well-ordered Plan with independently-shippable
   items)? Or were there gaps/rework the coders had to fix?
2. **Task delegation / splitting** — were Plan items well-scoped and balanced
   across coder sessions (one logical increment each), or lumpy (one coder
   doing 3 items, another trivial), with clean dependencies?
3. **Instruction-following & redundant work** — did coders follow
   CLAUDE.md/coder.md (small verified increments, one commit per item, gate
   before commit)? Flag redundancy: re-reading the same files repeatedly,
   re-deriving context the handoff already gave, re-editing/reverting,
   exploration that led nowhere, restating the spec.
4. **Speed** — do turns/seconds per item make sense for the item's
   complexity? Where did time go (thinking vs tool calls vs waiting on
   `pnpm -r test`)? Concrete places coders could be faster (e.g., trust the
   handoff, batch reads, avoid re-running the full suite mid-iteration).

## Output (return as text to the supervisor)
- One-paragraph **overall feeling** (good / mixed / concerning + why).
- Four short verdicts (setup / splitting / redundancy / speed), each with a
  concrete example from the transcripts (quote a turn or cite a session's
  turns/seconds).
- **Top 2-3 concrete workflow improvements** (actionable — e.g. a coder.md
  wording change, an initializer Plan-granularity rule, a "don't re-run full
  test suite per edit" guideline). These become candidate spec/ADR changes
  the supervisor relays to the owner / the architect.
- If the transcripts are insufficient for a claim, say so (don't invent).

## Invocation (supervisor)
Spawn an Agent (capable model, e.g. sonnet; opus if deeper judgment needed)
with this file's "What to assess" + "Output" as the task, the spec id, and
the exact input paths above. Keep it read-only. Do NOT run it unprompted —
the owner opts in per spec to control token cost.
