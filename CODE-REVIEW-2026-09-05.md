# Vault review and liveness fixes — 2026-09-05

Reviewed commit: `71b1bd227a5f3f3d35fb8449776747d5d88d28c7`.
Historical implementation checkpoint: local changes on top of that commit.
The subsequent [Signet readiness work](./SIGNET-READINESS-2026-09-05.md) includes
these fixes on `codex/signet-readiness-hardening`; no deployment is implied.

## Overall assessment

This is a substantive implementation of the requested multiplayer game, with
useful separation between deterministic transaction construction, browser-held
keys, server authorization, and chain-confirmed state. Exact PSBT comparisons,
nonce consumption, passkey-bound actions, and reorganization tests are valuable
defenses. The main newly demonstrated weaknesses were lifecycle and concurrency
failures, not a reason to replace the product or its cryptography.

The user reaffirmed the friendly holding-vault trust model and authorized these
improvements during the review. Economics, policy shapes, recovery threshold,
recovery delay, custody architecture, and network strategy were not changed.
Testing below uses synthetic keys and isolated services, never real funds.

## Confirmed and fixed

### 1. An unsigned shared proposal blocked independent exits

`createStoredVaultProposal` and the database previously permitted only one live
proposal per coin. Alice could propose a cooperative refund without signing;
Bob's valid solo exit then failed with “this coin already has a live transaction
proposal” for the proposal's 15-minute lifetime. The UI also hid the solo button.
This was a practical coordination failure even among friends, independently of
any malicious-participant threat model. It did not prevent manual Bitcoin spends.

Fix: migration 014 permits one live proposal per coin/action/actor. The server
returns available choices and defaults to the participant's own solo proposal;
the browser explicitly selects and reviews a proposal, clearing broadcast
acknowledgement when refreshing it. Duplicate copies of the same action remain
blocked. Current-coin locks serialize mutations without awarding the Bitcoin
spend to the first API caller.

Evidence: a real PostgreSQL fixture creates a cooperative proposal plus three
independent solo exits, rejects duplicate actions, and checks selection. The
three-browser test creates Bob's solo exit while cooperation is pending, then
selects the cooperative proposal and completes its real MuSig2 signature rounds.

### 2. Simultaneous final readiness proofs stranded a complete roster

`completeSigbashReadinessProof` locked separate challenges, inserted each proof,
then counted rows under independent transactions. With seven existing receipts,
two overlapping final submissions each saw eight. Both committed, leaving nine
valid proofs but `roster_confirmed`, `ready: false`, and no next challenge. Exact
retries returned before reconciling readiness.

Fix: lock the shared vault row before inserting/counting, reconcile readiness
on exact receipt retries, and repair existing nine-proof limbo in migration 014.
The regression uses real valid synthetic policy signatures and a test-only
deferred-commit delay to force the previously failing transaction schedule.

### 3. Proposal expiry could discard an already-authorized broadcast

An expired finalized proposal was marked stale when another proposal was created,
even with an approval already `submitting`. If RPC accepted the original bytes
while that happened, the post-send database update failed and left a stale
proposal plus a permanently unresumable submitting approval.

Fix: approved/submitting/broadcast intents are not discarded by proposal expiry.
Approval completion atomically rechecks the current, unexpired finalized proposal.
The watcher resumes both approved and submitting intents, restricts retries to
current inputs, and reports individual broadcast failures without abandoning
other candidates. Authorized competing history is retained so a restored input
can be reconsidered after a reorganization; only confirmed spends advance it.

The same boundary also previously marked an intent failed when both the send
response and subsequent lookup were unavailable. That is ambiguous, not proof
of rejection. Such attempts now remain submitting and retryable; the regression
injects both failures and proves a later exact-byte retry succeeds.

Evidence: the regression pauses a loopback RPC response across actual expiry,
creates another participant's proposal, and verifies successful recording of the
original send. It also simulates a crash after approval, a rejected competitor
visited before the confirmed winner, and a subsequent clean watcher poll.
This is database/RPC-boundary evidence, not a real mempool or Signet proof.

### 4. Full custody history prevented even read-only unlock

Revision 32 was an allowed encrypted snapshot, but the next authorization threw
because revision 33 was unavailable. The authorization is also used by ordinary
signing, including cooperative/recovery paths; no new ciphertext write was
necessary for those operations.

Fix: return existing encrypted envelopes with `nextRevision: 33` and
`nextAad: null`. Read/unlock remains available; further writes remain capped.
Registration checks for enough space for pending and completed snapshots before
contacting Sigbash. No old encrypted recovery snapshots are deleted or compacted.

Evidence: PostgreSQL regression with all 32 allowed revisions checks successful
authorization and disabled writes. This store-boundary test receives an already
verified synthetic assertion; it is not a WebAuthn signature-bypass test.

### 5. Uncertain initial funding could become restartable

The private funding operator reset a submitting finalization to `approved` when
both `sendrawtransaction` and the subsequent lookup failed. Bitcoin Core could
already have accepted those exact bytes. The reset re-enabled unanimous funding
restart, which could erase the application's record of a possibly funded vault.
This was reproduced before the fix using a real, three-input signed transaction,
actual PostgreSQL state, and an isolated loopback RPC with a lost acknowledgement.
No real transaction was sent and no real funds were lost in this test.

Fix: preserve `submitting` once a send might have happened, including uncertainty
inherited by a resumed attempt. Only a fresh preflight failure before send may
return to `approved`, and only if that attempt still owns the submission claim.
Exact transaction lookup can recover the broadcast without a second send.
The existing ten-minute operator retry delay and all approval gates remain intact.

Retry ownership also used PostgreSQL timestamps round-tripped through JavaScript
`Date`, which loses microseconds and can make the compare-and-swap miss its own
row. Timestamp tokens now retain database text precision through both reads and
parameter serialization. The regression deliberately uses a microsecond-bearing
timestamp, overlaps an old preflight with a reclaimed submission, and proves
that neither the old failure nor a subsequent retry failure enables restart.
Stored passkey approvals are synthetic prerequisites; this is not a live
authenticator, private-operator release-gate, or Bitcoin consensus acceptance test.

## Corrected interpretation of prior Sigbash evidence

The installed SDK's `SigbashClient.verifyPSBT` invokes
`SigbashWASM_VerifyPSBTAgainstPolicy` locally. It may request provider metadata
for nullifier timing, but successful policy evaluation is not proof that the
hosted signing service accepted the proof or transaction. README, STATUS, and the
Signet plan now distinguish those facts.

The last recorded hosted signing call returned `server_error: Signing service
error`. This review did not retry it or establish its server-side root cause.
The provider reproducer must include `withSigbashHexProofTransport` in
`src/sigbash.ts`, alongside the exact SDK/runtime versions, policy, PSBT, and
redacted error trace. Local WASM success is useful debugging evidence, not a
replacement for a real hosted signature.

## Remaining risks and useful next work

- **Real integration:** nine hosted Signet readiness signatures and the full
  physical-passkey lifecycle remain unproven. The earlier CLI/Core cooperative
  checkpoint does not prove that browser/provider path. No funding gate was bypassed.
  The complete Signet operator release ceremony also needs implementation and
  validation: `web/scripts/broadcast-funding.ts` still uses mainnet-specific
  release/confirmation contracts. Direct store regression tests do not prove
  that CLI ceremony works on Signet; do not weaken the mainnet gate to proceed.
- **Participant trust:** the previous key-provenance finding remains open.
  Self-consistent registration plus a positive signature cannot prove that a
  participant obtained the key from Sigbash or bound it to the claimed policy.
  Treat this as a trust assumption for friends, not a permissionless-security
  guarantee. Do not silently substitute a new custody design to address it.
- **Recovery:** the specified delayed N-1 leaf can spend arbitrary outputs;
  one survivor can use it in a pair round. This is the accepted design tradeoff,
  not a newly introduced threshold change.
- **Fees and payout UX:** immutable fees still need a tested fee-pressure plan.
  The optional final sweep still pays back to the existing payout script and
  burns another fee; changing its destination semantics requires an explicit
  transaction-approval design, not a cosmetic edit.
- **Maintainability:** split the large runtime store into proposal, contribution,
  broadcast, and confirmation modules after behavior is locked down by tests.
  Profile repeated artifact/PSBT reconstruction before adding caches; never
  cache away validation of untrusted inputs. A vetted constant-time MuSig2
  implementation merits a separate migration review; no timing exploit was
  demonstrated here and cryptographic code was not swapped speculatively.

## Review coverage

These are the reviewed boundaries and evidence, not a claim that every possible
interleaving, dependency behavior, or attack has been exhaustively checked.

| Area | Reviewed mechanisms and evidence | Important limit |
| --- | --- | --- |
| Product and transaction construction | Spec, fixed round economics, policy/PSBT matching, signature/consensus acceptance, MuSig2 and recovery suites | No replacement cryptography or external certification |
| Sigbash integration | SDK verification call path, policy/key commitments, proof transport wrapper, readiness state and concurrent completion | No new hosted signature; provider provenance remains a friend-trust assumption |
| Passkeys and custody | PRF encryption/recovery, action-bound challenges, origin/RP/user verification, counter consumption, session handling, revision limits | Virtual authenticators and synthetic store prerequisites are not physical-device evidence |
| Roster and funding | Confirmed-roster binding, independent UTXO checks, exact wallet signatures and final approvals, unanimous restart, private funding submission | Full Signet operator release ceremony remains unproven |
| Runtime coordination | Independent proposal choices, coin locks, nonce/signature consumption, broadcast approval and expiry | Loopback RPC fault injection, not live mempool contention |
| Chain state and recovery | Confirmed-winner advancement, competing broadcasts, reorganization, watcher leases, database restoration tests; follow-up Core 31.1 regtest drill | Core drill seeds synthetic vault bookkeeping; no new public-chain vault spend |
| HTTP and deployment | Origin checks, cookie/session settings, CSP, runtime pinning, container/ignore files, migration compatibility, optimized standalone build | No deployed-origin penetration test or new Docker-image certification |
| Maintenance and dependencies | Typechecks, advisory audit, test cleanup/isolation, large-module and repeated-validation review | Zero known package advisories is not proof of application security; optimization suggestions are unprofiled |

## Verification and release limits

- Core acceptance and web acceptance suites; both network acceptance profiles.
- PostgreSQL 16 migrations and database acceptance, including the new liveness
  and initial-funding uncertainty regressions and existing funding, replay,
  watcher-lease, restore, and reorg checks. Database suites pass under both
  configured network profiles using separate disposable databases.
- Optimized Signet standalone build and all six Chromium scenarios with virtual
  authenticators, including cooperative signing alongside a competing proposal.
- Typechecking, diff checks, and the dependency advisory audit. No known package
  advisories were reported; that does not establish application security.

Combining the suites exposed older test isolation assumptions: the browser
passkey test counted global credentials and the solo database fixture suppressed
a foreign-key cleanup failure. Assertions are now scoped to the test vault,
the solo fixture deletes its own dependent rows, and the harness uses separate
databases for database-only and browser scenarios.

The production/container browser harness now runs the database suite too.
Migration 014 and the matching app must ship together; the older one-proposal
application cannot safely be rolled back onto a newer competing-proposal database
without the reviewed matching backup/restore procedure.

This is a focused implementation review and regression pass, not an independent
cryptographic certification, exhaustive penetration test, new history-wide secret
scan, physical-device test, provider-service test, Docker-image certification,
deployment, or authorization to move funds.

The subsequent [independent test pass](./TEST-REPORT-2026-09-05.md) adds three-agent
negative/boundary testing and a real-node, isolated reorganization drill. All
final runs passed; live-provider and physical-device gates remain unproven.
