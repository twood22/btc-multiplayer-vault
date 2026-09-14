# V3 autonomous completion checklist

Status: integrated implementation under executable testing; no V3 production-readiness claim. Historical V2
acceptance is separate. The active goal and PRESIGNED-V3-FIXED-RECOVERY-DESIGN.md
define the full scope; a partial pass cannot close this checklist.

- [ ] V3 exact protocol/version/key domains, complete four-state graph, immutable
      fair refunds, separate authorization/trigger layers; no unrestricted bypass.
- [ ] V1/V2 legacy byte/digest, custody, parser and operation compatibility.
- [ ] Ceremony: all 12+9 approvals verified, all three portable kit restores and
      passkey checks complete before any honest-client wallet signature.
- [ ] Full browser invitations/identities/funding/withdrawal/recovery flows.
- [ ] Server-independent offline recovery and restored owner capabilities.
- [ ] Browser/offline cash-out of individually owned payout/refund coins to an
      owner-reviewed external Bitcoin address; no vault-coin or quorum bypass.
- [ ] All six normal orderings, all nine state-specific recovery quorum choices,
      cooperative exits, final sweeps, exact amounts/destinations and fees.
- [ ] Fresh-signature collusion attacks, whole-tree bypass attempts, version/epoch/
      network/role confusion, missing signatures and boundary/reorg negatives.
- [ ] Fee rescue/replacement/competition, confirmed-state progression, reauth and
      exact-byte durable broadcast journals; no mutable recovery-parent fallback.
- [ ] Complete applicable pure, database, Core and optimized-browser suites.
- [ ] Actual default-Signet complete acceptance for V3/new economics bound to
      exact final source and release artifacts, with retained custody/evidence.
- [ ] Independent adversarial AI review; all release-blocking findings resolved.
- [ ] Reproducible production artifacts, automated deploy/rollback, tested database
      restore, monitoring and concise onboarding/offline recovery instructions.
- [ ] Authorized deployment verified, or complete verified deployment package
      accurately handed off as NOT deployed.
- [ ] Final source-bound audit of every active-goal requirement; residual risks,
      physical-device and external-audit limits disclosed; no mainnet transfers.

## Evidence ledger

- Baseline: V3 design only; candidate single-leaf experiment is not product
  acceptance. Current V2 code retains its unrestricted delayed recovery.
- 2026-09-13 V3 core integration: full two-leaf trees and independently derived
  Core descriptors; all 9 recovery quorums and all 6 complete normal games mined.
  108 fresh-colluder transaction attacks, 66 witness/control negatives and
  9 annex consensus negatives refused; all 9 exact CSV/reorg boundaries checked.
  Retained intermediate evidence: `/tmp/btc-presigned-core-NS26T8/v3-fixed-recovery.json`.
  Pure matrix: 144 signed exits, all 4 refunds and 21 setup approvals, 42
  negative cases; historical V2 graph digest unchanged.
- V3 runtime/portable pure suites passed: all 9 quorums, all 5 fee-parent
  families, 9 refund sponsors/replacements, 4 reanchors; 39 encrypted kit
  restorations including all missing-member refunds and all final owners.
  These are cryptographic checks, not saved-file browser or Signet evidence.
- V3 actual database tests passed ceremony (51 actions), runtime (32 actions),
  and native dump/restore (6 encrypted passkey keys, 22 negative boundaries).
  Restore exposed and fixed migration 022's unqualified helper under the
  restored database's empty search path; successful rerun retained at
  `/tmp/btc-presigned-db.Sbg5al/presigned-restore-db-acceptance.log`.
- Actual standalone offline and optimized browser/Core integrations are running.
  These intermediate runs do not supply final-source release identity; that
  requires the complete frozen-source matrix and real default-Signet run.
- 2026-09-14 complete V3 database chain/reorg and fee suites passed at
  `/tmp/btc-presigned-db.N35x0D` and `/tmp/btc-presigned-db.Ufftix`. The queue
  regression now filters eligible protocols before pagination; 100 disabled
  legacy entries cannot starve an enabled V3 intent. Test-fixture encoding and
  bounded test-node lifetime failures were diagnosed and retained, not hidden.
- Owned-payout cash-out pure tests passed 48 signatures and 224 refusals across
  both protocols and address formats. Actual Core passed 24 cash-outs, 18
  parents, 192 mutations, eight source families and five standard destination
  types at `/tmp/btc-presigned-core-R8kwG4/owned-payout-cashout.json`.
- Actual database cash-out rerun passed after independent AI review hardening:
  `/tmp/btc-presigned-db.m8e1JY/presigned-cashout-db-acceptance.log`. Carol was
  absent from the triggered recovery, restored her encrypted kit and signed her
  own external-wallet transfer. Saved-only zero-send, lost reply/new pool,
  confirmed-state reconciliation, ancestor reorg and competing spend were tested.
- Focused saved-file cash-outs passed all five payout families and 16 refusals
  with zero network/storage/script errors at `/tmp/btc-presigned-offline.4apfIv`.
  This deliberately partial receipt does not count as the full offline suite.
  Full 19-case plus fee/cash-out acceptance is running separately.
- Web integration failure `/tmp/btc-presigned-browser.Rt2gsy` reached every
  participant's verified backups, then hit the default 30-second download-event
  wait during funding export. The node already had a 45-minute limit and stopped
  during cleanup, not at a 15-minute expiry. The next run gives that event the
  existing 60-second UI-verification budget; network deadlines are unchanged.
  Its success must be observed before calling this diagnosis resolved.
- The complete saved-file offline run subsequently passed at
  `/tmp/btc-presigned-offline.se3J3g/offline-browser-acceptance.json`: all 19
  lifecycles, 31 confirmed browser-signed transactions, 71 encrypted restores,
  10 confirmed fee replacements, 12 owner cash-outs and 37 cash-out refusals.
  Utility SHA-256 `d8126ff9b48fe87d9ad4d1d0e3d332e69e48b54efd2cce90a5e6cea3ff539e6d`.
  No network/storage/script errors or public broadcasts. This remains
  intermediate-source evidence, not final release acceptance.
- Web runs `/tmp/btc-presigned-browser.uYuuHh` and
  `/tmp/btc-presigned-browser.3VOGHh` failed during funding signature release
  and funding export respectively. The latter completed Alice's wallet release;
  secret-free diagnostics found Bob still in local key/restoration verification,
  with no recorded API HTTP failures, page errors, script errors or crashes.
  Repeated full graph/receipt validation is under measurement. These failures
  are unresolved; increasing a timeout is not proof of a fix.
- The deployment policy/private-file suite independently passed 174 negative
  controls, including 60 exact-evidence parser refusals. Root review requested
  additional resumed-database identity and retained-container hardening checks.
  Actual rootless container deployment/rollback has NOT run. The local host
  denies unprivileged user namespaces; the previously authorized no-cost public
  CI runner route remains the intended real-image execution environment.
- The additional resumed-database identity and actual container-hardening checks
  are implemented and independently verified: deployment policy suite passes
  224 refusals; release/evidence suite passes 211 refusals plus 19 archive controls.
  This is not actual container deployment or rollback evidence.
- Batch restoration validation passed 36 receipts, 12 single/batch equivalence
  checks and 84 mutations across both protocols and both network formats.
  The updated V3 acceptance plan has 58 pure and 75 local commands; the complete
  frozen-source matrix has not yet passed.
- Web `/tmp/btc-presigned-browser.7MKsdA` failed during Bob onboarding. Bounded
  read-only database inspection found no Bob registration challenge, credential
  or envelope; its isolated database was stopped again. Web
  `/tmp/btc-presigned-browser.BWQAhP` completed onboarding but failed during
  Alice's passkey restore: unlock options returned 200 with no later assertion.
  New fixture checks verify actual hydration/focus, remove the unchosen virtual
  key before switching, and retain only credential role/count diagnostics.
  Neither these changes nor an in-progress rerun establishes a fix yet.
- Three intermediate full lifecycle runs ended with signal exit 143, including
  both original and optimized snapshots. Their retained journals do not contain
  successful full acceptance. The signal source is unknown. A new exact frozen
  optimized run uses a bounded transient user service, without host-policy
  changes, restart, or public-network access.
- Recoverable public-cache retention passed all 290 synthetic reclaim/restores,
  19 refusal cases and interrupted-copy recovery at
  `/tmp/btc-public-cache-retention-test.VBvRKV`. Real preparation was interrupted
  before a manifest was finalized; only its separate operation-lock record was
  created. A prepare-only supervised retry is running. No historical cache
  files have been removed or real reclaim authorized at this checkpoint.
