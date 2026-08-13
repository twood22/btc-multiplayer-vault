#!/usr/bin/env bash
set -euo pipefail

# Isolated production-bundle acceptance only. The application remains
# mainnet-only; synthetic public registrations and coin observations used by
# the browser tests are explicit prerequisites, never live Sigbash or funding
# evidence.

readonly DEFAULT_POSTGRES_BIN='/home/codex/.cache/btc-multiplayer-vault/postgresql-16.14/usr/lib/postgresql/16/bin'
readonly DEFAULT_POSTGRES_LIB='/home/codex/.cache/btc-multiplayer-vault/postgresql-16.14/usr/lib/x86_64-linux-gnu'

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repository_root"

node_executable=${NODE_EXECUTABLE:-}
if [ -z "$node_executable" ]; then
  node_executable=$(command -v node)
fi
"$node_executable" scripts/check-runtime.mjs
node_bin=$(dirname "$node_executable")
export PATH="$node_bin:$PATH"

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

work_dir=$(mktemp -d /tmp/btc-vault-production-browser.XXXXXX)
postgres_started=false
web_started=false
acceptance_passed=false

cleanup() {
  safe_to_trash=true
  if [ "$acceptance_passed" != true ]; then safe_to_trash=false; fi
  if [ "$web_started" = true ]; then
    kill "$web_pid" >/dev/null 2>&1 || true
    wait "$web_pid" >/dev/null 2>&1 || true
    if kill -0 "$web_pid" >/dev/null 2>&1; then safe_to_trash=false; fi
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
    echo "An isolated acceptance service did not stop; preserved its data at $work_dir" >&2
  fi
}
trap cleanup EXIT INT TERM

free_port() {
  "$node_executable" -e "const server=require('node:net').createServer();server.listen(0,'127.0.0.1',()=>{process.stdout.write(String(server.address().port));server.close()})"
}

postgres_port=$(free_port)
web_port=$(free_port)
"$postgres_bin/initdb" -D "$work_dir/postgres" --auth=trust --no-locale --encoding=UTF8 >/dev/null
postgres_started=true
"$postgres_bin/pg_ctl" -D "$work_dir/postgres" \
  -o "-h 127.0.0.1 -p $postgres_port -k $work_dir" \
  -l "$work_dir/postgres.log" start >/dev/null

export NODE_ENV=production
export NEXT_TELEMETRY_DISABLED=1
export DATABASE_URL="postgresql://$(id -un)@127.0.0.1:${postgres_port}/postgres"
export WEBAUTHN_RP_ID=localhost
export WEBAUTHN_ORIGIN="http://localhost:${web_port}"
export APP_ORIGIN="$WEBAUTHN_ORIGIN"
export CHAIN_OBSERVATION_ORIGINS=https://chain.example
export VAULT_CONFIRMATIONS_REQUIRED=1
export VAULT_DEPOSIT_SATS=10000
export PRIVATE_BETA_MAX_DEPOSIT_SATS=10000
export VAULT_FUNDING_FEE_SATS=600
export VAULT_SOLO_FEE_SATS=300
export VAULT_SOLO_FEE_BUDGET_SATS=2000
export VAULT_COOP_FEE_SATS=300
export VAULT_RECOVERY_FEE_SATS=500
export VAULT_FINAL_SWEEP_FEE_SATS=300
export RECOVERY_DELAY_BLOCKS=144
export BROWSER_TEST_BASE_URL="$WEBAUTHN_ORIGIN"

npm run web:migrate >/dev/null
npm run web:build
mkdir -p .next/standalone/.next/static
cp -a .next/static/. .next/standalone/.next/static/

HOSTNAME=127.0.0.1 PORT="$web_port" \
  "$node_executable" .next/standalone/server.js >"$work_dir/web.log" 2>&1 &
web_pid=$!
web_started=true

ready=false
for _attempt in $(seq 1 120); do
  if curl --fail --silent --output /dev/null "$WEBAUTHN_ORIGIN/api/health/ready"; then
    ready=true
    break
  fi
  if ! kill -0 "$web_pid" >/dev/null 2>&1; then
    sed -n '1,240p' "$work_dir/web.log" >&2
    exit 1
  fi
  sleep 0.5
done
if [ "$ready" != true ]; then
  sed -n '1,240p' "$work_dir/web.log" >&2
  exit 1
fi

npx playwright test \
  web/browser-tests/passkey-prf.spec.ts \
  web/browser-tests/cooperative-musig2.spec.ts

acceptance_passed=true
printf 'Optimized standalone bundle, PostgreSQL %s, and all browser acceptance checks passed.\n' \
  "$("$postgres_bin/postgres" --version | awk '{print $3}')"
