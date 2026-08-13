# Private-beta deployment runbook

This runbook packages the real round-based Bitcoin multiplayer vault. It does
not authorize deployment or funding. Do not deploy the service until an
independent predeployment command has obtained and locally authorized a real
Sigbash mainnet signature. All nine in-product readiness proofs remain a later
funding gate. Funding is always a separate decision.

## Runtime shape

Use the reviewed `Dockerfile` as one immutable image with three execution
roles:

1. **Migration job** — run once per release: `npm run web:migrate`.
2. **Web service** — use the image's default
   `node scripts/start-production.mjs` command as its unprivileged `node` user.
   The launcher rejects any runtime other than `.node-version` before Next.js
   starts. Start with one replica for the three-person beta.
3. **Private chain watcher** — run `npm run web:watch-chain` on a private
   scheduler. It continuously reconciles every recorded confirmation block,
   not only pending transactions. A dedicated PostgreSQL session advisory lease
   permits only one invocation to act; overlap is a successful no-op and a
   dropped process or connection releases the lease. Never expose this command
   as an HTTP endpoint.

The image uses Next.js standalone output, includes the reviewed operator
scripts, and receives configuration only at runtime. Do not pass credentials as
Docker build arguments or bake `.env.local` into an image. The `.dockerignore`
excludes every `.env*` file except the empty example.

The base is the official Node 22.23.2 Debian Bookworm slim multi-architecture
image pinned by manifest digest. Update its version and digest together, rerun
the complete suite under the new runtime, and update the release checker before
building a later release.

The web role exposes:

- `GET /api/health/live`: process liveness only.
- `GET /api/health/ready`: database reachability and exact migration-set
  readiness. It always returns `fundingAuthorized: false`.

Neither endpoint checks or bypasses Sigbash, passkey, roster, broadcast, or
funding gates. Configure the platform's health probe to use the readiness path.

## Required runtime configuration

Set the variables documented in `.env.example`, including:

- exact HTTPS `WEBAUTHN_ORIGIN` and matching `APP_ORIGIN`;
- the exact WebAuthn relying-party host in `WEBAUTHN_RP_ID`;
- a PostgreSQL 16+ `DATABASE_URL` on a non-local host with
  `sslmode=verify-full`;
- one or more independent HTTPS `CHAIN_OBSERVATION_ORIGINS`;
- a fully synchronized, non-pruned mainnet Bitcoin Core backend with a
  synchronized `txindex`, or a mainnet-identity-checked Esplora backend;
- reviewed Sigbash runtime URLs and SHA-384 pins;
- explicit tiny-mainnet economics, recovery delay, and confirmation depth.

The user-facing service does not need participant Sigbash API keys in server
environment variables. Each browser creates its own Sigbash credential triplet
and stores only passkey-derived ciphertext in PostgreSQL. The legacy unsuffixed
Sigbash variables remain for command-line audit tooling and must not be used as
shared production custody.

Credential generation and mainnet entitlement are separate. The application
can generate and protect the credentials, but it cannot grant Sigbash mainnet
access. Each participant deliberately has a separate Sigbash organization, so
the three displayed non-secret `apikeyHash` identifiers must all be enabled by
Sigbash before the browsers can create the nine product keys. Do not collapse
the friends into one administrator-controlled organization merely to reduce
that activation step.

For any non-local database, the process refuses to start, migrate, or create
invites unless `sslmode=verify-full` is present. `sslmode=require` is rejected
because it encrypts traffic without authenticating the database certificate and
hostname. Local loopback is allowed only for isolated acceptance testing and is
rejected by the release report.

## Release sequence

1. Before deployment, obtain SDK mainnet enablement for a reviewed proof
   organization, provision a live Sigbash key, and run the
   explicit one-nullifier proof. It first requires the live service to reject
   every hostile PSBT, then requires a real signature and independently checks
   the exact consensus transaction:

   ```bash
   npm run sigbash-bootstrap
   npm run sigbash-proof-org-id
   SIGBASH_MODE=live npm run live-predeployment-setup
   SIGBASH_MODE=live npm run live-predeployment-proof
   ```

   Setup creates only the two immutable mainnet keys needed for one real
   pair-round vault, rather than creating all nine product keys before the
   product participants exist. It is resumable, journals each remote key, and
   keeps the credential triplet in owner-only
   `live-run/proof-credentials.env` while writing the derived non-secret key
   configuration to `live-run/predeployment.env`; the proof command loads both
   automatically. The whole `live-run` directory is excluded from Git and the
   container build context. Its address must never be funded. The proof command
   must end with `passed: true`, a non-null consensus authorization, and a new
   owner-only `live-run/predeployment-proof-receipt.json`. Independently review
   its public evidence and `proofDigest`. The current external service result
   is unproven; no local or dry-run success substitutes for this command.
2. Build the immutable image in CI and record its digest. Do not inject runtime
   secrets during the build.
3. Restore the latest encrypted database backup into an isolated database and
   run `npm run web:migrate`; verify the application and rollback procedure.
4. Run the migration job once against the selected production database. The
   migrator takes a PostgreSQL advisory lock and refuses migration files that do
   not exactly match the reviewed manifest.
5. Only after step 1 has passed, start the web role behind HTTPS and private
   access control. Forward the original host without rewriting it; the
   application verifies WebAuthn assertions against the configured origin and
   RP ID, not proxy headers.
6. Confirm liveness and operational readiness. A green health endpoint is not
   a green funding report.
7. Complete the physical two-passkey, three-person roster, nine-key Sigbash,
   and all nine live mainnet readiness ceremonies on the exact HTTPS origin.
   This includes sending each participant's non-secret organization hash to
   Sigbash and confirming all three organizations are mainnet-enabled.
8. Exercise backup/restore and mainnet-backend rejection, retry, mempool,
   confirmation, and reorganization behavior without a funded vault.
   First run `npm run web:test:core-reorg` to prove the exact reconciliation
   and PostgreSQL boundary with a checksum-pinned disposable Bitcoin Core
   31.1 node. Its regtest chain is isolated test infrastructure only; repeat
   the operational checks against the selected private mainnet node before
   funding.
9. Place the independently reviewed protected receipt's `proofDigest` in
   `LIVE_SIGBASH_MAINNET_PROOF_DIGEST` and keep
   `LIVE_SIGBASH_MAINNET_PROOF_RECEIPT` pointed at that owner-only receipt.
   Mount the receipt read-only into the release-report and funding-broadcast
   operator jobs; never bake it into the application image. Run
   `npm run web:release-status` as a preliminary pre-funding audit. Review its
   checks and `statusDigest`; this status output is not a broadcast artifact
   and cannot authorize funding.
10. After separately authorizing the non-broadcast funding ceremony, each
    participant uses the web funding ceremony
    to passkey-approve one independently observed wallet coin and its change
    destination. Confirm that all three browsers reproduce the same PSBT
    fingerprint before any external wallet signs it. Each wallet signs only its
    own input; the service normalizes and independently verifies each signature,
    finalizes the pristine PSBT, and requires all three friends to passkey-approve
    the exact witness bytes. The service does not possess the wallet private
    keys, and none of these browser steps broadcasts.
11. After all three final passkey approvals, rerun the complete release audit
    and deliberately acknowledge every manual gate while writing a fresh
    owner-only artifact to a new path:

    ```bash
    npm run web:release-status -- \
      --write-protected-report live-run/funding-release-report.json \
      --confirm-manual-gates REVIEWED_EVERY_MANUAL_FUNDING_GATE
    ```

    The writer refuses incomplete automated checks, an untouched or partially
    approved funding ceremony, unsafe file permissions, and replacement of a
    different existing report. Independently review the artifact, place its
    `reportDigest` in `FUNDING_RELEASE_REPORT_DIGEST`, and point
    `FUNDING_RELEASE_REPORT_PATH` at that exact file. The artifact binds the
    vault UUID, finalization digest and txid, live-proof digest, and complete
    gate list. It expires for broadcast after 30 minutes; generate a fresh file
    at a fresh path if the window closes. These are non-secret review
    fingerprints, not substitutes for reviewing the evidence.
12. Only after a final, separate explicit broadcast decision made after
    reviewing the protected artifact from step 11, run the private
    `web:broadcast-funding` command below against Bitcoin Core. Then keep
    `web:watch-chain` scheduled; it activates only the exact stored transaction
    after the configured confirmation depth.

## Backup and monitoring minimums

- Use encrypted automated PostgreSQL backups with point-in-time recovery, and
  perform a real restore drill before the private beta.
- Alert on web readiness failures, watcher failures, repeated broadcast
  failures, new `chain_reorganization_events`, database saturation, and
  sustained rate-limit activity. Do not log
  request bodies, invite tokens, passkey assertions, session cookies, Sigbash
  ciphertext, recovery kits, or database URLs.
- Keep the watcher private and single-scheduled for the initial beta. Its
  PostgreSQL lease makes accidental overlap a visible no-op and releases on
  process/connection loss; transaction claims still make later retries safe.
  A duplicate scheduler provides no availability benefit at this scale.
- A failed block-status lookup is an operational failure, not reorganization
  evidence, and must leave coordinator state unchanged. Drill both paths: an
  orphaned block rolls back the exact successor atomically, while a transaction
  re-included at the required depth is reanchored to its replacement block.
- A removed block followed by a transaction-lookup outage is also an
  operational failure. Only authoritative transaction absence, or the exact
  transaction observed below the required depth, permits rollback.
- Keep the service private to the three invited participants. No health probe,
  invite, operator command, or deployment platform setting may make the funding
  recorder or watcher publicly callable.

## Operator commands

Run these only in a private job or shell attached to the same immutable image:

```bash
npm run web:migrate
npm run web:create-invite -- --vault-name '<reviewed name>' --participant alice
npm run web:release-status
npm run web:release-status -- --write-protected-report live-run/funding-release-report.json --confirm-manual-gates REVIEWED_EVERY_MANUAL_FUNDING_GATE
npm run web:watch-chain
```

The initial broadcast command has no HTTP equivalent and requires every
reviewed fingerprint plus a literal mainnet confirmation phrase:

```bash
npm run web:broadcast-funding -- \
  --vault-id <uuid> \
  --finalization-digest <finalization-digest> \
  --live-sigbash-proof-digest "$LIVE_SIGBASH_MAINNET_PROOF_DIGEST" \
  --release-report-digest "$FUNDING_RELEASE_REPORT_DIGEST" \
  --confirm-mainnet-broadcast BROADCAST_EXACT_APPROVED_FUNDING_TRANSACTION
```

The private watcher normally performs confirmed activation. The manual
recovery command for the same boundary is:

```bash
npm run web:record-funding -- --vault-id <uuid> --txid <txid> --vout <index>
```

Do not run either command merely because the service is deployed or healthy.
Submission first runs Bitcoin Core `testmempoolaccept` and verifies the exact
txid, vsize, and fee. Activation rechecks the exact approved witness bytes,
three final passkey approvals, mainnet P2TR output, exactly three unique
qualifying funding inputs, fee/change sanity, and the database's nine-proof
ready state. On-chain
structure cannot prove which friend owns an input, so each friend must verify
their own wallet contribution and the complete transaction before signing; the
human funding approval remains mandatory.
