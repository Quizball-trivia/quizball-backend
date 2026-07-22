#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
FLEET="$SCRIPT_DIR/fleet.sh"
SSH_KEY_PATH="${HCLOUD_SSH_KEY_PATH:-$HOME/.ssh/quizball-staging-load}"
REPORT_ROOT="${REPORT_ROOT_OVERRIDE:-$SCRIPT_DIR/reports/${CAMPAIGN_ID:-quizball-staging-5k}}"
SSH=(ssh -n -i "$SSH_KEY_PATH" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=12 -o TCPKeepAlive=yes)
SCP=(scp -i "$SSH_KEY_PATH" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=12 -o TCPKeepAlive=yes)

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  run-scenario.sh gameplay <players> <duration-sec> <total-http-rps> [ramp-sec] [include-spend]
  run-scenario.sh gameplay-chaos <players> <duration-sec> <total-http-rps> [ramp-sec] [include-spend] [flap-rate] [flap-stages]
  run-scenario.sh gameplay-raid <players> <duration-sec> <total-http-rps> [ramp-sec] [include-spend]
  run-scenario.sh mixed-product <total-players> <ranked-players> <duration-sec> <total-http-rps> [ramp-sec] [include-spend]
  run-scenario.sh party <players> [ramp-sec]
  run-scenario.sh matchmaking <players> [join-timeout-sec] [join-ramp-sec] [connect-ramp-sec]
  run-scenario.sh http <global-rps> <duration> [ramp-duration]
  run-scenario.sh http-hot <global-rps> <duration> [ramp-duration]
  run-scenario.sh auth-login <global-rps> <duration> [ramp-duration]
  run-scenario.sh auth-mix <global-rps> <duration> [ramp-duration]

gameplay and matchmaking use the mixed fleet. auth-login uses every
mixed+auth worker so Supabase sees distributed source IPs. All commands source
only the staging environment installed by sync-env.ts.
EOF
}

run_party() {
  local players="$1"
  local ramp="${2:-120}"
  positive_int players "$players"
  non_negative_int ramp "$ramp"
  local workers
  workers="$(require_worker_count mixed 2)"
  (( players % 2 == 0 )) || die 'players must be even for party pairs'
  local total_pairs=$((players / 2))
  (( total_pairs >= workers )) || die "players must provide at least one pair per worker"
  local base_pairs=$((total_pairs / workers))
  local pair_remainder=$((total_pairs % workers))
  local max_per_players=$(( (base_pairs + (pair_remainder > 0 ? 1 : 0)) * 2 ))
  local lead=$((max_per_players * 23 / 10 + 240))
  (( lead < 300 )) && lead=300
  local start_at="${SCENARIO_START_AT:-$(( $(date +%s) + lead ))}"
  positive_int SCENARIO_START_AT "$start_at"
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-party-${players}-$$"
  local local_dir="$REPORT_ROOT/$stamp"
  mkdir -p "$local_dir"
  printf 'workers=%d max-clients/worker=%d pair-remainder=%d ramp=%ds synchronized=%s\n' \
    "$workers" "$max_per_players" "$pair_remainder" "$ramp" "$(format_epoch_utc "$start_at")"

  local index=0 ip offset=0 worker_pairs worker_players remote_report remote_marker log
  local pids=() reports=() markers=() ips=()
  while IFS= read -r ip; do
    worker_pairs="$base_pairs"
    if (( index < pair_remainder )); then worker_pairs=$((worker_pairs + 1)); fi
    worker_players=$((worker_pairs * 2))
    remote_report="/opt/quizball-load/reports/${stamp}-worker-$(printf '%02d' "$index").json"
    log="$local_dir/worker-$(printf '%02d' "$index").log"
    local db_flag='--no-db-stats'
    if (( index == 0 )) && [[ "${COLLECT_DB_STATS:-true}" == true ]]; then db_flag=''; fi
    local command
    command="$(remote_prefix)npx tsx scripts/chaos/friendly.ts --target=staging --clients=$worker_players --offset=$offset --ramp-s=$ramp --start-at=$start_at $db_flag --report=$remote_report"
    remote_marker="${remote_report}.exit"
    command="$(with_completion_marker "$command" "$remote_marker")"
    "${SSH[@]}" "root@$ip" "$command" >"$log" 2>&1 &
    pids+=("$!")
    reports+=("$remote_report")
    markers+=("$remote_marker")
    ips+=("$ip")
    offset=$((offset + worker_players))
    index=$((index + 1))
  done < <(worker_ips mixed)

  local failed=0
  for index in "${!pids[@]}"; do
    if ! wait_for_worker "${ips[$index]}" "${pids[$index]}" "${markers[$index]}"; then
      failed=$((failed + 1))
    fi
    collect_one "${ips[$index]}" "${reports[$index]}" \
      "$local_dir/worker-$(printf '%02d' "$index").json" || failed=$((failed + 1))
  done
  local aggregate_failed=0
  npx tsx "$REPO_ROOT/scripts/chaos/friendly-aggregate.ts" \
    --expected-clients="$players" --report="$local_dir/aggregate.json" \
    "$local_dir"/worker-*.json || aggregate_failed=1
  printf 'reports=%s failed_workers=%d aggregate_failed=%d\n' \
    "$local_dir" "$failed" "$aggregate_failed"
  (( failed == 0 && aggregate_failed == 0 )) || return 1
}

positive_int() {
  [[ "${2:-}" =~ ^[0-9]+$ ]] && (( $2 > 0 )) || die "$1 must be a positive integer"
}

non_negative_int() {
  [[ "${2:-}" =~ ^[0-9]+$ ]] || die "$1 must be a non-negative integer"
}

non_negative_number() {
  [[ "${2:-}" =~ ^([0-9]+([.][0-9]*)?|[.][0-9]+)$ ]] \
    || die "$1 must be a non-negative number"
}

format_epoch_utc() {
  local epoch="$1"
  if date -u -r "$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null; then
    return
  fi
  date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ
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

with_completion_marker() {
  local command="$1"
  local marker="$2"
  local started_marker="${marker}.started"
  printf "rm -f '%s' '%s' && printf 'started\\n' > '%s' && %s; rc=\$?; printf '%%s\\n' \"\$rc\" > '%s'; exit \"\$rc\"" \
    "$marker" "$started_marker" "$started_marker" "$command" "$marker"
}

wait_for_worker() {
  local ip="$1"
  local pid="$2"
  local marker="$3"
  local timeout_sec="${REMOTE_RESULT_TIMEOUT_SEC:-7200}"
  local deadline=$((SECONDS + timeout_sec))
  local start_deadline=$((SECONDS + 60))
  local status='' started='' started_seen=0 transport_reaped=0

  while (( SECONDS < deadline )); do
    status="$("${SSH[@]}" "root@$ip" "if test -f '$marker'; then cat '$marker'; fi" 2>/dev/null || true)"
    if [[ "$status" =~ ^[0-9]+$ ]]; then
      # Some long-lived Node processes leave the original SSH channel open
      # after the workload and report have finished. The remote marker is the
      # authoritative result, so close that stale local transport explicitly.
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      (( 10#$status == 0 ))
      return
    fi

    if (( started_seen == 0 )); then
      started="$("${SSH[@]}" "root@$ip" "if test -f '${marker}.started'; then printf 'yes'; fi" 2>/dev/null || true)"
      [[ "$started" == 'yes' ]] && started_seen=1
    fi
    if (( started_seen == 0 && SECONDS >= start_deadline )); then
      printf 'worker %s never published start marker %s.started\n' "$ip" "$marker" >&2
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 125
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      if (( transport_reaped == 0 )); then
        # Losing the control-plane SSH channel must not be confused with the
        # remotely running workload finishing. The remote marker remains the
        # authoritative result and is deliberately polled through reconnects.
        wait "$pid" 2>/dev/null || true
        transport_reaped=1
      fi
    fi
    sleep 2
  done

  printf 'worker %s did not publish completion marker %s within %ss\n' \
    "$ip" "$marker" "$timeout_sec" >&2
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  return 124
}

run_gameplay() {
  local players="$1"
  local duration="$2"
  local total_rps="$3"
  local ramp="${4:-60}"
  local include_spend="${5:-false}"
  local flap_rate="${6:-0}"
  local flap_stages="${7:-match}"
  local login_storm="${8:-false}"
  positive_int players "$players"
  positive_int duration "$duration"
  positive_int total-http-rps "$total_rps"
  positive_int ramp "$ramp"
  [[ "$include_spend" == true || "$include_spend" == false ]] \
    || die 'include-spend must be true or false'
  non_negative_number flap-rate "$flap_rate"
  [[ "$flap_stages" =~ ^(search|draft|gate|match)(,(search|draft|gate|match))*$ ]] \
    || die 'flap-stages must be a comma-separated subset of search,draft,gate,match'
  [[ "$login_storm" == true || "$login_storm" == false ]] \
    || die 'login-storm must be true or false'
  local workers
  workers="$(require_worker_count mixed 2)"
  (( players % 2 == 0 )) || die 'players must be even for human matchmaking'
  local total_pairs=$((players / 2))
  (( total_pairs >= workers )) || die "players must provide at least one pair per worker"
  local base_pairs=$((total_pairs / workers))
  local pair_remainder=$((total_pairs % workers))
  local max_per_players=$(( (base_pairs + (pair_remainder > 0 ? 1 : 0)) * 2 ))
  (( total_rps >= workers )) \
    || die "total-http-rps must be at least the $workers-worker count for gameplay"
  local base_rps=$((total_rps / workers))
  local rps_remainder=$((total_rps % workers))
  local lead=$((max_per_players * 23 / 10 + 180))
  (( lead < 300 )) && lead=300
  local start_at="${SCENARIO_START_AT:-$(( $(date +%s) + lead ))}"
  positive_int SCENARIO_START_AT "$start_at"
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-gameplay-${players}-$$"
  local local_dir="$REPORT_ROOT/$stamp"
  mkdir -p "$local_dir"
  printf 'workers=%d max-players/worker=%d pair-remainder=%d global-http-rps=%d base-rps/worker=%d rps-remainder=%d synchronized=%s\n' \
    "$workers" "$max_per_players" "$pair_remainder" "$total_rps" "$base_rps" "$rps_remainder" \
    "$(format_epoch_utc "$start_at")"

  local index=0 ip offset=0 worker_pairs worker_players remote_report remote_marker log
  local pids=() reports=() markers=() ips=()
  while IFS= read -r ip; do
    worker_pairs="$base_pairs"
    if (( index < pair_remainder )); then worker_pairs=$((worker_pairs + 1)); fi
    worker_players=$((worker_pairs * 2))
    local worker_rps=$base_rps
    (( index < rps_remainder )) && worker_rps=$((worker_rps + 1))
    remote_report="/opt/quizball-load/reports/${stamp}-worker-$(printf '%02d' "$index").json"
    log="$local_dir/worker-$(printf '%02d' "$index").log"
    local db_flag='--no-db-stats'
    if (( index == 0 )) && [[ "${COLLECT_DB_STATS:-true}" == true ]]; then db_flag=''; fi
    local command
    local spend_flag=''
    [[ "$include_spend" == true ]] && spend_flag='--include-spend=true'
    local login_flag=''
    [[ "$login_storm" == true ]] && login_flag="--login-storm=true --login-ramp-s=$ramp"
    local expected_fault_flag=''
    [[ "$flap_rate" =~ ^0+([.]0*)?$ ]] \
      || expected_fault_flag='--expect-socket-error=MATCH_PAUSED'
    command="$(remote_prefix)npx tsx scripts/chaos/run.ts --target=staging --users=$worker_players --offset=$offset --sockets=$worker_players --matches-per-client=1 --total-rps=$worker_rps --duration=$duration --ramp-s=$ramp --start-at=$start_at --flap-rate=$flap_rate --flap-stage=$flap_stages $expected_fault_flag $login_flag $spend_flag $db_flag --report=$remote_report"
    remote_marker="${remote_report}.exit"
    command="$(with_completion_marker "$command" "$remote_marker")"
    "${SSH[@]}" "root@$ip" "$command" >"$log" 2>&1 &
    pids+=("$!")
    reports+=("$remote_report")
    markers+=("$remote_marker")
    ips+=("$ip")
    offset=$((offset + worker_players))
    index=$((index + 1))
  done < <(worker_ips mixed)

  local failed=0
  for index in "${!pids[@]}"; do
    if ! wait_for_worker "${ips[$index]}" "${pids[$index]}" "${markers[$index]}"; then
      failed=$((failed + 1))
    fi
    collect_one "${ips[$index]}" "${reports[$index]}" \
      "$local_dir/worker-$(printf '%02d' "$index").json" || failed=$((failed + 1))
  done
  local aggregate_failed=0
  npx tsx "$REPO_ROOT/scripts/chaos/gameplay-aggregate.ts" \
    --expected-clients="$players" --expected-http-rps="$total_rps" \
    --include-spend="$include_spend" --report="$local_dir/aggregate.json" \
    "$local_dir"/worker-*.json || aggregate_failed=1
  printf 'reports=%s failed_workers=%d aggregate_failed=%d\n' \
    "$local_dir" "$failed" "$aggregate_failed"
  (( failed == 0 && aggregate_failed == 0 )) || return 1
}

run_mixed_product() {
  local total_players="$1"
  local ranked_players="$2"
  local duration="$3"
  local total_rps="$4"
  local ramp="${5:-120}"
  local include_spend="${6:-true}"
  positive_int total-players "$total_players"
  positive_int ranked-players "$ranked_players"
  positive_int duration "$duration"
  positive_int total-http-rps "$total_rps"
  positive_int ramp "$ramp"
  [[ "$include_spend" == true || "$include_spend" == false ]] \
    || die 'include-spend must be true or false'
  (( total_players % 2 == 0 )) || die 'total-players must be even'
  (( ranked_players % 2 == 0 )) || die 'ranked-players must be even'
  (( ranked_players < total_players )) || die 'ranked-players must be smaller than total-players'

  local party_players=$((total_players - ranked_players))
  (( party_players % 2 == 0 )) || die 'inferred party players must be even'
  local workers
  workers="$(require_worker_count mixed 2)"
  local max_users_per_worker=$(( (total_players + workers - 1) / workers ))
  # Both account namespaces prepare concurrently on each source IP. Budget the
  # lead time for their combined user count so provisioning is outside the
  # measured phase even when Auth asks either process to back off.
  local lead=$((max_users_per_worker * 23 / 10 + 300))
  (( lead < 600 )) && lead=600
  local start_at=$(( $(date +%s) + lead ))
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-mixed-${total_players}-$$"
  local mixed_dir="$REPORT_ROOT/$stamp"
  mkdir -p "$mixed_dir"
  printf 'mixed total=%d ranked=%d party=%d http-rps=%d synchronized=%s\n' \
    "$total_players" "$ranked_players" "$party_players" "$total_rps" \
    "$(format_epoch_utc "$start_at")"

  (
    REPORT_ROOT="$mixed_dir/ranked" \
    SCENARIO_START_AT="$start_at" \
    COLLECT_DB_STATS=true \
      run_gameplay "$ranked_players" "$duration" "$total_rps" "$ramp" "$include_spend"
  ) >"$mixed_dir/ranked-orchestration.log" 2>&1 &
  local ranked_pid=$!
  (
    REPORT_ROOT="$mixed_dir/party" \
    SCENARIO_START_AT="$start_at" \
    COLLECT_DB_STATS=false \
      run_party "$party_players" "$ramp"
  ) >"$mixed_dir/party-orchestration.log" 2>&1 &
  local party_pid=$!

  local ranked_failed=0 party_failed=0
  if ! wait "$ranked_pid"; then ranked_failed=1; fi
  if ! wait "$party_pid"; then party_failed=1; fi

  local ranked_report party_report aggregate_failed=0
  ranked_report="$(find "$mixed_dir/ranked" -type f -name aggregate.json -print -quit)"
  party_report="$(find "$mixed_dir/party" -type f -name aggregate.json -print -quit)"
  [[ -n "$ranked_report" ]] || die 'ranked aggregate report was not produced'
  [[ -n "$party_report" ]] || die 'party aggregate report was not produced'
  npx tsx "$REPO_ROOT/scripts/chaos/mixed-product-aggregate.ts" \
    --expected-total-clients="$total_players" \
    --ranked="$ranked_report" --party="$party_report" \
    --report="$mixed_dir/aggregate.json" || aggregate_failed=1
  printf 'reports=%s ranked_failed=%d party_failed=%d aggregate_failed=%d\n' \
    "$mixed_dir" "$ranked_failed" "$party_failed" "$aggregate_failed"
  (( ranked_failed == 0 && party_failed == 0 && aggregate_failed == 0 )) || return 1
}

run_matchmaking() {
  local players="$1"
  local timeout="${2:-30}"
  local join_ramp="${3:-1}"
  local connect_ramp="${4:-60}"
  positive_int players "$players"
  positive_int join-timeout "$timeout"
  non_negative_int join-ramp "$join_ramp"
  non_negative_int connect-ramp "$connect_ramp"
  local workers
  workers="$(require_worker_count mixed 2)"
  (( players % 2 == 0 )) || die 'players must be even'
  local total_pairs=$((players / 2))
  (( total_pairs >= workers )) || die "players must provide at least one pair per worker"
  local base_pairs=$((total_pairs / workers))
  local pair_remainder=$((total_pairs % workers))
  local max_per_players=$(( (base_pairs + (pair_remainder > 0 ? 1 : 0)) * 2 ))
  local lead=$((max_per_players * 23 / 10 + 240))
  (( lead < 300 )) && lead=300
  local start_at=$(( $(date +%s) + lead ))
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-matchmaking-${players}"
  local local_dir="$REPORT_ROOT/$stamp"
  mkdir -p "$local_dir"
  printf 'workers=%d max-clients/worker=%d pair-remainder=%d connect-ramp=%ds join-ramp=%ds synchronized=%s\n' \
    "$workers" "$max_per_players" "$pair_remainder" "$connect_ramp" "$join_ramp" "$(format_epoch_utc "$start_at")"

  local index=0 ip offset=0 worker_pairs worker_players remote_report remote_marker log
  local pids=() reports=() markers=() ips=()
  while IFS= read -r ip; do
    worker_pairs="$base_pairs"
    if (( index < pair_remainder )); then worker_pairs=$((worker_pairs + 1)); fi
    worker_players=$((worker_pairs * 2))
    remote_report="/opt/quizball-load/reports/${stamp}-worker-$(printf '%02d' "$index").json"
    log="$local_dir/worker-$(printf '%02d' "$index").log"
    local db_flag='--no-db-stats'
    (( index == 0 )) && db_flag=''
    local command
    command="$(remote_prefix)npm run chaos:matchmaking -- --target=staging --clients=$worker_players --offset=$offset --connect-ramp-s=$connect_ramp --join-ramp-s=$join_ramp --timeout-s=$timeout --start-at=$start_at --defer-pair-validation $db_flag --report=$remote_report"
    remote_marker="${remote_report}.exit"
    command="$(with_completion_marker "$command" "$remote_marker")"
    "${SSH[@]}" "root@$ip" "$command" >"$log" 2>&1 &
    pids+=("$!")
    reports+=("$remote_report")
    markers+=("$remote_marker")
    ips+=("$ip")
    offset=$((offset + worker_players))
    index=$((index + 1))
  done < <(worker_ips mixed)

  local failed=0
  for index in "${!pids[@]}"; do
    if ! wait_for_worker "${ips[$index]}" "${pids[$index]}" "${markers[$index]}"; then
      failed=$((failed + 1))
    fi
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
  local api_profile="${6:-full}"
  local users_per_worker="${K6_USERS_PER_WORKER:-1250}"
  positive_int global-rps "$rate"
  positive_int K6_USERS_PER_WORKER "$users_per_worker"
  local workers
  workers="$(require_worker_count "$role" 2)"
  local base_rate=$((rate / workers))
  local rate_remainder=$((rate % workers))
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-k6-${mode}-${rate}rps"
  local local_dir="$REPORT_ROOT/$stamp"
  mkdir -p "$local_dir"

  local index=0 ip offset remote_report remote_marker log
  local pids=() reports=() markers=() ips=()
  while IFS= read -r ip; do
    local worker_rate=$base_rate
    (( index < rate_remainder )) && worker_rate=$((worker_rate + 1))
    if (( worker_rate == 0 )); then
      index=$((index + 1))
      continue
    fi
    offset=$((index * users_per_worker))
    remote_report="/opt/quizball-load/reports/${stamp}-worker-$(printf '%02d' "$index").json"
    log="$local_dir/worker-$(printf '%02d' "$index").log"
    local k6_mode="$mode"
    local command
    command="$(remote_prefix)TARGET=staging MODE=$k6_mode API_PROFILE=$api_profile USERS=$users_per_worker SHARD_START=$offset RATE=$worker_rate START_RATE=1 TIME_UNIT=1s RAMP_DURATION=$ramp DURATION=$duration PREALLOCATED_VUS=$((worker_rate * 2)) MAX_VUS=$((worker_rate * 4)) k6 run --summary-export $remote_report scripts/load/k6/auth-api.k6.js"
    remote_marker="${remote_report}.exit"
    command="$(with_completion_marker "$command" "$remote_marker")"
    "${SSH[@]}" "root@$ip" "$command" >"$log" 2>&1 &
    pids+=("$!")
    reports+=("$remote_report")
    markers+=("$remote_marker")
    ips+=("$ip")
    index=$((index + 1))
  done < <(worker_ips "$role")

  local failed=0
  for index in "${!pids[@]}"; do
    if ! wait_for_worker "${ips[$index]}" "${pids[$index]}" "${markers[$index]}"; then
      failed=$((failed + 1))
    fi
    collect_one "${ips[$index]}" "${reports[$index]}" \
      "$local_dir/worker-$(printf '%02d' "$index").json" || failed=$((failed + 1))
  done
  local aggregate_failed=0
  npx tsx "$REPO_ROOT/scripts/load/k6/aggregate-summary.ts" \
    --report "$local_dir/aggregate.json" "$local_dir"/worker-*.json || aggregate_failed=1
  printf 'reports=%s failed_workers=%d aggregate_failed=%d\n' \
    "$local_dir" "$failed" "$aggregate_failed"
  (( failed == 0 && aggregate_failed == 0 )) || return 1
}

main() {
  local scenario="${1:-}"
  case "$scenario" in
    gameplay) [[ $# -ge 4 && $# -le 6 ]] || die 'gameplay requires players duration total-rps [ramp] [include-spend]'; run_gameplay "$2" "$3" "$4" "${5:-60}" "${6:-false}" ;;
    gameplay-chaos) [[ $# -ge 4 && $# -le 8 ]] || die 'gameplay-chaos requires players duration total-rps [ramp] [include-spend] [flap-rate] [flap-stages]'; run_gameplay "$2" "$3" "$4" "${5:-60}" "${6:-false}" "${7:-0.5}" "${8:-search,draft,gate,match}" false ;;
    gameplay-raid) [[ $# -ge 4 && $# -le 6 ]] || die 'gameplay-raid requires players duration total-rps [ramp] [include-spend]'; run_gameplay "$2" "$3" "$4" "${5:-60}" "${6:-false}" 0 match true ;;
    mixed-product) [[ $# -ge 5 && $# -le 7 ]] || die 'mixed-product requires total-players ranked-players duration total-rps [ramp] [include-spend]'; run_mixed_product "$2" "$3" "$4" "$5" "${6:-120}" "${7:-true}" ;;
    party) [[ $# -ge 2 && $# -le 3 ]] || die 'party requires players [ramp]'; run_party "$2" "${3:-120}" ;;
    matchmaking) [[ $# -ge 2 && $# -le 5 ]] || die 'matchmaking requires players [timeout] [join-ramp] [connect-ramp]'; run_matchmaking "$2" "${3:-30}" "${4:-1}" "${5:-60}" ;;
    http) [[ $# -ge 3 && $# -le 4 ]] || die 'http requires rps duration [ramp]'; run_k6 api mixed "$2" "$3" "${4:-2m}" ;;
    http-hot) [[ $# -ge 3 && $# -le 4 ]] || die 'http-hot requires rps duration [ramp]'; run_k6 api mixed "$2" "$3" "${4:-2m}" hot-db ;;
    auth-login) [[ $# -ge 3 && $# -le 4 ]] || die 'auth-login requires rps duration [ramp]'; run_k6 login all "$2" "$3" "${4:-2m}" ;;
    auth-mix) [[ $# -ge 3 && $# -le 4 ]] || die 'auth-mix requires rps duration [ramp]'; run_k6 auth-mix all "$2" "$3" "${4:-2m}" ;;
    *) usage; [[ -z "$scenario" ]] || exit 1 ;;
  esac
}

main "$@"
