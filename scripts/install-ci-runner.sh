#!/usr/bin/env bash
#
# install-ci-runner.sh — a self-hosted GitHub Actions runner for the gate
# (spec 0227 C).
#
# WHY self-hosted: the owner's constraint is zero Actions minutes on a private repo.
# WHY a runner and not Jenkins: `getCommitChecksConclusion` reads `actions/runs`
# (packages/github/src/client.ts:113), so a self-hosted runner feeds the promote
# gate with no integration at all, while Jenkins reports through the Status API
# that reader does not look at — and we already have Temporal for orchestration,
# which is what Jenkins would otherwise be for.
#
# WHERE: the sandbox box, VPS 100001 — the only id in infra/fleet-sandbox.json,
# so automated SSH here is sanctioned by ADR-013. Deliberately NOT the control
# plane: that box holds /etc/launchpad/launchpad.env, the database and the deploy
# keys, and it has half the cores.
#
# WHAT ISOLATION THIS BUYS, precisely — the same honesty as
# packages/agents/src/supervisor-tool-policy.ts, which says out loud that it is
# not a sandbox:
#
#   IT DOES:  run each job's code inside an ephemeral container on a dedicated
#             docker network that CANNOT route to the control plane. Job code
#             never touches the host filesystem and cannot reach the database,
#             the secrets file or the deploy keys.
#   IT DOES NOT: prevent the RUNNER PROCESS from escalating. The runner user is
#             in the `docker` group, which on any Linux host is root-equivalent.
#             That is the standard runner setup and the practical choice; it is
#             not a claim of containment for a determined adversary with commit
#             access. The upgrade is rootless docker for this user — deferred
#             because it breaks `container:` jobs in ways worth a spec of their
#             own. TRIGGER: the first connected customer repo with contributors
#             outside the company.
#
# Idempotent: every step is check-then-act, so a re-run is a no-op.
#
# Usage:
#   scripts/install-ci-runner.sh                prepare everything but register
#   scripts/install-ci-runner.sh --verify-only  assert the END STATE only
#
# Registration is deliberately NOT automated: it needs a GitHub runner
# registration token, and this script never handles credentials. The last step
# prints the exact command for a human to run.
set -euo pipefail

HOST="${CI_RUNNER_HOST:-203.0.113.20}"
KEY="${CI_RUNNER_KEY:-$HOME/.ssh/fleet_key}"
RUNNER_USER="ghrunner"
RUNNER_DIR="/opt/actions-runner"
CI_NET="ci-isolated"
# 10.200.N.0/24 is the fleet's allocation pattern (in use up to .17 today), so
# staying off it keeps a future tenant from colliding with CI.
CI_SUBNET="10.201.0.0/24"
CONTROL_PLANE="${CONTROL_PLANE_IP:-203.0.113.10}"
REPO_URL="https://github.com/example-org/launchpad"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '   \033[31mFAIL\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

SSH=(ssh -o ConnectTimeout=15 -o BatchMode=yes -i "$KEY" "root@${HOST}")
# Return the COMMAND's status, never a pipe's (VERIFICATION #8).
remote() { "${SSH[@]}" "$1"; }

VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --verify-only) VERIFY_ONLY=1 ;;
    --) ;;
    *) die "unknown argument $arg" ;;
  esac
done

# ---------------------------------------------------------------------------
# End-state assertions. Separate from the install so a re-run can answer "is
# this box still correct?" without changing anything — and so the network claim
# is tested by ATTEMPTING the connection, not by reading the iptables rule
# (registry row 64: a guard is only proven by invoking it).
# ---------------------------------------------------------------------------
verify() {
  local failures=0
  say "Asserting end state on ${HOST}"

  remote "id -u ${RUNNER_USER} >/dev/null 2>&1" \
    && ok "user ${RUNNER_USER} exists" || { bad "user ${RUNNER_USER} missing"; failures=1; }

  remote "test -x ${RUNNER_DIR}/run.sh" \
    && ok "runner unpacked at ${RUNNER_DIR}" || { bad "runner not unpacked"; failures=1; }

  # Unpacked is not the same as runnable: the runner is .NET and needs libicu.
  remote "cd ${RUNNER_DIR} && sudo -u ${RUNNER_USER} ./config.sh --help >/dev/null 2>&1" \
    && ok "runner binary starts as ${RUNNER_USER}" \
    || { bad "runner binary does NOT start (missing .NET deps?)"; failures=1; }

  remote "docker network inspect ${CI_NET} >/dev/null 2>&1" \
    && ok "docker network ${CI_NET} exists" || { bad "network ${CI_NET} missing"; failures=1; }

  remote "iptables -C DOCKER-USER -s ${CI_SUBNET} -d ${CONTROL_PLANE} -j DROP 2>/dev/null" \
    && ok "DOCKER-USER drops ${CI_SUBNET} -> ${CONTROL_PLANE}" \
    || { bad "firewall rule absent"; failures=1; }

  # The two checks that matter, run from INSIDE a container on that network.
  # `curl` exits 7/28 when it cannot connect; 0 when it can. Asserting both
  # directions, because a rule that blocks everything would pass the first.
  say "Probing from inside a container on ${CI_NET}"
  if remote "docker run --rm --network ${CI_NET} curlimages/curl:latest -s -m 6 -o /dev/null https://registry.npmjs.org/ 2>/dev/null"; then
    ok "the internet IS reachable (pnpm install can work)"
  else
    bad "the internet is NOT reachable — the gate could never install deps"; failures=1
  fi
  if remote "docker run --rm --network ${CI_NET} curlimages/curl:latest -s -m 6 -o /dev/null http://${CONTROL_PLANE}/api/health 2>/dev/null"; then
    bad "the control plane IS reachable from a CI job — isolation is NOT in effect"; failures=1
  else
    ok "the control plane is NOT reachable from a CI job"
  fi

  local registered
  registered="$(remote "test -f ${RUNNER_DIR}/.runner && echo yes || echo no")"
  if [[ "$registered" == "yes" ]]; then
    ok "runner is registered"
    remote "systemctl is-active --quiet 'actions.runner.*'" \
      && ok "runner service is active" || { bad "runner registered but service not active"; failures=1; }
  else
    printf '   \033[33mpending\033[0m runner not registered yet — see the command below\n'
  fi

  # Registered + active + listening is NOT the same as "CI works". With Actions
  # disabled for the repo, GitHub creates no runs at all: the runner reports
  # "Connected to GitHub / Listening for Jobs" forever, this script went green on
  # every other assertion, and nothing anywhere said the system could not fire.
  # That cost a diagnosis on 2026-08-19. So report the only fact that settles it.
  local jobs
  jobs="$(remote "journalctl -u 'actions.runner.*' --no-pager 2>/dev/null | grep -cE 'Running job' || true")"
  if [[ "${jobs:-0}" -gt 0 ]]; then
    ok "this runner has executed ${jobs} job(s) — CI demonstrably fires"
  else
    printf '   \033[33munproven\033[0m the runner has never executed a job. Listening is not\n'
    printf '             running: check Settings -> Actions -> General is ENABLED,\n'
    printf '             then push and watch. A runner cannot tell you this.\n'
  fi

  [[ "$failures" -eq 0 ]] || die "END STATE WRONG — do not report CI as working."
  say "Verified"
}

if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  verify
  exit 0
fi

# ---------------------------------------------------------------------------
say "Preflight"
remote "test -x /usr/bin/docker || command -v docker >/dev/null" || die "docker missing on ${HOST}"
ok "docker present"
remote "iptables -S DOCKER-USER >/dev/null 2>&1" || die "DOCKER-USER chain missing — is this docker?"
ok "DOCKER-USER chain present (docker will not clobber rules here)"

say "Runner user"
if remote "id -u ${RUNNER_USER} >/dev/null 2>&1"; then
  ok "${RUNNER_USER} already exists"
else
  remote "useradd --system --create-home --home-dir ${RUNNER_DIR} --shell /bin/bash ${RUNNER_USER}"
  ok "created ${RUNNER_USER}"
fi
# Root-equivalent on the host. Stated in the header; stated again here because
# this is the line that does it.
remote "usermod -aG docker ${RUNNER_USER}"
ok "${RUNNER_USER} in the docker group (see the header: this is root-equivalent)"

say "Runner binary"
if remote "test -x ${RUNNER_DIR}/run.sh"; then
  ok "already unpacked"
else
  # Resolve the latest release rather than pinning a version that will rot.
  # Public endpoint, no auth.
  TAG="$(remote "curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | grep -m1 '\"tag_name\"' | sed -E 's/.*\"v?([^\"]+)\".*/\\1/'")"
  [[ -n "$TAG" ]] || die "could not resolve the latest runner release"
  ok "latest runner is ${TAG}"
  remote "cd ${RUNNER_DIR} && curl -fsSL -o runner.tar.gz https://github.com/actions/runner/releases/download/v${TAG}/actions-runner-linux-x64-${TAG}.tar.gz && tar xzf runner.tar.gz && rm runner.tar.gz && chown -R ${RUNNER_USER}:${RUNNER_USER} ${RUNNER_DIR}"
  remote "test -x ${RUNNER_DIR}/run.sh" || die "unpack did not produce run.sh"
  ok "unpacked ${TAG}"
  # `installdependencies.sh` probes several libicu versions and reports apt
  # errors for the ones this release does not carry — it exits 0 anyway. The
  # first version of this script printed "ok dependencies installed" off that
  # exit code, which was a label with nothing behind it (registry row 5). What
  # matters is whether the .NET runtime starts, so assert THAT.
  remote "${RUNNER_DIR}/bin/installdependencies.sh >/dev/null 2>&1" || true
  if remote "cd ${RUNNER_DIR} && sudo -u ${RUNNER_USER} ./config.sh --help >/dev/null 2>&1"; then
    ok "the runner binary starts (.NET runtime resolved)"
  else
    die "the runner cannot start — installdependencies.sh left something missing. Check libicu."
  fi
fi

say "Isolated network"
if remote "docker network inspect ${CI_NET} >/dev/null 2>&1"; then
  ok "${CI_NET} already exists"
else
  remote "docker network create --subnet ${CI_SUBNET} ${CI_NET}"
  ok "created ${CI_NET} (${CI_SUBNET})"
fi

say "Firewall: CI jobs cannot reach the control plane"
if remote "iptables -C DOCKER-USER -s ${CI_SUBNET} -d ${CONTROL_PLANE} -j DROP 2>/dev/null"; then
  ok "rule already present"
else
  remote "iptables -I DOCKER-USER -s ${CI_SUBNET} -d ${CONTROL_PLANE} -j DROP"
  ok "rule inserted"
fi
# Survive a reboot without pulling in netfilter-persistent: a oneshot unit that
# re-applies the single rule we care about, idempotently.
remote "cat > /etc/systemd/system/ci-net-isolation.service <<'UNIT'
[Unit]
Description=Drop CI-network traffic to the launchpad control plane (spec 0227)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C DOCKER-USER -s ${CI_SUBNET} -d ${CONTROL_PLANE} -j DROP 2>/dev/null || iptables -I DOCKER-USER -s ${CI_SUBNET} -d ${CONTROL_PLANE} -j DROP'

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now ci-net-isolation.service >/dev/null 2>&1"
ok "ci-net-isolation.service enabled (rule survives reboot)"

verify

# ---------------------------------------------------------------------------
say "One step left, and it is a human's"
cat <<TXT
   Registration needs a GitHub runner token. This script does not handle
   credentials, so it stops here.

   1. Open:  ${REPO_URL}/settings/actions/runners/new
   2. Copy the token GitHub shows (it expires in ~1 hour).
   3. Run, replacing TOKEN:

      ssh -i ${KEY} root@${HOST} "cd ${RUNNER_DIR} && sudo -u ${RUNNER_USER} ./config.sh \\
        --url ${REPO_URL} --token TOKEN --name company-sandbox --labels self-hosted,linux,x64 \\
        --work _work --unattended --replace && ./svc.sh install ${RUNNER_USER} && ./svc.sh start"

   Then confirm with:

      scripts/install-ci-runner.sh --verify-only
TXT
