#!/usr/bin/env bash
# run-watch.sh — SUPERVISOR TOOLING (spec 0201).
#
# Answers ONE question about a production run: **why is it not finished yet?**
# It always distinguishes the three cases, and never just says "waiting":
#
#   PARKED   a gate is open — nobody is working, a human must click. This is the
#            state that cost 52 minutes on 2026-08-13: I polled for an agent
#            session that could not start because gate 1 was unpressed, and the
#            poll had no way to say so.
#   WORKING  an agent session is in flight (role + how long).
#   STALLED  neither — no gate open and no live session. Investigate.
#
# scripts/gate-watch.mjs does this for a LOCAL dev run; it connects to
# localhost:7233 and cannot be used here, because production Temporal is
# deliberately not exposed off-box. This reads the control-plane DB over ssh,
# which is the same data the UI shows.
#
# Usage:
#   scripts/run-watch.sh cafeteria-0005            # one status line, exit
#   scripts/run-watch.sh cafeteria-0005 --watch    # poll until the state CHANGES
#   scripts/run-watch.sh 0142                      # platform run (spec-0142)
#
# Exits 0 when it prints a state, 3 when --watch sees an actionable change
# (gate opened / run finished / stalled), 1 on an error. Env: DEPLOY_HOST,
# DEPLOY_KEY, DEPLOY_USER, DB_CONTAINER, POLL_SECONDS, STALL_SECONDS.
set -euo pipefail

HOST="${DEPLOY_HOST:-203.0.113.10}"
USER_="${DEPLOY_USER:-root}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/fleet_key}"
DB="${DB_CONTAINER:-launchpad-launchpad-db-1}"
POLL="${POLL_SECONDS:-30}"
STALL="${STALL_SECONDS:-420}"   # no gate + no live session for 7 min = say so

WATCH=0
ARG=""
for a in "$@"; do
  case "$a" in
    --watch) WATCH=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) ARG="$a" ;;
  esac
done

# Same id rule as gate-watch: prepend `spec-` when absent, never strip a prefix.
# The spec id is the LAST segment (docs/VERIFICATION.md #11).
[[ -n "$ARG" && "$ARG" =~ ^[a-zA-Z0-9-]+$ ]] || {
  echo "usage: scripts/run-watch.sh <spec> [--watch]   e.g. cafeteria-0005 | 0142" >&2; exit 1; }
WF="$ARG"; [[ "$WF" == spec-* ]] || WF="spec-${WF}"

GATES="awaiting_spec_approval awaiting_pr_approval awaiting_promotion"
TERMINAL="promoted rejected failed staged"

# One ssh round trip: run row, then the newest session row.
snapshot() {
  ssh -o ConnectTimeout=15 -o BatchMode=yes -i "$KEY" "${USER_}@${HOST}" \
    "docker exec -i ${DB} psql -U launchpad -d launchpad -tA" <<SQL
select 'RUN|'||status||'|'||phase||'|'||(extract(epoch from now()-started_at)::int)
  from agent_runs where workflow_id='${WF}' order by started_at desc limit 1;
select 'SES|'||role||'|'||(extract(epoch from now()-started_at)::int)
       ||'|'||(case when finished_at is null then 'live' else 'done' end)
       ||'|'||coalesce(turns::text,'?')
  from agent_sessions where workflow_id='${WF}' order by started_at desc limit 1;
SQL
}

# Prints the state and returns 0 while the run is merely working, 3 when the
# state is actionable (gate open, terminal, or stalled).
report() {
  local snap run ses status phase age srole sage slive sturns
  snap="$(snapshot)" || { echo "cannot reach ${HOST}"; return 1; }
  run="$(printf '%s\n' "$snap" | grep '^RUN|' || true)"
  ses="$(printf '%s\n' "$snap" | grep '^SES|' || true)"

  if [[ -z "$run" ]]; then
    printf '%s  NO RUN ROW for %s — it was never started, or the id is wrong.\n' "$(date +%H:%M:%S)" "$WF"
    return 3
  fi

  IFS='|' read -r _ status phase age <<<"$run"
  IFS='|' read -r _ srole sage slive sturns <<<"${ses:-SES|||}"
  CUR_PHASE="$phase"

  local mins=$((age / 60))
  local head
  head="$(printf '%s  %s  %s/%s  %sm' "$(date +%H:%M:%S)" "$WF" "$status" "$phase" "$mins")"

  if [[ " $TERMINAL " == *" $phase "* ]]; then
    printf '%s  → FINISHED (%s)\n' "$head" "$phase"; return 3
  fi
  if [[ " $GATES " == *" $phase "* ]]; then
    printf '%s\n   → PARKED at %s. Nothing is running; a human must click.\n' "$head" "$phase"; return 3
  fi
  # `agent_sessions` rows are INSERTED WHEN A SESSION FINISHES — there is never a
  # row with finished_at IS NULL (verified: 0 of 15 on 2026-08-14). So liveness
  # cannot come from the session table; it comes from the run's own status, and
  # the newest session row is the last COMPLETED step, not the current one.
  # The first version of this script got that wrong and cried STALLED at a
  # perfectly healthy coder session (spec 0201; docs/VERIFICATION.md #14).
  if [[ "$status" == "running" ]]; then
    printf '%s  → WORKING (%s); last completed: %s%s\n' "$head" "$phase" "${srole:-none}" \
      "$([[ -n "$sturns" && "$sturns" != "?" ]] && printf ' %s turns' "$sturns")"
    return 0
  fi
  printf '%s  → status %s, phase %s — not running and no gate open. Investigate.\n' "$head" "$status" "$phase"
  return 3
}

if [[ $WATCH -eq 0 ]]; then
  report; exit $?
fi

# --watch: poll until something actionable happens. Every line says WHY it is
# still waiting, so a silent wait is impossible by construction.
prev_phase=""; same=0
while true; do
  CUR_PHASE=""
  rc=0; report || rc=$?
  [[ $rc -eq 1 ]] && exit 1
  [[ $rc -eq 3 ]] && exit 3
  # The only stall signal available: the phase has not moved. Say how long it has
  # not moved and let the reader judge — never assert "stalled" from a session
  # table that cannot show work in flight.
  if [[ -n "$CUR_PHASE" && "$CUR_PHASE" == "$prev_phase" ]]; then
    same=$((same + 1))
    if (( same * POLL >= STALL )); then
      printf '   note: still in "%s" after %sm — long step, or stuck. Check for a live agent process.\n' \
        "$CUR_PHASE" "$(( same * POLL / 60 ))"
    fi
  else
    same=0
  fi
  prev_phase="$CUR_PHASE"
  sleep "$POLL"
done
