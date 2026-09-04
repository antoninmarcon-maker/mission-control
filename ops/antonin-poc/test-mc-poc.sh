#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LAUNCHER="$SCRIPT_DIR/mc-poc.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/mc-poc-test.XXXXXX")

cleanup() {
  if [[ "$TEST_ROOT" == "${TMPDIR:-/tmp}/mc-poc-test."* && -d "$TEST_ROOT" ]]; then
    rm -rf -- "$TEST_ROOT"
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file=$1
  local expected=$2
  grep -Fq -- "$expected" "$file" || fail "$file does not contain: $expected"
}

[[ -f "$LAUNCHER" ]] || fail "launcher missing: $LAUNCHER"

blocked_port_out="$TEST_ROOT/blocked-port.out"
if MC_POC_STATE_DIR="$TEST_ROOT/blocked-port" MC_POC_PORT=4317 bash "$LAUNCHER" init >"$blocked_port_out" 2>&1; then
  fail "port 4317 must be refused"
fi
assert_contains "$blocked_port_out" "4317"

blocked_host_out="$TEST_ROOT/blocked-host.out"
if MC_POC_STATE_DIR="$TEST_ROOT/blocked-host" MC_POC_HOST=0.0.0.0 bash "$LAUNCHER" init >"$blocked_host_out" 2>&1; then
  fail "non-loopback host must be refused"
fi
assert_contains "$blocked_host_out" "127.0.0.1"

blocked_extra_out="$TEST_ROOT/blocked-extra.out"
if MC_POC_STATE_DIR="$TEST_ROOT/blocked-extra" MC_POC_EXTRA_ALLOWED_HOSTS='mac.ts.net evil.example' bash "$LAUNCHER" init >"$blocked_extra_out" 2>&1; then
  fail "extra hosts with spaces must be refused"
fi
assert_contains "$blocked_extra_out" "MC_POC_EXTRA_ALLOWED_HOSTS"
if MC_POC_STATE_DIR="$TEST_ROOT/blocked-extra" MC_POC_EXTRA_ALLOWED_HOSTS='*' bash "$LAUNCHER" init >"$blocked_extra_out" 2>&1; then
  fail "wildcard extra host must be refused"
fi
assert_contains "$blocked_extra_out" "MC_POC_EXTRA_ALLOWED_HOSTS"

state_dir="$TEST_ROOT/runtime"
init_out="$TEST_ROOT/init.out"
MC_POC_STATE_DIR="$state_dir" bash "$LAUNCHER" init >"$init_out"

env_file="$state_dir/runtime.env"
[[ -f "$env_file" ]] || fail "runtime.env was not created"
[[ "$(stat -f '%Lp' "$env_file")" == "600" ]] || fail "runtime.env must have mode 600"
assert_contains "$env_file" "PORT=4318"
assert_contains "$env_file" "MC_POC_HOST=127.0.0.1"
assert_contains "$env_file" "MISSION_CONTROL_DATA_DIR=$state_dir/data"
assert_contains "$env_file" "LOCAL_LLM_ENDPOINT=http://127.0.0.1:11434/v1"
assert_contains "$env_file" "MC_ALLOWED_HOSTS=localhost,127.0.0.1,::1"

api_key=$(awk -F= '$1=="API_KEY" {print $2}' "$env_file")
auth_pass=$(awk -F= '$1=="AUTH_PASS" {print $2}' "$env_file")
[[ -n "$api_key" && -n "$auth_pass" ]] || fail "credentials were not generated"
if grep -Fq -- "$api_key" "$init_out" || grep -Fq -- "$auth_pass" "$init_out"; then
  fail "init output leaked a credential"
fi

status_out="$TEST_ROOT/status.out"
MC_POC_STATE_DIR="$state_dir" bash "$LAUNCHER" status >"$status_out"
assert_contains "$status_out" "stopped"

config_out="$TEST_ROOT/config.out"
MC_POC_STATE_DIR="$state_dir" bash "$LAUNCHER" config >"$config_out"
assert_contains "$config_out" "http://127.0.0.1:4318"
assert_contains "$config_out" "$state_dir/data"
if grep -Fq -- "$api_key" "$config_out" || grep -Fq -- "$auth_pass" "$config_out"; then
  fail "config output leaked a credential"
fi

hosts_state_dir="$TEST_ROOT/runtime-hosts"
MC_POC_STATE_DIR="$hosts_state_dir" MC_POC_EXTRA_ALLOWED_HOSTS='mac.tailnet-test.ts.net' bash "$LAUNCHER" init >"$TEST_ROOT/hosts-init.out"
hosts_env_file="$hosts_state_dir/runtime.env"
assert_contains "$hosts_env_file" "MC_ALLOWED_HOSTS=localhost,127.0.0.1,::1,mac.tailnet-test.ts.net"
assert_contains "$hosts_env_file" "MC_POC_HOST=127.0.0.1"

hosts_api_key=$(awk -F= '$1=="API_KEY" {print $2}' "$hosts_env_file")
update_out="$TEST_ROOT/update-hosts.out"
MC_POC_STATE_DIR="$hosts_state_dir" MC_POC_EXTRA_ALLOWED_HOSTS='other.tailnet-test.ts.net' bash "$LAUNCHER" update-hosts >"$update_out"
assert_contains "$update_out" "MC_ALLOWED_HOSTS=localhost,127.0.0.1,::1,other.tailnet-test.ts.net"
assert_contains "$hosts_env_file" "MC_ALLOWED_HOSTS=localhost,127.0.0.1,::1,other.tailnet-test.ts.net"
[[ "$(stat -f '%Lp' "$hosts_env_file")" == "600" ]] || fail "update-hosts must preserve mode 600"
[[ "$(awk -F= '$1=="API_KEY" {print $2}' "$hosts_env_file")" == "$hosts_api_key" ]] || fail "update-hosts must not touch credentials"
if grep -Fq -- "$hosts_api_key" "$update_out"; then
  fail "update-hosts output leaked a credential"
fi

MC_POC_STATE_DIR="$hosts_state_dir" bash "$LAUNCHER" update-hosts >"$update_out"
assert_contains "$hosts_env_file" "MC_ALLOWED_HOSTS=localhost,127.0.0.1,::1"
if grep -Fq -- "ts.net" "$hosts_env_file"; then
  fail "update-hosts without extra hosts must reset to the loopback allowlist"
fi

fake_bin="$TEST_ROOT/fake-bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/pnpm" <<'SH'
#!/usr/bin/env bash
echo "unversioned pnpm was used" >&2
exit 42
SH
cat > "$fake_bin/corepack" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$MC_POC_STATE_DIR/corepack.args"
while :; do sleep 1; done
SH
cat > "$fake_bin/lsof" <<'SH'
#!/usr/bin/env bash
exit 1
SH
cat > "$fake_bin/curl" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$fake_bin/pnpm" "$fake_bin/corepack" "$fake_bin/lsof" "$fake_bin/curl"
PATH="$fake_bin:$PATH" MC_POC_STATE_DIR="$state_dir" bash "$LAUNCHER" start > "$TEST_ROOT/start.out"
for _ in $(seq 1 20); do
  [[ -f "$state_dir/corepack.args" ]] && break
  sleep 0.05
done
assert_contains "$state_dir/corepack.args" "pnpm dev"
PATH="$fake_bin:$PATH" MC_POC_STATE_DIR="$state_dir" bash "$LAUNCHER" stop > "$TEST_ROOT/stop.out"

mkdir -p "$state_dir/data"
printf 'sentinel\n' > "$state_dir/data/sentinel.txt"
rollback_out="$TEST_ROOT/rollback.out"
MC_POC_STATE_DIR="$state_dir" bash "$LAUNCHER" rollback >"$rollback_out"
[[ ! -e "$state_dir" ]] || fail "rollback must move the active state directory"
archive_dir=$(find "$TEST_ROOT" -maxdepth 1 -type d -name 'runtime.archive.*' -print -quit)
[[ -n "$archive_dir" && -f "$archive_dir/data/sentinel.txt" ]] || fail "rollback archive is missing state"
assert_contains "$rollback_out" "Archived"

echo "PASS: mc-poc launcher safety contract"
