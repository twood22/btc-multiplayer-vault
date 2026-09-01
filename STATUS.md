# Current project status

Last updated: 2026-08-31
Reviewed baseline: `5dde338eba32aea11f5208fbb720007fbd79fe32`

This is the current operational status and roadmap for the Bitcoin multiplayer
vault described in [`spec.md`](./spec.md). The production target remains
mainnet, while the next implementation and integration milestone is the default
global Bitcoin Signet described in
[`SIGNET-VALIDATION-PLAN.md`](./SIGNET-VALIDATION-PLAN.md). Historical
findings remain in [`REVIEW.md`](./REVIEW.md), and detailed product and
deployment gates remain in [`PASSKEY-PRODUCT.md`](./PASSKEY-PRODUCT.md) and
[`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Verdict

**The typed standard-Signet profile, offline/PostgreSQL/build/browser gates, and
a real three-wallet funding plus cooperative-spend checkpoint now pass. Hosted
Sigbash signing and the complete user-facing lifecycle remain blocked or
unproven; mainnet is still unauthorized.**

The repository implements the intended round-based game: Sigbash-enforced solo
withdrawals, participant-only BIP-327 MuSig2 cooperative exits, distributed
passkey-protected participant custody, timelocked recovery, final sweep, and
three-wallet funding preparation. Remaining blockers include Sigbash-registration
provenance, fee adaptation, final-sweep destination semantics, and external
operational proof. Sigbash declined mainnet SDK enablement for the current
experimental project but permits SDK testing on Signet. A real standard-Signet
vault was funded and cooperatively spent, but no hosted Sigbash signature or
complete user-facing run has been obtained, and no real mainnet transaction has
been authorized. See the
[`current code review`](./CODE-REVIEW-2026-08-17.md) for evidence and severity.

## Proven on this baseline

- The offline TypeScript, policy, PSBT, Taproot, MuSig2, recovery, consensus,
  custody, and product-conformance suite passes under Node 22.23.2.
- Web typechecking and isolated browser tests pass under Node 22.23.2.
- Both mainnet and default-global-Signet network acceptance pass. The Signet
  offline/web suite, fresh PostgreSQL 16 migration/database suite, optimized
  production build, and all six optimized three-browser scenarios pass.
- Nine fresh **10,000-sat-per-participant** Signet-only hosted Sigbash keys were
  created under three independent credential organizations, with protected
  recovery journals. An earlier nine-key 1-BTC policy set is retained only as
  non-fundable historical setup evidence. Hosted
  `verifyPSBT` accepted the exact allowed transaction and rejected wrong-value,
  wrong-destination, and extra-output variants.
- Against the real confirmed vault outpoint
  `46fa0c249d7ccef642ef8b7d248c5fada161a571443e0b4721e03d7b7a518220:0`,
  hosted `verifyPSBT` accepted Alice's exact 9,500-sat first exit with 20,200
  sats re-vaulted and explicitly rejected wrong-amount, wrong-address, and
  extra-output PSBTs. The signing nullifier was reported available.
- Funding rejects non-canonical 65-byte Taproot signatures with an explicit zero
  sighash byte; all proposal types require fresh observations; recovery delay is
  bounded to the CSV-encodable range 1 through 65,535.
- Bitcoin Core 31.1 is fully synchronized against default global Signet in an
  isolated datadir with `txindex=1`. A faucet paid 82,132 sats in
  `c80ae308b476f73d6844aa75e713d33b9cb20428eca2d73c9917a58b5bcd8833`;
  `3bd606154ba8c7d6651861ff72f9a862f4b63fa13c1feba91d7e7bbcf193bc2c`
  split it into confirmed 20,000-sat Alice, Bob, and Carol wallet outputs.
- The exact three-wallet funding builder consumed one independently signed
  Taproot input from each Core wallet and confirmed transaction
  `46fa0c249d7ccef642ef8b7d248c5fada161a571443e0b4721e03d7b7a518220`,
  with one 30,000-sat round-one vault output, three 9,000-sat change outputs,
  and a 3,000-sat fee.
- The confirmed vault output was spent through its participant-only MuSig2
  key path by
  `ef01cb2027ca35b64e7d5390ffb7cd0b3b35e950658cfcc42684e35a57cad9f4`.
  The live audit verified the selected outpoint, Taproot key-path witness, no
  Sigbash keys in the cooperative path, three exact 9,900-sat refunds, and one
  confirmation. This isolated CLI signing checkpoint proves the consensus
  path, not three-device/passkey custody.
- `npm audit --audit-level=low` reports zero known vulnerabilities.
- The manual `Exact container acceptance` GitHub Actions run passed for the
  merged baseline: [run 32064526120](https://github.com/twood22/btc-multiplayer-vault/actions/runs/32064526120).
  It ran six isolated browser scenarios and the packaged, non-mutating operator
  probe against local image ID
  `sha256:d275c0d95ee4ec34564f36718fc1d1b4e433a91717b8f32a8a6e04db09a084b1`.
- That CI evidence is a tested local image ID, **not** a published registry
  manifest digest, deployed artifact, live-service test, funding approval, or
  mainnet authorization.

The pinned checkout/setup actions currently use Node 20 action runtimes that
GitHub forces onto Node 24. The application and acceptance suite still use the
repository's exact Node 22.23.2 runtime. Updating those actions is a maintenance
item, not evidence that the application ran under the wrong Node version.

## Explicitly unproven

- A complete real hosted-Sigbash signing flow on standard Signet. The hosted
  verifier accepts the real confirmed coin, but `signPSBT` still returns
  `server_error: Signing service error` from the signing service.
- Nine live readiness signatures, three physical-passkey identities, and the
  complete user-facing on-chain state machine.
- Sigbash mainnet enablement and one real, locally authorized mainnet signature.
- The nine participant-and-round readiness proofs using three independently
  owned Sigbash organizations and physical passkeys.
- Production HTTPS/RP configuration, encrypted database operations and restore,
  user-facing private Bitcoin Core operation, physical external-wallet signing,
  and real browser/device recovery drills.
- A published and independently reviewed registry manifest digest.
- Any deployment, mainnet funding/broadcast, or user-facing passkey-approved
  Signet funding/broadcast. The confirmed CLI checkpoint is operational evidence,
  not deployment authorization.

## Current code blockers before deployment or funding

- **Sigbash key provenance:** the coordinator checks browser-submitted key and
  policy data for internal consistency but has no Sigbash-signed or independently
  queried attestation that the provider issued that key with that policy. The
  existing positive readiness proof can be satisfied by possession of the
  registered leaf key and therefore does not close this gap.
- **Long-lived fee handling:** immutable low fixed fees and non-RBF sequences
  need a participant-approved fee-bump design or an explicit, tested alternative.
- **Final sweep semantics:** choose a separately approved destination or remove
  the current self-send and fee burn.

The protected live-proof receipt is local operator evidence, not a
provider-signed Sigbash attestation. Browser hostile-PSBT rejections are
browser-observed evidence; the server independently proves only the allowed
transaction and signature it can verify itself.

## Design decision requiring explicit funding-time review

The recovery leaf is an uncovenanted CSV-delayed `N-1` participant spend. After
the configured delay, `N-1` participants can send the entire current UTXO to
arbitrary outputs. In a two-participant round, that means one participant can
take the remaining pot after the delay. This is the specified liveness escape
hatch, not a Sigbash-enforced game withdrawal, and Bitcoin Script does not
constrain its outputs. It must be accepted as part of the trust model and given
a deliberately reviewed mainnet delay before any funds are approved.

## Questions for Sigbash

1. May the three participant-owned organizations each create their three
   immutable round-scoped keys on the default global Bitcoin Signet under the
   free SDK testing policy?
2. Can Sigbash provide a server-verifiable attestation binding organization,
   key ID/index, BIP-328 xpub, policy root, and the canonical compiled policy?
   If `policyRoot` is deterministic, how should an independent verifier
   recompute it?
3. Does the current Signet service support the SDK contract used here,
   including immutable `REQKEY`, output destination/value constraints,
   input/output counts, recovery-kit export, and the expected rate limits?
4. Please confirm that descriptor `tr(SIGBASH_XPUB/0/*)` identifies the
   child-`0/0` policy leaf key while the SDK's identification key remains its
   distinct internal aggregate root. The code fails closed if that contract
   differs; it does not substitute another leaf-key candidate.
5. Is every signing route for the identification root/aggregate key subject to
   the same canonical policy, even though it is a separate bare Taproot leaf?
6. What service-side evidence can Sigbash provide for policy rejection,
   nullifier consumption, key/network identity, and signed-response fields?
7. What Signet rate, key-count, nullifier, and retention limits should the
   nine-key three-person validation respect?

## Roadmap and hard gates

These are sequential gates, not a deployment schedule:

1. **Network boundary:** implement the isolated default-global-Signet profile
   in [`SIGNET-VALIDATION-PLAN.md`](./SIGNET-VALIDATION-PLAN.md) without changing
   the round game or weakening the existing mainnet gates.
2. **In-repository safety pass:** close the verified provenance, recovery-bound,
   fee-handling, stale-observation, funding-signature, and final-sweep findings;
   add focused regression tests and repeat the independent review.
3. **Signet infrastructure and coins:** run isolated default-Signet Core,
   Postgres, HTTPS/passkey, and independent observation boundaries; obtain a
   small faucet coin and split it into three participant-controlled wallet UTXOs.
4. **Real hosted-Sigbash proof:** create fresh Signet credentials and keys,
   resolve the historical signing failure, prove allowed signing and hostile
   rejection, and verify provider provenance as far as the service permits.
5. **Complete Signet product run:** execute all nine readiness proofs, funding,
   solo orderings, cooperative exits, recovery thresholds, final-owner flow,
   confirmation, restart, outage, fee, and reorganization drills using the real
   service and chain rather than fixtures.
6. **Independent Signet release review:** require no open critical/high funding
   issue and produce an explicitly non-mainnet report.
7. **Later commercial/mainnet decision:** only a separate decision may begin a
   new mainnet-scoped deployment and tiny-funding review. Every mainnet gate and
   explicit authorization remains required.

Until the Signet network boundary and safety gates pass, do not acquire or use
even Signet coins in the product flow. Mainnet remains **unfunded** unless a
later commercial and funding decision explicitly changes that state.
