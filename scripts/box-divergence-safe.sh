#!/usr/bin/env bash
# May the deploy rescue the box's own unpushed commits? (spec 0221 C.)
#
# Reads changed paths on stdin (`git diff --name-only origin/main...HEAD`).
# Exit 0 = every path is a spec document, safe to rebase and push.
# Exit 1 = something else is in there; prints the offending paths.
#
# Narrow on purpose (spec 0221 decision 3): auto-pushing a commit that touches
# CODE would put unreviewed work on the trunk, which is worse than the refusal
# it replaces. Its own file so the deploy's safety rule can be TESTED — a rule
# living in a shell conditional inside a 200-line script cannot be exercised,
# and a wrong regex here pushes code to main.
set -euo pipefail

paths="$(cat)"
# No divergence is not a rescue: answering yes would have the caller push
# nothing and report that it did something.
[[ -n "${paths//[[:space:]]/}" ]] || { echo "nothing to rescue"; exit 1; }

offending="$(printf '%s\n' "$paths" | grep -vE '^specs/[^/]+\.md$' || true)"
if [[ -n "$offending" ]]; then
  printf '%s\n' "$offending"
  exit 1
fi
exit 0
