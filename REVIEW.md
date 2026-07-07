# Review of the Codex Implementation

Verdict: **solid scaffolding, not safe to fund.** The Codex build got the
overall shape right — precomputed vault tree, taproot outputs with a
personal-keys-only key path, per-participant tapscript leaves, two-output solo
withdrawals, a local policy model mirrored against Sigbash, and an unusually
complete CLI for building/auditing live signet transactions. But it contained
one outright theft/burn vector, one consensus-invalid transaction path, a live
setup flow that cannot work without admin privileges, and a cooperative exit
that would never relay. All four are fixed in this revision (commit history:
`Codex baseline` → current).

## Defects found (and fixed)

1. **Cross-round policy confusion (theft/burn vector).** Each participant had
   a single Sigbash key whose policy was an OR across every round they could
   leave in, with no input-side constraints. The same leaf key appeared in the
   round-one and round-two vaults, so Alice could spend the 3 BTC round-one
   vault with round-two-shaped outputs: 1.025 BTC to herself (instead of the
   0.95 first-leaver haircut) and the "leftover" straight to Bob's personal
   payout address — destroying the game and Carol's custody. Sigbash would
   have signed it: the round-{A,B} OR branch was satisfied. **Fix:** one
   Sigbash key per (participant, round), so a key's signature is only valid in
   the single vault whose leaf contains it; plus `TX_INPUT_COUNT == 1` in every
   policy. A regression test builds the attack transaction and proves no
   policy/key combination accepts it.

2. **Consensus-invalid recovery transactions.** The timelocked recovery leaf is
   a `multi_a`-style `CHECKSIG/CHECKSIGADD ... NUMEQUAL` threshold, but the
   code finalized it with bitcoinjs' default tapscript finalizer, which emitted
   only the collected signatures (2 witness elements for a 3-key script) with
   no empty slot for the vanished signer and no ordering guarantee. The
   transaction validates in the repo's own PSBT-level checks but fails Bitcoin
   consensus — the recovery path (spec acceptance item 6) was unusable on
   chain. **Fix:** an explicit finalizer that emits exactly `threshold` valid
   signatures plus empty elements in reverse key order, verified by an
   independent script-execution check (`src/consensus.js`). Re-running the old
   finalizer against that verifier reproduces the failure.

3. **Live setup depended on an admin-only feature.** The flow created keys with
   `updateable: true` and later called `updatePolicy()`. Per the SDK docs,
   non-admin callers get that flag *silently ignored*, so `updatePolicy()`
   throws `NOT_UPDATEABLE` and the setup dead-ends (and even for admins, every
   update triggers a 24-hour signing cooldown). **Fix:** per-round keys make
   every policy final at creation time. Pair-round keys are created first
   (their policies pin only payout addresses), the pair vault addresses are
   derived from them, then round-one keys are created with those addresses
   pinned. No updateable keys, no cooldown, no circularity.

4. **Cooperative exit could not relay.** It refunded exactly 3 × 1 BTC from a
   3 BTC input — a zero-fee transaction, rejected by mempool policy. For pair
   rounds it refunded 1 BTC each and silently burned the ~0.05 BTC haircut
   surplus to fees. **Fix:** the pot is split equally after a ~900 sat fee.

5. **"BIP-327-style" key aggregation was nonstandard.** KeyAgg was hand-rolled
   over x-only keys (BIP-327 hashes 33-byte compressed keys), so no real MuSig2
   wallet could ever co-sign the "trust-minimized" exit path, and the
   deterministic-nonce aggregate Schnorr signer was reimplemented by hand.
   There was also a dead `aggregateXonlyPubkeys()` that "aggregated" keys by
   hashing them — not a curve point at all. **Fix:** standard BIP-327 KeyAgg
   validated against the official test vectors, with the demo signature
   produced by the library BIP-340 signer over the tweaked aggregate secret.
   (The demo still signs in one process; production needs interactive MuSig2 —
   see README.)

6. **Unbounded fee burn within policy.** Leftover floors left ~0.999 / ~0.497
   BTC of slack below the true leftover, all of which a malicious leaver could
   burn to fees while satisfying Sigbash. **Fix:** floors derived from the
   schedule with a 10,000 sat per-transaction fee budget.

7. **Live keys bound to a public seed.** Every "private" key — including the
   Sigbash client shares registered with the live server — derived from the
   checked-in default seed unless an env var was set. **Fix:** live-mode
   commands refuse to run on the default seed.

8. **Wrong leaf key for live mode (probable).** The tapscript leaf used
   `aggregatePubKeyHex`, which the SDK documents as the *taproot-tweaked*
   on-chain key, while its multisig integration derives co-signer leaf keys
   from `bip328Xpub/0/*`. **Fix:** leaf keys derive from the xpub child 0/0
   (with the tweaked aggregate printed as a fallback candidate), and every
   policy carries a descriptor-mode `REQKEY` that makes Sigbash itself verify
   the leaf key matches its own derivation before signing.

## What Codex got right

- The one rule that matters: no Sigbash key ever appears in the cooperative
  key path, and the ordering mechanism is purely the single spent UTXO.
- The vault taproot construction (leaves, control blocks, addresses) is
  correct — all spends against it verify at the consensus level.
- The local/live split with a mirrored policy evaluator is a good design and
  was kept.
- The funding/watch/audit CLI surface is genuinely useful for driving a real
  signet run and was kept nearly intact.

## Verification added

`npm test` now includes, beyond the original checks: official BIP-327 KeyAgg
and full-protocol vectors (nonce gen/agg, sign/verify, tweaked signing, sig
agg — 28 cases); independent consensus verification (control-block merkle
commitment, BIP-341 sighash recomputation, Schnorr verification, CHECKSIG/
CHECKSIGADD/NUMEQUAL emulation, BIP-68 sequence rules, 1 sat/vB fee floor) of
every transaction shape the vault can emit; an end-to-end interactive MuSig2
cooperative-exit ceremony proven consensus-valid for both round sizes; and
policy regression tests for the cross-round and multi-input attacks. Negative
tests confirm the verifier rejects corrupted signatures, wrong prevouts, and
wrong scripts.

## Live Sigbash findings (signet proving ground)

The demo was exercised against the real Sigbash signet server, not just the
local model. What was confirmed on live infrastructure:

- **Connectivity and provisioning work end to end.** WASM loads (with SHA-384
  pinning available via `SIGBASH_WASM_SHA384`), `generateCredentials` and
  `createKey` succeed, and the two-phase 9-key setup runs (now resumable via a
  checkpoint file and tolerant of the server's ~1-key/min rate limit and
  transient timeouts).
- **Policy enforcement is real and correct.** Live `verifyPSBT` returns a
  `satisfiedClause` showing every one of our constraints enforced: output
  count == 2, input count == 1, output 0 pinned to the leaver's address and
  amount, output 1 pinned to the next vault, and the leftover floor. This is
  the security-critical half of the design, and it works.
- **Tamper rejection works.** Wrong-amount, wrong-address, and extra-output
  PSBTs are all rejected live as "policy not satisfied." A malicious withdrawal
  cannot get a Sigbash signature.
- **Leaf-key derivation resolved.** The tapscript leaf key that satisfies the
  descriptor-mode `REQKEY` clause is the xpub's child `0/0` (not the tweaked
  aggregate, which was the documented fallback guess). The xpub also arrives
  with a BIP-380 key-origin prefix that the parser now strips.

**The one remaining live gap:** getting Sigbash to actually *co-sign* a
withdrawal. `verifyPSBT` reports "policy satisfied but no Sigbash-controlled
inputs found in PSBT" — Sigbash accepts the policy but does not yet recognize
the vault input as one it controls when its key sits in a bare `pk(K)`
tapscript leaf. Black-box probing (every KMC key as the leaf; every BIP-371
derivation-path format; keypath vs script-path) localized this precisely but
did not crack it. The most likely resolution is Sigbash's multi-party
`clientKeys` create-key parameter plus a `sortedmulti_a` leaf structure (the
integration its docs describe for combining a Sigbash key with co-signers),
which needs Sigbash's multi-party example or support to pin down. Until that is
closed, live solo withdrawals cannot be signed — so **the vault is not yet
fundable on mainnet**, and this is the top remaining item.

Everything that does not depend on Sigbash — the cooperative exit (now a real
interactive MuSig2 ceremony), the timelocked recovery, and the final sweep —
is consensus-verified and independent of this gap.
