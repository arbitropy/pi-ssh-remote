#!/usr/bin/env bash
# Mock SSH environment for pi-ssh-remote integration tests.
# Usage: mock-env.sh {up [--no-known-hosts] | down | status | env | reset-state}
set -euo pipefail

ROOT="${MOCK_ROOT:-/tmp/pi-ssh-mock}"
MOCK_PROVIDER="${MOCK_PROVIDER:-islam}"
MOCK_MODEL="${MOCK_MODEL:-qwen3.8-27b}"
MOCK_MODELS_JSON="${MOCK_MODELS_JSON:-/mnt/data/work/Personal/pi-env/profiles/main/models.json}"
PI_SSH_EXT="${PI_SSH_EXT:-/mnt/data/work/Personal/pi-ssh-remote/index.ts}"
PI_BIN="${PI_BIN:-/mnt/data/work/Personal/pi-env/node_modules/.bin/pi}"
SSHD=/usr/bin/sshd
SERVERS=(prod:2231 staging:2232 bench:2233)
ME="$(id -un)"

die() { echo "mock-env: $*" >&2; exit 1; }

find_sftp_server() {
  local p
  for p in /usr/lib/ssh/sftp-server /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/libexec/sftp-server /usr/lib/sftp-server; do
    [[ -x $p ]] && { echo "$p"; return; }
  done
  die "sftp-server not found"
}

gen_keys() {
  mkdir -p "$ROOT/keys"; chmod 700 "$ROOT/keys"
  [[ -f $ROOT/keys/client ]] || ssh-keygen -q -t ed25519 -N '' -C mock-client -f "$ROOT/keys/client"
  [[ -f $ROOT/keys/client_enc ]] || ssh-keygen -q -t ed25519 -N 'testpass' -C mock-client-enc -f "$ROOT/keys/client_enc"
  cat "$ROOT/keys/client.pub" "$ROOT/keys/client_enc.pub" > "$ROOT/keys/authorized_keys"
  chmod 600 "$ROOT/keys/authorized_keys"
  local s name
  for s in "${SERVERS[@]}"; do
    name="${s%%:*}"
    [[ -f $ROOT/keys/host_$name ]] || ssh-keygen -q -t ed25519 -N '' -C "mock-host-$name" -f "$ROOT/keys/host_$name"
  done
}

write_sshd_configs() {
  local sftp s name port
  sftp="$(find_sftp_server)"
  mkdir -p "$ROOT/run" "$ROOT/log" "$ROOT/conf"
  for s in "${SERVERS[@]}"; do
    name="${s%%:*}"; port="${s##*:}"
    cat > "$ROOT/conf/$name.conf" <<CONF
Port $port
ListenAddress 127.0.0.1
HostKey $ROOT/keys/host_$name
PidFile $ROOT/run/$name.pid
AuthorizedKeysFile $ROOT/keys/authorized_keys
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
AllowUsers $ME
Subsystem sftp $sftp
SetEnv MOCK_HOST=$name
LogLevel VERBOSE
CONF
  done
}

make_repo() { # dir
  local d="$1"
  (cd "$d" && git init -q -b main . 2>/dev/null || git init -q .
   git config user.name "Mock User"; git config user.email "mock@example.invalid"
   git config commit.gpgsign false
   git add -A && git commit -q -m "initial commit")
}

build_host_tree() { # name
  local name="$1" NAME app
  NAME="$(echo "$name" | tr a-z A-Z)"
  app="$ROOT/hosts/$name/app"
  [[ -d $app/.git ]] && return 0   # keep existing fixtures (idempotent)
  rm -rf "$app"
  mkdir -p "$app/src/api" "$app/logs" "$app/node_modules"
  echo "This is the $NAME server project (marker $NAME-MARKER-7731)." > "$app/AGENTS.md"
  [[ $name == prod ]] && echo "Production rules: never restart services without approval." > "$app/CLAUDE.md"
  cat > "$app/src/app.py" <<PY
"""$name application entry point."""
import os


def main():
    print("starting $name app")


def handle_payment(order_id, amount):
    if amount <= 0:
        raise ValueError("invalid amount")
    return {"order": order_id, "amount": amount, "host": "$name"}


def health_check():
    return "ok"


if __name__ == "__main__":
    main()
PY
  printf 'from .views import index\n' > "$app/src/api/__init__.py"
  cat > "$app/src/api/views.py" <<PY
def index(request):
    return "hello from $name"


def refund(request, order_id):
    return {"refunded": order_id}
PY
  echo "module.exports = 'junk $name handle_payment(';" > "$app/node_modules/junk.js"
  python3 -I - "$app/logs/error.log" "$name" <<'PY'
import sys
path, name = sys.argv[1:3]
with open(path, "w") as f:
    for i in range(1, 2001):
        if i == 1500:
            f.write(f"2026-01-01T00:25:00Z ERROR PaymentGateway timeout ref={name}-1500\n")
        else:
            f.write(f"2026-01-01T00:00:{i%60:02d}Z INFO request {i} ok\n")
PY
  python3 -I - "$app/big.txt" <<'PY'
import sys
with open(sys.argv[1], "w") as f:
    for i in range(1, 801):
        f.write(f"line {i:04d} " + "x" * 40 + "\n")   # ~ 40 KB
PY
  make_repo "$app"
}

build_local_project() {
  local d="$ROOT/local/project"
  [[ -d $d/.git ]] && return 0
  mkdir -p "$d/src"
  echo "This is the LOCAL project (marker LOCAL-MARKER-4410)." > "$d/AGENTS.md"
  cat > "$d/src/app.py" <<'PY'
def local_main():
    return "local"
PY
  make_repo "$d"
}

build_home() {
  local h="$ROOT/home" s name port
  mkdir -p "$h/.ssh"; chmod 700 "$h/.ssh"
  : > "$h/.ssh/config"
  for s in "${SERVERS[@]}"; do
    name="${s%%:*}"; port="${s##*:}"
    cat >> "$h/.ssh/config" <<CONF
Host mock-$name
  HostName 127.0.0.1
  Port $port
  User $ME
  IdentityFile $ROOT/keys/client
  IdentitiesOnly yes

CONF
  done
  cat >> "$h/.ssh/config" <<CONF
Host mock-prod-enc
  HostName 127.0.0.1
  Port 2231
  User $ME
  IdentityFile $ROOT/keys/client_enc
  IdentitiesOnly yes
CONF
  chmod 600 "$h/.ssh/config"
}

host_hash_hex() { # pubkey file -> lowercase hex sha256 of key blob
  awk '{print $2}' "$1" | base64 -d | sha256sum | awk '{print $1}'
}

build_agent() { # $1 = skip known hosts (0/1)
  local a="$ROOT/agent" s name port
  mkdir -p "$a"
  # models.json: only the selected provider (never echoed)
  node -e '
    const fs = require("fs");
    const [src, dst, prov] = process.argv.slice(1);
    const j = JSON.parse(fs.readFileSync(src, "utf8"));
    if (!j.providers || !j.providers[prov]) { console.error("provider not found: " + prov); process.exit(1); }
    const out = { ...j, providers: { [prov]: j.providers[prov] } };
    fs.writeFileSync(dst, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  ' "$MOCK_MODELS_JSON" "$a/models.json" "$MOCK_PROVIDER" || die "failed to build models.json"
  node -e '
    const [dst, prov, model] = process.argv.slice(1);
    require("fs").writeFileSync(dst, JSON.stringify({
      defaultProvider: prov, defaultModel: model, quietStartup: "header",
      enableInstallTelemetry: false, defaultTools: ["+grep", "+find", "+ls"], packages: []
    }, null, 2) + "\n");
  ' "$a/settings.json" "$MOCK_PROVIDER" "$MOCK_MODEL"
  if [[ $1 == 0 ]]; then
    local entries=()
    for s in "${SERVERS[@]}"; do
      name="${s%%:*}"; port="${s##*:}"
      entries+=("127.0.0.1:$port=$(host_hash_hex "$ROOT/keys/host_$name.pub")")
    done
    KH="$a/ssh-remote-known-hosts.json" node -e '
      const o = {};
      for (const e of process.argv.slice(1)) { const i = e.indexOf("="); o[e.slice(0, i)] = e.slice(i + 1); }
      require("fs").writeFileSync(process.env.KH, JSON.stringify(o, null, 2) + "\n", { mode: 0o600 });
    ' "${entries[@]}"
  else
    rm -f "$a/ssh-remote-known-hosts.json"
  fi
}

port_of() { local s; for s in "${SERVERS[@]}"; do [[ ${s%%:*} == "$1" ]] && echo "${s##*:}"; done; }

is_up() { # name
  local pf="$ROOT/run/$1.pid" pid
  [[ -f $pf ]] || return 1
  pid="$(cat "$pf" 2>/dev/null)" || return 1
  [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null
}

stop_server() { # name
  local pf="$ROOT/run/$1.pid" pid i
  if [[ -f $pf ]]; then
    pid="$(cat "$pf" 2>/dev/null || true)"
    if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for i in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pf"
  fi
}

probe() { # name -> prints MOCK_HOST
  ssh -F none -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    -o IdentitiesOnly=yes -i "$ROOT/keys/client" -p "$(port_of "$1")" "$ME@127.0.0.1" 'echo $MOCK_HOST'
}

cmd_up() {
  local skip=0
  for a in "$@"; do [[ $a == --no-known-hosts ]] && skip=1; done
  mkdir -p "$ROOT"
  gen_keys
  write_sshd_configs
  local s name port out
  for s in "${SERVERS[@]}"; do build_host_tree "${s%%:*}"; done
  build_local_project
  build_home
  build_agent "$skip"
  for s in "${SERVERS[@]}"; do
    name="${s%%:*}"; port="${s##*:}"
    stop_server "$name"
    : > "$ROOT/log/$name.log"
    "$SSHD" -f "$ROOT/conf/$name.conf" -E "$ROOT/log/$name.log" || die "sshd $name failed to start (see $ROOT/log/$name.log)"
  done
  local fail=0 i
  for s in "${SERVERS[@]}"; do
    name="${s%%:*}"; out=""
    for i in 1 2 3 4 5; do out="$(probe "$name" 2>/dev/null || true)"; [[ $out == "$name" ]] && break; sleep 0.3; done
    if [[ $out == "$name" ]]; then echo "ok   $name (port ${s##*:}) MOCK_HOST=$out"
    else echo "FAIL $name (port ${s##*:}) got '${out}' (see $ROOT/log/$name.log)"; fail=1; fi
  done
  return $fail
}

cmd_down() {
  local s
  for s in "${SERVERS[@]}"; do stop_server "${s%%:*}"; done
  echo "all mock sshds stopped"
}

cmd_status() {
  local s name rc=0
  for s in "${SERVERS[@]}"; do
    name="${s%%:*}"
    if is_up "$name"; then echo "$name 127.0.0.1:${s##*:} up (pid $(cat "$ROOT/run/$name.pid"))"
    else echo "$name 127.0.0.1:${s##*:} down"; rc=1; fi
  done
  return $rc
}

cmd_env() {
  cat <<ENV
export HOME='$ROOT/home'
export PI_CODING_AGENT_DIR='$ROOT/agent'
export MOCK_ROOT='$ROOT'
export PI_SSH_EXT='$PI_SSH_EXT'
export PI_BIN='$PI_BIN'
export MOCK_LOCAL_PROJECT='$ROOT/local/project'
ENV
}

cmd_reset_state() {
  rm -rf "$ROOT/agent/ssh-remote-config.json" "$ROOT/agent/ssh-remote-config.v1.backup.json" "$ROOT/agent/ssh-remote-memories" "$ROOT/agent/sessions"
  echo "extension state reset in $ROOT/agent"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  down) cmd_down ;;
  status) cmd_status ;;
  env) cmd_env ;;
  reset-state) cmd_reset_state ;;
  *) echo "usage: $0 {up [--no-known-hosts]|down|status|env|reset-state}" >&2; exit 2 ;;
esac
