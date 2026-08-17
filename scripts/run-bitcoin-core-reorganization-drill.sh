#!/usr/bin/env bash
set -euo pipefail

# This is an isolated consensus/backend acceptance drill. The user-facing
# application remains mainnet-only; regtest is never accepted by production
# configuration or used to claim live-mainnet readiness.

readonly CORE_VERSION='31.1'
readonly CORE_ARCHIVE='bitcoin-31.1-x86_64-linux-gnu.tar.gz'
readonly CORE_SHA256='b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e'
readonly CORE_URL="https://bitcoincore.org/bin/bitcoin-core-${CORE_VERSION}/${CORE_ARCHIVE}"
readonly DEFAULT_CORE_ROOT='/home/codex/.cache/btc-multiplayer-vault/bitcoin-core-31.1'
readonly DEFAULT_POSTGRES_BIN='/home/codex/.cache/btc-multiplayer-vault/postgresql-16.14/usr/lib/postgresql/16/bin'
readonly DEFAULT_POSTGRES_LIB='/home/codex/.cache/btc-multiplayer-vault/postgresql-16.14/usr/lib/x86_64-linux-gnu'

work_dir=$(mktemp -d /tmp/btc-vault-core-reorganization.XXXXXX)
core_started=false
postgres_started=false

cleanup() {
  safe_to_trash=true
  if [ "$core_started" = true ]; then
    "$core_bin/bitcoin-cli" -regtest -datadir="$work_dir/core" -rpcport="$core_rpc_port" stop >/dev/null 2>&1 || true
    core_pid_file="$work_dir/core/regtest/bitcoind.pid"
    if [ -f "$core_pid_file" ]; then
      core_pid=$(<"$core_pid_file")
      if [[ "$core_pid" =~ ^[0-9]+$ ]]; then
        for _attempt in $(seq 1 100); do
          if ! kill -0 "$core_pid" >/dev/null 2>&1; then break; fi
          sleep 0.1
        done
        if kill -0 "$core_pid" >/dev/null 2>&1; then safe_to_trash=false; fi
      fi
    fi
  fi
  if [ "$postgres_started" = true ]; then
    "$postgres_bin/pg_ctl" -D "$work_dir/postgres" -m immediate stop >/dev/null 2>&1 || true
    postgres_pid_file="$work_dir/postgres/postmaster.pid"
    if [ -f "$postgres_pid_file" ]; then
      postgres_pid=$(head -n 1 "$postgres_pid_file")
      if [[ "$postgres_pid" =~ ^[0-9]+$ ]] && kill -0 "$postgres_pid" >/dev/null 2>&1; then
        safe_to_trash=false
      fi
    fi
  fi
  if [ "$safe_to_trash" = true ]; then
    gio trash "$work_dir" >/dev/null 2>&1 || true
  else
    echo "An isolated drill service did not stop; preserved its data at $work_dir" >&2
  fi
}
trap cleanup EXIT INT TERM

case "$(uname -m)" in
  x86_64) ;;
  *)
    if [ -z "${BITCOIN_CORE_BIN:-}" ]; then
      echo 'BITCOIN_CORE_BIN is required on non-x86_64 hosts' >&2
      exit 1
    fi
    ;;
esac

node_executable=${NODE_EXECUTABLE:-}
if [ -z "$node_executable" ]; then
  node_executable=$(command -v node)
fi
"$node_executable" scripts/check-runtime.mjs
node_bin=$(dirname "$node_executable")

core_bin=${BITCOIN_CORE_BIN:-$DEFAULT_CORE_ROOT/bin}
if [ ! -x "$core_bin/bitcoind" ] || [ ! -x "$core_bin/bitcoin-cli" ]; then
  if [ -n "${BITCOIN_CORE_BIN:-}" ]; then
    echo 'BITCOIN_CORE_BIN must contain executable bitcoind and bitcoin-cli files' >&2
    exit 1
  fi
  mkdir -p "$(dirname "$DEFAULT_CORE_ROOT")"
  curl -fL --retry 3 --output "$work_dir/$CORE_ARCHIVE" "$CORE_URL"
  printf '%s  %s\n' "$CORE_SHA256" "$work_dir/$CORE_ARCHIVE" | sha256sum --check --status
  tar -xzf "$work_dir/$CORE_ARCHIVE" -C "$work_dir"
  mv "$work_dir/bitcoin-$CORE_VERSION" "$DEFAULT_CORE_ROOT"
  core_bin="$DEFAULT_CORE_ROOT/bin"
fi

postgres_bin=${POSTGRES_BIN:-$DEFAULT_POSTGRES_BIN}
if [ ! -x "$postgres_bin/initdb" ] || [ ! -x "$postgres_bin/pg_ctl" ]; then
  echo 'PostgreSQL 16 initdb and pg_ctl are required; set POSTGRES_BIN to their directory' >&2
  exit 1
fi
if [ -n "${POSTGRES_LIB:-}" ]; then
  export LD_LIBRARY_PATH="${POSTGRES_LIB}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
elif [ -z "${POSTGRES_BIN:-}" ] && [ -d "$DEFAULT_POSTGRES_LIB" ]; then
  export LD_LIBRARY_PATH="${DEFAULT_POSTGRES_LIB}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

free_port() {
  "$node_executable" -e "const n=require('node:net').createServer();n.listen(0,'127.0.0.1',()=>{process.stdout.write(String(n.address().port));n.close()})"
}

postgres_port=$(free_port)
core_rpc_port=$(free_port)
core_p2p_port=$(free_port)

"$postgres_bin/initdb" -D "$work_dir/postgres" --auth=trust --no-locale --encoding=UTF8 >/dev/null
postgres_started=true
"$postgres_bin/pg_ctl" -D "$work_dir/postgres" \
  -o "-h 127.0.0.1 -p $postgres_port -k $work_dir" \
  -l "$work_dir/postgres.log" start >/dev/null

mkdir -p "$work_dir/core"
core_started=true
"$core_bin/bitcoind" \
  -regtest \
  -datadir="$work_dir/core" \
  -daemonwait \
  -server=1 \
  -txindex=1 \
  -fallbackfee=0.00001 \
  -listen=0 \
  -rpcbind=127.0.0.1 \
  -rpcallowip=127.0.0.1 \
  -rpcport="$core_rpc_port" \
  -port="$core_p2p_port" >/dev/null

export PATH="$node_bin:$PATH"
database_user=$(id -un)
export DATABASE_URL="postgresql://${database_user}@127.0.0.1:${postgres_port}/postgres"
export BITCOIN_CORE_DRILL_RPC_URL="http://127.0.0.1:${core_rpc_port}"
export BITCOIN_CORE_DRILL_COOKIE_FILE="$work_dir/core/regtest/.cookie"

npm run web:migrate >/dev/null
NODE_OPTIONS=--conditions=react-server node --import tsx \
  web/tests/bitcoin-core-reorganization-db-acceptance.ts

printf 'Bitcoin Core %s and PostgreSQL %s completed the isolated reorganization drill.\n' \
  "$CORE_VERSION" "$("$postgres_bin/postgres" --version | awk '{print $3}')"
