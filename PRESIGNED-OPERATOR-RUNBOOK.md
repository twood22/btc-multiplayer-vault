# Presigned V2 operator and recovery runbook

Scope: `presigned-graph-v2` only. This is an operating procedure for the requested
product, not evidence of approval to deploy or fund it. Current results and
remaining requirements are in [PRESIGNED-V2-PLAN.md](./PRESIGNED-V2-PLAN.md).
Mainnet is the production target; mainnet spending, public app exposure and outreach
remain separately approval-gated. Physical passkeys are deferred to the friends'
onboarding, not claimed by virtual-authenticator tests.
Public source and synthetic-test publication were separately authorized; that
does not authorize app deployment or funding.

## 1. Preserve identity and rollback

- Keep the merged `sigbash-v1` baseline
  `202345ffd8bab35590fe15b98d966c4267f194ef`. Never change an existing vault's
  durable protocol, reinterpret a kit or delete an old funding epoch.
- Retain the exact tested source, image manifest, offline utility and private
  evidence. An image config ID is not an OCI manifest digest. Runtime network
  variables must match the network embedded when the image was built.
- Existing funded V2 vaults cannot be operated by a V1-only rollback. Before an
  application/database rollback, preserve all V2 kits, signed epochs and send
  journals and use a matching reviewed restore. Deleting a database or reverting
  code cannot revoke an already released Bitcoin signature.
- Keep participant secrets, wrapping keys, RPC cookies, database credentials,
  invite tokens and raw private test directories out of Git, shared logs and
  support messages. Invite URLs are bearer secrets, not publishable page links.

## 2. Establish actual software evidence

Use an isolated code-only checkout with the reviewed Node runtime and test
dependencies. Acceptance intentionally refuses operational Next.js dotenv files;
do not relocate or delete a running installation's credentials to satisfy it.

```bash
npm run presigned:test:local
npm run presigned:test:container -- signet
npm run presigned:test:container -- mainnet
```

The first command runs the fixed 49-step local matrix, including both network
formats, all Core families, five PostgreSQL suites, the complete saved-file
recovery browser and a fresh Signet-format web build. Container commands need
working local rootless Podman and never push an image. Do not enable privileged
containers or weaken host isolation when that prerequisite is unavailable.

The authorized standard public GitHub runners passed the historical 47-step
matrix and both exact-image profiles on source `536935c2`. The new low-capital
runner adds two pure signing/validation runs and requires new same-source
acceptance; old receipts cannot be reused. The original workflow publishes
normal test logs/receipts, not private wallets, recovery kits or whole runtime
directories. That log-only workflow does not retain all child transcripts and
OCI layers; a green run must not replace actual artifacts. The separately
approved test-only release route below now retains both complete image archives.
The interim `f889b15f` image archives are also retained and verified, but its local
run was stopped at 44/49 commands and eight lifecycle cases to revise regtest
mining. They do not establish acceptance of the revised source. The new regtest
checks recovery rejection at depth 11 and acceptance at depth 12 for all nine
cases; it mines intermediate blocks together without changing CSV12. Its
execution is bounded to 90 minutes, with 150 minutes for the complete CI suite.

For complete **current-source** evidence directories, `npm run
presigned:pack-evidence -- local|signet-image|mainnet-image /absolute/evidence
/private/output.tar.gz` creates a new owner-only local archive. The output
parent must already be owned/private, and the output must be outside the input
directory. The packager takes an exact allowlist, not a recursive directory
copy: required receipts/transcripts, five selected database logs, browser/runtime
summary JSON, the verified OCI index/manifest/config/layers for image evidence,
and the exact tested offline utility in the local archive (image archives retain
it inside their OCI layers). It excludes wallets, cookies, databases,
browser profiles/downloads, participant backups and unrelated OCI blobs.
It validates the input, a fresh private copy and the actual restored archive,
preserving original committed bytes and `executionDirectory`. It rejects
symlinks, hardlinks, path traversal and overwriting an existing output. Archive
files are regular mode0600 entries; restored evidence belongs to the current
user. The matching source checkout remains required for semantic verification.

This is not a privacy scanner: required rootless engine transcripts contain
host/storage metadata, and inspected image configuration may contain environment
metadata. Review those exact files and image build contents before approving any
publication. Do not redact hashed transcripts or include wallet/kit directories.
All three profiles passed actual packaging/restoration on disposable runners in
run34150142799, but that original acceptance workflow **does not upload archives**;
its temporary bytes disappeared with the runners.

The separately approved
[test-only evidence prerelease](https://github.com/twood22/btc-multiplayer-vault/releases/tag/presigned-v2-test-evidence-536935c2-20260908)
now retains both complete image archives and four retention/content-review
records from run 34178522361. Those historical archives pin source `536935c2`;
publication tooling is on a separate branch. Each archive has 39 required files
and 18 actual OCI layers. All six downloads matched GitHub hashes; both complete
archives passed local content review, actual restoration, semantic validation
and independent member-by-member review. See the evidence plan for exact hashes.

These permanently public synthetic-test images must **never receive real funds,
participant custody or operational credentials**, or be promoted to production.
The bounded content review includes historical layers and canonical archive
metadata; exact public GnuTLS self-test constants and unused framework test-build
keys are explicitly documented. No wallet/recovery directory is included.
A checksum, archive or prerelease is not a completed release dossier, a real
default-Signet lifecycle, or funding/deployment authority.

The separate historical `536935c2` private local run completed all 47 commands at
19:45 UTC on 2026-09-07. Its 102 required local files and actually restored,
revalidated archive are now retained owner-only on the host; exact bindings and
independent verification are recorded in the V2 evidence plan. This supplies
the same-source local counterpart to the test-image archives above, but not the
remaining real default-Signet proof.

Real default-Signet evidence is separate. On the exact fresh isolated test host,
`presigned:signet-lifecycle` takes `status`, `init`, `fund`, `advance` or `verify`
and the host's protected control-file path. `status` and `verify` are read-only.
`init` also requires `--capital-limit-sats=N --initial-outpoint=TXID:VOUT`.
Use one exact confirmed, non-coinbase native coin from that isolated wallet;
the minimum bounded seed is 124,680 sats. The 128,985-sat budget retains all
19 cases, five replacement families, 10,000-sat deposits and CSV12. `fund`
allocates the first case only. `advance` recycles each fully settled case's exact
payouts, refunds, sponsor change and reserve into the next, with no wallet coin
selection or key import. Full intent and signed journals precede signing and
broadcast respectively; only the same exact transaction may be retried.
The 20 allocations, including final return, are capped at 2,250 sats each and
use a conservative 2-sat/vB calculation. Together with 47,000 sats of fixed
lifecycle fees, total burn cannot exceed 92,000 sats. Final acceptance requires
all 84 unique transactions and a confirmed, unspent wallet return: at least
36,985 sats from a 128,985-sat seed. A missing historical intent, foreign spender,
changed source, fee-policy refusal or unproven replacement stops progress; never
increase the budget, drop cases or relabel spent payouts as unspent to continue.
Sequential confirmations and nine separate CSV waits make this slower than the
historical fully prefunded parallel run. Only isolated random keys/test coins
may be used; this capital-transport helper is not a product withdrawal API.
Wait for reported confirmations/CSV maturity and resume the same directory;
never substitute regtest, custom Signet or deterministic public fixture keys.
Freeze executable source from `init` through final verification.

Preserve the isolated test wallet separately from public test evidence with
Core's native `backupwallet`, and verify restoration into a distinct,
network-disabled test node. Keep the wallet file owner-only and out of Git,
image contexts and shared dossiers. Address ownership after restoration is a
wallet-recoverability check, not a completed default-Signet lifecycle. Never
load an operational wallet to replace a missing isolated test host.

Only after actual same-source local, both-image and live tests pass, assemble
software evidence with `presigned:assemble-acceptance`. Supply all six options:
`--local-run`, `--signet-image`, `--mainnet-image`, `--signet-control`, `--network`
and `--write-protected-receipt`. Paths must be absolute; the output must be new
and its parent owner-only. The assembler rereads artifacts and runs live Signet
verification now. It is not a facility for supplying invented passed flags.
Keep the dossier directory together with its source evidence. Assembly does not
grant deployment or spending authority.

## 3. Configure only the approved private installation

Configuration comes from the approved secret/environment mechanism, never image
build arguments or source-controlled secret files. A V2 instance needs:

| Configuration | Required binding |
| --- | --- |
| `VAULT_NETWORK`, `NEXT_PUBLIC_VAULT_NETWORK` | Same explicit network as the built image |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `APP_ORIGIN` | Reviewed RP and identical production HTTPS origins; do not change after passkey enrollment |
| `DATABASE_URL` | Exact PostgreSQL database; production release requires a non-local `sslmode=verify-full` endpoint |
| `BITCOIN_BACKEND=core`, `BITCOIN_RPC_URL` plus cookie **or** username/password | Authenticated private Core31.1, exact network/genesis, fully synchronized and non-pruned with synchronized `txindex`; no cleartext remote RPC |
| `CHAIN_OBSERVATION_ORIGINS`, `PRESIGNED_CHAIN_API_URL` | Independent allowed HTTPS Esplora base, no credentials; browsers must independently verify Bitcoin facts |
| `VAULT_CONFIRMATIONS_REQUIRED`, `VAULT_DEPOSIT_SATS`, `RECOVERY_DELAY_BLOCKS` | Explicit reviewed depth, equal deposit and relative timelock |
| `VAULT_FUNDING_FEE_SATS`, `VAULT_SOLO_FEE_SATS`, `VAULT_SOLO_FEE_BUDGET_SATS`, `VAULT_COOP_FEE_SATS`, `VAULT_RECOVERY_FEE_SATS`, `VAULT_FINAL_SWEEP_FEE_SATS` | Reviewed immutable economics, not a later fee override |

V2 has no Sigbash credential, hosted policy key or Sigbash readiness receipt.
That is an explicit protocol distinction, not a switch disabling V1 gates.
Do not use `VAULT_DEMO_SEED` for product custody or live acceptance.

The runtime roles are the migration job (`npm run web:migrate`), unprivileged web
role (the exact image's default startup command), and private one-shot watcher
(`npm run web:watch-chain`). The watcher can retry already authorized send
intents: it is not a read-only diagnostic. Schedule it only within the approved
installation. Never expose it as an HTTP endpoint. Select an explicit loopback
listener for host-local testing; no example here authorizes opening a listener
to other machines. Health readiness only proves operational availability and
the migration set; it always says `fundingAuthorized: false`.

## 4. Create a new V2 vault and complete custody

Once installation and participant onboarding are authorized, new vault creation
requires `web:create-invite -- --protocol presigned-graph-v2 --vault-name NAME
--participant alice --max-child-fee-sats CAP`. The deposit and delay environment
must be explicit. Use the returned exact vault ID for Bob and Carol's invites;
do not create three different vaults. Handle generated invite URLs through the
approved private delivery process, never public logs or automatic outreach.
An existing vault rejects a different protocol or inferred replacement settings.

Each participant completes these actions in their own browser:

1. Enroll two distinct PRF-capable passkeys; during actual onboarding, verify
   physical devices rather than treating six virtual credentials as that proof.
2. Compare the exact roster and economics with the other participants through
   an independent channel. Review the displayed final amount after base fees;
   the schedule does not promise that net payouts increase monotonically.
3. Choose one confirmed native P2WPKH or key-path P2TR wallet coin. It must cover
   the deposit, its deterministic funding-fee share and at least330 sats of
   refundable change. Change returns to that exact input-wallet script so its
   owner retains a funding-fee rescue path; this intentionally reuses an address.
4. Independently rebuild the frozen funding transaction and all nine exits,
   then release only the four counterparty signatures. The participant's own
   final leaver signatures remain private.
5. Save the complete encrypted portable kit, keep its independent wrapping
   secret separately, actually reopen the saved file, and restore with both
   passkeys. Save the verified offline HTML utility and public commitments too;
   compare its digest through an independently trusted artifact channel.
6. Only after local restoration checks pass, start wallet signing. This records
   an irrevocable local/server intent before PSBT export. Independently review
   the wallet transaction, import its signature and approve the exact completed
   funding bytes. Server readiness is not a substitute for local review.

Before any wallet-start intent, a new epoch requires unanimous digest-bound
restart approval. After an intent or released signature, retain the old epoch
and retry the exact transaction. A missing upload, failed download, browser
restart or fresh login does not make old signatures revocable. Sessions expire
after fifteen minutes; reauthenticate without clearing recovery material.

## 5. Mainnet funding requires a separate release

The software acceptance receipt, its independently reviewed digest, the exact
deployed image manifest and the explicit mainnet authorization must all match
before the mainnet wallet-signing workflow opens. Do not invent these artifacts
or set an authorization marker merely to exercise a test. Already funded exits
do not require a new initial-funding release report.

The software bindings are `PRESIGNED_V2_ACCEPTANCE_RECEIPT`,
`PRESIGNED_V2_ACCEPTANCE_RECEIPT_DIGEST` and `DEPLOYED_IMAGE_MANIFEST_DIGEST`.
The separately approved activation configures `PRESIGNED_V2_MAINNET_AUTHORIZATION`,
the exact `PRESIGNED_V2_BROADCAST_NETWORK` and `PRIVATE_BETA_MAX_DEPOSIT_SATS`.
Their presence is not a substitute for the user's actual authorization.

After an exact epoch is fully signed and unanimously approved, perform the
authorized encrypted database backup/restore and actually quiesce its source.
Use distinct, verified-TLS source and restored databases. The read-only command
`presigned:verify-database-restore` takes `--vault-id`, `--epoch-id`,
`--write-protected-receipt`, `--write-database-receipt` and
`--confirm-source-quiesced SOURCE_QUIESCED_FOR_BACKUP_RESTORE`. It does not perform
the backup, restore or pause. It compares full database contents plus that exact
approved funding state, all retained epochs and restored custody envelopes.

Configure both `DATABASE_RESTORE_RECEIPT`/`DATABASE_RESTORE_RECEIPT_DIGEST` and
`PRESIGNED_V2_FUNDING_RESTORE_RECEIPT`/`PRESIGNED_V2_FUNDING_RESTORE_RECEIPT_DIGEST`
from independently reviewed real outputs. The V2 operator commands load only an
explicit protected `BTC_VAULT_ENV_FILE` or injected environment; they do not
implicitly load a dotenv file.

`npm run presigned:release-status -- --vault-id ID --epoch-id ID` is read-only.
It checks the exact deployed offline utility, image and source before inspecting
the funding state, current coins, restored state, runtime and beta cap. Writing a report additionally requires
`--write-protected-report`, `--acknowledge-manual-review true` and
`--physical-passkeys-checked true`; those acknowledgements must describe actual
review/onboarding, never virtual-test substitutes. Configure its reviewed report
path and digest only through the separately approved release process. The
report expires after30 minutes, grants no authority itself and is rechecked
before an initial funding send. Participant broadcast approval is still required.
The report bindings are `PRESIGNED_V2_RELEASE_REPORT` and
`PRESIGNED_V2_RELEASE_REPORT_DIGEST`.

## 6. Ongoing operation, fees and coordinator loss

Keep signing, broadcast approval, send intent and confirmed activation distinct.
An accepted mempool transaction does not activate its next round. The watcher
tracks known graph transactions even if the coordinator never created a proposal;
an unavailable backend leaves the previous state intact. On a reorganization,
suspend affected descendants and reobserve exact coins and active anchors. Do
not erase proposals, old signatures or send journals to repair a disagreement.

Apply migration021 before starting this watcher version. Every successful or
deferred publication advances a monotonic `poll_revision`; identical state
hashes do not let an older worker overwrite a newer observation. Do not reset
that counter or edit watch rows to clear an error. An approved database restore
must stop all old watcher processes, not just obtain a new session lease: a
restored database is not a continuation of the old process's concurrency token.
Retry batches rotate retained accepted/deferred records by last attempt, so old
records do not permanently occupy the first100 positions. A fee package that
was merely approved remains outside that queue until an explicit send action.

Fee rescue preserves the full payout/refund and every parent/descendant txid.
Use a confirmed outside sponsor coin and independently approve the exact cap
and sponsor change. Only the initiating payout owner and sponsor sign their own
inputs. Save the public draft/completed package before leaving the page, then
refresh chain facts before restoring and approving it. Replace only the fee
child, never immutable funding or game parents. Parent confirmation while
offline signing was in progress is revalidated explicitly. Adequate fees,
sponsor liquidity and relay availability remain necessary; no bounded
confirmation-time guarantee is made.

If the coordinator is unavailable, open the saved, independently verified HTML
utility as a local file on a trusted device. It operates without service/network
requests. Restore the encrypted kit with its separate secret, obtain fresh
public coin observations from your own authenticated private Core using
`presigned:observe-coins`, and review their network, exact outpoints, active tip
and observation time. That helper is read-only and takes explicit `--network`,
`--rpc-url`, `--cookie-file`, repeated `--coin TXID:VOUT`, and a new `--output`.
Never send the cookie, participant secret or wrapping key to the utility provider.

The utility supports the owner's solo exits, interactive cooperative MuSig2,
mature N-1 recovery, final sweep and all five fee-parent families. Exchange only
the intended public contributions. A lost cooperative secret nonce requires a
fresh complete nonce ceremony, not reuse or reconstruction of an old nonce.
Review and submit the completed exact transaction/package through the separately
authorized private Bitcoin operator path. Completed signed bytes can be
broadcast by whoever receives them; do not treat deleting your copy as revocation.

The N-1 recovery condition permits the remaining quorum to take the coin after
CSV maturity (either member in a pair round). That inherited collusion tradeoff,
malicious browser-code delivery, stolen unlocked devices, wallet compatibility
and relay liveness remain explicit limits; see the
[protocol threat model](./PRESIGNED-PROTOCOL.md).
