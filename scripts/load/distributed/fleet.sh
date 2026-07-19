#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

HCLOUD_CONTEXT="${HCLOUD_CONTEXT:-quizball-load}"
CAMPAIGN_ID="${CAMPAIGN_ID:-quizball-staging-5k}"
LOCATION="${HCLOUD_LOCATION:-hel1}"
IMAGE="${HCLOUD_IMAGE:-ubuntu-24.04}"
SSH_KEY_NAME="${HCLOUD_SSH_KEY_NAME:-quizball-staging-load}"
SSH_KEY_PATH="${HCLOUD_SSH_KEY_PATH:-$HOME/.ssh/quizball-staging-load}"
FIREWALL_NAME="${HCLOUD_FIREWALL_NAME:-quizball-staging-load}"
SSH_ALLOWED_CIDRS="${HCLOUD_SSH_ALLOWED_CIDRS:-}"
MAX_TOTAL_SERVERS="${MAX_TOTAL_SERVERS:-21}"
MAX_LIFETIME_HOURS="${MAX_LIFETIME_HOURS:-24}"
SERVER_BUDGET_USD="${SERVER_BUDGET_USD:-15}"
# Hetzner bills the Primary IPv4 separately from the server. Keep this
# overrideable, but include the current project-currency price in every guard.
PRIMARY_IPV4_HOURLY_USD="${PRIMARY_IPV4_HOURLY_USD:-0.0010}"
HCLOUD_SPEND_APPROVAL="${HCLOUD_SPEND_APPROVAL:-}"

HCLOUD=(hcloud --context "$HCLOUD_CONTEXT")
SSH=(ssh -n -i "$SSH_KEY_PATH" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
SCP=(scp -i "$SSH_KEY_PATH" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  fleet.sh preflight
  fleet.sh estimate <count> <cx23|cx33|cx43|cx53>
  fleet.sh provision <mixed|auth> <count> <cx23|cx33|cx43|cx53>
  fleet.sh list [mixed|auth|all]
  fleet.sh wait-ready <mixed|auth>
  fleet.sh upload <mixed|auth>
  fleet.sh health <mixed|auth>
  fleet.sh exec <mixed|auth> <remote command...>
  fleet.sh collect <mixed|auth> [local directory]
  fleet.sh destroy <mixed|auth|all>

All servers are restricted to the dedicated Hetzner context, labeled
quizball-load=true, and intended only for https://api-staging.quizball.io.
EOF
}

require_tools() {
  local tool
  for tool in hcloud jq ssh scp curl git; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
  done
}

require_context() {
  "${HCLOUD[@]}" server list --selector 'quizball-load=true' -o json >/dev/null \
    || die "Hetzner context '$HCLOUD_CONTEXT' is missing or unauthenticated"
}

require_staging_health() {
  local body
  body="$(curl -fsS --connect-timeout 5 --max-time 10 https://api-staging.quizball.io/health)" \
    || die 'staging health check failed'
  [[ "$body" != *'api.quizball.io'* ]] || die 'production marker appeared in staging health response'
}

validate_role() {
  [[ "${1:-}" == 'mixed' || "${1:-}" == 'auth' ]] \
    || die "fleet role must be mixed or auth, got '${1:-}'"
}

validate_type() {
  case "${1:-}" in
    cx23|cx33|cx43|cx53) ;;
    *) die "unsupported shared server type '${1:-}'" ;;
  esac
}

hourly_usd() {
  local type="$1" type_json available
  type_json="$("${HCLOUD[@]}" server-type describe "$type" -o json)"
  available="$(jq -r --arg location "$LOCATION" \
    'any(.locations[]; .name == $location and .available == true)' <<< "$type_json")"
  [[ "$available" == 'true' ]] \
    || die "server type '$type' is not currently available in '$LOCATION'"
  jq -er --arg location "$LOCATION" \
    '.prices[] | select(.location == $location) | .price_hourly.gross' <<< "$type_json" \
    || die "no live hourly price for '$type' in '$LOCATION'"
}

estimate() {
  local count="$1"
  local type="$2"
  [[ "$count" =~ ^[0-9]+$ ]] && (( count > 0 && count <= MAX_TOTAL_SERVERS )) \
    || die "count must be 1..$MAX_TOTAL_SERVERS"
  validate_type "$type"
  local hourly
  hourly="$(hourly_usd "$type")"
  awk -v n="$count" -v h="$hourly" -v ip="$PRIMARY_IPV4_HOURLY_USD" \
    -v lifetime="$MAX_LIFETIME_HOURS" -v type="$type" \
    'BEGIN { printf "servers=%d type=%s plus_primary_ipv4 hourly=$%.4f 12h=$%.2f max_lifetime_%dh=$%.2f\n", n, type, n*(h+ip), n*(h+ip)*12, lifetime, n*(h+ip)*lifetime }'
  local projected
  projected="$(awk -v n="$count" -v h="$hourly" -v ip="$PRIMARY_IPV4_HOURLY_USD" \
    -v lifetime="$MAX_LIFETIME_HOURS" 'BEGIN { print n*(h+ip)*lifetime }')"
  awk -v projected="$projected" -v cap="$SERVER_BUDGET_USD" \
    'BEGIN { if (projected > cap) exit 1 }' \
    || die "projected server + IPv4 cost \$$projected exceeds fleet cap \$$SERVER_BUDGET_USD"
}

selector() {
  local role="${1:-all}"
  if [[ "$role" == 'all' ]]; then
    printf 'quizball-load=true,campaign=%s' "$CAMPAIGN_ID"
  else
    validate_role "$role"
    printf 'quizball-load=true,campaign=%s,fleet=%s' "$CAMPAIGN_ID" "$role"
  fi
}

servers_json() {
  "${HCLOUD[@]}" server list --selector "$(selector "$1")" -o json
}

server_ips() {
  servers_json "$1" | jq -r 'sort_by(.name)[] | select(.status != "deleting") | .public_net.ipv4.ip'
}

ensure_ssh_key() {
  if [[ ! -f "$SSH_KEY_PATH" || ! -f "$SSH_KEY_PATH.pub" ]]; then
    mkdir -p "$(dirname "$SSH_KEY_PATH")"
    ssh-keygen -q -t ed25519 -N '' -C 'quizball-staging-load' -f "$SSH_KEY_PATH"
  fi
  chmod 600 "$SSH_KEY_PATH"
  if ! "${HCLOUD[@]}" ssh-key describe "$SSH_KEY_NAME" >/dev/null 2>&1; then
    "${HCLOUD[@]}" ssh-key create --name "$SSH_KEY_NAME" \
      --public-key-from-file "$SSH_KEY_PATH.pub" \
      --label 'quizball-load=true' \
      --label "campaign=$CAMPAIGN_ID" >/dev/null
    return
  fi
  local remote_json remote_key local_key
  remote_json="$("${HCLOUD[@]}" ssh-key describe "$SSH_KEY_NAME" -o json)"
  remote_key="$(jq -r '.public_key // empty' <<< "$remote_json" | awk '{print $1 " " $2}')"
  local_key="$(awk '{print $1 " " $2}' "$SSH_KEY_PATH.pub")"
  [[ -n "$remote_key" && "$remote_key" == "$local_key" ]] \
    || die "Hetzner SSH key '$SSH_KEY_NAME' does not match $SSH_KEY_PATH.pub"
}

ssh_allowed_cidrs() {
  local raw="$SSH_ALLOWED_CIDRS"
  if [[ -z "$raw" ]]; then
    local operator_ip
    operator_ip="$(curl -4 -fsS --connect-timeout 5 --max-time 10 https://api.ipify.org)" \
      || die 'could not determine operator IPv4; set HCLOUD_SSH_ALLOWED_CIDRS explicitly'
    raw="$operator_ip/32"
  fi
  local cidr
  while IFS= read -r cidr; do
    cidr="$(xargs <<< "$cidr")"
    [[ "$cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]] \
      || die "invalid IPv4 CIDR in HCLOUD_SSH_ALLOWED_CIDRS: '$cidr'"
    printf '%s\n' "$cidr"
  done < <(tr ',' '\n' <<< "$raw")
}

ensure_firewall() {
  local cidrs desired_json
  cidrs="$(ssh_allowed_cidrs | sort -u)"
  desired_json="$(jq -Rsc 'split("\n") | map(select(length > 0)) | sort' <<< "$cidrs")"
  if ! "${HCLOUD[@]}" firewall describe "$FIREWALL_NAME" >/dev/null 2>&1; then
    jq -n --argjson sources "$desired_json" '[{
      direction: "in",
      protocol: "tcp",
      port: "22",
      source_ips: $sources,
      destination_ips: [],
      description: "QuizBall load control-plane SSH"
    }]' | "${HCLOUD[@]}" firewall create \
      --name "$FIREWALL_NAME" \
      --rules-file - \
      --label 'quizball-load=true' \
      --label "campaign=$CAMPAIGN_ID" >/dev/null
    return
  fi

  local firewall_json actual_json unexpected_rules
  firewall_json="$("${HCLOUD[@]}" firewall describe "$FIREWALL_NAME" -o json)"
  [[ "$(jq -r '.labels["quizball-load"] // ""' <<< "$firewall_json")" == 'true' ]] \
    || die "firewall '$FIREWALL_NAME' is not owned by the load-test campaign"
  [[ "$(jq -r '.labels.campaign // ""' <<< "$firewall_json")" == "$CAMPAIGN_ID" ]] \
    || die "firewall '$FIREWALL_NAME' belongs to a different campaign"
  actual_json="$(jq -c '[.rules[] | select(.direction == "in" and .protocol == "tcp" and .port == "22") | .source_ips[]] | unique | sort' <<< "$firewall_json")"
  unexpected_rules="$(jq '[.rules[] | select(.direction == "in" and (.protocol != "tcp" or .port != "22"))] | length' <<< "$firewall_json")"
  [[ "$unexpected_rules" == '0' && "$actual_json" == "$desired_json" ]] \
    || die "firewall '$FIREWALL_NAME' does not exactly restrict SSH to the requested operator CIDRs"
}

enforce_campaign_budget() {
  local existing_json="$1"
  local needed="$2"
  local new_type="$3"
  local existing_hourly='0' existing_type price
  while IFS= read -r existing_type; do
    validate_type "$existing_type"
    price="$(hourly_usd "$existing_type")"
    existing_hourly="$(awk -v total="$existing_hourly" -v add="$price" \
      -v ip="$PRIMARY_IPV4_HOURLY_USD" 'BEGIN { print total + add + ip }')"
  done < <(jq -r '.[] | select(.status != "deleting") | .server_type.name' <<< "$existing_json")
  local new_hourly projected
  new_hourly="$(hourly_usd "$new_type")"
  projected="$(awk -v existing="$existing_hourly" -v needed="$needed" -v add="$new_hourly" -v lifetime="$MAX_LIFETIME_HOURS" \
    -v ip="$PRIMARY_IPV4_HOURLY_USD" 'BEGIN { print (existing + needed * (add + ip)) * lifetime }')"
  awk -v projected="$projected" -v cap="$SERVER_BUDGET_USD" \
    'BEGIN { if (projected > cap) exit 1 }' \
    || die "campaign-wide projected server + IPv4 cost \$$projected exceeds cap \$$SERVER_BUDGET_USD"
  printf 'Campaign-wide max-lifetime server + IPv4 projection: $%.2f / $%.2f\n' \
    "$projected" "$SERVER_BUDGET_USD"
}

require_spend_approval() {
  local role="$1"
  local count="$2"
  local type="$3"
  local expected="$CAMPAIGN_ID:$role:$count:$type"
  [[ "$HCLOUD_SPEND_APPROVAL" == "$expected" ]] \
    || die "billable provisioning is locked; after explicit approval set HCLOUD_SPEND_APPROVAL='$expected' for this exact fleet"
}

preflight() {
  require_tools
  require_context
  require_staging_health
  printf 'Hetzner context: %s\n' "$HCLOUD_CONTEXT"
  printf 'Campaign: %s\n' "$CAMPAIGN_ID"
  printf 'Staging health: PASS\n'
  printf 'Production target: BLOCKED by harness and fleet policy\n'
}

provision() {
  local role="$1"
  local count="$2"
  local type="$3"
  validate_role "$role"
  [[ "$count" =~ ^[0-9]+$ ]] && (( count > 0 && count <= MAX_TOTAL_SERVERS )) \
    || die "count must be 1..$MAX_TOTAL_SERVERS"
  validate_type "$type"
  preflight

  local existing_json existing_total
  existing_json="$(servers_json all)"
  existing_total="$(jq '[.[] | select(.status != "deleting")] | length' <<< "$existing_json")"
  local existing_role
  existing_role="$(servers_json "$role" | jq '[.[] | select(.status != "deleting")] | length')"
  local needed=$((count - existing_role))
  (( needed >= 0 )) || die "$role fleet already has $existing_role servers; refusing implicit shrink"
  (( existing_total + needed <= MAX_TOTAL_SERVERS )) \
    || die "would exceed campaign server cap $MAX_TOTAL_SERVERS"
  enforce_campaign_budget "$existing_json" "$needed" "$type"
  require_spend_approval "$role" "$count" "$type"
  ensure_ssh_key
  ensure_firewall

  local occupied_names index=0 created=0 name
  occupied_names="$(servers_json "$role" | jq -r '.[] | select(.status != "deleting") | .name')"
  while (( created < needed )); do
    name="qb-load-${role}-$(printf '%02d' "$index")"
    if grep -Fxq "$name" <<< "$occupied_names"; then
      index=$((index + 1))
      continue
    fi
    printf 'Creating %s (%s, %s)…\n' "$name" "$type" "$LOCATION"
    "${HCLOUD[@]}" server create \
      --name "$name" \
      --type "$type" \
      --image "$IMAGE" \
      --location "$LOCATION" \
      --ssh-key "$SSH_KEY_NAME" \
      --firewall "$FIREWALL_NAME" \
      --without-ipv6 \
      --user-data-from-file "$SCRIPT_DIR/cloud-init.yaml" \
      --label 'quizball-load=true' \
      --label "campaign=$CAMPAIGN_ID" \
      --label "fleet=$role" \
      --label 'target=staging' \
      --label "expires-hours=$MAX_LIFETIME_HOURS" >/dev/null
    [[ -z "$occupied_names" ]] || occupied_names+=$'\n'
    occupied_names+="$name"
    created=$((created + 1))
    index=$((index + 1))
  done
  servers_json "$role" | jq -r '.[] | [.name,.server_type.name,.public_net.ipv4.ip,.status] | @tsv'
}

list_fleet() {
  local role="${1:-all}"
  servers_json "$role" | jq -r '.[] | [.name,.server_type.name,.public_net.ipv4.ip,.status,.created] | @tsv'
}

wait_ready() {
  local role="$1"
  validate_role "$role"
  local ip attempt ready
  while IFS= read -r ip; do
    ready=0
    for ((attempt = 1; attempt <= 60; attempt += 1)); do
      if "${SSH[@]}" "root@$ip" 'test -f /var/lib/quizball-load-ready' >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 5
    done
    (( ready == 1 )) || die "worker $ip did not finish cloud-init"
    printf '%s ready\n' "$ip"
  done < <(server_ips "$role")
}

upload_one() {
  local ip="$1"
  local archive="$2"
  "${SCP[@]}" "$archive" "root@$ip:/tmp/quizball-load.tar.gz"
  "${SSH[@]}" "root@$ip" \
    'rm -rf /opt/quizball-load/app && mkdir -p /opt/quizball-load/app /opt/quizball-load/reports && tar -xzf /tmp/quizball-load.tar.gz -C /opt/quizball-load/app && cd /opt/quizball-load/app && npm ci && npm run build && chown -R loadtest:loadtest /opt/quizball-load && touch /var/lib/quizball-load-app-ready'
  printf '%s source ready\n' "$ip"
}

upload() {
  local role="$1"
  validate_role "$role"
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]] \
    || die 'worktree has uncommitted or untracked changes; commit the exact tested source before upload'
  local archive
  archive="$(mktemp -t quizball-load.XXXXXX.tar.gz)"
  trap "rm -f '$archive'" EXIT
  git -C "$REPO_ROOT" archive --format=tar.gz --output="$archive" HEAD

  local ip pids=()
  while IFS= read -r ip; do
    upload_one "$ip" "$archive" &
    pids+=("$!")
  done < <(server_ips "$role")
  local pid
  for pid in "${pids[@]}"; do wait "$pid"; done
  rm -f "$archive"
  trap - EXIT
}

health() {
  local role="$1"
  validate_role "$role"
  local ip
  while IFS= read -r ip; do
    printf '\n[%s]\n' "$ip"
    "${SSH[@]}" "root@$ip" \
      "printf 'load='; cut -d' ' -f1-3 /proc/loadavg; free -h | sed -n '1,2p'; node --version; k6 version | head -1; test -f /var/lib/quizball-load-app-ready && echo app=ready || echo app=missing"
  done < <(server_ips "$role")
}

exec_fleet() {
  local role="$1"
  shift
  validate_role "$role"
  (( $# > 0 )) || die 'remote command is required'
  local command="$*"
  local ip pids=()
  while IFS= read -r ip; do
    "${SSH[@]}" "root@$ip" "cd /opt/quizball-load/app && $command" &
    pids+=("$!")
  done < <(server_ips "$role")
  local pid
  for pid in "${pids[@]}"; do wait "$pid"; done
}

collect() {
  local role="$1"
  local destination="${2:-$SCRIPT_DIR/reports/$CAMPAIGN_ID/$role}"
  validate_role "$role"
  mkdir -p "$destination"
  local ip index=0
  while IFS= read -r ip; do
    mkdir -p "$destination/worker-$(printf '%02d' "$index")"
    "${SCP[@]}" -r "root@$ip:/opt/quizball-load/reports/." \
      "$destination/worker-$(printf '%02d' "$index")/"
    index=$((index + 1))
  done < <(server_ips "$role")
  printf 'Reports collected under %s\n' "$destination"
}

destroy() {
  local role="$1"
  [[ "$role" == 'all' ]] || validate_role "$role"
  require_context
  local names
  names="$(servers_json "$role" | jq -r '.[].name')"
  if [[ -z "$names" ]]; then
    printf 'No %s campaign servers to destroy.\n' "$role"
    return
  fi
  local name
  while IFS= read -r name; do
    printf 'Deleting %s…\n' "$name"
    "${HCLOUD[@]}" server delete "$name"
  done <<< "$names"
  printf 'Fleet deletion complete.\n'
}

main() {
  require_tools
  local command="${1:-}"
  case "$command" in
    preflight) preflight ;;
    estimate) [[ $# == 3 ]] || die 'estimate requires count and type'; estimate "$2" "$3" ;;
    provision) [[ $# == 4 ]] || die 'provision requires role, count, and type'; provision "$2" "$3" "$4" ;;
    list) require_context; list_fleet "${2:-all}" ;;
    wait-ready) [[ $# == 2 ]] || die 'wait-ready requires role'; require_context; wait_ready "$2" ;;
    upload) [[ $# == 2 ]] || die 'upload requires role'; require_context; upload "$2" ;;
    health) [[ $# == 2 ]] || die 'health requires role'; require_context; health "$2" ;;
    exec) [[ $# -ge 3 ]] || die 'exec requires role and command'; require_context; shift; exec_fleet "$@" ;;
    collect) [[ $# -ge 2 && $# -le 3 ]] || die 'collect requires role and optional destination'; require_context; collect "$2" "${3:-}" ;;
    destroy) [[ $# == 2 ]] || die 'destroy requires role or all'; destroy "$2" ;;
    *) usage; [[ -z "$command" ]] || exit 1 ;;
  esac
}

main "$@"
