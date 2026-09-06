# Standard Signet validation plan

Decision date: 2026-08-29

Sigbash declined mainnet SDK enablement for the current hobby/experimental
project and explicitly invited continued SDK testing on Bitcoin Signet. The
near-term integration target is therefore the **default global Bitcoin Signet**.
Mutinynet and Bitcoin testnet are out of scope. Mainnet remains the eventual
production target if a commercial Sigbash agreement becomes appropriate.

This is a network strategy change, not a product substitution. The Signet
profile must exercise the same round-based haircut/bonus game, nine
participant-and-round Sigbash policy keys, participant-only BIP-327 MuSig2
cooperative path, passkey custody, CSV recovery path, final payout, three-wallet
funding ceremony, and persistent state transitions. A local signer, synthetic
registration, fixture chain, or simplified threshold vault cannot satisfy the
Signet exit criteria.

## Network isolation requirements

1. Add an explicit `signet` validation profile while retaining the mainnet
   production profile. No live process may infer a network from an address
   prefix or silently default to mainnet.
2. Commit the network and a network-specific chain identity into every roster,
   proposal, receipt, database vault, encrypted custody context, and release
   artifact. Reject cross-network imports and replays.
3. Keep Signet and mainnet credentials, databases, origins, cookies, encrypted
   envelopes, recovery kits, Bitcoin wallets, Core datadirs, and operator
   artifacts in separate paths and scopes.
4. Give Signet controls Signet-specific language. No Signet button, report, or
   receipt may say it authorizes mainnet funding or broadcast.
5. Preserve the current explicit mainnet funding and deployment gates. Passing
   Signet proves integration behavior; it never authorizes production.

## Implementation phases

### 1. Network boundary

- Centralize network selection behind one typed configuration boundary.
- Parameterize BitcoinJS, addresses, xpub/tpub parsing, policy destinations,
  PSBT parsing, explorers, Core/Esplora identity checks, database records,
  browser text, and operator commands together.
- Require a recognized default-global-Signet chain identity. Reject Bitcoin
  testnet, custom Signet challenges, Mutinynet, regtest, and mainnet in the
  Signet profile.
- Add adversarial tests for mixed-network keys, addresses, PSBTs, observations,
  receipts, database rows, and encrypted custody data.

### 2. Close current review blockers

- Require independently verifiable Sigbash key and canonical-policy provenance,
  or document and technically enforce the narrowest provider verification path
  Sigbash makes available.
- Enforce safe CSV encoding bounds and a distinct, explicitly test-only Signet
  delay. A short Signet delay must never become a production default.
- Add participant-approved fee adaptation and an explicit replacement/CPFP
  strategy.
- Reject a 65-byte P2TR funding signature with an explicit zero/default sighash
  byte.
- Require fresh independent observations for every spend type.
- Replace or remove the current final-payout self-send.

### 3. Real Signet infrastructure

- Run a fully validating default-Signet Bitcoin Core node in an isolated
  datadir with the transaction index required by the application.
- Configure an independent default-Signet observation source and verify it
  agrees with Core before signing.
- Use fresh Signet-only Sigbash credentials and keys. Do not reuse historical
  checkpoints or any mainnet-oriented proof artifact.
- Use separate Signet PostgreSQL state and a private HTTPS origin for physical
  passkey tests.

### 4. Acquire and distribute Signet coins

Bitcoin Core ships `contrib/signet/getcoins.py`, whose default target is the
global faucet at `https://signetfaucet.com`. Once the isolated Signet wallet and
receiving address exist, request a small faucet amount and wait for confirmation.
The public faucet is rate-limited, so keep and recycle the test coins rather
than making repeated claims.

Use the confirmed faucet coin only to seed three separately controlled Signet
wallet UTXOs, one for each participant. The actual funding ceremony must then
consume those three wallet-owned inputs; it must not replace the three-wallet
flow with a single operator input. Never request, store, or use mainnet bitcoin
for this validation phase.

### 5. End-to-end Sigbash and product proof

Against the real hosted Signet SDK service and real Signet chain:

1. Create all nine immutable participant-and-round keys and retain protected
   recovery kits.
2. Reproduce and resolve the historical server-side `signPSBT` failure.
3. Prove the allowed PSBT signs and the wrong-amount, wrong-address, and
   extra-output variants fail for every relevant policy shape.
4. Complete three-participant roster confirmation and all nine readiness proofs.
5. Build, externally sign, unanimously approve, broadcast, confirm, and
   reorganization-test the exact three-wallet funding transaction.
6. Execute and confirm each solo-withdrawal ordering, both cooperative round
   sizes, both recovery thresholds, and the final-owner path with physical
   passkeys and persistent PostgreSQL state.
7. Repeat restart, duplicate, stale-observation, fee-pressure, backend outage,
   and block-reorganization drills without fixtures or automatic broadcast.

## Signet completion standard

The Signet phase is complete only when the exact user-facing product passes the
real service and chain matrix above and an independent review finds no open
critical or high-severity funding issue. The resulting report must say
`signetValidated: true`, `mainnetValidated: false`, and
`mainnetFundingAuthorized: false`.

## Later mainnet decision

Mainnet work resumes only after a separate decision that the validated product
justifies a commercial Sigbash agreement. At that point, repeat provider
provenance, key provisioning, policy, physical-device, database, backend,
deployment-digest, fee, recovery-delay, and tiny-value funding reviews using
new mainnet-scoped material. No Signet key, receipt, database state, wallet, or
success flag may be promoted into the mainnet release evidence.

## Progress snapshot — 2026-09-05

The real-chain checkpoint below is recorded evidence from 2026-08-31, not a new
live test. The 2026-09-05 [review and implementation](./CODE-REVIEW-2026-09-05.md)
fix readiness concurrency, independent proposal selection, broadcast recovery,
initial-funding uncertainty/retry ownership, and full-history custody unlocks.
Those checks use isolated databases, synthetic
signatures, loopback chain responses, and virtual authenticators; they do not
satisfy the hosted Sigbash or physical-device gates.

- Complete: typed mainnet/default-global-Signet boundary, cross-network rejection,
  Signet migration, network-specific browser text, offline/web/database
  acceptance, optimized production build, and all six optimized browser scenarios.
- Complete: fresh three-organization Signet credentials, all nine immutable
  10,000-sat-per-participant round keys, protected recovery journals, one allowed
  SDK local WASM `verifyPSBT`, and three local WASM hostile-transaction rejections. The prior
  default-amount key set is explicitly non-fundable and not reused.
- Complete: explicit-zero Taproot sighash rejection, CSV upper bound, and fresh
  observation enforcement for every proposal type.
- Complete: fully validating default-Signet Core 31.1 synchronization with
  `txindex=1`, an independent public explorer check, and isolated Alice, Bob,
  Carol, and watch-only vault wallets.
- Complete: a confirmed 82,132-sat faucet payment was split into three confirmed
  20,000-sat participant-wallet outputs. The exact funding builder then consumed
  one independently signed input per wallet and confirmed the 30,000-sat vault
  output in transaction
  `46fa0c249d7ccef642ef8b7d248c5fada161a571443e0b4721e03d7b7a518220`.
- Complete: SDK local WASM `verifyPSBT` accepted Alice's exact first-exit PSBT against
  that real confirmed vault coin and rejected wrong amount, wrong address, and
  extra output. The nullifier was available.
- Complete as a consensus checkpoint, not a user-facing custody proof: the
  funded vault was cooperatively spent in
  `ef01cb2027ca35b64e7d5390ffb7cd0b3b35e950658cfcc42684e35a57cad9f4`;
  the live audit passed the real outpoint, Taproot key-path witness,
  personal-key-only path, three 9,900-sat refunds, and confirmation checks.
- Still unresolved: local SDK policy verification succeeds, but the last hosted
  `signPSBT` attempts on 2026-09-05 reproduced `server_error: Signing service error`
  for both the saved first-round and a fresh second-round transaction. Stock SDK
  transport instead fails proof-bundle hex parsing. SDK
  `verifyPSBT` is not hosted-signer acceptance, and server-side logs are needed
  to locate the failure. The integration's custom `policy_proofs` hex-transport
  wrapper must be included in the provider reproducer. No local signer was
  substituted for the live product path.
- Newly demonstrated on 2026-09-05: SDK 0.8.0 concurrent `listKeys()` retrievals
  can confuse key material and contaminate a subsequent retrieval. The live
  diagnostic used a fresh single-key client and checkpoint bindings. The
  follow-up browser/CLI guard now isolates retrievals, validates actual key and
  recovery bindings, and tests timeout/resume behavior. All nine existing live
  keys passed read-only retrieval/share/current-envelope recovery checks.
  See [the readiness follow-up](./SIGNET-READINESS-2026-09-05.md).
- Still open: provider-signed key/policy provenance, participant-approved fee
  adaptation, final-sweep destination semantics, physical passkeys, PostgreSQL
  lifecycle execution, solo orderings, both recovery thresholds, the final-owner
  path, and the restart/outage/reorganization matrix.
- Implemented: the Signet-scoped private funding release/broadcast contracts,
  network/genesis-bound versioned receipts, independent approval flags/evidence,
  and fail-closed browser-build/runtime network binding. The complete **live**
  operator run remains open; synthetic receipts and store tests do not prove it.
  Follow [SIGNET-OPERATOR-RUNBOOK.md](./SIGNET-OPERATOR-RUNBOOK.md).
- User decision: defer physical passkey testing to the first friends vault.
  Continue virtual-authenticator tests autonomously; complete real two-passkey
  setup and recovery during onboarding before funding, without a separate test
  session requested now. Keep all nine actual hosted signatures mandatory.
- Completion flags remain `signetValidated: false`, `mainnetValidated: false`,
  and `mainnetFundingAuthorized: false`.
