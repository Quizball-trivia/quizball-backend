#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
FLEET="$SCRIPT_DIR/fleet.sh"
SSH_KEY_PATH="${HCLOUD_SSH_KEY_PATH:-$HOME/.ssh/quizball-staging-load}"
REPORT_ROOT="$SCRIPT_DIR/reports/${CAMPAIGN_ID:-quizball-staging-5k}"
SSH=(ssh -n -i "$SSH_KEY_PATH" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
SCP=(scp -i "$SSH_KEY_PATH" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  run-scenario.sh gameplay <players> <duration-sec> <total-http-rps> [ramp-sec]
  run-scenario.sh matchmaking <players> [join-timeout-sec]
  run-scenario.sh http <global-rps> <duration> [ramp-duration]
  run-scenario.sh auth-login <global-rps> <duration> [ramp-duration]

gameplay and matchmaking use the mixed fleet. auth-login uses every
mixed+auth worker so Supabase sees distributed source IPs. All commands source
only the staging environment installed by sync-env.ts.
EOF
}

positive_int() {
  [[ "${2:-}" =~ ^[0-9]+$ ]] && (( $2 > 0 )) || die "$1 must be a positive integer"
}

worker_ips() {
  local role="$1"
  "$FLEET" list "$role" | awk 'NF >= 3 { print $3 }'
}

require_worker_count() {
  local role="$1"
  local minimum="$2"
  local count
  count="$(worker_ips "$role" | wc -l | tr -d ' ')"
  (( count >= minimum )) || die "$role fleet has $count workers; need at least $minimum"
  printf '%s' "$count"
}

remote_prefix() {
  printf "cd /opt/quizball-load/app && test -f /opt/quizball-load/staging.env && set -a && source /opt/quizball-load/staging.env && set +a && test \"\$TARGET\" = staging && test \"\$API_BASE\" = https://api-staging.quizball.io && "
}

collect_one() {
  local ip="$1"
  local remote_report="$2"
  local local_report="$3"
  "${SCP[@]}" "root@$ip:$remote_report" "$local_report"
}

run_gameplay() {
  local players="$1"
  local duration="$2"
  local total_rps="$3"
  local ramp="${4:-60}"
  positive_int players "$players"
  positive_int duration "$duration"
  positive_int total-http-rps "$total_rps"
  positive_int ramp "$ramp"
  local workers
  workers="$(require_worker_count mixed 2)"
  (( players % workers == 0 )) || die "players must divide evenly across $workers workers"
  local per_players=$((players / workers))
  (( per_players % 2 == 0 )) || die 'players per worker must be even for human matchmaking'
  (( total_rps >= workers )) \
    || die "total-http-rps must be at least the $workers-worker count for gameplay"
  local base_rps=$((total_rps / workers))
  local rps_remainder=$((total_rps % workers))
  local lead=$((per_players * 23 / 10 + 180))
  (( lead < 300 )) && lead=300
  local start_at=$(( $(date +%s) + lead ))
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-gameplay-${players}"
  local local_dir="$REPORT_ROOT/$stamp"
  mkdir -p "$local_dir"
  printf 'workers=%d players/worker=%d global-http-rps=%d base-rps/worker=%d remainder=%d synchronized=%s\n' \
    "$workers" "$per_players" "$total_rps" "$base_rps" "$rps_remainder" \
    "$(date -u -r "$start_at" +%Y-%m-%dT%H:%M:%SZ)"

  local index=0 ip offset remote_report log pids=() reports=() ips=()
  while IFS= read -r ip; do
    offset=$((index * per_players))
    local worker_rps=$base_rps
    (( index < rps_remainder )) && worker_rps=$((worker_rps + 1))
    remote_report="/opt/quizball-load/reports/${stamp}-worker-$(printf '%02d' "$index").json"
    log="$local_dir/worker-$(printf '%02d' "$index").log"
    local db_flag='--no-db-stats'
    (( index == 0 )) && db_flag=''
    local command
    command="$(remote_prefix)npx tsx scripts/chaos/run.ts --target=staging --users=$per_players --offset=$offset --sockets=$per_players --matches-per-client=1 --total-rps=$worker_rps --duration=$duration --ramp-s=$ramp --start-at=$start_at $db_flag --report=$remote_report"
    "${SSH[@]}" "root@$ip" "$command" >"$log" 2>&1 &
    pids+=("$!")
    reports+=("$remote_report")
    ips+=("$ip")
    index=$((index + 1))
  done < <(worker_ips mixed)

  local failed=0
  for index in "${!pids[@]}"; do
    if ! wait "${pids[$index]}"; then
      failed=$((failed + 1))
    fi
    collect_one "${ips[$index]}" "${reports[$index]}" \
      "$local_dir/worker-$(printf '%02d' "$index").json" || failed=$((failed + 1))
  done
  printf 'reports=%s failed_workers=%d\n' "$local_dir" "$failed"
  (( failed == 0 )) || return 1
}

run_matchmaking() {
  local players="$1"
  local timeout="${2:-30}"
  positive_int players "$players"
  positive_int join-timeout "$timeout"
  local workers
  workers="$(require_worker_count mixed 2)"
  (( players % workers == 0 )) || die "players must divide evenly across $workers workers"
  local per_players=$((players / workers))
  (( per_players % 2 == 0 )) || die 'players per worker must be even'
  local lead=$((per_players * 23 / 10 + 240))
  local start_at=$(( $(date +%s) + lead ))
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-matchmaking-${players}"
  local local_dir="$REPORT_ROOT/$stamp"
  mkdir -p "$local_dir"
  printf 'workers=%d clients/worker=%d synchronized=%s\n' \
    "$workers" "$per_players" "$(date -u -r "$start_at" +%Y-%m-%dT%H:%M:%SZ)"

  local index=0 ip offset remote_report log pids=() reports=() ips=()
  while IFS= read -r ip; do
    offset=$((index * per_players))
    remote_report="/opt/quizball-load/reports/${stamp}-worker-$(printf '%02d' "$index").json"
    log="$local_dir/worker-$(printf '%02d' "$index").log"
    local db_flag='--no-db-stats'
    (( index == 0 )) && db_flag=''
    local command
    command="$(remote_prefix)npm run chaos:matchmaking -- --target=staging --clients=$per_players --offset=$offset --connect-ramp-s=60 --join-ramp-s=1 --timeout-s=$timeout --start-at=$start_at --defer-pair-validation $db_flag --report=$remote_report"
    "${SSH[@]}" "root@$ip" "$command" >"$log" 2>&1 &
    pids+=("$!")
    reports+=("$remote_report")
    ips+=("$ip")
    index=$((index + 1))
  done < <(worker_ips mixed)

  local failed=0
  for index in "${!pids[@]}"; do
    if ! wait "${pids[$index]}"; then failed=$((failed + 1)); fi
    collect_one "${ips[$index]}" "${reports[$index]}" \
      "$local_dir/worker-$(printf '%02d' "$index").json" || failed=$((failed + 1))
  done
  local aggregate_failed=0
  npx tsx "$REPO_ROOT/scripts/chaos/matchmaking-aggregate.ts" \
    --expected-clients="$players" --report="$local_dir/aggregate.json" \
    "$local_dir"/worker-*.json || aggregate_failed=1
  printf 'reports=%s failed_workers=%d aggregate_failed=%d\n' \
    "$local_dir" "$failed" "$aggregate_failed"
  (( failed == 0 && aggregate_failed == 0 )) || return 1
}

run_k6() {
  local mode="$1"
  local role="$2"
  local rate="$3"
  local duration="$4"
  local ramp="${5:-2m}"
  positive_int global-rps "$rate"
  local workers
  workers="$(require_worker_count "$role" 2)"
  local base_rate=$((rate / workers))
  local rate_remainder=$((rate % workers))
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-k6-${mode}-${rate}rps"
  local local_dir="$REPORT_ROOT/$stamp"
  mkdir -p "$local_dir"

  local index=0 ip offset remote_report log pids=() reports=() ips=()
  while IFS= read -r ip; do
    local worker_rate=$base_rate
    (( index < rate_remainder )) && worker_rate=$((worker_rate + 1))
    if (( worker_rate == 0 )); then
      index=$((index + 1))
      continue
    fi
    offset=$((index * 1000))
    remote_report="/opt/quizball-load/reports/${stamp}-worker-$(printf '%02d' "$index").json"
    log="$local_dir/worker-$(printf '%02d' "$index").log"
    local k6_mode="$mode"
    local command
    command="$(remote_prefix)TARGET=staging MODE=$k6_mode USERS=1000 SHARD_START=$offset RATE=$worker_rate START_RATE=1 TIME_UNIT=1s RAMP_DURATION=$ramp DURATION=$duration PREALLOCATED_VUS=$((worker_rate * 2)) MAX_VUS=$((worker_rate * 4)) k6 run --summary-export $remote_report scripts/load/k6/auth-api.k6.js"
    "${SSH[@]}" "root@$ip" "$command" >"$log" 2>&1 &
    pids+=("$!")
    reports+=("$remote_report")
    ips+=("$ip")
    index=$((index + 1))
  done < <(worker_ips "$role")

  local failed=0
  for index in "${!pids[@]}"; do
    if ! wait "${pids[$index]}"; then failed=$((failed + 1)); fi
    collect_one "${ips[$index]}" "${reports[$index]}" \
      "$local_dir/worker-$(printf '%02d' "$index").json" || failed=$((failed + 1))
  done
  printf 'reports=%s failed_workers=%d\n' "$local_dir" "$failed"
  (( failed == 0 )) || return 1
}

main() {
  local scenario="${1:-}"
  case "$scenario" in
    gameplay) [[ $# -ge 4 && $# -le 5 ]] || die 'gameplay requires players duration total-rps [ramp]'; run_gameplay "$2" "$3" "$4" "${5:-60}" ;;
    matchmaking) [[ $# -ge 2 && $# -le 3 ]] || die 'matchmaking requires players [timeout]'; run_matchmaking "$2" "${3:-30}" ;;
    http) [[ $# -ge 3 && $# -le 4 ]] || die 'http requires rps duration [ramp]'; run_k6 api mixed "$2" "$3" "${4:-2m}" ;;
    auth-login) [[ $# -ge 3 && $# -le 4 ]] || die 'auth-login requires rps duration [ramp]'; run_k6 login all "$2" "$3" "${4:-2m}" ;;
    *) usage; [[ -z "$scenario" ]] || exit 1 ;;
  esac
}

main "$@"
