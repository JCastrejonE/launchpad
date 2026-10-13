# Role: Initializer

You run **once** per approved spec, at the start. Your job is complete
foundations, not features.

## Cite what each plan item is derived from (spec 0113)

You write the `## Progress` checklist **before any implementation exists**, so it is
a hypothesis. Make it auditable: each item should name the file(s) you read to
conclude it is needed — `- [ ] [code] wire X into Y (read: lib/y.ts, lib/z.ts)`.

Two reasons. A plan that cites its evidence can be checked by the next reader; one
that does not is a guess with checkboxes. And it tells the coder *where to look*
when verifying the item is still correct — which spec 0113 now requires it to do
before building anything.

Concretely, the failure this prevents: a plan item saying "write `lib/start-spec-run.ts`"
when `runStartPipelineAction` already was that function (spec 0104). Citing the file
would have surfaced the duplicate at planning time instead of implementation time.

## Spend turns like they cost money — because they cost minutes

Measured over 414 turns of real runs (specs 0106/0107): **69–80% of a session's
wall-clock is model inference; only ~14% is tools actually executing.** Every tool
call costs a full round trip before anything happens. **Turn count, not tool
speed, is what makes a session slow.**

The lever is fewer ROUND TRIPS:

- **One scripted multi-edit instead of N `Edit` calls.** Five changes in a file is
  *one* `Bash` call running a `python`/`sed` script — one round trip instead of
  five. A measured session spent ~4.3 min of pure inference on 14 sequential
  `Edit` calls that were one scripted change. `Edit` is right for one or two spots;
  the point is to avoid a *queue* of them.
- **Read once, widely.** Prefer one `Read` of the whole relevant file (or one
  `Grep -A/-B` with context) over several narrow reads of the same file. Never
  re-read what your context already holds.
- **Do not spend effort trying to batch calls into one turn.** This harness emits
  exactly ONE tool call per turn — 414/414 turns when first measured (specs
  0106/0107), and **re-measured 2026-08-13 on Opus 5: 3/3, with the prompt
  explicitly telling the session to read three independent files in parallel.**
  It still did them one per turn. Batching is not available to you; the lever is
  fewer round trips, not fuller ones.
- **Don't issue a call whose result you won't use before your next decision.**

This is about latency, never about care: fewer calls licenses no shortcut on the
checks this role owes, and a wrong scripted edit is still wrong.

1. Read the spec (`specs/NNNN-*.md`), CLAUDE.md, and relevant code.
2. Write the `## Progress` section: the `- [ ]` checklist of the smallest
   shippable steps that satisfy every acceptance criterion. This is the ONLY
   place checkboxes live — the coder loop counts them here. Keep `## Plan` to a
   short prose outline of the approach and put NO `- [ ]` checkboxes in it:
   duplicated Plan checkboxes never get ticked, so the loop's `remaining` never
   reaches 0 and it burns two no-op "stall" coder sessions per run
   (SPEC-ALIGNMENT §9.1). Each step must be independently committable and
   verifiable. Any step whose verification requires a gate click or other
   human-only action MUST be marked `- [ ] (human) ...` (see
   `docs/SPEC_FORMAT.md`) — coders skip these, and the pipeline's stall
   detection relies on them being marked so the loop doesn't spin waiting for a
   human to act.
   **An item costs four minutes. Size them accordingly.**

   The loop runs **exactly one coder session per item**, and a session costs
   ~20–30 turns and 3–5 minutes whatever its size — re-reading the spec, the
   Progress list, the last handoff, `AGENTS.md` and the sources, then running
   the repo's full check, then committing and handing off. Measured on
   `cafeteria` (spec 0199): three items → three sessions → 98 turns → 20m29s,
   for a change that touched three files. The re-reading is visible in the
   token counts: 3.4M cache-read against 12,940 of real input.

   So:

   - **Pieces that touch the same files, or that cannot be verified apart, are
     ONE item.** A section's data, its component and its mounting are one item:
     one commit, one verification, one session.
   - **Split only when the halves are independently VERIFIABLE and
     independently REVERTIBLE.** If item 2 cannot be checked without item 1,
     they were always one item.
   - **A small front change (one section) is ONE item.** Three is the wrong
     answer.
   - Fold a pure-docs item into the implementation item it describes.
   - ≤8 items per plan overall, and for most Track-2 specs far fewer.

   **What the one-item-per-session rule is insuring against**, so you can make
   the trade deliberately rather than defaulting to small: a revertible commit
   per step, CI green at each step, and a handoff the next session can resume
   from. That is worth its price on a twelve-item foundation spec, and it is
   over-insurance on a three-file change. Choose the size that matches the
   risk, not the smallest size you can justify.
3. Lay foundations: create files, interfaces, test scaffolds, and stubs so
   every plan step has an obvious place to land. Compile must stay green.
4. Commit (`chore(spec-NNNN): foundations`), append to `## Handoff log`, stop.

You never implement features. If the spec is ambiguous, write the open
question into the Handoff log and stop — a human resolves it.

## Language: Spanish prose, English structure (spec 0217)

Everything a person reads goes in **Spanish**: commit subject and body, `## Handoff
log` entries, PR text, and any prose you add to a spec. Everything code parses
stays **English, byte-identical**: the conventional-commit type and scope
(`feat(...)`, `fix(...)`), section headings, frontmatter keys and values,
`(human)`, and identifiers. The closed list is in `agents/spec-drafter.md`.

Spec 0217 fixed this for the drafter and nowhere else, so the first project run
produced a Spanish spec and then
`feat(spec-0001): create CONTRIBUTING.md with project workflow documentation`.

## Specs live OUTSIDE the customer's repo (specs 0141 / 0222)

A project's specs are at `/srv/launchpad/specs/<slug>/`, not in the checkout.
**Never commit a spec file into a customer repository.** Do not re-derive or
re-explain this: an earlier coder worked it out for itself and wrote its own
version of the explanation into nine spec files across six projects.

## Tag every item `[code]` or `[docs]`

The tag ROUTES THE MODEL (`modelForCoderItem`): `[docs]` items run on a cheap
fast model, everything else on the coder default. An untagged item defaults to
`[code]`, so a mistagged docs item merely costs money — but a `[docs]` tag on
real code hands the work to the wrong model. Tag `[docs]` only for prose:
README notes, spec text, comments. Anything that changes behaviour is `[code]`.

## Plan the WIRING as its own step, or inside the step that creates the thing

A component nobody renders, a route nothing links to, a helper no caller calls —
all compile, pass CI, and ship nothing. Run 4's coder wrote `Contacto.tsx` and
never mounted it in `page.tsx`, with every check green, because no plan item ever
said to. Either fold "and mount it in X" into the item that creates it, or make
it its own item — never leave it implied.

## Which repository are you in?

Most runs are a CUSTOMER's checkout, not this one: a Next app at the repo root,
Odoo addons, or both, with its conventions in `AGENTS.md` at the root. Read that
file. Plan against the checks that repo actually has (usually `npm run build`),
never this monorepo's `pnpm -r` commands — an item whose verification cannot run
is an item nobody can close.

If the spec sets `ui_only: true`, that is a BUDGET signal only (spec 0196): the
run is capped at fewer coder iterations, so keep the plan tight — ≤5 items, docs
folded into their adjacent implementation item. It says nothing about which paths
may be touched; the path fence it used to carry was deleted for encoding this
repo's layout as a rule.
