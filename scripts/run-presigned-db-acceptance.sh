#!/usr/bin/env bash
set -euo pipefail
umask 077

if [ "${PRESIGNED_DB_SCRIPT_FROZEN:-false}" != true ]; then
  presigned_db_repository=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  presigned_db_script=$(mktemp /tmp/btc-presigned-db-script.XXXXXX)
  cp "${BASH_SOURCE[0]}" "$presigned_db_script"
  cmp --silent "${BASH_SOURCE[0]}" "$presigned_db_script"
  exec env PRESIGNED_DB_SCRIPT_FROZEN=true PRESIGNED_DB_REPOSITORY="$presigned_db_repository" bash "$presigned_db_script" "$@"
fi

# New loopback-only PostgreSQL databases, never operational app configuration.
# Core-backed specs start and stop their own network-disabled regtest hosts.
repository_root=${PRESIGNED_DB_REPOSITORY:?missing frozen wrapper repository}
cd "$repository_root"
selection=${1:-all}
case "$selection" in
  ceremony) specs=(presigned-ceremony-db-acceptance) ;;
  runtime) specs=(presigned-runtime-db-acceptance) ;;
  chain) specs=(presigned-chain-broadcast-db-acceptance) ;;
  fees) specs=(presigned-fee-db-acceptance) ;;
  restore) specs=(presigned-restore-db-acceptance) ;;
  all) specs=(presigned-ceremony-db-acceptance presigned-runtime-db-acceptance presigned-chain-broadcast-db-acceptance presigned-fee-db-acceptance presigned-restore-db-acceptance) ;;
  *) echo 'usage: bash scripts/run-presigned-db-acceptance.sh [all|ceremony|runtime|chain|fees|restore]' >&2; exit 1 ;;
esac
for spec in "${specs[@]}"; do
  if [ ! -f "web/tests/$spec.ts" ]; then echo "Acceptance spec is not implemented: $spec" >&2; exit 1; fi
done
node_executable=${NODE_EXECUTABLE:-$(command -v node)}
"$node_executable" scripts/check-runtime.mjs
postgres_bin=${POSTGRES_BIN:-/home/codex/.cache/btc-multiplayer-vault/postgresql-16.14/usr/lib/postgresql/16/bin}
postgres_lib=${POSTGRES_LIB:-/home/codex/.cache/btc-multiplayer-vault/postgresql-16.14/usr/lib/x86_64-linux-gnu}
if [ ! -x "$postgres_bin/initdb" ] || [ ! -x "$postgres_bin/pg_ctl" ]; then
  echo 'The reviewed PostgreSQL16 test runtime is required.' >&2; exit 1
fi
export LD_LIBRARY_PATH="$postgres_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
work_dir=$(mktemp -d /tmp/btc-presigned-db.XXXXXX)
postgres_started=false
cleanup() {
  if [ "$postgres_started" = true ]; then "$postgres_bin/pg_ctl" -D "$work_dir/postgres" -m fast stop >/dev/null 2>&1 || true; fi
  printf 'Owner-only test evidence retained at %s\n' "$work_dir"
}
trap cleanup EXIT INT TERM
postgres_port=$("$node_executable" -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')
"$postgres_bin/initdb" -D "$work_dir/postgres" --auth=trust --no-locale --encoding=UTF8 >"$work_dir/initdb.log"
"$postgres_bin/pg_ctl" -D "$work_dir/postgres" -o "-h 127.0.0.1 -p $postgres_port -k $work_dir" -l "$work_dir/postgres.log" start >/dev/null
postgres_started=true
export VAULT_NETWORK=signet NEXT_PUBLIC_VAULT_NETWORK=signet NODE_ENV=test
export PRESIGNED_V2_BROADCAST_NETWORK=signet
unset BTC_VAULT_ENV_FILE BTC_VAULT_EXTRA_ENV_FILE BITCOIN_RPC_URL BITCOIN_RPC_USER BITCOIN_RPC_USERNAME BITCOIN_RPC_PASSWORD BITCOIN_RPC_COOKIE_FILE
unset PRESIGNED_V2_MAINNET_AUTHORIZATION PRESIGNED_V2_RELEASE_REPORT PRESIGNED_V2_RELEASE_REPORT_DIGEST
for spec in "${specs[@]}"; do
  database_name=${spec//-/_}
  "$postgres_bin/createdb" -h 127.0.0.1 -p "$postgres_port" "$database_name"
  export DATABASE_URL="postgresql://$(id -un)@127.0.0.1:${postgres_port}/${database_name}"
  printf 'Running %s on a disposable database\n' "$spec"
  "$node_executable" --conditions=react-server --import tsx "web/tests/$spec.ts" >"$work_dir/$spec.log" 2>&1
  printf 'Passed %s\n' "$spec"
done
