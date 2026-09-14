# V3 design: fixed, quorum-triggered recovery refunds

Date: 2026-09-13. Status: requested design, NOT an implemented protocol,
security audit, deployment approval, or permission to fund. The current V2
implementation still has unrestricted delayed recovery. Do not describe an
existing V2 vault as protected by this design.

## Product contract

Replace the ability of a recovery quorum to choose a transaction with the
ability to release one exact refund transaction approved before funding.

- Normal solo withdrawals retain `last-survivor-net-v1`: first < second < last
  after the committed solo and final-sweep base fees. Funding and optional fee
  boosts are separate costs.
- Recovery closes the current round and divides its remaining value equally
  among ALL current members, less a fixed, pre-approved recovery fee. A person
  need not be online or sign at recovery time to receive their refund.
- Refund amounts AND destination scripts are fixed before deposits are signed.
  There is no recovery destination picker, quorum-controlled allocation, fee
  override, operator override, or later unrestricted emergency branch.
- Two of three can trigger initial recovery after its delay. After one normal
  exit, either survivor can trigger pair recovery after that new coin's delay.
  They cannot use recovery to take the other members' refunds.
- Someone who already withdrew is not refunded again. After the second normal
  exit, the final coin belongs to its one owner; it needs no group recovery.
- Keep the all-current-member cooperative path. Those members can unanimously
  agree to another allocation. This is not permission for a smaller quorum.

Important remaining tradeoff: recovery is an emergency equal settlement, not a
last-survivor win. The quorum can invoke it after maturity even if nobody has
actually lost access. This prevents confiscation of a refund, but does not stop
forced game termination or guarantee the last-person bonus on recovery paths.
Bitcoin cannot infer that someone is genuinely unavailable from this script.
Protecting a winner's bonus even against forced equal settlement would require
a different game/recovery policy; it is not claimed here.

## Exact recipients and amounts

Use the same per-participant payout script committed for ordinary withdrawals.
In the current product that is a P2TR output derived from the participant's
payout key, NOT an arbitrary external-wallet address entered during recovery.
Show its Bitcoin address and verify local ownership during setup. Adding
user-entered external withdrawal scripts would be a separate wallet-interface
change; this design does not pretend that feature already exists.

For a round with value V, n current members, and the committed recovery fee R:

`base = floor((V - R) / n)`; `remainder = (V - R) mod n`.

Sort current participant IDs canonically. Give the first `remainder` members
one additional satoshi. Outputs occur in that same order. Validate safe integer
arithmetic, conservation, positive fee, and every output's policy floor before
any signature. Fee changes require a new, unanimously approved, unfunded epoch;
an already-signed recovery parent is immutable.

| Current coin | Fixed refund recipients | Setup approvals for this refund | Runtime trigger |
| --- | --- | --- | --- |
| ABC, funding output 0 | A, B, C | All 3 | Any 2 of those 3 |
| AB, C's first-exit output 1 | A, B | Both | Either A or B |
| AC, B's first-exit output 1 | A, C | Both | Either A or C |
| BC, A's first-exit output 1 | B, C | Both | Either B or C |
| Final single-owner payout | Already owned individually | No group refund | Owner's ordinary spend |

Example only, using the existing small fixture: D=10,000, solo fee F=300,
final-sweep fee S=300, recovery fee R=500 sats.

- Normal completed game: 9,120 / 9,600 / 10,080 sats after configured base fees.
- Recovery before any exit: 9,834 / 9,833 / 9,833 sats to A/B/C.
- Recovery after the first normal exit: the first person keeps 9,120; the
  20,580-sat pair coin refunds 10,040 to each survivor and pays 500 in fees.

Unused future solo/sweep fees are not separately deducted on recovery: start
from the actual current coin, deduct only R, and distribute the rest. Subsequent
spending of an individual refund may incur its owner's own wallet fee.

## On-chain construction: two independent signature requirements

Proposed identifier: `presigned-graph-v3`, serialization version 3, with an
explicit committed `recoveryPolicy: "fixed-equal-quorum-v1"`. Require the new
last-survivor schedule for newly created V3 rosters. Unknown versions or policy
markers fail closed. Protocol V3 is distinct from transaction `nVersion=3`.

Keep the cooperative MuSig2 internal key and the normal preauthorized solo
leaf. REPLACE the old recovery leaf; never retain it alongside the new leaf.
The proposed recovery leaf for n members is:

```text
<delay> CHECKSEQUENCEVERIFY VERIFY
<A1> CHECKSIG <A2> CHECKSIGADD ... <An> CHECKSIGADD <n> NUMEQUALVERIFY
<T1> CHECKSIG <T2> CHECKSIGADD ... <Tn> CHECKSIGADD <n-1> NUMEQUAL
```

`Ai` is a member's round-scoped recovery-authorization public key. `Ti` is that
member's separately derived recovery-trigger public key. Each group has its own
canonical x-only-key order and participant mapping. All are valid 32-byte keys.
They must be unique across participants, roles, and rounds, and distinct from
solo, payout, and cooperative keys. Use explicit V3/vault/role/round derivation
domains; do not alter V2 derivation or serialization.

For each round, every member signs the exact refund with their authorization
key during setup. Publish these signatures in the complete public kit. At
recovery time, the selected n-1 members add signatures using their trigger keys.
No trigger signatures are needed or collected during setup.

Witness stack, bottom to top before script execution:

```text
trigger slots in reverse T-key order (empty for the unselected member)
authorization signatures in reverse A-key order (all present)
recovery script
control block
```

Exactly n-1 trigger slots are nonempty for this script, not all n. The final
`NUMEQUAL` checks equality. All-n consent can select an n-1 subset or use the
cooperative path. The intermediate `NUMEQUALVERIFY` consumes the first check's
result before the second check. Tapscript's signature operations and leaf-bound
signatures support these separate checks. [BIP 342](https://bips.dev/342/)

All setup authorizations use 64-byte `SIGHASH_DEFAULT` signatures, committing
all inputs, outputs, amounts, sequences, version and locktime. The refund uses
one exact graph outpoint, transaction version 3, locktime 0, block-based sequence
equal to the approved delay, and exactly n payout outputs. It has no annex or
code separator. Validators reconstruct every byte rather than trusting uploaded
PSBT metadata. This proposed construction uses existing signature commitments,
not a covenant opcode or a service policy signer. [BIP 341](https://bips.dev/341/)

The delay is immutable per roster, measured from confirmation of the coin being
spent. A confirmed first exit starts a NEW delay for its pair output. It is not
time since signup, funding intent, or last website activity, and blocks are not
a guaranteed wall-clock duration. Enforce block units, enabled relative locktime,
and the validated 1..65,535 range. [BIP 112](https://bips.dev/112/)

The chain does not know when a signature was created. "Runtime trigger" means
the client releases a separate capability only after explicit approval; it
does not prove the participants signed after maturity. Once a full valid
witness has been released, anyone holding it can rebroadcast it after maturity.
Canceling a website proposal cannot revoke signatures or the on-chain timer.

## Why a colluding quorum cannot redirect the refund

Assume at least one current member's required secrets remain uncompromised,
that member approved only the canonical graph, and signature security holds.

1. The colluders can make their own fresh authorization and trigger signatures
   for any transaction, but they lack the honest member's authorization key.
2. The honest member's published recovery signature validates only for the
   pre-agreed refund. Changing its address, reducing its amount, raising the
   parent fee, or adding/removing outputs invalidates that signature.
3. The recovery leaf requires EVERY authorization, not just the trigger quorum.
   It cannot be satisfied for the changed transaction.
4. Other paths must not bypass this boundary: the key path needs all current
   members; the solo path retains its exact preauthorizations and the designated
   leaver's withheld signature. Audit the whole tree, not just this new leaf.

This is the design's security argument, not a completed audit. No deletion of
authorization keys is assumed. An honest member may retain theirs indefinitely.
An all-member reauthorization can change a settlement, but a smaller quorum
cannot. Authorization and trigger keys cannot be reused: otherwise published
setup signatures on this same message could also satisfy the trigger check.

Do not implement either tempting shortcut: app-only destination checks retain
the current theft risk; publishing a complete all-member refund witness with
only a timelock lets anyone trigger it after maturity, removing quorum control.

## Complete pre-funding graph and ceremony

Build one refund template for funding output 0 and one for each first-exit pair
output 1. Their outpoints are already predictable from native-SegWit funding and
the immutable solo graph; they do not require those transactions to confirm.
This adds FOUR terminal refund templates to the NINE existing solo templates.
It does not add a refund for each second-exit ordering.

Each member authorizes three refunds: ABC and the two pairs they belong to.
That is nine recovery authorizations total (3 + 2 + 2 + 2), in addition to the
twelve existing solo preauthorizations: twenty-one setup signatures, seven per
person. Solo designated-leaver signatures remain absent. Runtime trigger
signatures are a separate type and must be rejected by setup/public-kit APIs.

Commit scripts, keys, policy, exact refund templates and signature hashes into
the unsigned V3 graph digest. Bind each authorization envelope to protocol,
graph, participant, purpose and refund ID. The graph excludes signature bytes
so there is no circular digest; the complete-kit digest includes all 21
verified contributions. Consensus signatures bind transaction bytes; local
graph approval and envelope checks additionally bind the ceremony context.

Required order:

```text
identities and payout ownership -> roster approval -> native funding inputs
-> freeze graph including 4 refunds -> verify all 21 setup signatures
-> each person exports and independently restores a complete encrypted kit
-> durable wallet-start intent -> funding signatures -> witness approvals
-> separately authorized submission -> confirmed activation
```

No wallet-signable export or honest-client funding signature before completeness
and restoration checks. Withheld/invalid setup contributions abort funding.
Public transaction data cannot be hidden reliably; honest signing checks are
the safety boundary. Preserve every wallet-started/signed epoch and its kits;
UI restart, account deletion or session expiry cannot revoke existing signatures.

Each kit contains the complete graph, all 21 public contributions, scripts,
control blocks, exact source facts, version/network/genesis bindings, and its
owner's encrypted derivation material, recoverable independently of the server
or original browser. No server receives participant secrets or secret nonces.

Restoration verifies all NINE public recovery authorizations, all normal solo
capabilities, and local trigger/payout key ownership. Its owner possesses
trigger keys for THREE rounds. Use domain-separated test
challenges to prove trigger-key possession during setup, not real refund-trigger
signatures that might escape into a restoration receipt. Never publish a
pre-funding, fully signed recovery transaction as backup proof.

## Runtime, fees and loss cases

The app/offline tool selects ONLY the refund tied to the independently verified
current unspent graph coin. It displays the exact recipient amounts and
addresses, fee, source confirmation, block-based eligibility, and the fact that
recovery ends the game. After explicit participant approval, exchange trigger
contributions bound to those exact bytes and graph. Assemble the fixed witness,
revalidate locally, then use the existing durable, exact-byte broadcast journal.

Keep confirmation-based state progression, reorg handling and independent
source checks. If an exit and a recovery conflict, the chain decides which wins;
neither a coordinator lock nor a mempool observation is final settlement. After
a confirmed solo exit, old-source recovery is invalid unless that source returns
through a reorg; the new pair recovery has its own delay.

Do not make a new recovery parent to raise fees: the missing person's approval
would be needed again. Preserve the existing sponsored CPFP design: a child
spends the initiating owner's refund and one separately approved, confirmed
outside sponsor input, preserves the refund value, and charges only the sponsor.
Never spend another member's refund or a successor vault to pay the child fee.

Recalculate actual witness size and fee policy for both new leaf sizes; old
recovery size constants and fee estimates are not acceptance evidence. Check
parent-plus-child package policy, child replacement, sibling eviction, relay
floors, sponsor balance and wallet compatibility on the target Core version.
TRUC policy bounds topology on supporting nodes; it does not guarantee network
propagation, a fee cap sufficient forever, or confirmation. [BIP 431](https://bips.dev/431/)

Recovery can pay a missing member, but cannot recover a permanently lost payout
key or redirect that person's refund to a newly requested address. Encrypted
offline kits and separately kept wrapping secrets remain essential. If too few
trigger keys survive, quorum recovery is unavailable; normal solo exits may
still work for owners with intact kits. Losing all usable custody material can
make funds inaccessible. A hostile coordinator may withhold data, but complete
portable kits must remove it as a required runtime service. Malicious delivered
JavaScript or a compromised device can still defeat local approval and steal
keys; artifact verification remains a separate trust requirement.

## Implementation sequence and acceptance gates

1. **Protocol and adversarial proof.** Add version-dispatched V3 types, key
   derivation, whole-tree construction, four fixed-refund builders and the
   authorization/trigger split. Add deterministic, reproducible Core tests for
   the real two-leaf tree and every source coin; the exploratory check below
   is only a starting point.
2. **Funding and portable custody.** Extend graph/ceremony/signing validators,
   setup progress and completeness checks to 12+9 signatures. Version database
   records, routes, approvals, kit plaintext/envelope bindings and restoration
   proofs without mutating V2. Verify server-free recovery with each participant
   omitted in turn. Every participant must restore before funding.
3. **Browser/offline recovery and fees.** Remove arbitrary recovery-proposal
   construction for V3, add exact-refund selection and trigger exchange, update
   sizing and sponsored fee rescue, and preserve reauth/reorg/broadcast journals.
   Show normal-game and recovery settlements separately before approval.
4. **Full acceptance and review.** Run all normal orderings, all recovery
   quorums, negative controls, cooperative spends, final sweeps, fee competition,
   backend-loss/restore and browser workflows. Obtain independent cryptographic
   review as a later release gate; no such review is claimed or delegated here.
   Rebuild exact-source/image/default-Signet evidence for V3 and the new payout
   schedule, then rehearse physical devices and external funding wallets.
5. **Release decision.** Only after the gates pass, obtain separate authority
   for deployment and real-money funding. Review the chosen production delay,
   sponsor liquidity, custody instructions and public-contact privacy then.

Mandatory negative cases include fresh colluder signatures on theft transactions
while retaining the absent member's fixed approval; one-satoshi redistribution;
changed destination, output count/order, fee, input, version, locktime, sequence
or annex; missing approvals; insufficient/duplicate triggers; cross-role key use;
wrong round/vault/epoch/network; mixed V2/V3 artifacts; injected old recovery
leaves or control blocks; and boundary-height/reorg checks. For valid witnesses,
test all three 2-of-3 quorums and both 1-of-2 choices in EACH of the three pair
rounds, not merely one generic pair. Re-run all six normal payout orderings.

## Versioning and existing funds

This changes output scripts, addresses, funding/exit txids, signatures and kits:
it is not an economics-marker update or a web-only patch. New invitation
creation must choose V3 only after its implementation is qualified. Explicit
dispatch keeps V1/V2 recovery and imported kits usable with accurate warnings;
unknown/new artifacts must never fall through to a legacy parser or signer.

Do not relabel, overwrite, or automatically migrate any existing funded or
wallet-started V2 vault. An on-chain move to a new vault is a distinct, separately
authorized transaction and custody ceremony. A software rollback cannot change
V3 coins into V2 coins; retain verified V3 offline recovery tooling for every
funded V3 vault even if the web service rolls back. Keep legacy golden fixtures
and legacy recovery-risk tests with their original expected results.

## Evidence from this design task, and its limits

Current source inspection confirms that V2's recovery leaf is CSV plus N-1
personal-key signatures and that its equal-output check is in the application.
The existing setup verifies 12 solo signatures; recovery is currently proposed
after funding. These are the boundaries that the planned V3 work must change.

A one-off in-memory experiment on isolated, network-disabled Core 31.1 tested
the candidate combined recovery leaf with synthetic keys and a NUMS internal
key. All five generic quorum choices passed (three at n=3, two at n=2). Twenty
mutations failed script validation despite freshly re-signing with every
colluder's authorization and trigger keys while retaining the absent person's
original authorization. The mutations changed destination/allocation, one
satoshi, fee, or delay. Five missing-authorization cases and two each of early
spend, insufficient trigger, and authorization-as-trigger cases also refused.
One canonical transaction for each size was actually mined with exact payouts.

Observed single-leaf examples: n=3 script 211 bytes / transaction 324 vbytes;
n=2 script 143 bytes / transaction 232 vbytes. These are NOT production fee
estimates: the proposed product keeps a two-leaf tree with a larger control
block, and its complete graph/fee packages have not been tested for V3.

Private summary: `/tmp/btc-presigned-core-YaPLtp/fixed-refund-design-leaf.json`.
The experiment is not a committed regression harness, a full-tree bypass audit,
an app/backup test, public-Signet evidence or mainnet readiness. The owned node
stopped successfully; public-network broadcasts were zero. No production source,
existing signed vault, custody material, invitation or deployed service changed
in this design task. Implementation and release gates above remain open.
