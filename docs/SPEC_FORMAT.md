# Spec format

A spec is the pipeline's unit of work: one markdown file in `specs/`
(`NNNN-slug.md`). Drafted by the LLM from the user's plain-language request,
edited/approved by a human, then executed by agents.

## Required sections

```markdown
---
id: 0002
title: Add loyalty points to POS receipts
tenant: acme            # or "launchpad" for dogfood specs
odoo_version: 18        # omit for launchpad specs
status: draft           # draft | approved | in_progress | staged | promoted | rejected
track: 1                # 1 = authored by hand | 2 = runs through the pipeline (spec 0109)
requested_by: owner@example.com
approved_by:            # filled at spec-approval gate
ui_only: true           # optional; a smaller iteration budget for a small front change
product: hangar         # optional; self targets only — hangar | forge | both (ADR-019)
mode:                   # reserved, unparsed (ADR-019) — do not use yet
---

## Intent
One paragraph: the outcome the user wants, in their words.

## Scope
What will change (modules, models, views, code areas). Explicit non-goals.

## Acceptance criteria
Verifiable checks. Each becomes a test or a manual check on the build URL.

## Plan
Initializer fills this: an ordered PROSE outline of the approach, smallest
shippable steps. No `- [ ]` checkboxes here — the checklist lives in ## Progress.

## Progress
- [ ] item...            # THE checklist — coders tick these, one per commit.
                         # Only this section's boxes drive the coder loop
                         # (SPEC-ALIGNMENT §9.1); checkboxes elsewhere are ignored.

## Handoff log
Appended by each agent session: date, what was done, what's next, surprises.
```

## Language: Spanish prose, English structure (spec 0217)

**Prose is Spanish; structure is English, byte-identical.** The `title:` value,
`## Intent`, `## Scope`, the acceptance criteria, the out-of-scope entries and
every handoff-log entry are written in Spanish. The structure is not prose — it
is on-disk format that code parses with literal regexes, so a translated heading
does not read differently, it parses as ABSENT, silently.

The frozen set, closed and without exceptions:

- **Section headings**: `## Intent`, `## Scope`, `## Acceptance criteria`,
  `## Plan`, `## Progress`, `## Handoff log`, `## Out of scope / deferred`.
  Three are literal regexes in code: `^## Progress\s*$` and `^## Handoff log\s*$`
  (`packages/pipeline/src/store.ts`) and `^## Intent\s*$` (`store.ts`,
  `architect-session.ts`). A `## Progreso` makes the coder loop see zero pending
  items and close the spec green without implementing anything — it nearly
  happened with `## Implementación` in spec 0005 (`PENDING.md` row 166). The rest
  are frozen by the same rule: a closed set with no exceptions is the only
  version of it a drafter cannot misread.
- **Frontmatter**: every key (`id`, `title`, `tenant`, `odoo_version`, `status`,
  `track`, `requested_by`, `approved_by`, `ui_only`, `product`, `mode`) and every
  enumerated value (`draft`/`approved`/`in_progress`/`staged`/`promoted`/
  `rejected`, `launchpad`, `hangar`/`forge`/`both`) — `apps/web/lib/spec-project.ts`
  reads `tenant:` as a discriminator. The VALUE of `title:` is prose: Spanish.
- **Markers**: `(human)` literally — never `(humano)`; only that exact string is
  excluded from the done-condition (see below). Checkboxes `- [ ]` / `- [x]` as
  they are.
- **Filename**: `specs/NNNN-slug.md` — the slug may be Spanish, but ASCII
  kebab-case (no accents, no ñ: it is a path and a URL segment in
  `/forge/specs/[filename]`).

A comment is not a control (CLAUDE.md verification rule #11): row 166 carried
this as a warning from spec 0005 and prevented nothing. The control is
`specStructureViolations` (`packages/agents/src/spec-structure.ts`), which runs
on a freshly drafted spec — never on one already on disk — and rejects a
translated required heading or a `- [ ]` item outside `## Progress`.

## The `(human)` marker

A Progress item that only a human can complete — clicking a gate approval,
eyeballing a staged environment, any action a coder agent has no tool to
perform — is written as `- [ ] (human) <description>`.

- `countUnchecked` (the pipeline's "is the coder loop done?" check) ignores
  `(human)` items entirely; they never block convergence.
- `countHumanPending` counts them separately, and they're surfaced as a
  "Waiting on you" checklist at gate 2.
- Initializers: mark any verification step that requires a gate click or
  other human-only action as `(human)` when writing the `## Progress`
  checklist — never leave it as a plain item a coder will spin on.
- Coders: never pick up a `(human)` item, even if it's the first unchecked
  line. Skip to the next non-`(human)` item, or stop if none remain.

### What an agent session cannot reach

"An action a coder agent has no tool to perform" was left to the reader's
judgement, and judgement got it wrong: sandbox spec 0005 spent **two coder
sessions** discovering that the `docker run` in its acceptance criteria was
impossible. The initializer had reasoned, in writing, that it "es ejecutable por
el coder". The coder then found `docker ps` → *permission denied*, relabelled the
item, and stalled. Nothing was broken; two sessions were spent saying so.

Agent sessions run in a scrubbed sandbox (spec 0069). They have **no**:

- **docker daemon** — the `launchpad` user is not in the `docker` group. No
  container, image, or compose command works.
- **fleet SSH or VPS access** — the identity file is worker-only (ADR-013).
- **deploys**, staging or production — those are activities, not agent work.
- **gate clicks, GitHub reviews, merges, or promotes.**

### Verification the RUN already performs is not a checklist item

Before writing "and run the tests", check what the run does *between* items:

- **`runCi` runs the repo's own suite on every coder iteration** — for a Node
  repo `pnpm -r typecheck` and `pnpm -r test`; for an Odoo addons repo, the
  module's own tests on the sandbox VPS, in both Odoo's runner and a standalone
  pass for the plain `unittest` classes Odoo's tag filter skips (spec 0167).
- **Staging is deployed on arrival at gate 2** (specs 0119/0134).

So "install the module under Odoo and confirm it is green" is not an item — it is
the gate every item already has to pass. Writing it as one asks an agent to redo
the pipeline's job with tools it does not have, and the loop pays two sessions to
find that out. If a check genuinely needs a person (a pixel check, a staged
environment eyeballed), it is `(human)`; if the pipeline does it, it is not
written down as work at all.

## The `ui_only` flag (spec 0031 / ADR-018)

An optional frontmatter key, `ui_only: true`, declaring that a spec is a small
front-end change. Absent or `false` ⇒ today's behavior, unchanged.

- **It is a budget, and since spec 0196 that is ALL it is.** When set, the
  pipeline caps the coder loop at `UI_ONLY_MAX_ITERATIONS` (6). It makes the run
  leaner, never different in kind.
- **It is a human-gated declaration, not auto-detection.** `spec-drafter` may
  propose it; the human confirms or edits it at gate 1 like any other
  frontmatter field.
- **The diff-path fence it used to carry is GONE (spec 0196).** It allowed
  `apps/web/**` — the launchpad's own layout — so on a customer project, whose
  Next app lives at the repo root, every legitimate increment was flagged as a
  violation; it blocked one A/B run for rounds and drafting agents began routing
  around it. It was also never a boundary: a path allowlist is defense-in-depth
  an agent can route around through any allowed code-runner, while the real
  boundaries are the throwaway worktree, CI, the PR, the human gate, and GitHub
  branch protection. See `docs/DECISIONS.md` (2026-08-13).

## The `product` facet and the reserved `mode` key (spec 0035 / ADR-019)

The monorepo is understood as two named products sharing one codebase:
**Hangar** (the fleet/tenant admin dashboard) and **Forge** (the chat-first
pipeline UI). Two frontmatter keys carry that split into the spec format;
`tenant:` is unaffected and still identifies the tenant target as before.

- **`product: hangar | forge | both`** — an optional frontmatter facet,
  **self targets only** (it does not apply to `tenant:` specs). It records
  which product a self-run changes; it is NOT a target kind — a Hangar-change
  run and a Forge-change run are behaviorally identical (same repo,
  credentials, and deploy path), so `product` is descriptive metadata, not a
  branch point for runtime behavior.
  - Gate-1, human-gated, like `ui_only`: `spec-drafter` proposes a value when
    the request clearly targets one product's surface, the human confirms or
    edits it at gate 1 — never trust an un-gated guess.
  - Read via `provisionEphemeralEnv`'s activity OUTPUT, reusing the exact
    channel ADR-018 proved for `ui_only` (activity-output → `EphemeralEnv`,
    never a `workflow.ts`-side file read).
  - **Informational only this batch.** No `readProduct()` parser, no
    `EphemeralEnv.product` field, and no behavior keyed off it yet — those
    land in the next spec of the batch. Writing `product:` today has no
    runtime effect.
- **`mode:`** — reserved, unparsed. The batch anticipates future Forge
  scope-limiting modes (e.g. forge-self / hangar-app / fleet+tenants) that
  narrow what a run may touch. The key is reserved now so the frontmatter
  shape is stable, but it has no parser and no enforcement yet.
  - When modes are eventually built, they must flow through the same
    channel as `ui_only` and `product` — activity output → `EphemeralEnv` →
    activity behavior (prompt content, tool availability, path-fence
    enforcement) — never a `workflow.ts` file read and never a `target.kind`
    branch.
  - **Invariant (stated loudly so nobody smuggles around it):** a mode that
    would require a DIFFERENT GATE STRUCTURE (for example, skipping gate 2
    for a narrowly-scoped run) is a Temporal-versioned `workflow.ts` change,
    not "just another mode." Modes may change what an activity does within
    the existing gates; they may never change which gates exist or fire.

See ADR-019 for the full rationale (facet vs. target kind, the modes seam,
and the ADR-011/0025 `/` → Hangar / `/forge` → Forge amendment).

## Lifecycle

`draft` → human edits/approves (gate 1) → `approved` → initializer + coders on
branch `spec/<id>` in an ephemeral env → CI green → PR review (gate 2) →
`staged` → human promotes → `promoted` (env destroyed) — or `rejected` at any
gate (env destroyed, branch kept for reference).


## The `track` field (spec 0109)

Which of CLAUDE.md's two execution tracks builds this spec:

- **`track: 1`** — authored directly by a steered session → PR → human review.
  Foundation reshapes, security surgery, cross-repo adoption, pipeline/agent
  self-modification, and trivial docs.
- **`track: 2`** — runs through the full initializer/coder/fixer pipeline. Only
  for specs that are **additive, scoped to this repo, and independently
  testable**, which is where the loop plus CI plus the gates earn their keep.

Unlike `status`, this records a **process decision, not a fact about the change** —
it is the one field in the frontmatter that does. It exists because the two tracks
have different lifecycles and the UI cannot otherwise tell them apart:

**a Track-1 spec stays `status: draft` for its entire life.** No pipeline run ever
advances it to `approved`/`staged`/`promoted`, because no pipeline run happens. So
`draft` on a Track-1 spec means "done, built by hand", while `draft` on a Track-2
spec means "not started". Before this field, the workspace's "Siguiente paso" card
read the first meaning as the second and invited pipeline runs on finished, merged
work (spec 0109 defect 2).

Rules:

- Set it at drafting time; the human confirms or edits it at gate 1 like
  `ui_only`/`product`.
- **An absent `track` is treated as Track 1** — i.e. the UI will not offer to start
  a run. That fails closed on purpose: a missing button is a nuisance, whereas
  wrongly offering a run re-executes completed work.
- It does not gate anything in the pipeline itself. It is a routing/reporting fact,
  not an enforcement mechanism.
