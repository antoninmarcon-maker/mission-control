#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
STATE_DIR=${MC_POC_STATE_DIR:-}
PORT=${MC_POC_PORT:-4318}
HOST=${MC_POC_HOST:-127.0.0.1}
EXTRA_HOSTS=${MC_POC_EXTRA_ALLOWED_HOSTS:-}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

validate_scope() {
  [[ -n "$STATE_DIR" ]] || die "MC_POC_STATE_DIR must be an explicit absolute path"
  [[ "$STATE_DIR" == /* ]] || die "MC_POC_STATE_DIR must be absolute"
  [[ "$STATE_DIR" != "/" && "$STATE_DIR" != "$REPO_ROOT" ]] || die "unsafe MC_POC_STATE_DIR"
  [[ "$HOST" == "127.0.0.1" ]] || die "MC_POC_HOST must be 127.0.0.1"
  [[ "$PORT" =~ ^[0-9]+$ ]] || die "MC_POC_PORT must be numeric"
  (( PORT >= 1 && PORT <= 65535 )) || die "MC_POC_PORT must be between 1 and 65535"
  [[ "$PORT" != "4317" ]] || die "port 4317 is reserved for the existing Dash"
  if [[ -n "$EXTRA_HOSTS" ]]; then
    [[ "$EXTRA_HOSTS" =~ ^[A-Za-z0-9.-]+(,[A-Za-z0-9.-]+)*$ ]] || die "MC_POC_EXTRA_ALLOWED_HOSTS must be comma-separated hostnames (no spaces, no wildcards)"
  fi
}

allowed_hosts() {
  local hosts='localhost,127.0.0.1,::1'
  [[ -z "$EXTRA_HOSTS" ]] || hosts="$hosts,$EXTRA_HOSTS"
  printf '%s\n' "$hosts"
}

env_file() { printf '%s/runtime.env\n' "$STATE_DIR"; }
pid_file() { printf '%s/mission-control.pid\n' "$STATE_DIR"; }
log_file() { printf '%s/mission-control.log\n' "$STATE_DIR"; }

write_runtime_env() {
  local target=$1
  local api_key auth_pass auth_secret
  api_key=$(openssl rand -hex 32)
  auth_pass=$(openssl rand -hex 16)
  auth_secret=$(openssl rand -hex 32)

  umask 077
  {
    printf 'PORT=%q\n' "$PORT"
    printf 'MC_POC_HOST=%q\n' "$HOST"
    printf 'MC_ALLOWED_HOSTS=%s\n' "$(allowed_hosts)"
    printf 'NEXT_PUBLIC_GATEWAY_OPTIONAL=%q\n' 'true'
    printf 'MISSION_CONTROL_DATA_DIR=%q\n' "$STATE_DIR/data"
    printf 'MISSION_CONTROL_TOKENS_PATH=%q\n' "$STATE_DIR/data/mission-control-tokens.json"
    printf 'OPENCLAW_STATE_DIR=%q\n' "$STATE_DIR/openclaw"
    printf 'OPENCLAW_WORKSPACE_DIR=%q\n' "$STATE_DIR/workspace"
    printf 'OPENCLAW_MEMORY_DIR=%q\n' "$STATE_DIR/memory"
    printf 'OPENCLAW_LOG_DIR=%q\n' "$STATE_DIR/logs"
    printf 'LOCAL_LLM_ENDPOINT=%q\n' 'http://127.0.0.1:11434/v1'
    printf 'AUTH_USER=%q\n' 'antonin-poc'
    printf 'AUTH_PASS=%q\n' "$auth_pass"
    printf 'AUTH_SECRET=%q\n' "$auth_secret"
    printf 'API_KEY=%q\n' "$api_key"
  } > "$target"
  chmod 600 "$target"
}

init_state() {
  validate_scope
  mkdir -p "$STATE_DIR/data" "$STATE_DIR/openclaw" "$STATE_DIR/workspace" "$STATE_DIR/memory" "$STATE_DIR/logs"
  local runtime_env
  runtime_env=$(env_file)
  if [[ ! -f "$runtime_env" ]]; then
    write_runtime_env "$runtime_env"
    echo "Initialized isolated POC state: $STATE_DIR"
  else
    chmod 600 "$runtime_env"
    echo "POC state already initialized: $STATE_DIR"
  fi
}

load_runtime_env() {
  local runtime_env
  runtime_env=$(env_file)
  [[ -f "$runtime_env" ]] || die "runtime state is not initialized"
  set -a
  # shellcheck disable=SC1090
  source "$runtime_env"
  set +a
}

is_running() {
  local file pid
  file=$(pid_file)
  [[ -f "$file" ]] || return 1
  pid=$(<"$file")
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

start_server() {
  init_state >/dev/null
  load_runtime_env
  if is_running; then
    echo "Mission Control POC already running at http://$HOST:$PORT"
    return 0
  fi
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $PORT is already in use"
  fi

  local log pidfile
  log=$(log_file)
  pidfile=$(pid_file)
  (
    cd "$REPO_ROOT"
    nohup corepack pnpm dev >"$log" 2>&1 &
    printf '%s\n' "$!" > "$pidfile"
  )

  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 2 "http://$HOST:$PORT/api/health" >/dev/null 2>&1; then
      echo "Mission Control POC started: http://$HOST:$PORT"
      return 0
    fi
    if ! is_running; then
      die "Mission Control exited during startup; inspect $log"
    fi
    sleep 1
  done

  stop_server >/dev/null || true
  die "Mission Control did not become healthy within 60 seconds; inspect $log"
}

stop_server() {
  validate_scope
  local file pid
  file=$(pid_file)
  if ! is_running; then
    [[ -f "$file" ]] && unlink "$file"
    echo "Mission Control POC is stopped"
    return 0
  fi

  pid=$(<"$file")
  kill "$pid"
  local attempt
  for attempt in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      unlink "$file"
      echo "Mission Control POC stopped"
      return 0
    fi
    sleep 1
  done
  die "process $pid did not stop; no forced kill was attempted"
}

show_status() {
  validate_scope
  if is_running && curl -fsS --max-time 2 "http://$HOST:$PORT/api/health" >/dev/null 2>&1; then
    echo "running http://$HOST:$PORT"
  else
    echo "stopped http://$HOST:$PORT"
  fi
}

show_config() {
  validate_scope
  load_runtime_env
  echo "URL=http://$HOST:$PORT"
  echo "STATE_DIR=$STATE_DIR"
  echo "DATA_DIR=$MISSION_CONTROL_DATA_DIR"
  echo "LOCAL_LLM_ENDPOINT=$LOCAL_LLM_ENDPOINT"
  echo "CREDENTIALS=redacted"
}

rollback_state() {
  validate_scope
  if [[ ! -e "$STATE_DIR" ]]; then
    echo "No POC state to archive: $STATE_DIR"
    return 0
  fi
  stop_server >/dev/null || true
  local archive
  archive="${STATE_DIR}.archive.$(date -u +%Y%m%dT%H%M%SZ)"
  [[ ! -e "$archive" ]] || die "archive target already exists: $archive"
  mv "$STATE_DIR" "$archive"
  echo "Archived POC state to: $archive"
}

update_hosts() {
  validate_scope
  local runtime_env tmp
  runtime_env=$(env_file)
  [[ -f "$runtime_env" ]] || die "runtime state is not initialized"
  umask 077
  tmp="$STATE_DIR/runtime.env.tmp"
  awk -v line="MC_ALLOWED_HOSTS=$(allowed_hosts)" '/^MC_ALLOWED_HOSTS=/ {print line; next} {print}' "$runtime_env" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$runtime_env"
  echo "MC_ALLOWED_HOSTS=$(allowed_hosts)"
  echo "Restart Mission Control (stop, then start) to apply the new host allowlist."
}

usage() {
  echo "Usage: MC_POC_STATE_DIR=/absolute/path $0 init|start|status|stop|rollback|config|update-hosts"
}

command=${1:-}
case "$command" in
  init) init_state ;;
  start) start_server ;;
  status) show_status ;;
  stop) stop_server ;;
  rollback) rollback_state ;;
  config) show_config ;;
  update-hosts) update_hosts ;;
  *) usage; exit 2 ;;
esac
