#!/usr/bin/env bash
#
# gate.sh — THE definition of "is this tree green?" (spec 0227 A).
#
# It existed in three places that had already drifted:
#
#   CLAUDE.md        `pnpm -r typecheck && pnpm -r test`, plus `next build`
#   package.json     three separate scripts — no `next build`, no ordering
#   runCi            its own sequence, build-before-typecheck (spec 0055)
#
# One rule with three copies is the shape that cost eight defects on 2026-08-19
# (docs/COMPLIANCE-REGISTRY.md). This file is the copy; CLAUDE.md, the root
# package.json and .github/workflows/gate.yml call it.
#
# `runCi` DELIBERATELY DOES NOT, and that is not drift — do not "unify" it:
#
#   - it builds `--filter=./packages/*` and never `apps/web`, with a stated
#     reason (a red build folds into `green: false` without a novel error shape);
#   - it runs the suite with TEMPORAL_TEST=1 and HARNESS_EXEC_COUNT_FILE, then
#     folds `harnessSkipProofError` into the verdict — spec 0010's merge gate.
#     Moving that into shell would lose it, and it would slow every local run.
#   - for a CUSTOMER repo it calls `runProjectCi`, which already runs THAT
#     repo's own package.json scripts (spec 0171). A repo wanting a different
#     gate declares it there; a second discovery mechanism here would compete
#     with the one that already works.
#
# Two properties this script exists to hold, both paid for:
#
#   BUILD BEFORE TYPECHECK. A stale `dist/` answers `tsc` with yesterday's types
#   — three times in one session (registry row 11, VERIFICATION #7).
#
#   NEVER READ AN EXIT CODE THROUGH A PIPE. `cmd | tail` exits with TAIL's
#   status, in both directions (VERIFICATION #8, registry row 22). Every step
#   here captures the command's own status and nothing else pipes into it.
#
# Usage:
#   scripts/gate.sh              full gate
#   scripts/gate.sh --no-web     skip the apps/web production build (the slow
#                                step) when the change cannot affect bundling
#
# Exit: 0 green, 1 red. The failing step is named on stderr.
set -euo pipefail

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '   \033[31mFAIL\033[0m %s\n' "$*"; }

WEB_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-web) WEB_BUILD=0 ;;
    # `pnpm gate -- --no-web` forwards pnpm's own separator through. Accepting
    # it beats documenting an invocation the script then rejects.
    --) ;;
    *) printf 'gate.sh: unknown argument %s\n' "$arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

failed=""

# Run one step, capture ITS status, keep going so one run reports every failure
# rather than making the reader re-run to find the next one.
step() {
  local label="$1"; shift
  say "$label"
  local status=0
  "$@" || status=$?
  if [[ "$status" -eq 0 ]]; then
    ok "$label"
  else
    bad "$label (exit $status)"
    failed="${failed}${failed:+, }${label}"
  fi
}

# Build first: `tsc` reads the built `dist/` of sibling packages, so a stale one
# is answered as if it were current.
step "build"     pnpm -r build
step "typecheck" pnpm -r typecheck
step "test"      pnpm -r test

# The repo's own spec validator, on the specs THIS change touches. It has
# existed since 0217 and only ever ran in the drafter path, so hand-written
# specs were unchecked — the Track 1 gap again. After `build` on purpose: it
# imports a built package.
step "spec structure" scripts/lint-specs.mjs

# The instruments we COMMIT (build-plan item 6). Gated rather than report-only
# because it is clean across all 24 of them today — unlike lint-specs (213 of 226
# specs fail) and lint-boundaries (mostly by-design noise), which is the whole
# reason each of the three was measured before being wired.
step "instruments"    scripts/lint-instruments.mjs --strict

# A rule given to ONE agent is a rule that will not hold (rows 14, 15, 61).
# Gated: complete today, and the check is cheap.
step "agent rules"    scripts/lint-agent-rules.mjs --strict

# apps/web bundles differently from `tsc` under the test config, so a green
# typecheck is not evidence the app builds (CLAUDE.md, hard rule 3).
if [[ "$WEB_BUILD" -eq 1 ]]; then
  step "web build" pnpm --filter @launchpad/web build
else
  printf '\n   \033[33mskipped\033[0m apps/web build (--no-web)\n'
fi

if [[ -n "$failed" ]]; then
  printf '\n\033[31mGATE RED: %s\033[0m\n' "$failed" >&2
  exit 1
fi
printf '\n\033[32mGATE GREEN\033[0m\n'
