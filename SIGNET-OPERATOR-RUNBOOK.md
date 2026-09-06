# Private default-Signet friends vault

This is the current network-specific operator path for the real multiplayer
vault, not a replacement product. Mainnet remains unauthorized. A successful
local test, failed hosted-signing attempt, or historical CLI funding transaction
is not a live proof receipt or permission to fund a user-facing vault.

Current stop: hosted Sigbash signing still needs a provider fix. Prepare and
test locally now; do not bypass the real signing gates to deploy or fund.
Physical passkey checks are deliberately deferred to the first friends vault,
where each participant completes setup and recovery before funding. Nobody is
being asked to do a separate physical-device test session now.

## 1. Keep the network and evidence separate

Use a dedicated Signet database, Core datadir/wallets, participant organizations,
credentials, recovery kits, and `live-run/signet/` evidence. Never reuse a
mainnet credential or promote a Signet success into mainnet evidence. Both
network variables must be explicit and agree:

```bash
export VAULT_NETWORK=signet
export NEXT_PUBLIC_VAULT_NETWORK=signet
```

The selected chain is **default global Signet**, genesis
`00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6`.
Testnet address bytes alone do not distinguish this chain from other testnets.

The owner-only operator environment must include the real private HTTPS/RP
configuration, TLS-authenticated PostgreSQL, explicit reviewed tiny economics,
confirmation depth, synchronized non-pruned Signet Core with `txindex=1`, and
the pinned SDK/WASM runtime. The historical test used 10,000 sats per person and
a 12-block CSV delay; those are test evidence, not automatically chosen settings
for the friends' immutable roster. Review their actual values before setup.

The web service does not receive the participants' Sigbash credential triplets.
Browsers generate those independently and save passkey-encrypted custody data.
Protect backups and operator files with private directories and mode `0600`.

## 2. Obtain the real predeployment signature when Sigbash works

For a fresh, separately backed-up Signet proof organization:

```bash
npm run sigbash-bootstrap -- --output live-run/signet/proof-credentials.env
npm run signet:proof-org-id
npm run signet:predeployment-setup
npm run signet:predeployment-proof
```

Do not recreate existing credentials just to retry. The bootstrap refuses an
existing file; setup reconciles the exact immutable policy and key slot after
an uncertain response. Back up credentials and recovery journals separately.
Checkpoints without their recovery journal are not acceptable resume evidence.
The pinned compiler can intermittently fail creation with `policy_root mismatch`.
Stop and retain the exact credentials, slot, policy, and recovery checkpoint.
An explicit same-checkpoint retry completed the tested pair setup, but that is
not a compiler fix; never skip the root check or create arbitrary replacement
slots. The credential-free reproducer is linked in the readiness report below.

The proof uses an intentionally unfunded pair-round outpoint. It must reject
hostile PSBTs locally, obtain a **real hosted signature**, and independently
authorize the exact consensus transaction. Only success writes the version-2
`live-sigbash-signet-signing-proof` receipt at
`live-run/signet/predeployment-proof-receipt.json`. Preserve and independently
review that file and its digest. The earlier provider diagnostics cannot stand
in for this receipt.

## 3. Build and verify the Signet image

```bash
npm test
npm run web:test
npm run web:test:browser:production
# On a host with a container engine:
npm run web:test:browser:container
```

The browser tests use virtual authenticators, synthetic provider prerequisites,
and controlled chain responses. They exercise the actual optimized application
but are not hosted signing, physical-device, real-wallet, or broadcast evidence.

The container has a deliberate non-secret network build argument:

```bash
docker build --build-arg VAULT_NETWORK=signet --tag btc-multiplayer-vault:signet .
```

Next.js embeds browser network values during the build. The immutable build
profile is packaged with the image; startup refuses missing, mixed, or
wrong-network runtime values before starting the server. Runtime environment
variables cannot turn a mainnet browser image into a Signet image. Never pass
credentials as build arguments. The manually dispatched exact-container CI
workflow tests separate Signet and mainnet images without publishing either.

After the real predeployment proof and independent review, choose a private
HTTPS origin/access boundary and deploy an independently reviewed registry
manifest digest. No host, domain, or deployment is selected or authorized by
this document. Follow [DEPLOYMENT.md](./DEPLOYMENT.md) for the migration, web,
watcher, TLS, backup/restore, and rollback topology, using Signet configuration.
Migration `014_runtime_liveness` requires the matching application version.

## 4. Complete the real ceremony with friends

Each participant uses two real, distinct PRF-capable passkeys and demonstrates
recovery during onboarding. Then complete the original dependency order: six
pair-round Sigbash keys, three full-round keys, unanimous roster confirmation,
and **all nine server-verified readiness signatures**. The compiler/key-response
compatibility guard does not manufacture signatures or policy attestations.

Only then coordinate the three independent wallets' exact funding inputs and
change, review the shared PSBT and fee, collect each wallet's own signatures,
and obtain all three passkey approvals of the final transaction. Funding is
still not broadcast. Exercise the private Core retry/rejection/confirmation and
reorganization drills and document every manual gate listed by release status.

## 5. Review a fresh release artifact, then separately authorize broadcast

The release and broadcast commands load only an explicitly named protected
operator file (or explicitly injected environment); they do not implicitly load
`.env.local`. Other private deployment jobs receive the same reviewed network
configuration through their environment.

```bash
BTC_VAULT_OPERATOR_ENV_FILE=live-run/signet/operator.env npm run web:release-status
```

Record these **actual reviewed** values in that protected environment:

- `LIVE_SIGBASH_SIGNET_PROOF_RECEIPT` and `LIVE_SIGBASH_SIGNET_PROOF_DIGEST`;
- `DATABASE_RESTORE_RECEIPT` and its `DATABASE_RESTORE_RECEIPT_DIGEST`, generated
  by the existing quiesced-database backup/restore verifier;
- `DEPLOYED_IMAGE_MANIFEST_DIGEST`, the deployed registry digest, not a local
  Docker image ID.

Only after all automated and manual gates genuinely pass:

```bash
BTC_VAULT_OPERATOR_ENV_FILE=live-run/signet/operator.env npm run web:release-status -- \
  --write-protected-report live-run/signet/funding-release-report.json \
  --confirm-manual-gates REVIEWED_EVERY_MANUAL_FUNDING_GATE
```

Review the version-3 `signet-funding-release` artifact, then record
`SIGNET_FUNDING_RELEASE_REPORT_PATH` and `SIGNET_FUNDING_RELEASE_REPORT_DIGEST`.
It binds the network/genesis, vault, exact unanimously approved transaction,
real live-proof digest, and deployed image. It expires after 30 minutes; old
version-1 proofs/version-2 release reports are rejected, not silently relabeled.

The following is a template, **not a command to run now**. Substitute only the
reviewed public fingerprints after a separate explicit funding decision:

```bash
BTC_VAULT_OPERATOR_ENV_FILE=live-run/signet/operator.env npm run web:broadcast-funding -- \
  --vault-id <reviewed-vault-uuid> \
  --finalization-digest <reviewed-finalization-digest> \
  --live-sigbash-proof-digest <reviewed-signet-proof-digest> \
  --release-report-digest <reviewed-signet-release-digest> \
  --confirm-signet-broadcast BROADCAST_EXACT_APPROVED_SIGNET_FUNDING_TRANSACTION
```

The mainnet flag/acknowledgement does not work on this path. Missing evidence,
cross-network artifacts, changed fingerprints, or incomplete nine-proof and
three-approval gates fail closed. An uncertain submission stays bound to the
same transaction and cannot be used to restart funding with different inputs.
Use the private watcher to reconcile broadcasts and confirmations; never use
the funding recorder to import an arbitrary coin around the ceremony.

## Completion still requires real evidence

After the provider is fixed, test actual first and second solo exits, all six
exit orderings, cooperative closure, both CSV recovery thresholds, final-owner
access, and interruption/restart/reorganization behavior on Signet. Do not call
the whole lifecycle validated based only on local tests or the historical CLI
cooperative spend. Mainnet entitlement and a later mainnet review remain
separate future work.
