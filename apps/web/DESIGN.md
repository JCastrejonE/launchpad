# Design

The design system for **Hangar** (VPS fleet + tenant admin) and **Forge**
(chat-first code pipeline) — one product, two surfaces. Register: **product**
(design serves the task). This file is the source of truth the pipeline's coders
**transcribe** — values here are exact and greppable; do not invent. Authored
via the impeccable skill against `apps/web/PRODUCT.md`; live feel + in-situ
contrast are verified in the hands-on `polish`/`live` pass at each visual spec's
gate 3 (specs 0039–0041).

Direction (approved): **Cobalt + Signal mono** — a composed cobalt-blue accent
on cool near-neutral surfaces, with a monospace "technical texture" as the data
voice. **Light-default**, both themes AA. Restrained everywhere; the one
Committed surface is the Forge front-door hero.

---

## 1. Color

OKLCH is the authoring space; hex is the compiled token (browsers get hex for
`color-mix` stability, OKLCH noted for tuning). Neutrals are biased a hair
toward the cobalt hue (~262°, chroma ≤0.01) — cool, never warm/cream. Contrast
ratios are against the token's normal background; every body pair ≥ 4.5:1, large
text/UI ≥ 3:1 (WCAG 2.1 AA, both themes). **The hands-on pass re-verifies each
starred pair in-browser before promote.**

### 1.1 Light theme (default)

| Token | Hex | OKLCH | Role / contrast |
|---|---|---|---|
| `--bg` | `#fbfcfe` | 0.99 0.004 262 | body bg |
| `--bg-1` | `#ffffff` | 1.00 0 0 | raised surface (cards, inputs) |
| `--bg-2` | `#f2f4f8` | 0.96 0.006 262 | hover / second neutral (nav, toolbars) |
| `--bg-3` | `#e8ebf1` | 0.92 0.008 262 | active / pressed neutral |
| `--border` | `#e5e8ef` | 0.92 0.006 262 | hairline |
| `--border-2` | `#d3d8e2` | 0.86 0.008 262 | stronger divider / control border |
| `--text` | `#12141a` | 0.20 0.012 262 | body ink · **~16:1** ✓ |
| `--muted` | `#4d5361` | 0.44 0.014 262 | secondary text · **~7.2:1** ✓ |
| `--faint` | `#6b7180` | 0.55 0.014 262 | tertiary/labels · **~4.6:1** ✓ (was 8a8a94 ≈ 3.1:1, a fail — fixed) |
| `--accent` | `#2563eb` | 0.55 0.215 264 | cobalt: primary action, selection, live state · white-on-accent **~5.0:1** ✓ |
| `--accent-h` | `#1d4fd7` | 0.50 0.215 264 | accent hover |
| `--accent-fg` | `#ffffff` | — | text on accent |
| `--accent-dim` | `rgba(37,99,235,0.10)` | — | focus ring fill / accent tint |
| `--accent-ring` | `rgba(37,99,235,0.38)` | — | focus ring |
| `--accent-ink` | `#1a44b8` | 0.45 0.20 264 | cobalt AS TEXT on light bg · **~6.5:1** ✓ (use this, not `--accent`, for accent-colored text) |

### 1.2 Dark theme

| Token | Hex | OKLCH | Role / contrast |
|---|---|---|---|
| `--bg` | `#0b0d12` | 0.16 0.008 262 | body bg |
| `--bg-1` | `#111420` | 0.20 0.012 262 | raised surface |
| `--bg-2` | `#171b28` | 0.24 0.014 262 | hover |
| `--bg-3` | `#1e2333` | 0.28 0.016 262 | active |
| `--border` | `#262c3b` | 0.30 0.014 262 | hairline |
| `--border-2` | `#343c50` | 0.36 0.016 262 | stronger divider |
| `--text` | `#eef1f7` | 0.95 0.006 262 | body ink · **~15:1** ✓ |
| `--muted` | `#a2a9ba` | 0.72 0.014 262 | secondary · **~7:1** ✓ |
| `--faint` | `#6f7686` | 0.55 0.014 262 | tertiary · **~4.6:1** ✓ |
| `--accent` | `#5486ff` | 0.68 0.16 262 | cobalt (lifted for dark) · white/ink pairs per use |
| `--accent-h` | `#6b97ff` | 0.72 0.15 262 | hover |
| `--accent-ink` | `#7ea6ff` | 0.75 0.14 262 | cobalt as text on dark bg · **~6:1** ✓ |
| `--accent-dim` | `rgba(84,134,255,0.14)` | — | tint |
| `--accent-ring` | `rgba(84,134,255,0.45)` | — | focus ring |

### 1.3 Semantic ramps (both themes)

Keep the existing `ok/warn/info/danger` roles + `-bg`/`-bd` variants (values in
globals.css are fine after re-checking `info` against the new cobalt so they
read as distinct from the accent). `info` stays a lighter/cyan-leaning blue, NOT
cobalt, so "informational" ≠ "primary action". Each colored-on-tint pair AA-checked.

### 1.4 Strategy

- **Restrained** floor across Hangar dashboard, spec inbox, spec detail: cool
  neutrals + cobalt reserved for primary action, current selection, and live
  state — accent surface area ≤ ~10%.
- **Committed** cobalt on exactly ONE surface: the `/forge` empty-state hero.
- Retire: the indigo `--accent`, the gradient brand `.mark`, gradient AI avatar.
  The ambient `.glow` → keep but **quieter** (cobalt, ≤ 0.06 alpha) or drop —
  decided in the hands-on pass; not a keyframe, so reduced-motion-safe either way.
- `color-scheme` + the pre-paint theme script in `layout.tsx` stay; **default
  flips `dark` → `light`** (respect a stored preference).

---

## 2. Typography

- **One sans** (system stack, product permission): `--sans: ui-sans-serif,
  -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif`.
- **Mono is the data voice** (`--mono: ui-monospace, "SF Mono", "JetBrains
  Mono", Menlo, monospace`): spec IDs, phases, IPs, DB names, model labels,
  tenant ids, the `~/forge ❯` kicker. `font-variant-numeric: tabular-nums`
  everywhere a number can change.
- **Fixed rem scale** (ratio ~1.2), no fluid clamp: `--fs-1: 0.75rem` (12) ·
  `--fs-2: 0.8125rem` (13, dense/label) · `--fs-3: 0.875rem` (14, **body**) ·
  `--fs-4: 1rem` (16) · `--fs-5: 1.25rem` (20) · `--fs-6: 1.5rem` (24, page h1) ·
  `--fs-7: 2rem` (32, **Forge hero only**). Hero ≤ 32px — product register, not
  a landing page.
- Body `line-height: 1.5`, `letter-spacing: -0.006em`. Headings
  `letter-spacing: -0.02em` (never below -0.04em). `text-wrap: balance` on
  h1–h3. Prose capped 65–75ch; data/tables may run denser.

---

## 3. Spacing, radii, shadow, z

- **4pt spacing scale** — replace every ad-hoc `14px/18px/22px`:
  `--space-1: 4px · -2: 8px · -3: 12px · -4: 16px · -5: 20px · -6: 24px ·
  -7: 32px · -8: 48px · -9: 64px`. Vary spacing for rhythm; don't uniform-pad.
- **Radii:** `--r-sm: 6px · --r: 9px · --r-lg: 13px` (unchanged — they work).
- **Shadow:** keep the two-layer `--shadow`; re-tint the ambient toward cobalt
  in light. No glow-as-decoration.
- **z-scale (semantic, named):** `--z-base: 0 · --z-dropdown: 10 · --z-sticky:
  20 · --z-backdrop: 30 · --z-modal: 40 · --z-toast: 50 · --z-tooltip: 60`.
  Never arbitrary 999.

---

## 4. Motion

Governed by emil-design-eng + impeccable motion rules. **Motion conveys state,
never decoration.** Ease-out, no bounce/elastic. 120–320ms. Value-driven motion
uses **transitions, not keyframes** (interruptible + survives the 3s
`router.refresh()` re-render). Infinite loops use a **clock-synced negative
`animation-delay`** so a React remount doesn't visibly restart them. **Every
entry has a `prefers-reduced-motion: reduce` alternative** (the blanket
`animation/transition: none` backstop in globals.css stays; per-row gentler
alternatives are listed and preferred where they add legibility).

### 4.1 Motion tokens

```
--dur-1: 120ms;   /* feedback (press, hover) */
--dur-2: 200ms;   /* state change (default) */
--dur-3: 320ms;   /* layout / larger reveals */
--ease-out: cubic-bezier(0.22, 1, 0.36, 1);       /* quint-ish, the default */
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
/* infinite loops use `linear` */
```
Exits ~75% of enter duration. `:active` on every pressable = `scale(0.97)`.

### 4.2 In-progress / running animation inventory

Each is a named, spec-able unit. `RM` = reduced-motion alternative.

| # | Name | Trigger / where | Behavior | RM |
|---|---|---|---|---|
| 1 | `live-dot` | `.pill .d` on any active state (running pipeline, "live" handoff badge, VPS starting/creating/restoring, Deploying pills) | opacity 1→0.4→1, 2s `--ease-in-out` infinite, clock-synced delay | static dot |
| 2 | `flow-line` | stepper `.bar` between done→current during machine phases | cobalt gradient sweeps along the bar, `background-position` linear 1.6s infinite | static cobalt segment |
| 3 | `node-pulse` | current stepper `.node` (`.step.cur`) | box-shadow ring expand + fade, 2s `--ease-out` infinite | static ring (present today) |
| 4 | `progress-fill` | plan-progress bar + `%` (inbox rows + detail) on poll change | **width transition** `--dur-3 --ease-out` (never keyframe); tabular-nums | instant width |
| 5 | `value-flash` | any `.kv .v` / phase label whose value changed on a poll refresh | `--accent-dim` bg fades out 600ms `--ease-out` | none |
| 6 | `entry-in` | new `.ev` handoff entry arriving | `@starting-style` opacity 0 + translateY(4px) → in, `--dur-2 --ease-out`; timeline dot scale .9→1 | opacity only |
| 7 | `skeleton-shimmer` | fleet live-tenant Suspense fallback (skeleton rows, not "Loading…" text), chat tool-card pending, inbox first load | two-tone skeleton + `background-position` linear 1.2s sweep | static skeleton block |
| 8 | `stream-caret` | chat streaming tail + "Thinking…" | mono block caret blink `steps(2)` 1s linear; pending tool text = shimmer | static "Working…" |
| 9 | `gate-attn` | primary gate button while `awaiting_*` (waiting-on-you IS state) | minimal ring/shadow breathe, 3s `--ease-in-out`, low amplitude | static cobalt ring |
| 10 | `card-crossfade` | gate/phase card content swap after action or refresh | crossfade + 2px blur bridge, `--dur-2` | instant swap |
| 11 | `deploy-pending` | deploy-tenant submit (Hangar dashboard form) | button → inline fast spinner + form disabled until redirect | "Starting…" text |
| 12 | `drafting-ellipsis` | "Drafting spec…" placeholder page | mono ellipsis/cursor cycle | static "Drafting spec…" |
| 13 | `pill-swap` | status pill label change (running→waiting etc.) | 150ms crossfade | instant |
| 14 | `btn-press` | all pressables | `transform: scale(0.97)` on `:active`, `--dur-1` | kept (feedback, no travel) |

No page-load choreography, no scroll reveals, no route-transition theater.

---

## 5. Components (state-complete)

Keep the existing class vocabulary; re-base its values on §1–4. **Every
interactive component ships all applicable states: default · hover · focus
(`:focus-visible` cobalt ring) · active (`scale(0.97)`) · disabled · loading ·
error.** Current gaps to fill: loading/disabled on `.btn`, `.input`; skeletons
for `.row`/fleet cards; `.pill` running/live variant (#1); error state on
`.composer`.

- **Shell:** `.topbar` (section-aware brand: **Hangar** on `/`, **Forge** on
  `/forge*`), `.nav` (`Hangar · Forge · Specs`, cobalt active), `.shell`.
- **Inbox:** `.panel` + `.row` (sortable heads, `%` via #4, product badge).
- **Fleet/detail:** `.card`/`.hd`/`.bd`, `.kv` (#5 on live values), skeletons (#7).
- **Pipeline:** `.stepper`/`.step`/`.node`/`.bar` (#2/#3), `.gatebar` (#9),
  `.feed`/`.ev` (#6, collapsible — keep spec-0032 behavior).
- **Chat:** `.composer`/`.chips`, `.msg` (avatar reworked off the indigo
  gradient), `.hero` (the Committed cobalt surface; #8 streaming).
- **Consolidate the two dialects:** custom CSS is the source of truth; map the
  shadcn `components/ui/{button,card}.tsx` (chat cards) onto the same tokens via
  Tailwind v4 `@theme` reading these CSS variables — don't ship a second style
  language.

---

## 6. For the pipeline coders (transcribe, don't design)

- Every value above is exact — copy it. If a value is missing, STOP and leave a
  `(human)` item rather than inventing one; the hands-on pass fills it.
- Gate each increment on `pnpm -r typecheck && pnpm -r test` + `next build`
  (client-bundle discipline, spec 0032) + `node
  .claude/skills/impeccable/scripts/detect.mjs --json apps/web` clean (catches
  the absolute bans headlessly).
- Reduced-motion: the global `@media (prefers-reduced-motion: reduce)` backstop
  stays; where a per-animation RM alternative above is gentler, add it too.
- **Absolute bans (auto-reject):** side-stripe borders, gradient text,
  decorative glassmorphism, the hero-metric template (the Hangar summary strip
  is live restrained data, not the template — keep it plain), identical card
  grids, per-section eyebrow (retire the current `.eyebrow`), numbered section
  markers, text overflow.