# Bitcoin Multiplayer Savings Vault — One-Pager

## What it is

A 3-player Bitcoin savings game whose product code is pinned to mainnet. Alice, Bob, and Carol each lock
1 BTC into a shared vault that rewards patience: anyone can leave at any
time, but the **first** to withdraw takes a haircut (**0.95 BTC**), the
**second** gets a bonus (**1.025 BTC**), and the **last** sweeps the remainder
(**~1.025 BTC**). If everyone agrees, a cooperative exit refunds all deposits
in full — with no third party involved. The payout schedule is enforced by
**Sigbash**, a policy co-signer that holds half of a 2-of-2 signing key and
refuses to sign any withdrawal that breaks the rules.

## How it works

Each round of the game is **one Taproot UTXO**. Round one holds 3 BTC; a solo
withdrawal spends it entirely into exactly two outputs — the leaver's pinned
payout, and the leftover re-vaulted into the next round's (smaller) vault for
the remaining players. Ordering needs no coordinator: two people trying to
take the same round's payout are just double-spending the same coin, and
Bitcoin confirms only one. The whole address tree (1 round-one vault + 3
possible round-two vaults) is precomputed at setup.

Every vault output has three kinds of spending paths:

| Path | Who | Enforced by |
|---|---|---|
| **Key path** — MuSig2 (BIP-327) of all current players' personal keys | everyone together | Bitcoin consensus only |
| **One tapscript leaf per player** — that player's 2-of-2 Sigbash key | one player + Sigbash | Sigbash policy |
| **Recovery leaf** — `older(T)` timelock + (N−1)-of-N personal keys | remaining players after a delay | Bitcoin consensus only |

Each Sigbash key's policy pins everything: exact payout amount and address at
output 0, the next round's vault at output 1, a leftover floor that caps fee
burn at 10,000 sats, exactly 2 outputs, exactly 1 input, and a proof that the
key being used is the leaf key registered for that round.

## How it's built

TypeScript on Node.js (strict mode, run via `tsx`, `tsc --noEmit` gating the
test suite) + `bitcoinjs-lib` + `tiny-secp256k1`, with `@sigbash/sdk` for the
co-signer half. Satoshi amounts use a branded `Sats` type validated at every
input boundary. Key design decisions:

- **One Sigbash key per (player, round)** — nine keys, not three. A key's
  signature is only valid in the one vault whose leaf contains it, making
  cross-round replay (taking the round-two bonus out of the round-one pot)
  impossible by construction rather than by policy cleverness.
- **Immutable policies, no setup circularity.** Pair-round keys are created
  first (their policies pin only payout addresses); their vault addresses are
  derived; then round-one keys are created pinning those addresses. No
  mutable-policy features, no signing cooldowns.
- **Standard cryptography.** The cooperative key path is genuine BIP-327
  KeyAgg (validated against the official test vectors), so any compliant
  MuSig2 wallet can produce the cooperative exit.
- **Self-verification.** The test suite signs every transaction shape the
  vault can emit and re-verifies each one with an independent consensus
  checker: taproot merkle commitments, BIP-341 sighashes, Schnorr signatures,
  CHECKSIGADD/NUMEQUAL threshold semantics, BIP-68 timelock encoding, and
  relay-fee floors — plus regression tests that build the known attack
  transactions and prove no key/policy combination accepts them.

## Security model

**Sigbash is trusted for fairness, never for custody.** A hostile or offline
Sigbash can only grief (refuse to co-sign solo withdrawals); it can never
move or freeze funds, because the cooperative key path and the recovery leaf
contain no Sigbash key. This separation is the product's core invariant and
is checked by the audit suite.

**What each party can and cannot do:**

- *One player alone*: can take exactly their round's scheduled payout to
  their own registered address — nothing more, nothing else, nowhere else.
- *All players together*: full refund anytime, no Sigbash needed.
- *N−1 players after the timelock*: can recover a stuck vault (the escape
  hatch if someone vanishes).
- *Sigbash alone*: nothing.

**Assumptions and known trade-offs:**

1. **The recovery leaf is a collusion path.** After `T` blocks of vault
   inactivity (the inherited default 6 is offline-test-only), any N−1 players
   can jointly take the pot; in a 2-player round that is one person. This is
   the price of the "no one can freeze the vault" guarantee. Real deployments
   set `T` much higher and accept the trade-off knowingly.
2. **Cooperative signing is distributed.** The production ceremony implements
   interactive BIP-327 MuSig2 with one participant secret per device; the
   single-process signer remains an offline acceptance harness only.
3. **Participant custody is distributed.** Each participant secret is generated
   and passkey-encrypted in that participant's browser. The checked-in seed is
   only an offline fixture and live commands refuse it.
4. **Fee-burn bound.** A malicious leaver can overpay fees by at most 10,000
   sats per withdrawal — bounded by policy, not goodwill.
5. **Mainnet is not the same as mainnet-ready.** The code is mainnet-only, but
   live Sigbash mainnet signing, Core acceptance, a reviewed recovery delay,
   roster unanimity, real passkeys/Postgres, and deliberately tiny funding are
   still hard gates.
