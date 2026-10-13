#!/usr/bin/env bash
# Web page-render smoke (spec 0020) — the supervisor's ONE-command gate-time
# live check for specs touching apps/web. Codifies spec 0017's amended
# acceptance criterion ("tsc alone is not sufficient proof for bundled apps/web
# code") after the .js-suffixed-import defect (98f720b) shipped tsc-green but
# 500'd every page.
#
# Usage: scripts/web-smoke.sh [BASE_URL]   # default http://localhost:3000
# Runs against a RUNNING server — a local dev server for the supervisor's
# gate-2/pre-promote checks below, or (spec 0042 item A) a prod `next start`
# started by the CI Route-smoke step in .github/workflows/ci.yml.
# curl-checks:
#   GET /                               (Launchpad: project grid — spec 0080 C.1
#                                        replaced the Hangar dashboard here)
#   GET /new, /connect, /projects/platform  (Phase C shell — spec 0096)
#   GET /forge/specs                    (spec inbox)
#   GET /forge/specs/<first-spec-file>  (a real spec detail route)
#   GET /api/health                     (health endpoint)
# Exits 0 iff every route above returns HTTP 200. It ALSO asserts (spec 0038,
# extended by specs 0060 and 0082) that every pre-IA-flip/pre-consolidation URL
# — /fleet, /specs, /chat, /forge, /forge/supervisor — returns a 3xx (proving the
# permanentRedirect() stubs fire) rather than following the redirect (no
# `curl -L`): a 200 on an old URL would mean the redirect stub silently
# regressed back into a real page. On any expectation mismatch (including a
# dead port), exits non-zero naming the failing route and the status seen.
# Deterministic, no retries. Timeout is generous (20s) because a dev-mode
# server compiles each route on-demand on first hit — a page pulling in heavy
# deps (e.g. the pipeline lib's @temporalio/client import chain) can take
# several seconds to compile before it serves its first response; a tight
# timeout produced a false non-200 in local observation (see spec 0020
# Handoff log).
#
# NOT wired into the per-item coder gate: during a run the dev server serves
# the PRIMARY checkout (main), not the run's worktree, so a coder-run smoke
# would exercise the wrong tree (spec 0020 decision). The guard
# (apps/web/lib/import-guard.ts) is the per-item catch; CI `next build` is the
# pre-merge catch; this script is the supervisor's recorded gate-2 check.
set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"

# Fetch an HTTP status, retrying ONLY on 000 (connection refused/reset/no
# response) — the dev server briefly returns 000 while it hot-reloads (e.g.
# right after a merge updates main), which false-flagged the spec-0020
# post-merge gate on spec 0042. A real HTTP status (2xx/3xx/4xx/5xx) is
# returned immediately and never retried, so a genuine 500 still fails fast.
curl_status() {
  local url="$1" s
  for _attempt in 1 2 3 4 5; do
    s="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" || true)"
    s="${s:-000}"
    if [ "$s" != "000" ]; then printf '%s' "$s"; return; fi
    sleep 2
  done
  printf '000'
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
specs_dir="$repo_root/specs"

first_spec="$(cd "$specs_dir" && ls -1 *.md | sort | head -n 1)"
if [ -z "$first_spec" ]; then
  echo "web-smoke: FAIL no spec files found under $specs_dir" >&2
  exit 1
fi

# Spec 0096 item: the Phase C Mission Control shell (specs 0080-0086) was NOT
# covered here at all — /new, /connect and /projects/[id] shipped unchecked,
# which is how the promote-button dead-end reached the owner. `/projects/platform`
# depends on the seeded platform Project row (spec 0079); a 404 there is a real
# failure (the control plane cannot show its own project), not a false negative.
#
# Spec 0095's link-reachability item — CLOSED by spec 0124, and the note it
# replaces is worth keeping for why it took this long:
#
#   > That is not robustly checkable with curl — the link lives in the Agentes tab,
#   > which is client-rendered and only lists rows when agent runs exist, so the
#   > href is absent from the initial HTML. Asserting it would be a data-dependent
#   > flake.
#
# That was true of the AGENTES tab. Spec 0122 added a Specs tab whose server-rendered
# slot lists every spec belonging to the project, and a server component passed as a
# prop is serialized into the payload even when its tab is not the active one — so the
# href is present, and it is present because specs exist on disk, not because a run
# happens to. Verified against a PRODUCTION build, not just dev (docs/VERIFICATION.md
# #3: a dev payload inlines source and cannot be grepped as evidence).
routes_200=(
  "/"
  "/new"
  "/connect"
  "/projects/platform"
  "/forge/specs"
  "/forge/specs/$first_spec"
  "/api/health"
)

# Spec 0082 (C.3) moved "/forge" here: the standalone console is retired (its
# chat is the project workspace's "Chats · sdd" tab now), so /forge must 3xx.
# A 200 on it would mean the retired console came back.
routes_3xx=(
  "/fleet"
  "/specs"
  "/chat"
  "/forge"
  "/forge/supervisor"
)

for route in "${routes_200[@]}"; do
  status="$(curl_status "$BASE_URL$route")"
  if [ "$status" != "200" ]; then
    echo "web-smoke: FAIL $route returned HTTP $status (expected 200)" >&2
    exit 1
  fi
  echo "web-smoke: OK $route (200)"
done

# Spec 0095 / 0124: the workspace must LINK to a spec detail page, not merely render.
# A 200 on /projects/platform proves the page loads; this proves the path from the
# workspace to a spec is actually reachable, which is the thing a human needs.
platform_html="$(curl -fsS --max-time 30 "$BASE_URL/projects/platform" || true)"
if ! printf '%s' "$platform_html" | grep -q '/forge/specs/'; then
  echo "web-smoke: FAIL /projects/platform contains no /forge/specs/ link (spec 0095 reachability)" >&2
  exit 1
fi
echo "web-smoke: OK /projects/platform links to a spec detail page"

for route in "${routes_3xx[@]}"; do
  status="$(curl_status "$BASE_URL$route")"
  if [ "${status}" -lt 300 ] || [ "${status}" -ge 400 ]; then
    echo "web-smoke: FAIL $route returned HTTP $status (expected a 3xx redirect)" >&2
    exit 1
  fi
  echo "web-smoke: OK $route (redirects, $status)"
done

echo "web-smoke: all routes OK ($BASE_URL)"
exit 0
