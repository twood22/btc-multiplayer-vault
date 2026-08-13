# Bitcoin Multiplayer Vault — Mainnet Product Specification

This is the authoritative product contract. It supersedes the repository's
original signet-demo brief. A deterministic offline harness may remain for
testing, but it is never evidence that the product is deployable, fundable, or
working with Sigbash mainnet.

## 1. Non-negotiable scope

- The product is mainnet-only and fixed to exactly three participants.
- It implements the round-based haircut/bonus withdrawal game described below.
- A solo withdrawal is enforced by the departing participant's round-scoped
  Sigbash key and policy.
- A cooperative exit is an N-of-N BIP-327 MuSig2 key-path spend using only the
  current participants' personal keys. Sigbash has no key-path authority.
- Personal signing material and Sigbash client custody are distributed across
  participant devices and protected by passkeys. The service is a coordinator,
  not a custodian.
- The product must never be replaced by a static 3-of-3 vault, an eventually
  degraded threshold vault, a mock, or a UI-only simulation.
- No deployment, funding, or broadcast is allowed until a real Sigbash mainnet
  signing result passes the local hostile-artifact and consensus verifier.

## 2. Economic game and state transitions

Each participant contributes the same committed deposit. The immutable roster
commits the deposit, fees, fee-burn budget, withdrawal schedule, and recovery
delay before revealing a fundable address.

The default schedule preserves the original proportions:

- first solo leaver: 95% of one deposit;
- second solo leaver: 102.5% of one deposit;
- last participant: the remainder after committed fees;
- cooperative exit: all current participants refund themselves equally, with
  the committed transaction fee deducted deterministically.

Production uses deliberately small, explicitly reviewed mainnet amounts. The
schedule must conserve exactly three deposits before fees.

There is exactly one current vault UTXO. Round one is `{Alice, Bob, Carol}`.
The first confirmed solo withdrawal spends that entire coin and creates the
departing payout plus one of the three precommitted pair-round vaults. A second
transaction attempting to spend the prior coin is only a Bitcoin double-spend;
there is no coordinator counter that decides the winner. A pair-round solo
withdrawal creates the second payout plus the final participant's payout coin.
The final participant sweeps that coin with their personal key.

## 3. On-chain construction

Precompute four Taproot vault outputs: one three-participant round and the three
possible two-participant rounds. Every output contains:

1. a key path formed by standard BIP-327 KeyAgg of only the current
   participants' personal public keys;
2. one policy-spend tapscript leaf per current participant, containing that
   participant's Sigbash policy key for this exact round;
3. one distinct, identification-only Sigbash leaf per participant where the
   current SDK requires it for input recognition; and
4. a relative-timelocked recovery leaf requiring N-1 current participant keys.

The recovery leaf is an explicit trust tradeoff: after the committed CSV delay,
N-1 current participants can move the whole coin. In a pair round this is one
of two participants. The delay must be reviewed for production; a short local
fixture value is not acceptable evidence for funding.

The Sigbash key must never appear in the cooperative key path. Identification
leaf keys must never satisfy a policy `REQKEY` and must never be selected for a
solo spend.

## 4. Sigbash key and policy topology

Every participant has one immutable Sigbash key for every round in which they
could leave: the three-person round and the two pair rounds containing them.
That is nine independent `(participant, round)` registrations. A shared key or
an OR-of-rounds policy is forbidden because it permits cross-round policy
confusion.

Pair-round keys are created first. Their vault addresses allow creation of the
round-one policies. Every solo policy is an AND policy that binds:

- exactly one input;
- exactly two outputs;
- output 0 to the leaver's committed payout address;
- output 0 to the exact committed haircut or bonus amount;
- output 1 to the exact next pair vault or final payout address;
- output 1 to a minimum value that caps fee burning; and
- `REQKEY` to the exact round-scoped policy-spend leaf key.

The browser asks Sigbash to verify the exact locally rebuilt PSBT before asking
it to sign. Returned transactions and PSBTs are hostile input: the product must
reproduce the unsigned transaction, verify the witness UTXO and selected leaf,
reject key-path or identification-leaf signatures, verify Schnorr signatures,
and run local Bitcoin consensus validation before finalization or broadcast.

## 5. Participant custody and passkeys

Each participant device independently controls:

- the personal key used for cooperative MuSig2, recovery, and final sweep;
- the payout key/address;
- the browser share and credentials for that participant's Sigbash
  organization; and
- the participant's three round-specific encrypted Sigbash custody records
  (nine records across the roster).

No plaintext participant secret, personal private key, Sigbash private share,
secret MuSig2 nonce, API credential, recovery secret, or passkey PRF output may
be stored in the database, logs, Git, deployment image, or coordinator session.
The database may hold only public commitments, protocol contributions, and
opaque ciphertext envelopes.

Enrollment requires a PRF-capable primary passkey and a distinct PRF-capable
recovery passkey. The recovery ceremony must prove that both unwrap the same
participant identity and custody. Passkey assertions bind roster confirmation,
chain observations, funding inputs and signatures, final transaction approval,
restart decisions, and broadcast approvals to exact digests.

MuSig2 is an interactive two-round ceremony on participant devices. Secret
nonces are generated and encrypted locally, bound to one proposal/message, and
burned before partial signing. The server receives public nonces and verified
partial signatures only. No single process may hold all production personal
private keys.

## 6. Roster and funding ceremony

The publishable roster requires all nine live, mainnet Sigbash registrations.
All participants independently reproduce and passkey-confirm the same public
artifact, economics, policies, payout addresses, and vault commitments. The
round-one funding address remains hidden until confirmation is unanimous.

Funding uses one confirmed, independently observed native P2WPKH or key-path
P2TR input from each participant's external wallet. The coordinator builds one
deterministic three-input PSBT. Each wallet signs only its own input. The server
verifies and normalizes every external signature, finalizes one pristine PSBT,
and requires all three participants to passkey-approve the exact fully signed
witness serialization.

The service never receives wallet private keys and browser routes never
broadcast initial funding. Restarting a failed pre-broadcast ceremony requires
all three passkeys to approve the same exact ceremony state and reason; the
restart is immutable audit evidence and cannot occur after submission begins.

Initial funding is released only by a private operator command. It requires the
exact finalization fingerprint, the reviewed live-Sigbash proof fingerprint,
the reviewed fingerprint of a fresh owner-only release artifact, an explicit
mainnet phrase, and a private Bitcoin Core `testmempoolaccept` result for the
exact bytes. The release artifact can be created only after unanimous final
passkey approval and commits the same vault, finalization digest, transaction
ID, live-proof digest, and passing automated/manual gate list; the broadcast
command authenticates the file and rejects stale or mismatched evidence. A private
watcher activates only that exact transaction after the configured confirmation
depth. Every confirmation stores its active-chain block hash. The watcher keeps
reconciling confirmed state: backend failure leaves state untouched, a deeply
re-included exact transaction is reanchored, and an orphaned confirmation
atomically restores the prior coin while invalidating unsigned descendants and
stale observations. Already-broadcast exact descendants remain tracked for
safe replay after their ancestor reconfirms.

## 7. Runtime signing and broadcast lifecycle

Before signing, every participant independently observes the exact current
mainnet outpoint, value, script, unspent state, and confirmations and binds that
observation with a passkey. The browser rebuilds the immutable roster, current
coin, proposal digest, PSBT, and unsigned transaction before using local keys.

Supported runtime transitions are:

- solo: one live Sigbash policy-leaf signature and exact re-vault/final payout;
- cooperative: N-of-N distributed MuSig2 key-path spend, without Sigbash;
- recovery: N-1 distributed signatures through the mature CSV leaf; and
- final sweep: the final participant's personal key spends their payout coin.

Signing and finalization never broadcast implicitly. A separate passkey
ceremony approves the exact finalized transaction. The server re-authorizes the
stored bytes, submits only those bytes to private mainnet Bitcoin Core, handles
idempotent retry, and advances coordinator state only after observing the exact
confirmed transaction. Reorganizations must roll state back safely.
The private watcher holds a crash-released database session lease for the whole
poll; overlapping scheduler invocations must not both reconcile or submit.

## 8. Mainnet release gates

Offline tests, local deterministic signatures, historical signet runs, SDK type
compatibility, and a successful build are necessary but insufficient.

Before deployment, run the live predeployment proof against a deliberately
unfunded placeholder mainnet outpoint. It must demonstrate:

- Sigbash accepts the valid policy-bound solo PSBT;
- Sigbash explicitly rejects the hostile wrong-amount, wrong-address, and
  extra-output variants;
- `signPSBT` returns a real signature artifact; and
- the local authorizer proves that artifact is the exact requested
  policy-leaf transaction and passes consensus validation.

The command writes a fresh owner-only proof receipt that binds the request,
artifacts, authorization, hostile checks, final txid, and canonical digest.
That receipt is human-reviewed and mounted read-only into later operator jobs;
it is not a provider-signed attestation and does not remove the operator trust
boundary.

After deployment but before funding, every item in `DEPLOYMENT.md` and
`PASSKEY-PRODUCT.md` remains mandatory, including physical two-passkey drills,
nine live browser readiness proofs, three real wallet signing drills,
PostgreSQL backup/restore, private Bitcoin Core rejection/retry/confirmation/
reorganization exercises, HTTPS/RP validation, and a fresh release report.
The isolated checksum-pinned Bitcoin Core reorganization drill must first pass
against the exact reconciliation and database boundary. That regtest drill is
test infrastructure only and does not replace the private mainnet-backend
exercise or the live Sigbash mainnet proof.
Funding is a later, separate, explicit decision.

## 9. Acceptance standard

Completion requires evidence for all of the following:

1. the four-round tree and nine immutable policy keys reproduce identically on
   all participant devices;
2. solo withdrawals preserve the haircut/bonus game and cross-round, multi-
   input, output, witness, and leaf mutations are rejected;
3. cooperative exits work with Sigbash unavailable and no Sigbash key in the
   key path;
4. distributed recovery and final sweep transactions pass consensus checks;
5. passkey custody, recovery, roster, funding, signing, restart, observation,
   and broadcast bindings survive adversarial and replay tests;
6. database migrations, concurrency constraints, production build, dependency
   audit, an authenticated exact schema-and-row backup restore, and runtime
   health checks pass;
7. a real Sigbash mainnet signing proof and all real-device/backend drills are
   recorded; and
8. no deployment, funding, or broadcast occurred before its required gate and
   explicit approval.

If any evidence is missing or indirect, the product is not yet shipped.
