#!/usr/bin/env bash
# deploy-control-plane.sh — SUPERVISOR TOOLING (spec 0201).
#
# Deploys this checkout to the control plane (launchpad.example.com) and then
# ASSERTS THE END STATE. It exists because the procedure lived in one table row
# in PENDING.md and in the session's head, and was got wrong twice on 2026-08-13:
#
#   1. `git bundle` cut from a base commit the box did not have. The remote pull
#      errored; `systemctl restart` still reported `active`; the deploy was
#      reported done while the box kept running the old tree. Spec 0199's prompt
#      fix was "deployed" for an hour that way.
#   2. Same shape again an hour later.
#
# Both are structurally impossible here:
#   - the bundle base is READ FROM THE BOX (`git rev-parse HEAD`), never assumed;
#   - `git merge-base --is-ancestor` refuses when the box holds commits we lack;
#   - every remote step runs under `set -euo pipefail` and its exit status is
#     read from PIPESTATUS[0], never through the pipe (docs/VERIFICATION.md #8);
#   - the run ends by asserting the END STATE — the box's HEAD is the commit we
#     pushed, both units are active, /api/health answers 200 from off-box — not
#     by trusting that a restart command returned.
#
# Added 2026-08-17 (spec 0210): the tree is handed back to the service user, and
# the end state asserts THAT USER can still write it. Every check above is
# satisfied by a box the pipeline cannot commit on — root can write anything and
# health only reads — so two users' runs died on a reflog we had taken from them
# while HEAD, both units and /api/health stayed green.
#
# Usage:
#   scripts/deploy-control-plane.sh                # deploy HEAD, then verify
#   scripts/deploy-control-plane.sh --dry-run      # show the plan, touch nothing
#   scripts/deploy-control-plane.sh --verify-only  # assert the end state only
#   scripts/deploy-control-plane.sh --migrate      # required if drizzle/ changed
#   scripts/deploy-control-plane.sh --allow-dirty  # deploy with a dirty worktree
#
# Env overrides: DEPLOY_HOST, DEPLOY_USER, DEPLOY_KEY, DEPLOY_REPO, HEALTH_URL.
set -euo pipefail

HOST="${DEPLOY_HOST:-203.0.113.10}"
USER_="${DEPLOY_USER:-root}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/fleet_key}"
REPO="${DEPLOY_REPO:-/srv/launchpad/repo}"
HEALTH_URL="${HEALTH_URL:-https://launchpad.example.com/api/health}"
UNITS=(launchpad-web launchpad-worker)

DRY_RUN=0; VERIFY_ONLY=0; RUN_MIGRATE=0; ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --verify-only) VERIFY_ONLY=1 ;;
    --migrate) RUN_MIGRATE=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

SSH=(ssh -o ConnectTimeout=15 -o BatchMode=yes -i "$KEY" "${USER_}@${HOST}")
say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '   \033[31mFAIL\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# Run a command on the box and return ITS exit status (never a pipe's).
remote() { "${SSH[@]}" "$1"; }

# The identity the services actually run as — READ from the box, never assumed,
# for the same reason the bundle base is read from the box. We deploy as root
# into a tree the units run as someone else (spec 0210), so this is the user
# every ownership and writability question below is asked about.
SVC="" SVC_GROUP=""
service_identity() {
  [[ -n "$SVC" ]] && return 0
  SVC="$(remote "systemctl show ${UNITS[0]} -p User --value")" \
    || die "cannot read ${UNITS[0]}'s User= from ${HOST}"
  [[ -n "$SVC" ]] \
    || die "${UNITS[0]} reports no User= — refusing to guess who must own ${REPO}.
Set User= on the unit, or teach this script that this box runs its services as root."
  SVC_GROUP="$(remote "systemctl show ${UNITS[0]} -p Group --value")"
  [[ -n "$SVC_GROUP" ]] || SVC_GROUP="$SVC"
}

# ---------------------------------------------------------------- end state --
# The only function that decides whether a deploy worked. Asserts facts about
# the box, not the fact that we sent it instructions.
verify_end_state() {
  local want="$1" failures=0 got

  got="$(remote "git -C ${REPO} rev-parse HEAD")" || die "cannot read HEAD on ${HOST}"
  if [[ "$got" == "$want" ]]; then ok "HEAD is ${want:0:8}"
  else bad "HEAD is ${got:0:8}, expected ${want:0:8} — the box is NOT running this commit"; failures=1; fi

  # Spec 0213 E2: what is actually BUILT, which is what the units serve. HEAD is
  # the checkout; this is the artifact. They diverge exactly when a deploy fails
  # between `git merge` and `pnpm -r build` — the case that reported healthy.
  local built
  built="$(remote "cat ${REPO}/apps/web/.next/BUILD_COMMIT 2>/dev/null || true")"
  if [[ -z "$built" ]]; then
    printf '   note no BUILD_COMMIT stamp yet (first deploy since spec 0213 E2)\n'
  elif [[ "$built" == "$want" ]]; then ok "built artifact is ${want:0:8}"
  else bad "built artifact is ${built:0:8}, expected ${want:0:8} — the box has the commit but is SERVING an older build"; failures=1; fi

  local unit state
  for unit in "${UNITS[@]}"; do
    state="$(remote "systemctl is-active ${unit} || true")"
    if [[ "$state" == "active" ]]; then ok "${unit} ${state}"
    else bad "${unit} ${state}"; failures=1; fi
  done

  # Off-box, so it proves what a user gets rather than what the box thinks.
  local code
  code="$(curl -fsS -m 20 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
  if [[ "$code" == "200" ]]; then ok "${HEALTH_URL} → 200"
  else bad "${HEALTH_URL} → ${code:-no response}"; failures=1; fi

  # A unit can be 'active' while its last start failed and it is mid-restart.
  local since
  for unit in "${UNITS[@]}"; do
    since="$(remote "systemctl show ${unit} -p NRestarts --value || true")"
    [[ -n "$since" && "$since" != "0" ]] && printf '   note %s has restarted %s time(s) since boot\n' "$unit" "$since"
  done

  # Can the harness still write? (spec 0210.) Every check above is satisfied by
  # a box the pipeline cannot commit on: root can write anything and the health
  # check only reads, so on 2026-08-17 HEAD/active/200 were all green while two
  # users' runs died on `unable to append to '.git/logs/HEAD': Permission denied`.
  #
  # Assert WRITABILITY BY THE SERVICE USER, not ownership. Git replaces nearly
  # everything via <file>.lock + rename(), which needs the DIRECTORY and not the
  # file — so a root-owned tree stages a spec perfectly and then cannot commit
  # it. The reflog is the one thing git APPENDS to in place. That asymmetry is
  # why weeks of root-owned files caused nothing until a platform run tried to
  # commit, and it is why the fatal list is the append-in-place paths plus the
  # two directories the harness creates files in.
  service_identity
  local p
  for p in ".git/logs/HEAD" ".git/logs/refs/heads/main" ".git" "specs"; do
    remote "test -e ${REPO}/${p}" || continue   # not every checkout has every path
    if remote "sudo -u ${SVC} test -w ${REPO}/${p}"; then
      ok "${SVC} can write ${p}"
    else
      bad "${SVC} CANNOT write ${p} — the harness cannot commit on this box"
      failures=1
    fi
  done

  # Ownership predicts the failure without being it, so it is a note: a
  # root-owned file that stays writable is harmless, and a check that reddens
  # for something harmless gets trained away. Any root `git` here — `git status`
  # rewrites the index — puts paths in this count.
  local strays
  strays="$(remote "find ${REPO} ! -user ${SVC} 2>/dev/null | wc -l" || echo 0)"
  [[ -n "$strays" && "$strays" != "0" ]] \
    && printf '   note %s path(s) under %s are not owned by %s — a root command has touched this tree\n' \
       "$strays" "$REPO" "$SVC"

  return $failures
}

# ------------------------------------------------------------------- verify --
LOCAL_HEAD="$(git rev-parse HEAD)"

if [[ $VERIFY_ONLY -eq 1 ]]; then
  say "Verifying end state on ${HOST}"
  verify_end_state "$LOCAL_HEAD" || die "END STATE NOT MET — the box is not running ${LOCAL_HEAD:0:8}"
  say "Verified: ${HOST} is running ${LOCAL_HEAD:0:8} and answering."
  exit 0
fi

# ------------------------------------------------------------------ preflight --
say "Preflight"
if [[ $ALLOW_DIRTY -eq 0 ]] && ! git diff-index --quiet HEAD --; then
  die "worktree is dirty — commit first, or pass --allow-dirty (the bundle only ships COMMITS)"
fi
ok "worktree clean"

BOX_HEAD="$(remote "git -C ${REPO} rev-parse HEAD")" || die "cannot reach ${HOST} or read ${REPO}"
BOX_BRANCH="$(remote "git -C ${REPO} rev-parse --abbrev-ref HEAD")"
ok "box at ${BOX_HEAD:0:8} on ${BOX_BRANCH}"
ok "local at ${LOCAL_HEAD:0:8}"
service_identity
ok "services run as ${SVC}:${SVC_GROUP} — the tree will be handed back to them"

if [[ "$BOX_HEAD" == "$LOCAL_HEAD" ]]; then
  say "Box already at ${LOCAL_HEAD:0:8} — nothing to ship. Verifying it is healthy."
  verify_end_state "$LOCAL_HEAD" || die "box is at the right commit but NOT healthy"
  exit 0
fi

# The box writes to its own tree: the harness commits spec files during a run
# (a drafted spec, a `status -> promoted` roll-up) and never pushes them. Spec
# 0221 taught `deploy-here.sh` to rescue exactly that, and this script — the one
# you run from a laptop — only refused and handed the job back. Doing it by hand
# three times is how you learn to put it in the script (VERIFICATION #14).
#
# The rescue is deliberately narrow: SPEC FILES ONLY, judged by the same
# `box-divergence-safe.sh` deploy-here.sh uses, and it MERGES rather than rebases
# so `origin` can fast-forward instead of needing a force-push. And it pushes —
# a rescue that commits without pushing recreates the divergence it just fixed,
# which is registry rows 12 and 13.
rescue_box_divergence() {
  say "Box is ahead — checking whether it is only spec files"
  # git does not know about $KEY — `remote()` passes `-i` to ssh itself, and a
  # fetch needs GIT_SSH_COMMAND. The first version omitted it AND sent stderr to
  # /dev/null, so the rescue died reporting "cannot fetch" while hiding the
  # actual reason. Never hide the diagnostic from the failure path.
  GIT_SSH_COMMAND="ssh -o ConnectTimeout=15 -o BatchMode=yes -i ${KEY}" \
    git fetch -q "${USER_}@${HOST}:${REPO}" main \
    || die "box is ahead and I cannot fetch from it to see what it has (see the error above)"
  local boxref; boxref="$(git rev-parse FETCH_HEAD)"

  local offending
  if ! offending="$(git diff --name-only "${LOCAL_HEAD}...${boxref}" | "$(dirname "$0")/box-divergence-safe.sh")"; then
    die "the box holds commits that are NOT spec files:
${offending}
Reconcile by hand — this script will not merge product code it did not gate."
  fi
  printf '   the box has %s spec-only commit(s):\n' "$(git rev-list --count "${LOCAL_HEAD}..${boxref}")"
  git log --oneline "${LOCAL_HEAD}..${boxref}" | sed 's/^/     /'

  git merge --no-edit -q "$boxref" || die "the box's spec commits do not merge cleanly — reconcile by hand"
  # Only specs changed, so check only specs. Scoping the check to what changed is
  # the same correction lint-specs itself needed.
  scripts/lint-specs.mjs || die "the box's spec commits introduce structure violations"
  git push -q origin HEAD:main || die "merged the box's commits but could not push — do NOT leave it here"
  LOCAL_HEAD="$(git rev-parse HEAD)"
  ok "rescued and pushed; now shipping ${LOCAL_HEAD:0:8}"
}

# The check that would have caught both failures: we can only ship commits that
# build on what the box actually has.
if ! git cat-file -e "${BOX_HEAD}^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$BOX_HEAD" "$LOCAL_HEAD"; then
  rescue_box_divergence
fi
if ! git merge-base --is-ancestor "$BOX_HEAD" "$LOCAL_HEAD"; then
  die "box HEAD ${BOX_HEAD:0:8} is still NOT an ancestor of ${LOCAL_HEAD:0:8} after the rescue — reconcile by hand."
fi
ok "box HEAD is an ancestor — bundle base is real"

COMMITS="$(git rev-list --count "${BOX_HEAD}..${LOCAL_HEAD}")"
say "Shipping ${COMMITS} commit(s)"
git --no-pager log --oneline "${BOX_HEAD}..${LOCAL_HEAD}" | sed 's/^/   /'

# Migrations are a schema change to production: named, never silent, never automatic.
MIGRATIONS="$(git diff --name-only "${BOX_HEAD}" "${LOCAL_HEAD}" -- packages/db/drizzle/ | grep -c '\.sql$' || true)"
if [[ "$MIGRATIONS" -gt 0 ]]; then
  if [[ $RUN_MIGRATE -eq 1 ]]; then
    printf '\n   %s new migration file(s); --migrate given, they will be applied\n' "$MIGRATIONS"
  else
    die "${MIGRATIONS} new migration file(s) in this range. Re-run with --migrate to apply them, or deploy an earlier commit."
  fi
fi

if [[ $DRY_RUN -eq 1 ]]; then
  say "--dry-run: nothing was changed on ${HOST}."
  exit 0
fi

# -------------------------------------------------------------------- ship --
BUNDLE="$(mktemp -t launchpad-deploy-XXXXXX).bundle"
trap 'rm -f "$BUNDLE"' EXIT

say "Bundling ${BOX_HEAD:0:8}..${LOCAL_HEAD:0:8}"
git bundle create "$BUNDLE" "${BOX_HEAD}..${LOCAL_HEAD}" HEAD
git bundle verify "$BUNDLE" >/dev/null || die "bundle failed its own verify"
ok "bundle $(du -h "$BUNDLE" | cut -f1) verified"

say "Transferring"
scp -q -o ConnectTimeout=15 -i "$KEY" "$BUNDLE" "${USER_}@${HOST}:/tmp/deploy.bundle" \
  || die "scp failed"
ok "on box at /tmp/deploy.bundle"

# `active` is not evidence that THIS deploy is running. On 2026-08-15 the remote
# aborted at the migration — before `systemctl restart` — and the end-state check
# passed anyway: HEAD on disk was the new commit, both units were `active`, health
# was 200, and the processes serving it were the OLD build. Record each unit's
# monotonic start stamp now and require it to move.
PRE_STAMPS=()
for u in "${UNITS[@]}"; do
  PRE_STAMPS+=("$(remote "systemctl show -p ActiveEnterTimestampMonotonic --value ${u}" || echo 0)")
done

say "Applying + building on ${HOST} (this takes a few minutes)"
LOG="$(mktemp -t launchpad-deploy-log-XXXXXX)"
# set -euo pipefail REMOTELY: an early failure must abort the rest, or a failed
# pull is followed by a successful restart and the box lies about being current.
# rm -rf packages/*/dist: building over an existing dist produced a bogus
# "not exported" failure (PENDING.md live-topology table).
# chown -R: every step above runs as root in a tree the units run as ${SVC}.
# Handing it back is the last thing before the restart, inside set -e, so a
# half-owned tree aborts the deploy instead of shipping (spec 0210).
"${SSH[@]}" "set -euo pipefail
  cd ${REPO}
  git fetch /tmp/deploy.bundle HEAD
  git merge --ff-only FETCH_HEAD
  test \"\$(git rev-parse HEAD)\" = '${LOCAL_HEAD}'
  # --config.confirmModulesPurge=false: on 2026-08-18 the install hit an
  # interactive purge prompt, EXITED 0 having installed nothing, and left every
  # per-package node_modules deleted; the build then died on tsc: not found.
  # An exit code that cannot fail is not a check (docs/VERIFICATION.md #2), so
  # the install is followed by an assertion on a binary it must have produced.
  # NOTE: no double quotes in this block -- it lives inside the remote command's
  # own double-quoted string.
  CI=true pnpm install --frozen-lockfile --config.confirmModulesPurge=false
  test -x packages/agents/node_modules/.bin/tsc || { echo 'install exited 0 but produced no tsc; refusing to build'; exit 1; }
  rm -rf packages/*/dist
  pnpm -r build
  # Spec 0213 E2: stamp the build with the commit it came from. HEAD is the
  # CHECKOUT's commit and says nothing about what was compiled -- on 2026-08-18 a
  # failed install left the box at the right commit, both units active and health
  # 200, serving a build from an hour earlier. A stamp written by the build step
  # is the only thing that can tell those apart.
  echo '${LOCAL_HEAD}' > apps/web/.next/BUILD_COMMIT
  $([[ $RUN_MIGRATE -eq 1 ]] && echo '(set -a; . /etc/launchpad/launchpad.env; set +a; pnpm --filter @launchpad/db migrate)' || echo 'true')
  chown -R ${SVC}:${SVC_GROUP} ${REPO}
  systemctl restart ${UNITS[*]}
  rm -f /tmp/deploy.bundle" 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}          # ssh's status, NOT tee's (docs/VERIFICATION.md #8)
if [[ $rc -ne 0 ]]; then
  printf '\n   remote steps exited %s; last lines:\n' "$rc"
  tail -20 "$LOG" | sed 's/^/   /'
  die "REMOTE DEPLOY FAILED (exit ${rc}) — full log: ${LOG}"
fi
ok "remote steps exited 0"

for i in "${!UNITS[@]}"; do
  u="${UNITS[$i]}"
  post="$(remote "systemctl show -p ActiveEnterTimestampMonotonic --value ${u}" || echo 0)"
  [[ "$post" != "${PRE_STAMPS[$i]}" ]] \
    || die "${u} did NOT restart — it is still the process from before this deploy"
done
ok "both units restarted into this deploy"

# Services need a moment to bind before the health check means anything.
sleep 8

# ------------------------------------------------------------------ assert --
say "Asserting end state"
if ! verify_end_state "$LOCAL_HEAD"; then
  die "DEPLOY NOT VERIFIED — remote steps returned 0 but the end state is wrong.
That combination is exactly the 2026-08-13 failure; do not report this as deployed."
fi

rm -f "$LOG"
# Record the deploy's outcome on a release row, IF a human named a version for
# this commit. Never invents one — the owner, 2026-08-12: automation does not pick a
# number the developer did not write. When no row names the commit it says so,
# because the silent version of this is how project_releases stopped at 1.0.13
# while the box went on being deployed, which made hard rule 9 (every defect
# names the release it was found on) impossible to satisfy for a week.
say "Release ledger"
service_identity
remote "systemd-run --quiet --wait --pipe --collect --uid=${SVC} \
  -p EnvironmentFile=/etc/launchpad/launchpad.env \
  -p WorkingDirectory=${REPO} \
  node ${REPO}/scripts/mark-release-for-commit.mjs platform ${LOCAL_HEAD} '${DEPLOY_ACTOR:-$(git config user.email 2>/dev/null || echo laptop)}' ${LOCAL_HEAD}" \
  || printf '   \033[33mnote\033[0m could not reach the release ledger — the deploy itself is fine\n'

say "Deployed and verified: ${HOST} is running ${LOCAL_HEAD:0:8}."
