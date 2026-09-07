#!/usr/bin/env bash
# Disposable public GitHub runner only. No host security-policy changes.
set -euo pipefail
umask 077

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux || "${RUNNER_ARCH:-}" != X64 || "$(id -u)" == 0 ]]; then
  echo 'This bootstrap is only for a non-root Linux x64 GitHub Actions job.' >&2
  exit 1
fi
test -d "${RUNNER_TEMP:?missing disposable runner directory}"
test -f "${GITHUB_ENV:?missing GitHub environment file}"

presigned_ci_runtime=$(mktemp -d "$RUNNER_TEMP/presigned-core.XXXXXX")
presigned_ci_archive=bitcoin-31.1-x86_64-linux-gnu.tar.gz
presigned_ci_sha256=b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 \
  "https://bitcoincore.org/bin/bitcoin-core-31.1/$presigned_ci_archive" \
  --output "$presigned_ci_runtime/$presigned_ci_archive"
printf '%s  %s\n' "$presigned_ci_sha256" "$presigned_ci_runtime/$presigned_ci_archive" | sha256sum --check --status
tar --extract --gzip --file "$presigned_ci_runtime/$presigned_ci_archive" --directory "$presigned_ci_runtime" --no-same-owner
"$presigned_ci_runtime/bitcoin-31.1/bin/bitcoind" --version | head -1

presigned_ci_postgres=/usr/lib/postgresql/16/bin
test -x "$presigned_ci_postgres/initdb"
test -x "$presigned_ci_postgres/pg_ctl"
"$presigned_ci_postgres/postgres" --version | grep -E '^postgres \(PostgreSQL\) 16\.'
printf 'BITCOIN_CORE_BIN=%s\nPOSTGRES_BIN=%s\nPOSTGRES_LIB=%s\n' \
  "$presigned_ci_runtime/bitcoin-31.1/bin/bitcoind" "$presigned_ci_postgres" /usr/lib/x86_64-linux-gnu >> "$GITHUB_ENV"
