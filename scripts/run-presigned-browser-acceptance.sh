#!/usr/bin/env bash
set -euo pipefail
umask 077

# Bash otherwise rereads later script bytes after a long child exits. Freeze
# the wrapper itself before starting services so an editor cannot corrupt its
# continuation or cleanup. This snapshot contains code only, never credentials.
if [ "${PRESIGNED_BROWSER_SCRIPT_FROZEN:-false}" != true ]; then
  presigned_browser_repository=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  presigned_browser_script=$(mktemp /tmp/btc-presigned-browser-script.XXXXXX)
  cp "${BASH_SOURCE[0]}" "$presigned_browser_script"
  cmp --silent "${BASH_SOURCE[0]}" "$presigned_browser_script"
  exec env PRESIGNED_BROWSER_SCRIPT_FROZEN=true PRESIGNED_BROWSER_REPOSITORY="$presigned_browser_repository" bash "$presigned_browser_script"
fi

# Disposable optimized-bundle V2 acceptance. Never reads operational .env files.
# Coordinate the shared webpack build with the root agent before setting approval.
# PRESIGNED_BROWSER_REUSE_BUILD=true reruns only test sources against the last explicitly approved build.
repository_root=${PRESIGNED_BROWSER_REPOSITORY:?missing frozen wrapper repository}
cd "$repository_root"
for dotenv_path in .env .env.local .env.production .env.production.local; do
  if [ -e "$dotenv_path" ]; then
    echo 'Refusing browser acceptance beside an operational Next.js dotenv file.' >&2
    exit 1
  fi
done
container_image=${PRESIGNED_BROWSER_CONTAINER_IMAGE_ID:-}
container_started=false
network=${PRESIGNED_BROWSER_NETWORK:-signet}
case "$network" in signet|mainnet) ;; *) echo 'Only explicit Signet/mainnet FORMAT acceptance is supported.' >&2; exit 1 ;; esac
if [ -n "$container_image" ]; then
  if [[ ! "$container_image" =~ ^sha256:[0-9a-f]{64}$ ]] || ! command -v podman >/dev/null 2>&1; then
    echo 'Exact container acceptance needs local rootless Podman and an immutable config ID.' >&2; exit 1
  fi
  if [ -z "${BROWSER_TEST_BUILD_IDENTITY:-}" ]; then echo 'Exact container build identity is required.' >&2; exit 1; fi
elif [ "${PRESIGNED_BROWSER_REUSE_BUILD:-false}" != true ] && [ "${PRESIGNED_BROWSER_BUILD_APPROVED:-false}" != true ]; then
  echo 'Coordinate the shared webpack build, then set PRESIGNED_BROWSER_BUILD_APPROVED=true.' >&2
  exit 1
fi
node_executable=${NODE_EXECUTABLE:-$(command -v node)}
"$node_executable" scripts/check-runtime.mjs
export PATH="$(dirname "$node_executable"):$PATH"
postgres_bin=${POSTGRES_BIN:-/home/codex/.cache/btc-multiplayer-vault/postgresql-16.14/usr/lib/postgresql/16/bin}
postgres_lib=${POSTGRES_LIB:-/home/codex/.cache/btc-multiplayer-vault/postgresql-16.14/usr/lib/x86_64-linux-gnu}
if [ ! -x "$postgres_bin/initdb" ] || [ ! -x "$postgres_bin/pg_ctl" ]; then
  echo 'The reviewed cached PostgreSQL 16 test runtime is required.' >&2
  exit 1
fi
export LD_LIBRARY_PATH="$postgres_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
work_dir=$(mktemp -d /tmp/btc-presigned-browser.XXXXXX)
printf 'Owner-only browser acceptance evidence: %s\n' "$work_dir"
postgres_started=false
web_started=false
cleanup() {
  if [ "$container_started" = true ]; then
    podman stop --time 10 "$container_name" >/dev/null 2>&1 || true
  fi
  if [ "$web_started" = true ]; then
    kill "$web_pid" >/dev/null 2>&1 || true
    wait "$web_pid" >/dev/null 2>&1 || true
  fi
  if [ "$postgres_started" = true ]; then
    "$postgres_bin/pg_ctl" -D "$work_dir/postgres" -m immediate stop >/dev/null 2>&1 || true
  fi
  printf 'Owner-only acceptance evidence retained at %s\n' "$work_dir"
}
trap cleanup EXIT INT TERM
free_port() {
  "$node_executable" -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'
}
postgres_port=$(free_port)
web_port=$(free_port)
while [ "$web_port" = "$postgres_port" ]; do web_port=$(free_port); done
chain_port=$(free_port)
while [ "$chain_port" = "$postgres_port" ] || [ "$chain_port" = "$web_port" ]; do chain_port=$(free_port); done
"$postgres_bin/initdb" -D "$work_dir/postgres" --auth=trust --no-locale --encoding=UTF8 >"$work_dir/initdb.log"
postgres_started=true
"$postgres_bin/pg_ctl" -D "$work_dir/postgres" -o "-h 127.0.0.1 -p $postgres_port -k $work_dir" -l "$work_dir/postgres.log" start >/dev/null

export NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
export VAULT_NETWORK="$network" NEXT_PUBLIC_VAULT_NETWORK="$network"
export DATABASE_URL="postgresql://$(id -un)@127.0.0.1:${postgres_port}/postgres"
export WEBAUTHN_RP_ID=localhost WEBAUTHN_ORIGIN="http://localhost:${web_port}"
export APP_ORIGIN="$WEBAUTHN_ORIGIN" BROWSER_TEST_BASE_URL="$WEBAUTHN_ORIGIN"
export CHAIN_OBSERVATION_ORIGINS=https://chain.example PRESIGNED_CHAIN_API_URL=https://chain.example/api
export BITCOIN_BACKEND=core BITCOIN_RPC_URL="http://127.0.0.1:${chain_port}"
export BROWSER_CHAIN_FIXTURE_PORT="$chain_port" BROWSER_TEST_EVIDENCE_DIR="$work_dir"
export VAULT_CONFIRMATIONS_REQUIRED=1 VAULT_DEPOSIT_SATS=10000 PRIVATE_BETA_MAX_DEPOSIT_SATS=10000
export VAULT_FUNDING_FEE_SATS=600 VAULT_SOLO_FEE_SATS=300 VAULT_SOLO_FEE_BUDGET_SATS=2000
export VAULT_COOP_FEE_SATS=300 VAULT_RECOVERY_FEE_SATS=500 VAULT_FINAL_SWEEP_FEE_SATS=300 RECOVERY_DELAY_BLOCKS=12
# These are not needed by V2. Never inherit live Core authentication or private CLI env-file loaders.
unset BITCOIN_RPC_USER BITCOIN_RPC_USERNAME BITCOIN_RPC_PASSWORD BITCOIN_ESPLORA_URL
unset BITCOIN_RPC_COOKIE_FILE
unset BTC_VAULT_ENV_FILE BTC_VAULT_EXTRA_ENV_FILE
unset PRESIGNED_V2_MAINNET_AUTHORIZATION
unset PRESIGNED_V2_ACCEPTANCE_RECEIPT PRESIGNED_V2_ACCEPTANCE_RECEIPT_DIGEST
unset PRESIGNED_V2_RELEASE_REPORT PRESIGNED_V2_RELEASE_REPORT_DIGEST DEPLOYED_IMAGE_MANIFEST_DIGEST
unset DATABASE_RESTORE_RECEIPT DATABASE_RESTORE_RECEIPT_DIGEST
unset PRESIGNED_V2_FUNDING_RESTORE_RECEIPT PRESIGNED_V2_FUNDING_RESTORE_RECEIPT_DIGEST
# Broadcast calls can reach only the loopback regtest bridge started by this spec, never public Signet.
if [ "$network" = signet ]; then export PRESIGNED_V2_BROADCAST_NETWORK=signet; else unset PRESIGNED_V2_BROADCAST_NETWORK; fi
# Public synthetic transport authentication, scoped to this disposable bridge.
# The bridge separately uses the real regtest node's private cookie internally.
export BITCOIN_RPC_USER=presigned-browser-test BITCOIN_RPC_PASSWORD=public-test-fixture
npm run web:migrate >"$work_dir/migrations.log" 2>&1
if [ -n "$container_image" ]; then
  container_name="presigned-v2-browser-${work_dir##*.}"
  podman run --rm --name "$container_name" --network host --read-only --cap-drop ALL \
    --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,noexec,size=64m \
    --env NODE_ENV --env NEXT_TELEMETRY_DISABLED --env DATABASE_URL \
    --env WEBAUTHN_RP_ID --env WEBAUTHN_ORIGIN --env APP_ORIGIN \
    --env CHAIN_OBSERVATION_ORIGINS --env PRESIGNED_CHAIN_API_URL \
    --env BITCOIN_BACKEND --env BITCOIN_RPC_URL --env BITCOIN_RPC_USER --env BITCOIN_RPC_PASSWORD \
    --env VAULT_NETWORK --env NEXT_PUBLIC_VAULT_NETWORK --env PRESIGNED_V2_BROADCAST_NETWORK \
    --env VAULT_CONFIRMATIONS_REQUIRED --env VAULT_DEPOSIT_SATS --env PRIVATE_BETA_MAX_DEPOSIT_SATS \
    --env VAULT_FUNDING_FEE_SATS --env VAULT_SOLO_FEE_SATS --env VAULT_SOLO_FEE_BUDGET_SATS \
    --env VAULT_COOP_FEE_SATS --env VAULT_RECOVERY_FEE_SATS --env VAULT_FINAL_SWEEP_FEE_SATS --env RECOVERY_DELAY_BLOCKS \
    --env "HOSTNAME=127.0.0.1" --env "PORT=$web_port" "$container_image" >"$work_dir/web.log" 2>&1 &
  web_pid=$!
  container_started=true
elif [ "${PRESIGNED_BROWSER_REUSE_BUILD:-false}" = true ]; then
  "$node_executable" scripts/check-build-network.mjs
  if [ ! -f .next/standalone/server.js ]; then echo 'No approved optimized standalone build exists.' >&2; exit 1; fi
else
  npm run web:build >"$work_dir/build.log" 2>&1
fi
if [ -z "$container_image" ]; then
mkdir -p .next/standalone/.next/static .next/standalone/scripts
cp -a .next/static/. .next/standalone/.next/static/
cp scripts/start-production.mjs scripts/check-runtime.mjs scripts/check-build-network.mjs .next/standalone/scripts/
cp .node-version vault-build-network.json .next/standalone/
if [ -f vault-presigned-build.json ]; then cp vault-presigned-build.json .next/standalone/; fi
if [ -d public ]; then mkdir -p .next/standalone/public; cp -a public/. .next/standalone/public/; fi
(
  cd .next/standalone
  exec env HOSTNAME=127.0.0.1 PORT="$web_port" "$node_executable" scripts/start-production.mjs
) >"$work_dir/web.log" 2>&1 &
web_pid=$!
fi
web_started=true
ready=false
for _attempt in $(seq 1 120); do
  if curl --fail --silent --output /dev/null "$WEBAUTHN_ORIGIN/api/health/ready"; then ready=true; break; fi
  if ! kill -0 "$web_pid" >/dev/null 2>&1; then
    echo 'The isolated optimized app exited; inspect the owner-only web log.' >&2; exit 1
  fi
  sleep 0.5
done
if [ "$ready" != true ]; then echo 'Isolated optimized app readiness timed out.' >&2; exit 1; fi
if [ "$container_started" = true ]; then
  podman container inspect --format '{"image":{{json .Image}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"networkMode":{{json .HostConfig.NetworkMode}},"mounts":{{json .Mounts}},"running":{{json .State.Running}}}' \
    "$container_name" >"$work_dir/container-runtime.json"
fi
# The spec keeps its 45-minute body deadline and all action/assertion limits.
# An independent runner deadline prevents stalled fixture cleanup extending it
# indefinitely; deadline expiry is a failure, never an accepted retry.
npx playwright test web/browser-tests/presigned-v2.spec.ts --workers=1 --global-timeout=2820000 --output "$work_dir/browser-output" >"$work_dir/browser.log" 2>&1
printf 'Optimized V2 browser acceptance passed. No public-network broadcasts; regtest identity bridge is test-only.\n'
