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
- 2026-09-14 04:00 UTC: candidate `19d82053f47a28a386039118ff37de9eecfd5752`
  / source `2e47819de8d02e6fa80b6e0ace45f5a6f1edc287d27a93379a6475e0b895c744`
  was privacy-reviewed and pushed to the existing authorized public repository.
  Run `34802859714` failed all three jobs; it is not accepted. The local job
  stopped at `evidence-boundaries`: a fresh source snapshot reproduced its
  missing generated offline HTML dependency. The parser fixture now uses its
  own private, explicitly synthetic bytes; the real artifact validator is
  unchanged and additionally tested against missing/mismatched bytes.
- Actual rootless mainnet-image build/export/runtime stages passed, but its
  browser run failed at the cash-out coin selector. Safe diagnostic rerun
  `34803686595` identified the exact location; a minimal Chromium reproduction
  found zero exact-label matches but one correct accessible combobox match.
  The test selector is corrected; a complete image rerun is still required.
  Local browser `/tmp/btc-presigned-browser.v8E0qm` reached the first solo
  proposal before failing at its review checkbox. This separate failure remains
  under investigation; no completed web receipt was produced.
- Real public-cache preparation subsequently completed and its exact manifest
  was independently reviewed: 290 files, 22,486,088,175 bytes, manifest
  `5371d5bb992531c020de5653d0eb585faedcd7315db37ae8e31989b8e730a820`.
  Reclaim was explicitly approved for this scope. Its first supervised invocation
  reached the declared 30-minute ceiling after 143 duplicate files were removed
  and one original was quarantined. The same durable intent is now resuming with
  a 90-minute bound; completion is not yet asserted. Every removed byte remains
  in the verified retained keeper. Wallets, backups, unique tail files, indexes,
  chainstate and historical evidence are outside the reclaim scope.
- Reclaim completed with actual service exit 0. Root independently verified the
  completed record, all 290 absent duplicates, every keeper's pinned metadata,
  all 1,124 protected inventory entries and 129 protected content hashes
  (389,356,466 bytes). About 20.94 GiB of duplicate files was removed; every byte
  remains recoverable from the retained keeper using the exact saved recipe.
  Original inode numbers/change times cannot be restored. Free disk space was
  31 GiB at the post-check. This does not authorize any expanded cleanup.
- Corrected candidate `cf52826983b839bf0e425f785979db6efc05b307` / source
  `21af8d9d682043da26f0550d272d3eea9ad02e1b60d1fd27ded72fa40578923c`
  is now running in full CI `34804929173` and exact-image retention
  `34805003735` (tooling `74aff61411ce9e91dd35c46a61bc32a84d0e1766`).
  Its clean-checkout evidence parser passed 213 negatives plus 19 archive
  controls; both affected typechecks and nine diagnostic-privacy checks passed.
  Independent AI review found no blocking issue in those corrections.
  The prior first-solo failure's database contained three distinct transaction
  IDs and one eligible collecting solo proposal; actual server/client runtime
  validation passed in a bounded read-only restart, then that database stopped.
  This rules out duplicate saved transactions or deterministic view rejection,
  but does not establish the original browser failure's cause.
- Candidate `cf528269` / source `21af8d9d`: both image profiles in regular CI
  `34804929173` passed, including the complete Signet-format browser game and
  owner cash-out. The combined 75-command job is still running. Exact-image
  retention `34805003735` passed both profiles. All six original assets are
  retained privately under `live-run/presigned-v3-public-ci.07HNtw`; their remote
  sizes, SHA-256 values, source and tooling/run bindings were independently
  checked. Neither the test-only draft nor these isolated-Core tests constitute
  public default-Signet acceptance, deployment or funding authorization.
- Mainnet-format retained archive independently passed the unchanged full-layer
  privacy scanner, exact private restoration and actual candidate image/OCI
  validators with terminal exit 0: 39 files / 837,584,005 bytes / 18 layers / seven
  executed stages at `mainnet-restored.Bpn1CEXi` under that retention directory.
  Fresh review matches the original bytes and structure. Archive SHA-256:
  `70c8f94cbe183c300a88945bd7d94bb0eb504a9d05c540717365cae942b5d263`;
  image manifest `sha256:e401cbf708ec4f752ee88ab4731273d19bf9ece42a88b5958215a0991956af44`.
  Local Signet-format privacy scan also exited 0; strict restoration and candidate
  validation remain in progress. No local container execution has been claimed.
- Guarded post-assembly deployment proof tooling was independently reviewed,
  tested and committed as `51b4c9f48756bc8913f666f8fadb362f4d6fa6ed` on the
  existing test-evidence branch. Sixteen new tests (including 82 Node refusal
  controls) plus all 33 existing privacy tests passed. Final receipt pins remain
  unset and the dispatch preflight correctly refuses execution; no deployment
  proof has been created, because actual final assembled acceptance is pending.
- Local Signet-format restoration and actual candidate image/OCI validation
  subsequently passed with terminal exit 0: 39 private single-link files /
  837,642,053 bytes / 18 layers / seven executed stages at
  `signet-restored.eXn5EX` in the same retention directory. Archive SHA-256
  `eb0d3dbe2793a2d833062df4a6c5d5da8ad0f95cc8987265ddba61348a25f821`;
  manifest `sha256:093ba3daf094c21b3a3f5174cb6a3714cdc76f3f3b498c69d6f53d73662f37af`.
  A separate root-agent rerun of the actual candidate validator passed for both
  restored profiles and confirmed the same offline utility and source identity.
- Exact-source full local acceptance is now running at
  `/tmp/btc-presigned-acceptance.Rrm4aI`, source snapshot
  `/tmp/btc-v3-final-local-source.opr8Q7VC`, supervised by
  `btc-v3-final-local-isolated-PSDpfMeT.service`. It has a separate real dependency
  directory and all 75 unchanged commands. The first short invocation
  `/tmp/btc-presigned-acceptance.Hxnc66` was deliberately stopped to remove the
  shared-dependency build risk; its partial log remains retained and is not a
  pass. Control notes and both logs are private in
  `live-run/v3-final-local-control.PSDpfMeT`.
- Bounded final-contract AI review found no additional missing product feature
  or blocking code defect. Closeout must generate both prescribed network-bound
  software receipts and preserve their category dossiers, then execute/retain
  the separately validated deployment proof. No additional whole-host Signet
  loss drill is required by these contracts: the actual lifecycle already
  requires 19 independent case restores, 83 native restored signatures and 57
  participant-kit restores, plus the full matrix's wallet/database tests. This
  does not claim whole-disk/off-host recovery or professional human review.
- Supervised intermediate lifecycle `btc-v3-lifecycle-vkbVudZz` exited 1 at
  04:43:10 UTC. Its unchanged 90-minute timer stopped the isolated Core node at
  04:43:09 UTC; refund-ancestor reorg cleanup then failed while reading the
  removed RPC cookie. All 19 cases reached transaction completion, but the
  subsequent audits had run about 10m37s without producing the final receipt.
  No `passed:true` or `resumable-lifecycle-runner.json` exists, and the actual
  final-source evidence parser rejected this partial run. Its source remains
  `d4aff7f206259f5648b8b2f7bc54ad51cd6b207c98fdfaf09fc5b3581f6ef86f`;
  journal and Core reorg state are retained unchanged. This explains that one
  failure, not earlier unrelated signal interruptions. No source, assertions or
  deadlines were changed; reduced contention helping a new run is only a
  hypothesis. The actual final-source CI and full local suite remain running.
- The private image retention directory now includes a checked
  `artifact-inventory.json` with all six original hashes/sizes and both restored
  profile identities. Root independently recomputed every original asset hash
  and both complete restored-file counts/byte totals. It explicitly marks final
  software/default-Signet/deployment acceptance incomplete and grants no funds
  authority. Fresh dependency advisory check exited 0 with no reported findings;
  this is a dated registry result, not a universal security or human-audit claim.
- The additional faucet credit confirmed: actual synchronized native test wallet
  balance is now 40,555 sats, with no pending coins. This remains below the
  88,652-sat lifecycle envelope, before a separate native transfer fee. A normal
  sandboxed headed-browser fallback for another faucet failed before launch and
  submitted nothing; no sandbox or faucet limits were bypassed. Read-only disk
  review found only about 1.95 GiB of potential safe cleanup, not the requested
  5 GiB headroom. No further files were removed, no fresh V3 host was created and
  historical custody/proofs remain untouched.
- Hosted run `34804929173` completed with a failure at the last command,
  `database-v3-all`, after 74/75 passed. Both full lifecycle suites and the
  optimized browser passed. All seven final database child processes exited 0;
  the evidence validator rejected the restore stdout because its actual V3
  protocol identifier was omitted. The strict validator remains unchanged;
  the reporting defect and missing/wrong-protocol regressions are being fixed.
  Local `Rrm4aI` was deliberately stopped at 65/75 rather than continue a known
  final failure. Its private evidence remains incomplete, not accepted. Both
  exact-image artifacts for source `21af8d9d` remain genuine historical tests,
  but cannot authorize the corrected source. Fresh full/image runs are required.
- Bounded read-only timing inspection of historical browser `v8E0qm` ruled out
  simple overall-session-age expiry: Alice's latest session remained unexpired
  for 13m50.804s after the final log-write upper bound, and her preceding session
  was also unexpired. It does not establish which cookie was presented or the
  original failure's cause. The temporary read-only database was stopped again;
  no browser/Core was started or sensitive fields selected.
- Private native test-seed helper `live-run/presigned-v3-seed-transfer.l5GIIh`
  is implemented but inactive with all 27 operational pins unset. Independent
  root review and all seven CLI refusal checks passed; no control/wallet access
  occurred. Separate disposable tests passed 56 policy/tamper refusals, four
  native restored targets, one exact 89,000-sat regtest payment and lost-reply
  reconciliation without resend. Full configured operational branches remain
  untested; this is neither current Signet readiness nor transfer authorization.
- The minimal database-reporting correction passed independent AI review,
  scripts/web typechecks, 227 evidence refusals and 19 archive controls. Fourteen
  new negatives rehash each of the seven V3 database summaries after removing
  or substituting its protocol, require the identity-specific rejection, then
  restore/revalidate the positive artifact. Actual native V3 restore at
  `/tmp/btc-presigned-db.9ezpeM` and V2 restore at `/tmp/btc-presigned-db.wqbTIs`
  both exited 0, each retaining six restored encrypted keys and 22 refusals with
  matching stdout/private receipt protocol. Both databases stopped afterward.
  Production validators are unchanged. Corrected source
  `61d3b2c5e0d37b49775b87c7554b644c4225a7afbaee358e2ad2f1b257780353`
  requires fresh complete local/image/default-Signet evidence.
