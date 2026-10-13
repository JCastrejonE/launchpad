#!/usr/bin/env bash
# Preflight — one command to get a dev box ready to drive the pipeline from
# apps/web (spec 0005). Idempotent: running it twice in a row is a no-op the
# second time (see the spec's acceptance criteria) — every step below only
# performs a side effect when something is actually missing/down; a re-run
# just re-affirms the already-good state and exits 0.
#
# Order (per spec 0005 Plan, extended by spec 0007 item 8):
#   1. Docker compose services up (start only what's missing).
#   2. Temporal reachable (probe TEMPORAL_ADDRESS, retry, fail fast).
#   3. .env present with CLAUDE_CODE_OAUTH_TOKEN set (never print the value —
#      CLAUDE.md rule 6).
#   4. Build packages if dist/ is missing.
#   5. Stale-dist guard: warn if packages/pipeline/dist is older than the
#      latest commit touching packages/{pipeline,agents}/src, and offer to
#      rebuild + restart the worker (spec 0007 — the chicken-and-egg found in
#      spec 0006, where a running worker keeps executing pre-rebuild
#      workflow/activity code with no indication anything's stale).
#   6. Start the worker if it isn't already running for this repo; report
#      status either way. Refuses to start a second worker (pidfile + pgrep
#      cross-check) unless `--force` (spec 0008 — run 2's merge failure was
#      exactly two workers polling the same queue, one stale).
#   7. Start apps/web's dev server (`next dev`) on WEB_HOST (default
#      127.0.0.1 — spec 0087; `next dev` binds every interface unless told
#      otherwise, and this script runs the binary directly so it does NOT pick
#      up the `-H` in apps/web/package.json), the same way, with env already
#      loaded from .env — retires the operator's manual `set -a; source .env;
#      next dev` ritual (spec 0018). A detached background loop supervises it:
#      auto-restart on crash with bounded backoff, up to a give-up threshold
#      that reports red instead of flapping forever. Polls `/api/health`
#      until ready and warns on a degraded-Temporal body.
#   8. Warm the Temporal test-server binary cache used by the pipeline's own
#      workflow test harness (spec 0010 item 4) — a one-time download on a
#      cold cache, a fast no-op once cached, so `runCi`'s first
#      `TEMPORAL_TEST=1` harness execution never burns activity time on a
#      network fetch.
#
# Subcommand:
#   restart — kill every worker process (tracked + untracked), rebuild
#     packages/* ONLY (never apps/web — running `next build` here while THIS
#     checkout's dev server is up corrupts its shared .next directory, spec
#     0008 item 5; the hazard is that local dev-server contention, not an
#     inherent property of `next build` — CI runs it safely on a fresh
#     checkout with no dev server, spec 0020), start exactly one worker,
#     print its build id. Loads .env (so the worker gets TEMPORAL_ADDRESS /
#     LAUNCHPAD_REPO_ROOT / the oauth token) but skips the docker-up and
#     Temporal-reachability checks above — it assumes preflight already ran
#     once and infra is up; use it after a merge/pull to get back to exactly
#     one worker on the known-good build. Refuses to run at all while any
#     specPipeline workflow is RUNNING (queried via
#     scripts/open-pipeline-workflows.mjs) unless --force — mid-run worker
#     swaps were a contributing factor in spec 0015's TMPRL1100 crash (spec
#     0017).
set -euo pipefail

# --force: bypass the second-worker refusal in step 6/7 below (start a new
# worker even though one already appears to be running, pidfile or pgrep) AND
# the restart-subcommand's refuse-while-a-run-is-open guard above. The
# caller is responsible for knowing that's safe — this does NOT kill the
# existing worker for you (see the `restart` subcommand below for "kill
# everything and start exactly one").
FORCE=0
SUBCOMMAND=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    restart) SUBCOMMAND="restart" ;;
    # Internal only (spec 0018 item 7) — not a documented operator
    # subcommand. This is how the web-lifecycle supervisor daemonizes
    # itself: the main flow below re-invokes this same script with this
    # arg via `nohup "$0" __web-supervisor &`, so the crash-restart loop
    # keeps running detached from the preflight invocation that started
    # it.
    __web-supervisor) SUBCOMMAND="__web-supervisor" ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="infra/docker-compose.dev.yml"
STATE_DIR="$REPO_ROOT/.preflight"
WORKER_PID_FILE="$STATE_DIR/worker.pid"
WORKER_LOG_FILE="$STATE_DIR/worker.log"
WORKER_ENTRYPOINT="packages/pipeline/dist/worker.js"

# Web dev-server lifecycle (spec 0018 item 7): pid + log tracked alongside the
# worker's own (same STATE_DIR — the spec's "~/.launchpad/" phrasing describes
# the immutable worker-build snapshots below, which really do live under the
# user's home dir; the worker's OWN pid/log have always lived in this
# repo-local STATE_DIR, so "alongside the worker's" is honored literally here
# rather than introducing a second, inconsistent state directory just for
# web). WEB_SUPERVISOR_PID_FILE tracks the detached crash-restart loop's own
# pid, separate from `next dev`'s pid, so the two lifecycles (the dev server
# itself vs. the thing that restarts it) can be reasoned about independently.
WEB_APP_DIR="$REPO_ROOT/apps/web"
WEB_PID_FILE="$STATE_DIR/web.pid"
WEB_LOG_FILE="$STATE_DIR/web.log"
WEB_SUPERVISOR_PID_FILE="$STATE_DIR/web-supervisor.pid"
WEB_SUPERVISOR_LOG_FILE="$STATE_DIR/web-supervisor.log"
WEB_GIVEUP_FILE="$STATE_DIR/web.giveup"
# Spec 0023 lockfile-hash stamp (shared with the pipeline's post-merge sync in
# packages/pipeline/src/activities.ts): sha256 of $REPO_ROOT/pnpm-lock.yaml,
# used by ensure_web_deps to detect node_modules drift.
DEPS_STAMP_FILE="$STATE_DIR/deps-lock.sha"
WEB_PORT="${PORT:-3000}"
# Spec 0087: loopback UNLESS someone opts out on purpose. `next dev` binds all
# interfaces by default, and step 7 runs the next binary directly (see
# start_web_once) rather than `pnpm run dev`, so it does NOT inherit the
# `-H 127.0.0.1` in apps/web/package.json — which silently defeated CLAUDE.md's
# "never expose the dev server on a routable interface" for anyone starting the
# documented way. Overridable (WEB_HOST=0.0.0.0) for a deliberate LAN demo.
WEB_HOST="${WEB_HOST:-127.0.0.1}"
WEB_HEALTH_URL="http://localhost:${WEB_PORT}/api/health"
# Bounded backoff + explicit give-up threshold (spec 0018 acceptance: "reports
# red instead of flapping forever"). A crash that happens after the app has
# been up for a while resets the counter — otherwise an app with occasional,
# unrelated crashes over weeks of uptime would eventually exhaust the budget
# and stop auto-restarting for good, which isn't the "flapping" this guards
# against.
WEB_RESTART_MAX_ATTEMPTS="${LAUNCHPAD_WEB_RESTART_MAX_ATTEMPTS:-5}"
WEB_RESTART_BACKOFF_MAX_SECONDS=30
WEB_STABLE_UPTIME_SECONDS=60

# Immutable worker build snapshots (spec 0017): `preflight restart` never
# starts the worker from packages/*/dist in place — it materializes a
# frozen copy under here first (see materialize_worker_snapshot below) so a
# later mid-run rebuild (runCi, manual tsc) can alter the repo's dist/ without
# ever touching the code the running worker process actually executes.
# WORKER_ENTRYPOINT above stays a relative-path SUBSTRING match target for
# `pgrep -f` in other_worker_pids/worker_running — a snapshot's absolute path
# (.../worker-builds/<sha>/packages/pipeline/dist/worker.js) still ends with
# it, so those checks keep working unchanged.
WORKER_BUILD_ROOT="$HOME/.launchpad/worker-builds"
WORKER_BUILD_KEEP="${WORKER_BUILD_KEEP:-5}"

# .env is validated as a hard requirement in step 3 below, but if it's
# already there we load it now so TEMPORAL_ADDRESS / LAUNCHPAD_REPO_ROOT /
# CLAUDE_CODE_OAUTH_TOKEN are available to the rest of this script (including
# the `restart` subcommand, which starts a worker without going through the
# numbered steps below) exactly as they would be for the worker/CLI. Values
# are never echoed.
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi
: "${LAUNCHPAD_REPO_ROOT:=$REPO_ROOT}"
export LAUNCHPAD_REPO_ROOT

# Tracked via our own pidfile rather than `pgrep -f <worker.js>` — on macOS,
# reading another process's full argv (what -f matches against) is subject
# to per-process permission checks and was observed to return stale/wrong
# matches for workers not started by this script's own session. A pidfile
# we wrote ourselves + `kill -0` (existence check only, no argv needed) is
# reliable regardless of who/how the process table is visible.
worker_running() {
  [ -f "$WORKER_PID_FILE" ] || return 1
  local pid
  pid="$(cat "$WORKER_PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Cross-check via pgrep for any *other* live process running our worker
# entrypoint that our own pidfile doesn't know about (spec 0008: run 2's
# merge failure came from exactly this — a second worker polling the same
# task queue that this script's pidfile-only check couldn't see). pgrep -f's
# argv match is best-effort (see the note above `worker_running` re: macOS
# permission checks returning stale/empty results for processes outside this
# script's session) — it can under-detect but a hit here is always a real
# additional PID beyond the one in our pidfile.
other_worker_pids() {
  local mine
  mine="$(cat "$WORKER_PID_FILE" 2>/dev/null || echo "__none__")"
  pgrep -f "$WORKER_ENTRYPOINT" 2>/dev/null | grep -v -x "$mine" || true
}

# Same pidfile + kill -0 pattern as worker_running, for the `next dev`
# process this script starts/supervises.
web_running() {
  [ -f "$WEB_PID_FILE" ] || return 1
  local pid
  pid="$(cat "$WEB_PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Is the detached crash-restart loop (run_web_supervisor, via `"$0"
# __web-supervisor`) itself still alive? Distinct from web_running: the
# supervisor can be alive with web currently down (mid-backoff, about to
# retry).
web_supervisor_running() {
  [ -f "$WEB_SUPERVISOR_PID_FILE" ] || return 1
  local pid
  pid="$(cat "$WEB_SUPERVISOR_PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Spec 0023 (belt, defense in depth): (re)install deps when pnpm-lock.yaml has
# changed out from under node_modules, keyed off the SAME stamp file the
# pipeline's post-merge sync uses (DEPS_STAMP_FILE = sha256 of the root
# pnpm-lock.yaml). On a hash mismatch: `pnpm install --frozen-lockfile` at
# $REPO_ROOT, then restamp. On a match: a hash comparison and NOTHING else, so
# both call sites stay idempotent (preserves spec 0005's re-run-is-a-no-op).
# Portable sha256 via `shasum -a 256` (macOS/Linux), same spirit as
# file_mtime_epoch's stat shim.
#
# This layer alone can NOT fix the 0016 defect — the supervisor only reacts to
# process EXIT, and a missing-module 500 leaves `next dev` alive — which is why
# the pipeline trigger (layer 1) is the real fix and this is only the belt.
#
# Called from exactly two places: (a) step 7's main flow, before the
# node_modules/.bin/next existence check; (b) inside run_web_supervisor's loop
# before each start_web_once, so a crash-restart never boots against stale
# node_modules even if a merge-sync was somehow missed (e.g. a manual git pull).
#
ensure_web_deps() {
  local current stamped
  current="$(shasum -a 256 "$REPO_ROOT/pnpm-lock.yaml" | awk '{print $1}')"
  stamped="$(cat "$DEPS_STAMP_FILE" 2>/dev/null || true)"
  if [ "$current" = "$stamped" ]; then
    return 0
  fi
  echo "preflight: pnpm-lock.yaml hash changed (or no stamp yet) — running pnpm install --frozen-lockfile at $REPO_ROOT"
  (cd "$REPO_ROOT" && pnpm install --frozen-lockfile)
  mkdir -p "$STATE_DIR"
  echo "$current" > "$DEPS_STAMP_FILE"
}

# Starts `next dev` once, records its pid to WEB_PID_FILE, and sets it in the
# global WEB_LAST_PID (same "set a global, don't return via stdout" convention
# as materialize_worker_snapshot/WORKER_SNAPSHOT_DIR below) — NOT via
# command-substitution/echo: `pid="$(start_web_once)"` would run this whole
# function in a subshell (command substitution always forks one), so the `&`
# background job below would belong to that transient subshell rather than to
# run_web_supervisor's own shell. Verified live: with the echo/substitution
# form, the job was reparented once the substitution subshell exited, and
# run_web_supervisor's later `wait "$pid"` no longer recognized it as one of
# ITS children — bash's `wait` immediately fails on an unknown pid ("not a
# child of this shell", exit 127), even though the real `next dev` process
# was still starting up fine underneath. A global-variable return sidesteps
# the subshell entirely. Runs the real next binary directly (not `pnpm run
# dev`, which wraps it in an extra process pnpm may or may not forward
# signals through) via `exec` inside the backgrounded subshell, so the
# subshell's own pid (captured as $!) IS next's actual pid once exec replaces
# the subshell's process image — exactly what `wait`/`kill -0` need.
start_web_once() {
  (
    cd "$WEB_APP_DIR"
    exec "$WEB_APP_DIR/node_modules/.bin/next" dev -H "$WEB_HOST" -p "$WEB_PORT" >>"$WEB_LOG_FILE" 2>&1
  ) &
  WEB_LAST_PID=$!
  echo "$WEB_LAST_PID" > "$WEB_PID_FILE"
}

# The supervisor loop itself (spec 0018 item 7: "auto-restart on crash with
# bounded backoff and an explicit give-up threshold that reports red instead
# of flapping forever"). Invoked ONLY via `"$0" __web-supervisor`, nohup'd +
# backgrounded by the main flow below so it outlives this preflight
# invocation. Writes its own pid to WEB_SUPERVISOR_PID_FILE, then loops:
# start web, wait for it to exit, decide whether to back off and retry or
# give up.
# `next dev` runs its actual dev server in a CHILD process separate from the
# CLI process we start/track (observed live: killing our tracked pid can
# leave a `next-server` process still bound to WEB_PORT). If that child
# outlives the parent — whether the parent crashed on its own or was killed
# externally (exactly what item 8's human live-check does) — every
# subsequent restart attempt fails with EADDRINUSE forever, which would
# silently exhaust the give-up budget for the wrong reason (a stuck port, not
# a genuinely broken app) every single time. Sweep the port clear before each
# (re)start attempt so a stray child from the previous attempt can never
# block the next one.
free_web_port() {
  command -v lsof >/dev/null 2>&1 || return 0
  local pids
  pids="$(lsof -ti "tcp:${WEB_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "preflight web-supervisor: port $WEB_PORT still held by pid(s) $pids (a stray next.js child process, most likely) — clearing before (re)start" >>"$WEB_SUPERVISOR_LOG_FILE"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    sleep 1
  fi
}

run_web_supervisor() {
  # Normally already created by the main flow before this is ever launched
  # (mkdir -p "$STATE_DIR" runs near the top of the non-subcommand flow,
  # before step 7 backgrounds this), but guard it here too since this
  # function is reachable standalone via `"$0" __web-supervisor`.
  mkdir -p "$STATE_DIR"
  echo "$$" > "$WEB_SUPERVISOR_PID_FILE"
  rm -f "$WEB_GIVEUP_FILE"
  local attempts=0
  while true; do
    local start_ts pid exit_code end_ts uptime backoff
    free_web_port
    ensure_web_deps  # never boot next dev against stale node_modules (spec 0023 belt)
    start_ts="$(date +%s)"
    start_web_once
    pid="$WEB_LAST_PID"
    echo "preflight web-supervisor: web started (pid $pid)" >>"$WEB_SUPERVISOR_LOG_FILE"
    # `wait` returns the awaited process's exit status, which is non-zero for
    # any crash (that's the whole point — we're watching for exactly that).
    # This script runs under `set -e`, so a bare `wait "$pid"` whose target
    # exits non-zero would abort the ENTIRE supervisor loop right here,
    # silently, before any restart/backoff logic ever ran — verified live:
    # an earlier draft did exactly this (`kill -9` the web pid made the whole
    # backgrounded supervisor process vanish with no restart and no log
    # line). Using `wait` as an `if` condition is the standard errexit-safe
    # form: a command's failure inside an `if`/`while` test doesn't trigger
    # errexit.
    if wait "$pid" 2>/dev/null; then
      exit_code=0
    else
      exit_code=$?
    fi
    end_ts="$(date +%s)"
    uptime=$((end_ts - start_ts))
    rm -f "$WEB_PID_FILE"
    echo "preflight web-supervisor: web (pid $pid) exited (code $exit_code) after ${uptime}s" >>"$WEB_SUPERVISOR_LOG_FILE"

    if [ "$uptime" -ge "$WEB_STABLE_UPTIME_SECONDS" ]; then
      attempts=0
    fi
    attempts=$((attempts + 1))

    if [ "$attempts" -ge "$WEB_RESTART_MAX_ATTEMPTS" ]; then
      echo "preflight web-supervisor: giving up after $attempts consecutive crash(es) within ${WEB_STABLE_UPTIME_SECONDS}s of starting — web will stay DOWN; see $WEB_LOG_FILE, fix the underlying issue, then re-run preflight to try again" >>"$WEB_SUPERVISOR_LOG_FILE"
      echo "down: gave up after $attempts consecutive crashes (last exit code $exit_code) — see $WEB_LOG_FILE" > "$WEB_GIVEUP_FILE"
      # Sweep any stray child the last, un-retried crash left bound to the
      # port — otherwise "DOWN" would be a lie: something would still be
      # answering on WEB_PORT, unmanaged, until the next preflight run's
      # first free_web_port call happened to clear it (verified live: the
      # final crash's orphaned next-server survived exactly like this until
      # this call was added).
      free_web_port
      break
    fi

    backoff=$((2 ** attempts))
    [ "$backoff" -gt "$WEB_RESTART_BACKOFF_MAX_SECONDS" ] && backoff="$WEB_RESTART_BACKOFF_MAX_SECONDS"
    echo "preflight web-supervisor: restarting web in ${backoff}s (attempt $attempts/$WEB_RESTART_MAX_ATTEMPTS)" >>"$WEB_SUPERVISOR_LOG_FILE"
    sleep "$backoff"
  done
  rm -f "$WEB_SUPERVISOR_PID_FILE"
}

# Materializes an immutable snapshot of the just-built packages/{pipeline,
# agents,github}/dist + package.json at
# ~/.launchpad/worker-builds/<git-sha>/, then prunes older snapshots down to
# the last WORKER_BUILD_KEEP (default 5). Sets WORKER_SNAPSHOT_DIR for the
# caller.
#
# node_modules is deliberately NOT copied into the snapshot — each package
# dir instead gets a symlink back to the repo's own node_modules (plus one
# for the repo root, covering hoisted/top-level deps). Dependencies never
# change from a `pnpm -r build` (only dist/ does), so a symlink is both
# correct and — critically — keeps @temporalio's per-platform native addon
# (@temporalio/core-bridge's releases/*/index.node, resolved via relative
# symlinks several levels up into node_modules/.pnpm) working: symlinking the
# whole node_modules directory preserves those nested relative symlinks
# exactly as they resolve today, since symlink targets are resolved relative
# to the symlink's own real containing directory, not the path used to reach
# it. Copying node_modules instead would risk silently breaking that native
# binary resolution, or ballooning disk usage per snapshot for no benefit
# (node_modules is never what a rebuild changes).
materialize_worker_snapshot() {
  local sha snapshot_dir pkg
  sha="$(git rev-parse HEAD)"
  snapshot_dir="$WORKER_BUILD_ROOT/$sha"

  echo "preflight restart: materializing worker build snapshot at $snapshot_dir"
  rm -rf "$snapshot_dir"
  mkdir -p "$snapshot_dir"
  ln -s "$REPO_ROOT/node_modules" "$snapshot_dir/node_modules"

  for pkg in pipeline agents github; do
    mkdir -p "$snapshot_dir/packages/$pkg"
    cp -R "packages/$pkg/dist" "$snapshot_dir/packages/$pkg/dist"
    cp "packages/$pkg/package.json" "$snapshot_dir/packages/$pkg/package.json"
    if [ -d "packages/$pkg/node_modules" ]; then
      ln -s "$REPO_ROOT/packages/$pkg/node_modules" "$snapshot_dir/packages/$pkg/node_modules"
    fi
  done

  if [ -d "$WORKER_BUILD_ROOT" ]; then
    local stale stale_count
    stale="$(ls -1dt "$WORKER_BUILD_ROOT"/*/ 2>/dev/null | tail -n +$((WORKER_BUILD_KEEP + 1)))"
    if [ -n "$stale" ]; then
      stale_count="$(echo "$stale" | wc -l | tr -d ' ')"
      echo "preflight restart: pruning $stale_count old worker-build snapshot(s), keeping last $WORKER_BUILD_KEEP"
      echo "$stale" | xargs rm -rf
    fi
  fi

  WORKER_SNAPSHOT_DIR="$snapshot_dir"
}

# `restart` subcommand (spec 0008 item 5): kill every worker process this
# script can find (tracked pidfile + untracked pgrep matches), rebuild
# packages/* ONLY, start exactly one worker, print its build id. Runs instead
# of the normal 7-step flow above/below — it's meant to be reached for
# post-merge/pull recovery, not first-time setup, so it skips the docker-up
# and Temporal-reachability checks and assumes preflight already ran once
# (though .env is already loaded above, since the worker needs it either way).
run_restart() {
  mkdir -p "$STATE_DIR"

  echo "== preflight restart: checking for open specPipeline runs =="
  OPEN_WORKFLOWS="$(node "$REPO_ROOT/scripts/open-pipeline-workflows.mjs" 2>/dev/null || true)"
  if [ -n "$OPEN_WORKFLOWS" ] && [ "$FORCE" -ne 1 ]; then
    echo "preflight restart: refusing — a specPipeline workflow is RUNNING (mid-run worker swaps contributed to the 0015 TMPRL1100 crash). Open workflow(s):" >&2
    echo "$OPEN_WORKFLOWS" | sed 's/^/  /' >&2
    echo "preflight restart: wait for it to finish, or pass --force to restart anyway." >&2
    exit 1
  fi
  if [ -n "$OPEN_WORKFLOWS" ]; then
    echo "preflight restart: --force set — restarting despite open workflow(s): $(echo "$OPEN_WORKFLOWS" | tr '\n' ' ')" >&2
  fi

  echo "== preflight restart: killing all worker processes =="
  if worker_running; then
    OLD_PID="$(cat "$WORKER_PID_FILE")"
    echo "preflight restart: stopping tracked worker (pid $OLD_PID)"
    kill "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$WORKER_PID_FILE"

  local other_pids
  other_pids="$(other_worker_pids)"
  if [ -n "$other_pids" ]; then
    echo "preflight restart: stopping untracked worker pid(s): $other_pids"
    # shellcheck disable=SC2086
    kill $other_pids 2>/dev/null || true
  fi
  # Give killed processes a moment to actually exit before starting a new one
  # on the same task queue — avoids a brief window with two workers up.
  sleep 1

  echo "preflight restart: rebuilding packages/* only (never apps/web here — running \`next build\` against THIS checkout while its dev server is up corrupts the dev server's shared .next; not a hazard in CI, which has no dev server, spec 0020)"
  pnpm --filter='./packages/*' -r build

  WORKER_SNAPSHOT_DIR=""
  materialize_worker_snapshot

  echo "preflight restart: starting exactly one worker (from snapshot)"
  LAUNCHPAD_WORKER_SNAPSHOT="$WORKER_SNAPSHOT_DIR" \
    nohup node "$WORKER_SNAPSHOT_DIR/packages/pipeline/dist/worker.js" >>"$WORKER_LOG_FILE" 2>&1 &
  local worker_pid=$!
  echo "$worker_pid" > "$WORKER_PID_FILE"
  sleep 1
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "preflight restart: worker failed to start — see $WORKER_LOG_FILE" >&2
    exit 1
  fi

  local build_id
  build_id="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
  echo "preflight restart: worker started (pid $worker_pid, buildId: $build_id, snapshot: $WORKER_SNAPSHOT_DIR)"
}

if [ "$SUBCOMMAND" = "restart" ]; then
  run_restart
  exit 0
fi

if [ "$SUBCOMMAND" = "__web-supervisor" ]; then
  run_web_supervisor
  exit 0
fi

command -v docker >/dev/null 2>&1 || {
  echo "preflight: docker not found on PATH — install Docker Desktop (or equivalent) first" >&2
  exit 1
}

mkdir -p "$STATE_DIR"

echo "== 1/8: docker compose services =="
ALL_SERVICES=()
while IFS= read -r line; do
  [ -n "$line" ] && ALL_SERVICES+=("$line")
done < <(docker compose -f "$COMPOSE_FILE" config --services)

RUNNING_SERVICES=()
while IFS= read -r line; do
  [ -n "$line" ] && RUNNING_SERVICES+=("$line")
done < <(docker compose -f "$COMPOSE_FILE" ps --services --filter "status=running")

MISSING_SERVICES=()
for svc in "${ALL_SERVICES[@]:-}"; do
  [ -z "$svc" ] && continue
  found=0
  for up in "${RUNNING_SERVICES[@]:-}"; do
    [ "$svc" = "$up" ] && found=1 && break
  done
  [ "$found" -eq 0 ] && MISSING_SERVICES+=("$svc")
done

if [ "${#MISSING_SERVICES[@]}" -eq 0 ]; then
  echo "preflight: all ${#ALL_SERVICES[@]} compose services already up"
else
  echo "preflight: starting ${#MISSING_SERVICES[@]} compose service(s): ${MISSING_SERVICES[*]}"
  docker compose -f "$COMPOSE_FILE" up -d
fi

echo "== 2/8: Temporal reachable =="
TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"
TEMPORAL_HOST="${TEMPORAL_ADDRESS%%:*}"
TEMPORAL_PORT="${TEMPORAL_ADDRESS##*:}"

temporal_reachable() {
  (exec 3<>"/dev/tcp/${TEMPORAL_HOST}/${TEMPORAL_PORT}") 2>/dev/null
}

ATTEMPTS=0
MAX_ATTEMPTS=30
until temporal_reachable; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
    echo "preflight: Temporal not reachable at $TEMPORAL_ADDRESS after ${MAX_ATTEMPTS}s — is docker compose up? (see step 1)" >&2
    exit 1
  fi
  sleep 1
done
echo "preflight: Temporal reachable at $TEMPORAL_ADDRESS"

echo "== 3/8: .env present with CLAUDE_CODE_OAUTH_TOKEN =="
if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "preflight: .env not found — copy .env.example to .env and set CLAUDE_CODE_OAUTH_TOKEN (see README quickstart)" >&2
  exit 1
fi
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "preflight: CLAUDE_CODE_OAUTH_TOKEN is not set in .env — run \`claude setup-token\` and paste the result in (value withheld from this output on purpose)" >&2
  exit 1
fi
echo "preflight: .env present, CLAUDE_CODE_OAUTH_TOKEN is set (value not shown)"

echo "== 4/8: build packages if dist/ missing =="
NEEDS_BUILD=0
for pkg_dir in packages/*/; do
  if [ -f "${pkg_dir}package.json" ] && [ ! -d "${pkg_dir}dist" ]; then
    NEEDS_BUILD=1
  fi
done
if [ "$NEEDS_BUILD" -eq 1 ]; then
  echo "preflight: dist/ missing for one or more packages — running pnpm -r build"
  pnpm -r build
else
  echo "preflight: dist/ present for all packages/*, skipping build"
fi

# Apply control-plane DB migrations (spec 0078). @launchpad/db owns the schema
# (users/audit_log/secrets + the Project model + the folded chat tables) now
# that chat-store no longer bootstraps its own DDL — so the schema must exist
# before the worker or apps/web query it. drizzle-orm's migrator is idempotent
# (tracked in __drizzle_migrations), so a re-run is a no-op. DATABASE_URL comes
# from .env (sourced above); Postgres is up from step 1.
echo "preflight: applying @launchpad/db migrations"
pnpm --filter @launchpad/db migrate

echo "== 5/8: stale-dist guard =="
# Portable file-mtime-as-epoch-seconds: GNU coreutils (`stat -c %Y`, Linux/CI)
# vs. BSD/macOS (`stat -f %m`, dev laptops) disagree on stat's flags.
file_mtime_epoch() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

# Newest mtime among every file under packages/pipeline/dist — a directory's
# own mtime does NOT change when tsc overwrites an existing file's contents
# in place (only on add/remove/rename), so it can't stand in for "was this
# rebuilt after that commit".
dist_mtime_epoch() {
  local newest=0 m
  while IFS= read -r -d '' f; do
    m="$(file_mtime_epoch "$f")"
    [ "$m" -gt "$newest" ] && newest="$m"
  done < <(find packages/pipeline/dist -type f -print0 2>/dev/null)
  echo "$newest"
}

SRC_COMMIT_EPOCH="$(git log -1 --format=%ct -- packages/pipeline/src packages/agents/src 2>/dev/null || true)"
if [ -z "$SRC_COMMIT_EPOCH" ] || [ ! -d packages/pipeline/dist ]; then
  echo "preflight: skipping stale-dist check (no git history for src/, or dist/ not built yet)"
elif [ "$(dist_mtime_epoch)" -lt "$SRC_COMMIT_EPOCH" ]; then
  echo "preflight: packages/pipeline/dist looks STALE — a commit touching packages/{pipeline,agents}/src is newer than the built dist/. A running worker would keep executing the old workflow/activity code with no other indication anything's wrong." >&2
  REBUILD_REPLY="n"
  if [ -t 0 ]; then
    read -r -p "preflight: rebuild (pnpm -r build) and restart the worker now? [y/N] " REBUILD_REPLY || true
  else
    echo "preflight: not an interactive terminal — skipping the rebuild offer; re-run interactively or run \`pnpm -r build\` yourself" >&2
  fi
  if [[ "$REBUILD_REPLY" =~ ^[Yy]$ ]]; then
    pnpm -r build
    if worker_running; then
      OLD_PID="$(cat "$WORKER_PID_FILE")"
      echo "preflight: stopping worker (pid $OLD_PID) so the restart below picks up the rebuild"
      kill "$OLD_PID" 2>/dev/null || true
      rm -f "$WORKER_PID_FILE"
    fi
  else
    echo "preflight: continuing with the possibly-stale dist/ — see README's \"new semantics after a rebuild\" note" >&2
  fi
else
  echo "preflight: packages/pipeline/dist is up to date with src/"
fi

echo "== 6/8: pipeline worker =="

if worker_running; then
  # Our own tracked worker is up — this is the steady-state idempotent case
  # (spec 0005 acceptance: re-running preflight is a no-op), NOT "starting a
  # second worker", so it doesn't need --force.
  echo "preflight: worker already running (pid $(cat "$WORKER_PID_FILE"))"
else
  OTHER_PIDS="$(other_worker_pids)"
  if [ -n "$OTHER_PIDS" ] && [ "$FORCE" -ne 1 ]; then
    echo "preflight: refusing to start — found worker process(es) not tracked by our pidfile (pid(s): $OTHER_PIDS matching $WORKER_ENTRYPOINT). This is the mixed-version-worker class that broke spec 0007's merge: two workers polling the same queue, one stale. Investigate/kill the stray process(es) yourself, or pass --force to start anyway." >&2
    exit 1
  fi
  if [ -n "$OTHER_PIDS" ]; then
    echo "preflight: --force set — starting another worker despite untracked pid(s) already matching $WORKER_ENTRYPOINT ($OTHER_PIDS). You now have multiple workers on the same queue; that's on you." >&2
  fi
  echo "preflight: starting worker (repo: $LAUNCHPAD_REPO_ROOT, log: $WORKER_LOG_FILE)"
  nohup node "$WORKER_ENTRYPOINT" >>"$WORKER_LOG_FILE" 2>&1 &
  WORKER_PID=$!
  echo "$WORKER_PID" > "$WORKER_PID_FILE"
  sleep 1
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo "preflight: worker failed to start — see $WORKER_LOG_FILE" >&2
    exit 1
  fi
  echo "preflight: worker started (pid $WORKER_PID)"
fi

echo "== 7/8: web app (next dev) =="

ensure_web_deps  # before the next existence check below, so a fresh dep from
                 # a merge installs instead of hard-failing here (spec 0023 belt)
if [ ! -x "$WEB_APP_DIR/node_modules/.bin/next" ]; then
  echo "preflight: apps/web/node_modules/.bin/next not found — run \`pnpm install\` first" >&2
  exit 1
fi

# Polls WEB_HEALTH_URL until it answers 200 (env-check passing — see
# apps/web/lib/health.ts) or the attempt budget is exhausted. Reads the body
# to warn on a degraded Temporal connection, but per spec 0018 item 6 that
# NEVER changes the HTTP status this polls on — `checks.temporal:false` is a
# warning, not a reason to keep waiting or to fail this step.
poll_web_health() {
  local attempts=0 max_attempts=60 status body
  until [ "$attempts" -ge "$max_attempts" ]; do
    status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$WEB_HEALTH_URL" 2>/dev/null || echo 000)"
    if [ "$status" = "200" ]; then
      body="$(curl -s --max-time 2 "$WEB_HEALTH_URL" 2>/dev/null || true)"
      echo "preflight: web healthy — $WEB_HEALTH_URL -> $body"
      if echo "$body" | grep -q '"temporal":false'; then
        echo "preflight: WARNING — web reports degraded Temporal connectivity (checks.temporal=false); gate actions from apps/web may fail until Temporal is reachable" >&2
      fi
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

# Spec 0123: never start `next dev` on a PRODUCTION `.next`.
#
# `next build` (run for a pixel check, a bundling verification, anything) leaves
# production output in apps/web/.next. Starting the dev server on top of it serves
# chunks the production manifest does not describe, so a route that pulls in a heavy
# dependency 500s — `/projects/platform` did, with "Cannot find module
# './vendor-chunks/@temporalio+proto...'" — while lighter routes look fine, which is
# what makes it confusing rather than obvious.
#
# Third instance of the same class in this repo: dist/ outliving deleted tests (spec
# 0083), .next/types outliving a deleted route (0122), and this. Step 5 above already
# guards packages/*/dist; apps/web/.next never had the equivalent.
#
# Keyed on BUILD_ID / required-server-files.json, which are the ONLY build-only
# markers — measured, because `next dev` also writes prerender-manifest.json and
# routes-manifest.json, so a guard keyed on either would wipe the dev cache on every
# run and become the problem it was meant to prevent.
#
# Removes rather than asking (unlike step 5's rebuild offer): `.next` is disposable
# build output that `next dev` regenerates on demand, and there is no case where
# serving production chunks from a dev server is what anyone wanted.
NEXT_DIR="$WEB_APP_DIR/.next"
next_is_production() {
  [ -e "$NEXT_DIR/BUILD_ID" ] || [ -e "$NEXT_DIR/required-server-files.json" ]
}

if web_running; then
  # Spec 0123, corrected: do NOT remove .next while a dev server is live. An earlier
  # version of this guard did, and the running server 500d with `ENOENT:
  # routes-manifest.json` — deleting a directory out from under the process reading it
  # is a worse failure than the one being prevented. Warn instead; the operator (or
  # `preflight restart`) restarts it.
  if next_is_production; then
    echo "preflight: WARNING — apps/web/.next holds a PRODUCTION build while the dev server is RUNNING, so it may serve mismatched vendor chunks. Stop web (kill the pids in .preflight/) and re-run preflight to clear it (spec 0123)." >&2
  fi
  echo "preflight: web already running (pid $(cat "$WEB_PID_FILE"))"
elif web_supervisor_running; then
  echo "preflight: web supervisor already active (pid $(cat "$WEB_SUPERVISOR_PID_FILE")) but web is currently down between restart attempts — see $WEB_SUPERVISOR_LOG_FILE"
else
  if [ -f "$WEB_GIVEUP_FILE" ]; then
    echo "preflight: previous web supervisor had given up ($(cat "$WEB_GIVEUP_FILE")) — starting a fresh supervisor now"
  fi
  # Only here — about to START the server — is removing .next safe (spec 0123).
  if next_is_production; then
    echo "preflight: apps/web/.next holds a PRODUCTION build (next build was run here) — removing it so next dev does not serve mismatched vendor chunks (spec 0123)"
    rm -rf "$NEXT_DIR"
  fi
  echo "preflight: starting web (next dev, supervised with auto-restart) on ${WEB_HOST}:${WEB_PORT} (repo: $LAUNCHPAD_REPO_ROOT, log: $WEB_LOG_FILE, supervisor log: $WEB_SUPERVISOR_LOG_FILE)"
  if [ "$WEB_HOST" != "127.0.0.1" ] && [ "$WEB_HOST" != "localhost" ]; then
    echo "preflight: WARNING — WEB_HOST=$WEB_HOST exposes the dev server beyond loopback (spec 0087)" >&2
  fi
  nohup "$0" __web-supervisor >>"$WEB_SUPERVISOR_LOG_FILE" 2>&1 &
  disown
fi

echo "preflight: polling $WEB_HEALTH_URL until ready..."
if ! poll_web_health; then
  echo "preflight: web did not become healthy within the poll window — see $WEB_LOG_FILE / $WEB_SUPERVISOR_LOG_FILE" >&2
  exit 1
fi

echo "== 8/8: warm Temporal test-server binary cache =="
# Idempotent (spec 0010 item 4): node scripts/warm-temporal-test-server.mjs
# itself does the createTimeSkipping() + teardown() round trip and is a fast
# no-op once the binary is cached — no separate "is it cached" check needed
# here, the script's own idempotency covers it.
node "$REPO_ROOT/scripts/warm-temporal-test-server.mjs"

echo "preflight: all checks passed — ready to drive the pipeline from apps/web"
