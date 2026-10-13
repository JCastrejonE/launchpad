#!/usr/bin/env bash
# deploy-here.sh — deploy the control plane FROM the box it runs on (spec 0213 D).
#
# Sibling of deploy-control-plane.sh, not a replacement. That one is a PUSH: it
# cuts a bundle from a developer's laptop and ships it. This one is a PULL, run
# on the box by the Desplegar button, so it fetches from origin instead.
#
# Runs as the SERVICE USER, never root. Everything except the restart is
# unprivileged, which is what keeps root out of /srv/launchpad/repo and stops
# spec 0210's ownership fault from recurring by construction. The two restarts
# come from /etc/sudoers.d/launchpad-deploy, which grants exactly those two
# commands and nothing else.
#
# Usage:  deploy-here.sh <commit-sha> [projectSlug version deployedBy]
#
# When the release triple is given, the OUTCOME is written to the release row at
# the end -- from evidence (the stamp and the health check both passed), never
# from intent. A failure records itself too: knowing 1.4.2 failed is worth as
# much as knowing 1.4.1 is live.
set -euo pipefail

REPO="${LAUNCHPAD_REPO_ROOT:-/srv/launchpad/repo}"
HEALTH_URL="${HEALTH_URL:-https://launchpad.example.com/api/health}"
UNITS=(launchpad-web launchpad-worker)
# Parameters arrive either on the command line (a human at a terminal) or from
# the request file (the button). The file exists because the grant that launches
# this in its own systemd unit must name an EXACT command with no arguments.
REQUEST="${LAUNCHPAD_DEPLOY_REQUEST:-/tmp/launchpad-deploy-request}"
if [[ $# -eq 0 ]]; then
  # Spec 0219 B: CLAIM the request by renaming it before reading. rename(2) is
  # atomic, so two deploys that raced to write this path cannot read each
  # other's parameters — the loser finds no file and refuses here rather than
  # deploying someone else's commit under its own release row. The claim also
  # names the holder while the deploy runs (`deployInFlight` reads it).
  if mv "$REQUEST" "$REQUEST.inflight" 2>/dev/null; then
    # shellcheck disable=SC2046
    set -- $(head -1 "$REQUEST.inflight")
  else
    die "no deploy request to claim at $REQUEST (another deploy took it, or none was written)"
  fi
fi
SHA="${1:-}"
SLUG="${2:-}"; VERSION="${3:-}"; ACTOR="${4:-}"

# Record a failure wherever we exit non-zero, so a deploy that dies at the build
# does not leave the row saying "candidate" forever.
mark() { [[ -n "$SLUG" && -n "$VERSION" && -n "$ACTOR" ]] || return 0; node "$REPO/scripts/mark-release-deployed.mjs" "$SLUG" "$VERSION" "$ACTOR" "$1" "${2:-}" || true; }
trap '[[ $? -eq 0 ]] || mark failed' EXIT

step() { printf '\n== %s\n' "$*"; }
die()  { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

[[ -n "$SHA" ]] || die "usage: deploy-here.sh <commit-sha>"
cd "$REPO"

step "Fetching origin"
git fetch --quiet origin

# The button may only ship something that is ON main. Without this, a crafted
# request could deploy any object in the repo — a branch tip, an old commit, a
# commit from an unmerged PR.
git merge-base --is-ancestor "$SHA" origin/main \
  || die "$SHA is not an ancestor of origin/main — refusing to deploy it"

# Three activities commit to the box's own main and NONE of them push:
# commitDraftIfUncommitted, repairHandoffOnlyDirt and markSpec. `reset --hard`
# below would discard that work without a word, and for a chat-drafted spec the
# box is the only place it exists — so refusing is right and stays.
#
# Spec 0221: what was missing is a route OFF the box. If every one of those
# commits touches only `specs/*.md`, rebase them onto origin/main and push. A
# plain push can never fast-forward here — origin has moved by definition, since
# this deploy exists to ship a newer commit — so the rebase is the mechanism,
# and it republishes nothing: those commits were never on origin.
UNPUSHED="$(git rev-list --count origin/main..HEAD)"
if [[ "$UNPUSHED" != "0" ]]; then
  printf '\n== The box holds %s commit(s) origin does not have:\n%s\n' \
    "$UNPUSHED" "$(git --no-pager log --oneline origin/main..HEAD)"

  # Spec 0221 decision 3: code must never ride along. Pushing an unreviewed
  # commit to the trunk is worse than the refusal it would replace. The rule is
  # its own script so it can be tested — see box-divergence.test.ts.
  if ! OFFENDING="$(git diff --name-only origin/main...HEAD | "$REPO/scripts/box-divergence-safe.sh")"; then
    die "the box holds ${UNPUSHED} commit(s) origin does not have, and they are not spec files:
${OFFENDING}
Push or discard them by hand first:
$(git --no-pager log --oneline origin/main..HEAD)"
  fi

  step "Rescuing ${UNPUSHED} spec commit(s) onto origin/main"
  if ! git rebase --quiet origin/main; then
    git rebase --abort || true
    die "the box's ${UNPUSHED} spec commit(s) do not rebase cleanly onto origin/main.
A deploy script is not where a merge conflict gets decided — resolve it by hand:
$(git --no-pager log --oneline origin/main..HEAD)"
  fi
  git push --quiet origin HEAD:main \
    || die "rebased the box's spec commit(s) but could not push them to origin/main.
They are safe on the box at $(git rev-parse --short HEAD); nothing was discarded."
  # Say what happened. A deploy that silently rewrites the box's branch and ships
  # is worse than one that refuses — this has to be readable in the journal after.
  printf '== Pushed to origin/main: %s\n' "$(git rev-parse --short HEAD)"
  git fetch --quiet origin main
fi

step "Checking out ${SHA:0:8}"
git reset --hard --quiet "$SHA"
test "$(git rev-parse HEAD)" = "$SHA" || die "reset did not land on $SHA"

step "Installing"
# --prod=false is load-bearing, not belt-and-braces. This script is spawned BY
# the web process and inherits its environment, where NODE_ENV=production —
# so pnpm skips devDependencies, `typescript` is one of them, and the build has
# no compiler. The install still exits 0: it did exactly what it was asked.
#   devDependencies: skipped because NODE_ENV is set to production
# deploy-control-plane.sh never hit this because it runs over ssh WITHOUT the
# env file, so NODE_ENV is unset there. Same command, two environments, two
# different installs.
#
# The purge flag and the assertion below are spec 0213 E1: an install that hits
# the interactive prompt exits 0 having done nothing, so the exit code is not
# the check — the binary is.
CI=true pnpm install --frozen-lockfile --prod=false --config.confirmModulesPurge=false
test -x packages/agents/node_modules/.bin/tsc \
  || die "install exited 0 but produced no tsc"

step "Building"
rm -rf packages/*/dist
pnpm -r build
# The stamp is what makes "is the box serving this commit?" answerable. HEAD is
# the checkout; this is the artifact (spec 0213 E2).
echo "$SHA" > apps/web/.next/BUILD_COMMIT

step "Restarting"
for u in "${UNITS[@]}"; do
  sudo -n /usr/bin/systemctl restart "${u}.service" || die "could not restart ${u}"
done

step "Verifying"
sleep 8
for u in "${UNITS[@]}"; do
  [[ "$(systemctl is-active "$u")" == "active" ]] || die "${u} is not active after restart"
done
built="$(cat apps/web/.next/BUILD_COMMIT 2>/dev/null || true)"
[[ "$built" == "$SHA" ]] || die "built artifact is ${built:-none}, expected ${SHA}"
code="$(curl -fsS -m 20 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
[[ "$code" == "200" ]] || die "${HEALTH_URL} answered ${code:-nothing}"

mark ok "$SHA"
printf '\nDEPLOYED %s\n' "$SHA"
