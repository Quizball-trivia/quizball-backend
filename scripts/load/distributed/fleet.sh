#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

HCLOUD_CONTEXT="${HCLOUD_CONTEXT:-quizball-load}"
CAMPAIGN_ID="${CAMPAIGN_ID:-quizball-staging-5k}"
LOCATION="${HCLOUD_LOCATION:-nbg1}"
IMAGE="${HCLOUD_IMAGE:-ubuntu-24.04}"
SSH_KEY_NAME="${HCLOUD_SSH_KEY_NAME:-quizball-staging-load}"
SSH_KEY_PATH="${HCLOUD_SSH_KEY_PATH:-$HOME/.ssh/quizball-staging-load}"
MAX_TOTAL_SERVERS="${MAX_TOTAL_SERVERS:-21}"
MAX_LIFETIME_HOURS="${MAX_LIFETIME_HOURS:-24}"
SERVER_BUDGET_EUR="${SERVER_BUDGET_EUR:-15}"

HCLOUD=(hcloud --context "$HCLOUD_CONTEXT")
SSH=(ssh -i "$SSH_KEY_PATH" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
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

hourly_eur() {
  case "$1" in
    cx23) printf '0.0096' ;;
    cx33) printf '0.0144' ;;
    cx43) printf '0.0264' ;;
    cx53) printf '0.0481' ;;
  esac
}

estimate() {
  local count="$1"
  local type="$2"
  [[ "$count" =~ ^[0-9]+$ ]] && (( count > 0 && count <= MAX_TOTAL_SERVERS )) \
    || die "count must be 1..$MAX_TOTAL_SERVERS"
  validate_type "$type"
  local hourly
  hourly="$(hourly_eur "$type")"
  awk -v n="$count" -v h="$hourly" -v lifetime="$MAX_LIFETIME_HOURS" -v type="$type" \
    'BEGIN { printf "servers=%d type=%s hourly=€%.4f 12h=€%.2f max_lifetime_%dh=€%.2f (ex VAT)\n", n, type, n*h, n*h*12, lifetime, n*h*lifetime }'
  local projected
  projected="$(awk -v n="$count" -v h="$hourly" -v lifetime="$MAX_LIFETIME_HOURS" 'BEGIN { print n*h*lifetime }')"
  awk -v projected="$projected" -v cap="$SERVER_BUDGET_EUR" \
    'BEGIN { if (projected > cap) exit 1 }' \
    || die "projected server cost €$projected exceeds fleet cap €$SERVER_BUDGET_EUR"
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
  fi
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
  estimate "$count" "$type"
  preflight
  ensure_ssh_key

  local existing_total
  existing_total="$(servers_json all | jq 'length')"
  local existing_role
  existing_role="$(servers_json "$role" | jq 'length')"
  local needed=$((count - existing_role))
  (( needed >= 0 )) || die "$role fleet already has $existing_role servers; refusing implicit shrink"
  (( existing_total + needed <= MAX_TOTAL_SERVERS )) \
    || die "would exceed campaign server cap $MAX_TOTAL_SERVERS"

  local index name
  for ((index = existing_role; index < count; index += 1)); do
    name="qb-load-${role}-$(printf '%02d' "$index")"
    printf 'Creating %s (%s, %s)…\n' "$name" "$type" "$LOCATION"
    "${HCLOUD[@]}" server create \
      --name "$name" \
      --type "$type" \
      --image "$IMAGE" \
      --location "$LOCATION" \
      --ssh-key "$SSH_KEY_NAME" \
      --without-ipv6 \
      --user-data-from-file "$SCRIPT_DIR/cloud-init.yaml" \
      --label 'quizball-load=true' \
      --label "campaign=$CAMPAIGN_ID" \
      --label "fleet=$role" \
      --label 'target=staging' \
      --label "expires-hours=$MAX_LIFETIME_HOURS" >/dev/null
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
  git -C "$REPO_ROOT" diff --quiet || die 'worktree has uncommitted changes; commit the exact tested source before upload'
  git -C "$REPO_ROOT" diff --cached --quiet || die 'worktree has staged but uncommitted changes'
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
