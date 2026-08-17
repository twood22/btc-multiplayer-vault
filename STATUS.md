# Current project status

Last updated: 2026-08-17
Reviewed baseline: `5dde338eba32aea11f5208fbb720007fbd79fe32`

This is the current operational status and roadmap for the real mainnet-only
Bitcoin multiplayer vault described in [`spec.md`](./spec.md). Historical
findings remain in [`REVIEW.md`](./REVIEW.md), and detailed product and
deployment gates remain in [`PASSKEY-PRODUCT.md`](./PASSKEY-PRODUCT.md) and
[`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Verdict

**Ready to share with Sigbash for integration and security review, with the
open findings below disclosed. Not ready to deploy, fund, or broadcast.**

The repository implements the intended round-based game: Sigbash-enforced solo
withdrawals, participant-only BIP-327 MuSig2 cooperative exits, distributed
passkey-protected participant custody, timelocked recovery, final sweep, and
three-wallet funding preparation. Remaining blockers include a critical
Sigbash-registration provenance gap, in-repository safety work, and deliberately
external operational proof. In particular, no live Sigbash mainnet signature
has been obtained and no real mainnet transaction has been authorized. See the
[`current code review`](./CODE-REVIEW-2026-08-17.md) for evidence and severity.

## Proven on this baseline

- The offline TypeScript, policy, PSBT, Taproot, MuSig2, recovery, consensus,
  custody, and product-conformance suite passes under Node 22.23.2.
- Web typechecking and isolated browser tests pass under Node 22.23.2.
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

- Sigbash mainnet enablement and one real, locally authorized mainnet signature.
- The nine participant-and-round readiness proofs using three independently
  owned Sigbash organizations and physical passkeys.
- Production HTTPS/RP configuration, encrypted database operations and restore,
  private Bitcoin Core operations, real external-wallet signing, and real
  browser/device recovery drills.
- A published and independently reviewed registry manifest digest.
- Any deployment, funding, relay acceptance of the final real transaction, or
  broadcast.

## Current code blockers before deployment or funding

- **Sigbash key provenance:** the coordinator checks browser-submitted key and
  policy data for internal consistency but has no Sigbash-signed or independently
  queried attestation that the provider issued that key with that policy. The
  existing positive readiness proof can be satisfied by possession of the
  registered leaf key and therefore does not close this gap.
- **Recovery bounds:** enforce both a reviewed production minimum and the
  65,535-block BIP-68 maximum. The current explicit-value release check is not a
  safety bound.
- **Long-lived fee handling:** immutable low fixed fees and non-RBF sequences
  need a participant-approved fee-bump design or an explicit, tested alternative.
- **Funding P2TR signature encoding:** reject a 65-byte signature carrying an
  explicit zero/default sighash byte before it reaches final approvals.
- **Fresh chain evidence:** apply an age bound to solo, cooperative, and final
  proposal observations, not only recovery.
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

1. Can three participant-owned organizations be enabled for mainnet, with each
   participant creating the three immutable round-scoped keys they control?
2. Can Sigbash provide a server-verifiable attestation binding organization,
   key ID/index, BIP-328 xpub, policy root, and the canonical compiled policy?
   If `policyRoot` is deterministic, how should an independent verifier
   recompute it?
3. Does the current mainnet service support the SDK contract used here,
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
7. Are there mainnet-specific operational, fee, or abuse limits that should be
   reflected in the private three-person pilot?

## Roadmap and hard gates

These are sequential gates, not a deployment schedule:

1. **Sigbash integration review:** share this repository, the
   [`current code review`](./CODE-REVIEW-2026-08-17.md), and the questions above;
   enable only the isolated proof organization; confirm mainnet SDK, attestation,
   policy-root, and both leaf-key behaviors.
2. **In-repository safety pass:** close the verified provenance, recovery-bound,
   fee-handling, stale-observation, funding-signature, and final-sweep findings;
   add focused regression tests and repeat the independent review.
3. **Predeployment proof:** run the unfunded live setup/proof flow, back up the
   generated recovery kits, and have a human review the owner-only receipt and
   consensus evidence. Never fund its helper address.
4. **Private deployment:** publish the reviewed image, record and independently
   verify its registry manifest digest, configure HTTPS/RP/database/Core
   boundaries, and prove backup restoration.
5. **Three-person drills:** use two physical passkeys per participant, three
   separately controlled Sigbash organizations, all nine live keys/proofs, real
   wallets, and real-browser solo/cooperative/recovery/final-sweep exercises
   while the vault remains unfunded.
6. **Funding review:** choose a deliberately tiny amount cap and an appropriate
   recovery delay; review the recovery collusion trade-off, fees, readiness
   report, exact deployed digest, and final funding transaction with all three
   participants.
7. **Separate funding authorization:** only an explicit later decision may
   authorize broadcasting the funding transaction. A subsequent spend or
   broadcast remains a separate user and operator action.

Until every applicable gate passes, the correct state remains **unfunded**.
