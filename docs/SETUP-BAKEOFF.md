# Setup bake-off

*29 September 2026. One brief, six ways of running Claude Code in seven runs (the dynamic workflow ran twice, headless and interactive), everything measured from transcripts and a headless browser rather than from the agents' own reports.*

## The setup

Every contender got the same brief, its own empty git repository, and the same conditions: Claude Code 2.1.284, Opus 5.5, auto permission mode, a $25 cap, and a macOS `sandbox-exec` fence with a fake home directory that blocked SSH keys, credentials and the other contenders' folders. Approval gates had standing approval; each contender logged the questions it would have asked.

> **Brief:** build a cool generative, algorithmic, interactive page in vanilla JavaScript. No frameworks, no libraries, no build step. Make it something you would be proud to show.

| | Setup | How it ran |
|---|---|---|
| A | **This repository's method** | the real `agents/*.md` prompts, composed the way the pipeline composes them: a spec drafter, an initializer, then fresh coder sessions until the checklist was done |
| B | Plain Claude Code | the brief and nothing else |
| C | Claude Code + gstack | installed by its own setup; `/office-hours` → `/autoplan` → build → `/review` → `/qa` → `/ship` |
| D | Claude Code + ECC | installed from its pinned checkout; `orch-pipeline`: planner agent → TDD → reviewer agents |
| E | A dynamic Workflow, headless | `claude -p` writing and running its own multi-agent workflow |
| E2 | The same setup, interactive | a real terminal session driven by `expect`; each run writes its own workflow, and E2's had six phases where E's had five |
| F | An agent team | a lead plus sim, UI and QA teammates (interactive; teams do not form under `-p`) |

## Results

| | Cost | Time | Screenshots read | Tests catch a broken core | Tests catch broken input | Reduced motion |
|---|---|---|---|---|---|---|
| A | $2.34 | 12 min | 0 | yes | only in a smoke suite CI never ran | honoured |
| B | $2.33 | 14 min | 38 | no tests | no tests | ignored, not claimed |
| C | $10.64 | 32 min | 13 | yes | only with setup the repo does not declare | honoured |
| D | $2.66 | 14 min | 11 | yes | no | partial, stated accurately |
| E | $1.21 | 11 min | 0 | nothing was built | | |
| E2 | ~$10 | 82 min | 84 | no tests | no tests | honoured after a warm-up |
| F | ~$8 | 40 min | 36 | yes | no | partial, claimed as full |

E2 and F costs are estimated from their transcripts with per-token rates fitted to the headless runs' own reported costs (within about 7%). "Tests catch" means a break-check: the line was broken on purpose and the contender's own suite had to go red. "No tests" means no committed test files, which the harness counts as files under a `test/`, `tests/` or `__tests__/` directory or named `*.test.*` or `*.spec.*`. B and E2 each committed a browser smoke script outside that pattern (`tools/check.mjs`, `tools/verify.mjs`) and no test command, so they count as having no tests.

## What it showed

1. **The model sets the ceiling, not the setup.** Every page that shipped worked, with no errors and no outside requests. Five of six built the same idea, a Physarum slime-mould simulation; only A did not.
2. **Cost varied fourfold for similar results.** The extra spend in C, E2 and F bought polish and review, not working versus broken.
3. **Independent review found the real bugs.** The setups with a fresh-context reviewer found what their builders missed: touch users stuck under reduced motion, pointer offsets on mobile, a resize that wiped the simulation, a vulgar name the station generator could produce.
4. **Tests guard algorithms, not interaction.** Every suite caught a broken simulation core. Only two caught broken pointer input, and both kept that check outside the default test command. One test named "drag changes the trail" still passed with dragging disconnected.
5. **Looking and testing are different skills.** B and E2 tuned by eye from dozens of screenshots and kept no tests; A wrote tests and never looked at its page.
6. **Headless Claude Code has limits worth knowing.** A workflow started with `claude -p` is stopped when the session ends (E built nothing and exited 0); agent teams do not form at all; auto mode silently falls back to default permissions on Haiku.

## What it said about this repository's method

It was the cheapest fully audited run, its spec cited evidence for each checklist item and carried the commit that did it, and it marked what it had not verified instead of claiming it. But its prompts told it the harness makes one tool call per turn (it made none in parallel; B made 12 batches), they carried project-specific details into a brand-new project, there was no review step, and its CI command skipped the browser suite.
