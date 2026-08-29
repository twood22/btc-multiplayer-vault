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
