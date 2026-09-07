# Presigned vault protocol v2

Status: user-authorized architecture, implementation in progress, **not a
security audit, mainnet release, or funding authorization**. Protocol identifier
`presigned-graph-v2`, serialization version 2. The separate `sigbash-v1` contract
and merged commit `202345ffd8bab35590fe15b98d966c4267f194ef` remain the rollback
baseline. Existing funded addresses/transactions cannot change protocol.

## Invariants and authority

Exactly three participants deposit equal amounts. First solo payout is 95% of
one deposit; second is 102.5%; the final participant receives the remainder
after the committed fees. Cooperative exits refund current participants equally
with deterministic fee allocation. Economics, scripts, network/genesis hash,
participant identities, recovery delay and fee rules are immutable commitments.
Mainnet is the production target; default global Signet is real-chain validation.

The coordinator holds public records, verified protocol contributions and
opaque ciphertext only. Personal, payout and solo private keys stay on each
participant's device. There is no service signing key, online policy signer,
required key-deletion assumption or covenant opcode. Miniscript defines signing
conditions; BIP-341 SIGHASH_DEFAULT signatures commit the full transaction.
Unanimous participants may always cooperate to change their allocation. After
the existing CSV delay, N-1 current participants may take the coin; in a pair
round that is either person. That is an explicit inherited collusion tradeoff,
not unilateral safety after recovery matures.

The browser code and participant device are trust boundaries. Local digest pins,
independent chain queries and restored kits defend against coordinator **data**
equivocation; they cannot make malicious JavaScript safe. A compromised code
delivery origin or extension can steal an unlocked secret or lie about review.
Participants must obtain the reviewed build/offline utility through an
independently verified artifact digest, compare public commitments with their
friends out of band, and keep the encrypted file and wrapping key separately.
Passkey user verification alone does not attest to the Bitcoin transaction.
JavaScript strings and browser copies cannot be reliably zeroized; short-lived
callbacks and byte-array clearing reduce exposure but are not a secure enclave.

## Vault outputs and signing keys

There are four vault outputs: ABC, AB, AC and BC. Each has:

1. BIP-327 KeySort/KeyAgg of current **personal** keys as the Taproot internal
   key; cooperative spending uses the correctly Taproot-tweaked MuSig2 key path.
2. A `multi_a(N,...)` leaf using distinct participant-and-round-scoped solo
   keys. Each current member must sign this leaf.
3. `and_v(v:older(delay),multi_a(N-1,...))` using current personal keys for
   recovery. `v:older` compiles to CSV followed by VERIFY; implementations must
   recognize this exact encoding, not confuse it with the legacy CSV/DROP leaf.

The nine solo keys bind the vault ID and are domain-separated from personal/payout
keys and from legacy Sigbash derivations. All public keys are curve-checked, unique by role,
and independently reconstructed by their owners. The two-leaf tree, key order,
descriptors and control blocks are deterministic and cross-checked with Core.

## Funding epoch and complete graph

An epoch binds the vault ID, explicit protocol/network/genesis, canonical roster,
economics, three confirmed native P2WPKH or key-path P2TR wallet inputs, exact
change scripts, total funding fee, and exact unsigned funding transaction.
The submission path accepts no legacy/P2SH input, scriptSig, Taproot script-path
funding signature or annex. Benign wallet metadata is checked and normalized.
Witness signatures leave its txid
unchanged. Output 0 is exactly three deposits to the ABC vault. Other outputs
are three deterministically ordered refundable changes of at least 330 sats
each, sent back to each participant's exact native funding-input wallet script.
That wallet-control boundary gives every participant a funding-fee rescue path;
none may recreate any of the four vault scripts. The refundable surplus is not
a larger game deposit. Funding, every game exit, and each new cooperative,
recovery or final-sweep proposal use transaction version 3 (TRUC).

From funding output 0, construct the three first-leaver transactions. Each has
one input and exactly two outputs: the committed payout at index 0, and the
remaining pair vault at index 1. From each parent index 1 construct both possible
second-leaver transactions, each paying its leaver at index 0 and the final
participant at index 1. Their fixed fees preserve the existing first-round fee
and doubled pair-round fee. All nine transaction IDs are known before funding
signatures exist. Final sweeps and cooperative/recovery exits are created only
when their exact coin and independently observed chain state are known.

Each person pre-signs **only other people's** exits that need their signature:
two first-round and two pair-round transactions, four signatures per person.
The complete set has twelve signatures. The designated leaver's final signature
is deliberately absent from every setup transaction and is rejected by setup
APIs. After funding, that person can complete any of their three applicable exits
without contacting any other signer. The chain, not a coordinator lock, decides
which conflicting exit confirms.

## Ordered ceremony and irrevocable signatures

The user-facing phases are distinct:

`identity/recovery → roster agreement → unsigned funding inputs → frozen epoch
→ 12 preauthorizations → verified portable backups → durable wallet-start intent → wallet signatures
→ exact-witness approvals → private operator submission → confirmed activation`.

Every participant rebuilds the entire graph and verifies all twelve signatures
before acknowledging backup and before exporting a wallet-signable funding PSBT
or releasing a wallet signature. Their client checks its own local public keys,
approved roster/epoch digests, all payouts and parent links. The server repeats
validation but cannot substitute for the client checks. A participant may obtain
unsigned transaction data earlier to validate it; concealing a PSBT is not a
cryptographic safety boundary. The honest client refusing to sign is.

An acknowledgement means a complete encrypted kit was exported, independently
reopened and verified. Passkey ciphertext alone is not portable: an offline
recovery secret must unlock the kit without this service, browser profile or RP
origin. The kit includes the public roster, exact funding template/prevouts,
all nine exits, all twelve preauthorizations, scripts/control blocks, network and
epoch bindings, and that participant's encrypted key material. The recovery
secret is generated/displayed locally and never transmitted, logged or stored
in coordinator state. Two distinct PRF passkeys remain the everyday custody and
device-recovery requirement. Restoring a kit must prove a usable exit offline,
not merely decrypt JSON. Files must be size-bounded and authenticated before use.

The honest UI records a passkey-approved, durable wallet-start intent before
exporting a wallet-signable PSBT. Any such intent closes the restart path,
including after a failed download or lost signature upload. The coordinator
cannot detect someone manually reconstructing/signing public transaction data
outside this workflow; that limitation is not disguised as PSBT concealment.

Once any wallet signature has been released, database deletion, an expired
session, a unanimous restart or an operator approval cannot revoke it. Retain
every signed epoch and its complete kit; never overwrite it with a replacement
epoch. An old funding transaction remains potentially broadcastable until its
inputs are provably spent. Never automatically create a conflicting funding RBF
replacement or retire old recovery material. If signing did not start, a new
epoch may supersede setup only with unanimous digest-bound restart approval.

## Fee adaptation and relay limits

Game transactions are immutable, not economically reliant on a 'non-RBF' flag.
Core full-RBF means competing fully signed exits can replace one another before
confirmation. Extra fees must not mutate any game parent, its txid or successor
output. CPFP spends only the initiating payout owner's payout, together
with one separately approved **confirmed** outside wallet sponsor input. With sponsorship,
the child preserves the full committed payout and charges its fee to sponsor
change. No other participant's payout or successor vault may fund the child.

The payout owner signs locally; a sponsor independently signs only its own
input. Both approve exact bytes, destinations, maximum fees and change. A new
child may replace a prior child, without invalidating any descendant signature.
The UI shows extra fees, the preserved payout/refund, sponsor change, conservative
and final package sizes, and the exact cap. Public drafts and completed packages
can be saved/restored after interruption; no participant secret is included.
The service rechecks parent quorum, full transaction signatures, active source
anchors and confirmed sponsor facts at both passkey approval stages. A durable
exact-package journal exists before `submitpackage`; lost replies are reconciled
by transaction ID, and per-attempt compare-and-swap prevents stale workers from
overwriting newer outcomes. Parent/child package submission, relay
floors, package/cluster limits, fee replacement and competing-branch pinning
require Core tests. Do not promise time-bounded confirmation or hide the
need for sufficient outside fee liquidity.

Funding has the same fee-rescue requirement. A funding child consumes exactly
one participant's wallet-change output and one confirmed outside sponsor input.
The external wallets sign their own inputs; the child returns the full original
refund to the same script and charges only the sponsor. It does not spend the
ABC vault or alter funding bytes, its txid, any deposit or any preauthorization.
Because all three funding inputs are confirmed and funding uses V3, this is a
one-parent/one-child package too. A fee child can sibling-evict an early first exit
from a local mempool, but cannot invalidate it; wait for funding confirmation and
relay the identical exit again. Arbitrary wallet-change addresses are not accepted
as a claim of unilateral control; this initial policy reuses the proven input
script, with that address-reuse privacy tradeoff disclosed during setup.

The offered package must have a confirmed round input (funding confirmed before
first exit, first exit confirmed before second). A sponsor coin comes from
outside the graph and is already confirmed. The committed fee-policy identifier
is `confirmed-truc-payout-cpfp-v1`. Version-3 parents and fee children opt into
BIP431 topology restrictions: the sponsored child is at most 1,000 vbytes and
has one unconfirmed parent. Child-alone and combined-package fee requirements
are checked; a below-floor immutable parent is allowed only within an adequately
funded package. Sibling eviction may remove an unconfirmed second exit from a
node's mempool, but does not invalidate its exact signed bytes; it can be relayed
again after its parent confirms. Application round progression requires confirmation.

An actual Core31.1 experiment demonstrated a 64-transaction volume pin with
ordinary V2 transactions. The selected V3 policy rejected the descendant flood,
permitted fee-child sibling eviction/replacement, and rescued a fixed-fee parent
when genuine eviction raised the rolling floor. This bounds particular local
pinning attacks, not all liveness failures: high-fee competing children, sponsor
liquidity, wallet compatibility and heterogeneous relay remain constraints.
Local package acceptance is not a promise of propagation or confirmation.

The UI must display the final payout after base fees, not promise monotonically
increasing net returns. For the 10,000-sat isolated fixture, the payouts are
9,500, 10,250 and 9,350 sats: 300 + 600 base fees outweigh the last-player bonus.
Sponsored fee children preserve these exact amounts, not repair that arithmetic.

## Runtime, failure and release boundaries

Use the same separate signing, exact-byte broadcast approval, idempotent send,
confirmed transition, watcher lease and active-chain block anchoring principles
as v1. An unavailable coordinator must not prevent offline recovery from a kit.
An orphaned parent suspends descendants; preserve and track previously released
exact bytes and funding epochs rather than invalidating their recovery material.
Observation failures leave state unchanged. No counter or backend status grants
authority to spend an unrelated outpoint, round, network or epoch.

State digests authenticate content but do not order observations. Watch
publication also compares a monotonic database revision under the vault lock;
successful and deferred publications both advance it. This rejects stale
same-state snapshots and confirmation/reorganization cycles that return to the
same digest after a worker loses its separate session lease. Database restoration
still requires quiescing every old writer. Accepted sends remain observable for
reorganizations, but bounded retry batches rotate by last attempt rather than
permanently selecting the oldest creation times. Retry scheduling does not
replace exact authority checks or turn fee approval into a send intent.

Discover all known funding/graph transaction IDs even when no API proposal was
created. A first poll may see funding and both exits already confirmed in one
block, with spent intermediate outputs. Exact approved witness bytes constrain
our submission; on-chain recognition must also accept a different valid witness
for the same exact non-witness transaction and txid. Transaction and block
observations must agree against a stable before/after tip and independent active
block anchors; an RPC error is never evidence that a transaction disappeared.

A funding input's initially recorded block hash is immutable selection evidence,
not a transaction or sighash field. If the identical input re-confirms in another
active block, later wallet/funding checks keep the graph and all signed bytes
unchanged while independently rechecking its exact outpoint, value, native
script, non-coinbase status, current unspent status and minimum depth. The browser
must disclose the new anchor. Runtime source anchors and CSV age are separate
execution predicates: reanchoring a finalized runtime proposal requires a new,
linked execution proposal and fresh broadcast approvals, reusing the exact
transaction bytes but never old MuSig secret nonces. Earlier bytes and approvals
remain retained and cannot be cryptographically revoked.

Version is a durable database, artifact, custody and API discriminator, not a
global environment switch capable of reinterpreting old data. New v2 readiness
requires a locally rebuilt graph, verified preauthorizations, restored backups,
chain-bound funding inputs, approvals, release evidence and consensus checks.
It never treats local fixtures or absent Sigbash checks as readiness.

The new executable-evidence receipt names every mandatory Core, browser,
recovery, database and real-Signet acceptance category and binds source,
offline-utility and exact tested-image digests. A distinct fresh funding release
must also bind this vault/epoch/graph/final transaction, a production database
restore receipt, explicit beta cap and verified private Core runtime. Physical
passkey tests are not claimed by the automated receipt: release for the friends'
vault remains blocked until onboarding actually supplies them. These release
checks are being integrated and are not evidence that any release has passed.

Required evidence: all six exit orderings on Core; missing/wrong/extra signature,
payout, script, input, branch, fee, epoch and network mutations rejected; full
cooperative, mature/immature recovery and final sweeps; fee-child/package tests;
portable offline recovery; two virtual-passkey browser ceremonies; durable
database/restart/concurrency/reorg tests; and complete real default-Signet
lifecycles using isolated nonpublic test keys and test coins. Physical passkey
drills remain explicitly deferred to friends' onboarding. Mainnet spending,
public exposure and outreach require separate user authorization.

## Primary specifications

- [BIP 379 Miniscript](https://github.com/bitcoin/bips/blob/master/bip-0379.md)
- [BIP 341 Taproot](https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki)
- [BIP 141 Segregated Witness](https://github.com/bitcoin/bips/blob/master/bip-0141.mediawiki)
- [BIP 327 MuSig2](https://github.com/bitcoin/bips/blob/master/bip-0327.mediawiki)
- [BIP 431 TRUC](https://github.com/bitcoin/bips/blob/master/bip-0431.mediawiki)

These specify primitives, not an audit of this application or its ceremony.
