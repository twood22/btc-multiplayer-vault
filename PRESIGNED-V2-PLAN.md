# V2 implementation and evidence plan

Goal authorized 2026-09-06. Status: in progress; test-only evidence prereleases
published, but no production release. A real-Signet test run was interrupted by
loss of temporary custody; persistent recovery and a new complete run are pending.
Rollback: merged commit `202345ffd8bab35590fe15b98d966c4267f194ef`.
Working branch: `codex/presigned-vault-v2`. No existing vault mutation, mainnet
spending, public listener, deployment or outreach is authorized.

On 2026-09-07 the user separately authorized publishing the V2 source and tests
to the existing public repository, using zero-cost test infrastructure. The
initial public acceptance workflow runs the complete local matrix plus both
genuine rootless OCI-image profiles on standard Ubuntu runners. It refuses
private-repository execution and has no paid runners, caches, Actions artifact
uploads, registry pushes or deployments.
Normal logs contain synthetic-test progress and independently revalidated
receipts; no wallets or recovery kits are uploaded. These CI additions change
the source digest: the earlier `80460afa...` checkpoint remains separate
historical evidence. The new-source results are recorded below. Retaining the
full exact-image bytes was separately authorized and completed as test-only
prerelease retention below; final release assembly remains separate work.

First public CI run `34145927695` on commit `cbb76642` passed both actual
rootless preflights and built/exported both production images. Both image jobs
then failed the strict private-owned OCI-root check; neither reached immutable
runtime/browser acceptance. The remaining local job was canceled when that
source was superseded, not counted as a full pass. The producer now tightens
only its owned export directory inside its existing private evidence root using
a no-follow directory descriptor. The verifier remains unchanged and strict.
Sixteen OCI boundary regressions pass, including 0755 refusal, successful
permission correction, symlink non-mutation and non-private-parent refusal;
scripts typecheck passes. The fresh whole matrix subsequently passed below.

## Current persistent-recovery checkpoint (2026-09-10 UTC)

Historical source `9afe98cf951de4261db89dd8e342ff607393ed6d52f64e9381e0d3dc842688c7`
(commit `a87c6dc`) completed all 49 fixed local commands at 01:15 UTC on
2026-09-09, including all 19 isolated-Core cases, five fee families, 84 confirmed
transactions and every CSV11/12 boundary. The actual 106-file retained local
evidence has run digest `229c8b9c8f2a14b0cf12ce997fe6f6d956c6910b670436fcc7bcaad989b57f28`;
its restored archive SHA-256 is
`f6e985609e5f7bb533ee38bfc758a47bd6c35a86864ed2d06beeeb70a9570718`.
Both actual OCI profiles also passed and their complete 39-file archives were
retained and independently verified. These artifacts remain historical; none
certifies the new executable source.

The real default-Signet run on that historical source funded its first case and
confirmed a first solo exit, but reboot removed its `/tmp` primary journal and
participant material. It cannot safely continue or be reinterpreted. A surviving
native test-wallet backup was restored into a new persistent isolated host,
with networking and automatic wallet broadcast disabled during restoration.
At the 2026-09-10 16:30 UTC chain audit, the original 128,985 test sats reconciled
exactly as 89,717 sats in seven owned/solvable native outputs, 29,700 sats in two
other known unspent leaves, and 9,568 sats in five confirmed fees. Audit SHA-256:
`6166a397ce465fef7f7bec353c8c4e8dcc08a054c1aafc47765c7bd274a0bbe1`.
This is a dated non-spending recovery snapshot, not a fresh UTXO authorization.
No consolidation or new funded run has been performed on the recovered coins.

The new execution profile preserves the full 19-case/5-fee-family/84-transaction
matrix, all 10,000-sat deposits, 9,500/10,250-sat first/second payouts, graph fees
and CSV12. Only test-capital transport (integer-ceiling 300 millisatoshis/vB,
338 sats maximum per allocation) and external sponsor escrow (15,000 sats) change.
The exact minimum seed is 88,352 sats; regtest uses 89,000. Twenty allocations
cost at most 6,760 sats plus 47,000 fixed lifecycle fees. Separate consolidation,
if later executed, needs a fresh audit and its own bound; no extra coins or
outreach are assumed and no fee or capital override is automatic.

Persistent private primary/full-backup/independent-anchor roots replace temporary
funded state. Actual native restore proofs cover the receiving key and all 82
reserved wallet targets; every case independently restores all three complete
participant kits before wallet signing. Exact intent checkpoints precede all
signatures and sends. Kernel locks, total-primary-loss restoration, incomplete
initialization retry and same-identity host recovery are implemented. Restoring
a host requires a new independently acknowledged attempt-bound native proof;
stale or missing acknowledgements cannot enable ordinary restart/funding.
These sibling directories do not protect against whole-disk loss.

Narrow current-development checks passed: scripts typecheck, 19 synthetic durable
checkpoints/14 complete restores/42 refusal cases, four kernel-lock checks,
83 actual restored native signatures/15 binding refusals, and four actual POSIX
lock checks including live Core exclusion and lock-holder death. The isolated
custody smoke run restored two completely missing primaries and reconciled lost
submission replies without duplicates; it is not full lifecycle acceptance.
The unfunded default-Signet drill passed on source
`b8c4cf2848be5d9626f8210d601b245f18bbf49ec15595efc5f46b73246dc97f`:
two same-wallet restarts, two full host restorations, ten specific refusal cases,
two new attempt-bound native signatures, unchanged receiving address, zero wallet
transactions and zero test sats. Its node stopped cleanly; original trees and
negative-fixture bytes remain private. The current-source custody smoke also
passed both primary-loss/init-interruption schedules and funding/replacement
lost-reply reconciliation without duplicate sends. Neither is the full funded
19-case acceptance. Independent final delta review found no additional actionable
blocker in its bounded static scope; the full suite is still required.

The required local plan now has **52 commands**: the prior 49 plus two filesystem
checks and one native-wallet restore check. Full current-source local acceptance,
both current exact images, retained complete artifacts, a new funded default-
Signet 19-case/five-fee-family run and final release assembly remain required.
Physical-device passkey tests remain explicitly deferred. Mainnet spending,
public app exposure and further outreach remain unauthorized.

## Historical low-capital follow-up (2026-09-08 UTC)

The user authorized proceeding with the available confirmed 128,985 test sats.
The runner now uses one explicitly selected coin and a closed sequential
allocation DAG, preserving all 19 cases, five replacement families and original
economics. Its 20 allocation fees are capped at 45,000 sats in total; the fixed
lifecycle fees are 47,000 sats. Final acceptance requires a confirmed unspent
return and exact conservation across 84 unique confirmed transactions, with no
unrelated wallet inputs. The original all-at-once 800,000-sat harness budget was
not a Bitcoin network minimum. The new lower bound is 124,680 sats.

Pure signing tests pass for both configured networks (ten valid transactions,
eight wallet-PSBT normalization forms and 96 hostile mutations each), scripts
typecheck passes, and the evidence boundary suite now has 73 refusal checks
plus 19 archive negatives.
Independent review corrections and a Core PSBT compatibility diagnosis are
recorded in the review checkpoint. The complete low-capital Core run is being
validated; real default-Signet allocation has not started. An interim source
`f889b15f` completed 44 of 49 local commands and eight lifecycle cases before a
controlled stop to improve test-time mining. Its two actual image archives were
independently downloaded and verified in a separate test-only draft; they do not
certify the revised test source. The revised regtest explicitly checks every
recovery at depth 11 and 12, avoiding repeated full-history advances at
intermediate depths. Its execution deadline is 90 minutes (full CI: 150), without
changing CSV12, transaction bytes, coverage or capital limits. The required full
local plan now contains 49 commands. Current-source full local, both image
profiles and live-Signet evidence remain required. All `536935c2` receipts and
archives below are historical and cannot certify this changed executable source.

The table below records implementation and prior test coverage; it is not a
claim that the changed source has completed its fresh acceptance requirements.

| Requirement | Implementation / acceptance evidence | Status |
| --- | --- | --- |
| Versioned protocol, threat model, full scope | PRESIGNED-PROTOCOL.md; independently reviewed findings reproduced and corrected | Implemented and documented; three scoped internal reviews and rereviews complete, not an external audit |
| Four Miniscript trees, exact nine-transaction graph | src/presigned/graph.ts; Core drill below | Core graph and actual browser reconstruction verified |
| Twelve preauthorizations, missing leaver signatures | src/presigned/signing.ts; eight wallet formats; Core accepts/rejects below | Core and actual browser ceremony verified |
| Stable funding and signed-epoch retention | Native SegWit, mandatory controlled refund, retained epochs, durable wallet-start intent | Core + PostgreSQL + optimized browser verified in the passing frozen-source full aggregate |
| Portable complete recovery before wallet signing | Authenticated encrypted kits, independent secret, all three owner exits restored | Unified exact offline artifact passed full lifecycle and ten wallet/fee cases on Core |
| Two-passkey browser custody and signing | Full v2 ceremony, local append-only digest/backup ledger, Web Locks | Six virtual PRF passkeys passed actual optimized browser; physical checks deferred |
| Cooperative, CSV, final sweep | Core19 confirmed cases and56 rejections; funding and all game transactions V3 | Core and actual browser signing passed; lifecycle confirmations also proven by standalone offline browser |
| Fee adaptation with stable descendants | Funding, solo, cooperative, CSV and final payout sponsorship; TRUC/rolling-floor tests | Unified offline/database families, actual Core fee tests and clean Signet-format browser wrapper pass in the full aggregate |
| Versioned database/runtime/watcher | Migrations015-021, exact-send journals, unknown-state preservation, reverse reorg/restore and monotonic poll revision | Lost-lease/ABA and both fair-queue regressions pass actual Core/PostgreSQL in the corrected-source full aggregate |
| Substantive v2 readiness and release gate | Exact-image/check receipts and exact funding-state restore proof; no provider gate bypass | Evidence boundary suite has67 fail-closed negatives plus19 archive negatives; native restore has22; end-to-end release proof remains pending |
| Actual packaged app execution | Production Dockerfile, rootless Podman, all OCI bytes, immutable image, operator and real browser checks | Both profiles passed; exact test-only archives are now publicly retained and independently restored/validated |
| Real default-Signet full lifecycles | Isolated keys/coins, txids, confirmations, output audit | Historical real run interrupted; native wallet recovered and 128,985-sat ledger reconciled; persistent runner and new complete run still required |
| Documentation and independent security review | Protocol, operator/recovery runbook, versioned historical docs; reviewer findings reproduced and fixed | Three reviews and focused independent rereviews completed; no new findings in the corrected delta |
| Physical-device passkeys | Friends' onboarding, explicitly deferred by user | Deferred; not tested |
| Mainnet activation/public deployment | Separate user authority and release review | Not authorized |

The preliminary Core feasibility experiment is not integration evidence and
does not satisfy the pending requirements above. Unchecked rows block completion
of the active development goal, except the explicit deferred/unauthorized items.

## Historical retained test-image checkpoint (2026-09-08 UTC)

The user explicitly authorized test-only prerelease archive publication on
2026-09-07 local time. The
[published test-only evidence release](https://github.com/twood22/btc-multiplayer-vault/releases/tag/presigned-v2-test-evidence-536935c2-20260908)
retains six assets: two actual image archives and four retention/content-review
records. It was published at 02:19 UTC as a prerelease, not latest. These public
synthetic-test images must never be used with real funds, participant custody
or operational credentials, and cannot be promoted to production.

[Run 34178522361](https://github.com/twood22/btc-multiplayer-vault/actions/runs/34178522361)
passed both genuine rootless image profiles, packaging/restoration, content
review and draft-only uploads. Candidate commit
`d5ff8e8677fc2ed39a9f35d2f260cf060650bd7c` retains executable source
`536935c274261a11f18d9a798cc385770c878681842cfe0fc8e89aec724c2069`.
Retention tooling commit `ee97b86a6f240b0c6a5a8ffff972a8f866e94bdc` is on a
separate branch and not part of the application image's source fingerprint.
The earlier full 47 local proof below remains the same-source local acceptance;
this image-only run did not rerun that matrix.

- Signet-format archive: 258,102,723 bytes, 39 required files, SHA-256
  `cda7c3ba29b236d311efac07a1295e639b4fa291432faba50700772fa0b659a9`.
  Tested OCI manifest:
  `sha256:6231b5ce076c35157001e91154f8ed7ea2cd378a69bee9a1d6ee90455a013cda`.
  Execution receipt:
  `c586c4d254c100fab314b29740c7b1ce49b20556c5747308fb0ec01a0bbdeec5`.
- Mainnet-format archive: 258,101,735 bytes, 39 required files, SHA-256
  `4d6d661f44b72ee5a094df30da683ab5559367069dddd7999991d219d4a0f088`.
  Tested OCI manifest:
  `sha256:90b8ecbe0c4d1bef6639b40bbc15809424ec0bb6a4cc57014304d0bd1679ccee`.
  Execution receipt:
  `117279edcc9692efcc0c10305aa6109511592087d07a97b5e75aefd81bcefb86`.

Both retain the exact previously tested offline utility
`3afcdac5caf72eb0c03598ce8165c78961f4463f7ef50adf6f715f02b9599807`.
Signet-format exercises the full isolated-Core browser game; mainnet-format
exercises the complete pre-funding custody/backup ceremony and authorization
refusal. Neither establishes real default-Signet or mainnet transactions.

The publisher reviewed every required member and all 18 historical image layers,
including their metadata, padding and trailers. The review is bounded, not a
universal secret-absence proof. Exact public GnuTLS self-test constants were
independently matched to published source and tightly hash/offset bound; unused
framework test-build keys are permanently public. See the release notes and
review ledger for the boundaries; never redact committed transcripts.

At 02:14:56 UTC, a separate owner-only download matched all six GitHub asset hashes
and sizes. Both complete archives passed a repeated content review, canonical
envelope checks, actual restoration and the candidate semantic validator.
An independent read-only reviewer checked both semantic validators, exact 39-file
allowlists, each archive member against restored bytes, all six recorded asset
digests, and private ownership/permissions, with no finding. The exact assets
were checked again before and after publication; the tag resolves to d5ff8e8.
Raw/restored proof and publication verification are retained in
`live-run/presigned-v2-public-images.ZuU0Yi/`; files/directories were flushed.
No registry push, app deployment, public listener, paid artifact storage,
operational credentials or private wallet/recovery directories were published.

The default-Signet wallet still had 0 confirmed/0 pending sats at 02:18 UTC and
was uninitialized. All 19 real lifecycles and final release assembly remain
outstanding; physical-device checks remain deferred to onboarding.

## Historical log-only archive-CI checkpoint (2026-09-07 UTC)

[Run 34150142799](https://github.com/twood22/btc-multiplayer-vault/actions/runs/34150142799)
passed all three jobs on commit `3f0d621be4c5b78165f8856d1727382ce4c0f013`,
executable source
`536935c274261a11f18d9a798cc385770c878681842cfe0fc8e89aec724c2069`.
Every profile binds the same tested offline utility
`3afcdac5caf72eb0c03598ce8165c78961f4463f7ef50adf6f715f02b9599807`.

- **Local47 passed** from18:04:57 to18:27:18 UTC, including all four typechecks,
  both network-format crypto/legacy matrices, seven Core suites, all five
  database suites, complete saved-file recovery and optimized browser execution.
  Run digest `57e07e25605d1d21960f198e2908373f83b0b6b2b6174eac8400fc252af49c8a`.
  Its102-file archive was created, restored and revalidated:1,315,244 bytes,
  SHA256 `60eca4cd555c630f167bb3fe88e76dccaa98d046bb3f24a117e6e63540c224b5`.
- **Signet-format exact image passed** at18:12:12 UTC, including the complete
  isolated-Core browser game. Manifest
  `sha256:df0986c5558685332c30bc8680840f2b4352e0e9a07066b4c79b40d9bf2124dd`;
  receipt `a380d1166264fbb11845b5a584eca9c650bbe562c37bfa31b2c3d4b52fa20109`.
  Its39-file archive passed actual restoration/revalidation:258,108,793 bytes,
  SHA256 `2ffabc4405ec92919244f1eea6f610665ee7c809f001a6e9f893c327c74884c1`.
- **Mainnet-format exact image passed** at18:07:44 UTC, including complete
  pre-funding browser custody/backup setup and unauthorized-funding refusal.
  Manifest `sha256:f302fc7ba70b681ad00451a71358fbda0921341040d58b961129144cc726e239`;
  receipt `64babb9b0bd6e22a98513756b98d20fa8554a3d298b67e52d6bab1dc56be497a`.
  Its39-file archive passed actual restoration/revalidation:258,110,251 bytes,
  SHA256 `7ba38cd89e6414f2de9fc2e34a8963d41c058a6a900cfea7b0dc35ebb9686066`.

The new local-only packager uses exact allowlists, private staging, bounded
regular-file reads, no-clobber outputs and actual archive restoration. Its19
synthetic negative boundaries also passed inside the full suite. Real complete
local/image dossiers were separately validated before copying, after staging
and after restoration, with their original committed bytes preserved.

Root independently checked all actual job conclusions, fixed command plans,
source/receipt commitments and matching archive-result bindings. Four public
result files per profile, the read-only collector and its README are retained
owner-only in `live-run/presigned-v2-public-ci.e7clQK/` (14 files). **These are
log-only copies, not the archive/OCI bytes.** No archive was uploaded; runner
disposal removed those bytes. Archive publication was not authorized at this
earlier checkpoint. The separately authorized, retained and content-reviewed
archives above come from a new image run; these older hashes remain historical.
No completed release dossier or final acceptance assembly is claimed.

At18:28 UTC, the isolated default-Signet wallet still had zero pending/confirmed
test sats and no initialized lifecycle. All19 real default-Signet lifecycles
remain outstanding. Physical-device passkeys remain explicitly deferred, and
no mainnet spend, app deployment, public listener or outreach was authorized.

## Private retained local checkpoint (2026-09-07 UTC)

A separate full local run passed all 47 commands from 18:37:59 to 19:45:12 UTC,
with unchanged executable source `536935c2` and the same tested offline utility
as all three public CI profiles. This includes all seven Core suites, all five
database suites, complete saved-file recovery and the optimized browser game.
Run digest:
`67fbd4dcf6ac3110a735a90645437957f3e61b95aa056b5ad5e73f613868341a`.

After the actual parent exited zero, the guarded private collector retained the
101 required proof files plus the exact offline utility in
`live-run/presigned-v2-private-local.v0XHDp/local/`. Its separate archive contains
exactly those 102 files: 1,315,278 bytes, SHA-256
`6120e429ad72291b3a69f6336daa03fcf88a8c0a1958de2402fef915995b933b`.
The archive was created, restored and semantically revalidated before acceptance.
Root additionally reread the original and copied complete runs, compared every
copied byte, checked exact archive members, ownership and private permissions,
and flushed the exact retained files/directories. An independent read-only
review repeated semantic validation, archive/utility hashing and exact member
and permission checks with no finding. The collector also passed its isolated
TypeScript check and active-parent refusal before collection.

These are actual retained local proof bytes, not CI-log substitutes. Raw proof
files are mode 0600 under mode 0700 directories. Test wallets, cookies, child
databases, browser profiles/downloads and participant kits were not copied.
Original evidence remains intact. This is storage on this host, not an off-host
backup or a power-loss recovery experiment. The test parent, browser processes,
Core nodes and scoped PostgreSQL instances stopped; the original outbound-only
default-Signet node remains running.

At that checkpoint, both public image archives were still unretained. Host checks
at 19:24 UTC found no local container engine or QEMU; `unshare -Ur true` was denied at
`uid_map`. No host security setting was changed. Public test-only prerelease
archive retention was not yet approved; the new authorized checkpoint above
supersedes that limitation. At 19:30 UTC the isolated default-Signet
wallet still had zero pending/confirmed test sats and no initialized lifecycle.
All 19 real default-Signet lifecycles and final release assembly remain pending;
physical passkeys remain deferred. No archive publication, mainnet spending,
app deployment or outreach occurred during that private-local checkpoint.

## Historical initial public-CI checkpoint (source09609ca8, 2026-09-07 UTC)

[Run 34146377273](https://github.com/twood22/btc-multiplayer-vault/actions/runs/34146377273)
completed successfully with all three jobs on commit
`2177e1307d30ae85c22a8f21c4d8c4432323ce98`. All three bind executable source
`09609ca81eeb29786f3a4d950a6ed895e88e99f7fdae401faf2b42cf448647aa` and exact
offline utility `3afcdac5caf72eb0c03598ce8165c78961f4463f7ef50adf6f715f02b9599807`.

- The complete **47-command local matrix passed** from 17:09:59 to 17:32:17 UTC,
  run digest `d11f03489495c5e484829a8e57b84deb5edb5d141a57c2e5d4b0769cae0b8f2c`.
  This includes all four typechecks, both cryptographic/legacy network-format
  matrices, seven Core suites, five database suites, the exact offline utility
  and optimized full-game browser.
- Genuine rootless **Signet-format image acceptance passed** at 17:16:26 UTC,
  OCI manifest `sha256:c97160f3321ec2b7e9b1a27ae0c9113010d3afdb961eb6c3d541ca89a0d219a5`,
  receipt `928b2496fc2ceeff54d447738ddf293133a99ac7c19ef21d83bcbd0e020b7625`.
  The actual immutable production image completed operator-entrypoint and
  full browser-game checks against isolated regtest, with no mounted source.
- Genuine rootless **mainnet-format image acceptance passed** at 17:12:18 UTC,
  OCI manifest `sha256:ccdfc478a833a9f91195eda47f3db89e8ed0ee23afea4fd47a62bddfa427f378`,
  receipt `5e636377bc8f8088b8b78b983a8ac411d54167de2df09c2e7cdf64387b697544`.
  This exercised actual startup, operator imports, complete browser custody and
  backup setup, and the unauthorized-funding refusal. It did not spend mainnet.

The CI producer reread each required transcript and every OCI metadata/layer
byte before its success receipt. Root independently downloaded the actual public
job logs and checked the matching GitHub job conclusions, source, all fixed
command plans and receipt commitments. Owner-only copies are retained in
`live-run/presigned-v2-public-ci.KM6rVx/`. **This is log-only result retention,
not a complete retained release dossier**: full child transcripts and OCI layers
were not uploaded from the runners. The assembler still correctly refuses an
incomplete dossier; actual image execution is now proven, but final assembly is
not. A test-only downloadable build-archive publication requires its separate
approval; no release, registry image, deployment or funding authorization was
created by these jobs.

At 17:32 UTC, the isolated default-Signet wallet still had zero confirmed and
zero pending test sats, with no initialized lifecycle. The user's faucet queue
message is not a received payment. All19 real default-Signet lifecycles remain
outstanding; physical passkeys remain explicitly deferred. No host security
policy was changed, and the legacy rollback/default branch is unchanged.

## Historical private checkpoint (source80460afa, 2026-09-07 UTC)

The corrected-source **47-command local aggregate passed** from 07:05:42 to
08:05:09 UTC. The exact source digest is
`80460afa6fb7f6ab1568f779efceb8abc4c247622f07fb08ef67c688e1e83267`; run digest
`c57f61311e9e4cb3d105461f689d6b90dec089e1f7c17095e431edd7e5cd90a2`.
The parent runner exited zero. Root independently reread the complete fixed
execution plan, every transcript and auxiliary-artifact hash, database/browser
semantics, and the actual offline utility bytes. All four TypeScript projects,
both explicit network-format crypto and legacy matrices, seven actual Core
suites, all five PostgreSQL suites, the unified offline artifact and the clean
optimized Signet-format browser full game passed.

Final independent transaction review identified two P2 gaps after the passing
earlier-source run: accepted entries can monopolize both oldest-100 retry queues, and watcher
state hashes do not fence stale same-state or advance/reorg/return (ABA)
publications after a lost session lease. Root reproduced both retry defects and
three stale-publication schedules against actual Core/PostgreSQL, including
confirmation followed by block invalidation. The corrected queues rotate by
`updated_at, id`; migration021 adds a monotonic revision checked alongside the
state digest on every successful and deferred watch publication.
The targeted chain/broadcast suite passed 12 groups in
`/tmp/btc-presigned-db.YblUsL`; all five fee families and queue fairness passed in
`/tmp/btc-presigned-db.0SvheC`. The complete aggregate then reran both regressions
successfully in `/tmp/btc-presigned-db.BAMASU`. Test databases and Core nodes were
checked stopped. All three reviewers completed focused rereviews without new
findings; exact scope and limits are in
[PRESIGNED-V2-REVIEW.md](./PRESIGNED-V2-REVIEW.md).

The other two reviews found narrower hardening issues. The report CLI now shares
the actual funding gate's deployed-utility/source/image check. Forty-nine
evidence-boundary tests pass, including real CLI utility-mismatch refusal and
rejection of explicit failed Core records followed by a successful summary.
Owned mutable key-envelope buffers are cleared in `finally` paths; 22 custody
cases pass, including real WebCrypto success and exception cleanup. This is
best-effort memory hygiene, not erasure of JavaScript strings or browser internals.

The matching optimized mainnet-format browser passed in
`/tmp/btc-presigned-browser.knCexA`, proving the actual pre-funding refusal before
wallet PSBT export, signing intent, signature release or send RPC. The aggregate's
Signet-format browser passed in `/tmp/btc-presigned-browser.KJDcJ2`, including
four genuine passkey reauthentications and confirmed funding/solo/solo/final-sweep
transactions. Both clean wrappers exited zero. Both browser scopes used isolated
regtest facts, six virtual PRF credentials and zero public-network broadcasts;
neither is real Signet, physical-device, mainnet-spending or image-execution
evidence. All eleven aggregate Core nodes, the separate mainnet test Core, test
PostgreSQL and both browser listeners were checked stopped.

The aggregate's exact offline utility
`3afcdac5caf72eb0c03598ce8165c78961f4463f7ef50adf6f715f02b9599807` passed 70
complete kit restorations, 31 browser-signed lifecycle confirmations, all six
solo orderings, four cooperative rounds, nine recovery signer subsets and ten
native-wallet fee rescues with confirmed replacements. It made zero network
requests and did not persist secrets. The same-source resumable Core runner
passed all 19 lifecycles, 19 pre-funding backup gates, three lost replies without
resending, 57 restored kits, 80 hostile rejections and five fee families. Its
read-only verifier rejected an actually missing backup and an invalidated block;
reconsidering the block restored successful verification. The native database
restore recovered six encrypted key envelopes and passed 22 negative boundaries.

Owner-only copies of the complete run, both browser scopes, selected public
Core/restore summaries and the exact offline HTML/manifest are retained in
`live-run/presigned-v2-evidence.Z5bbaY/`. The copied run was revalidated against
the current source, each transcript and auxiliary-artifact digest, the full
fixed execution plan and the actual utility/input bytes. The source archive
also reproduced the exact source digest when privately extracted without
executing it. This is a **private local evidence dossier, not a release receipt**.
It contains no participant wallet, RPC cookie or recovery secret. The original
outbound-only default-Signet node remains running.

At 07:56 UTC the actual default-Signet wallet still had zero confirmed and zero
pending test sats, with no initialized lifecycle. A native backup of that fresh
test-only wallet was restored into a separate network-disabled default-Signet
node; its reserved address remained owned and solvable, and the verification
node stopped cleanly. That private backup is kept separately from this dossier;
it is recoverability evidence, not a funded Signet lifecycle. Actual container
preflights for both network profiles failed because rootless Podman is unavailable.
Fresh read-only engine checks again found no local container engine or QEMU;
`unshare -Ur true` failed at `uid_map` with operation not permitted. No engine was
installed and no host policy was weakened. Finishing requires isolated
default-Signet test coins and a suitable private container runner; actual image
execution, real default-Signet lifecycles and final evidence assembly remain
unproven. Mainnet spending, public exposure/deployment and outreach still require
separate user authority. Physical-device checks remain explicitly deferred.

The earlier source `49eacf7307d06c9a9d55b7f57edadb9c3dc0ca397cc15f42d100b39b1b049835`
passed from 05:31:19 to 06:28:42 UTC with run digest
`1617b5a6377658d1bb97fecd537b1fd245ba2d0673787efc5903791ea733c946`.
Its private source/evidence dossier `live-run/presigned-v2-evidence.kg32fM/` is
preserved as historical proof with the subsequently identified defects clearly
marked; it is not evidence for the corrected source or a release.

The historical entries below retain failures, superseded digests and earlier
partial evidence. Their old in-progress statements are not the current status.

## Implementation evidence history (2026-09-06 onward)

- `node_modules/.bin/tsx src/presigned/acceptance.ts`: passes eight native-wallet
  combinations with preauthorizations created before wallet signatures, all nine
  exits, missing-leaver and transaction/graph/role/epoch mutation rejection, and
  valid alternate-witness recognition. Offline cryptography, not browser proof.
- `node_modules/.bin/tsx scripts/presigned-core-acceptance.mts`: actual isolated,
  network-disabled Core 31.1 accepted 72 exit cases, rejected 144 missing-signature
  or altered-payout cases, reproduced 32 Miniscript descriptors, and confirmed
  all six full first/second exit orderings across eight wallet-format mixtures.
  Latest all-V3 funding evidence: `/tmp/btc-presigned-core-aBP3kj/graph-acceptance.json`; automatic node
  shutdown completed. No public-network broadcasts. This does not yet prove
  cooperative/recovery/final sweeps, fee packages, browser or live Signet.
- Independent component suites report portable-kit/passkey-contract, fee-child
  cryptography and graph-reconciliation passes. Their actual browser/database/
  Core integration and root review remain separate acceptance items.
- `scripts/presigned-core-spends.mts`: Core31.1 confirmed four genuinely
  interactive cooperative rounds, all nine N-1 recovery signer subsets (18
  exact premature/one-block-early checks), and six final sweeps; 38 witness or
  payout mutations rejected. Latest all-V3 funding-and-spends evidence is
  `/tmp/btc-presigned-core-MEk0TA/spends-acceptance.json`; the node stopped cleanly.
- Production V3 solo fee constructors passed real Core walletprocesspsbt for
  P2TR/P2WPKH sponsorship, sibling eviction, child replacement, topology limits
  and real rolling-floor rescue in `/tmp/btc-presigned-core-vLeo9M`.
- Independent Core observations proved high-S, annex and low-fee funding can
  be consensus-mined despite strict send-policy rejection, and a leaver-only
  SIGHASH_ALL exit can confirm unchanged. Evidence `/tmp/btc-presigned-core-2niFpp`;
  separate trusted-Core confirmed recognition is being implemented, not a
  relaxation of wallet signing or submission rules.
- New provider-free browser ceremony/routes, immutable V2 creation, durable
  wallet-start intent, legacy route and database write boundaries are implemented.
  Real production-browser acceptance, actual runtime/watch/broadcast integration,
  independent final review and default-Signet lifecycles remain incomplete.
- Funding-fee Core evidence `/tmp/btc-presigned-core-wquryX/funding-fees-acceptance.json`
  verifies both native wallet roles, absent/present parent package submission,
  child-only replacement, unchanged refunds and all descendant txids, and an
  actual rolling mempool floor rise from0.1 to2.102 sat/vB. Separate54-child
  cryptographic cases and10 boundary groups pass. A false caller-provided
  confirmed-sponsor assertion is deliberately disproved by real Core; the
  production adapter must independently observe every source and sponsor.
- Core/PostgreSQL chain and broadcast evidence `/tmp/btc-presigned-core-EtrYwX/chain-broadcast-db-acceptance.json`
  covers lost send replies without duplicate send, restart, pending versus
  confirmed source availability, reverse descendant reorganization and ordered
  restoration, retained epoch conflicts and same-txid MuSig restarts. The
  independent reviewer reproduced a stale worker overwriting a newer accepted
  result; attempt-count compare-and-swap now protects both success and failure
  writes. Complete epoch-set and same-epoch snapshot digests are rechecked under
  the vault lock before publishing a watch snapshot or vault status.
- The isolated, fully synchronized default-Signet Core31.1 node uses a fresh
  test-only wallet and no pre-existing participant wallet. Its test balance is
  still zero; no v2 real-Signet transaction or lifecycle has been claimed.
- `scripts/presigned-offline-acceptance.mts` completed the actual local-file
  browser lifecycle with HTTP disabled and zero network requests: 44 encrypted
  kit restorations and 31 browser-signed transactions confirmed by Core31.1,
  covering all six solo/solo/final-sweep orderings, four cooperative rounds and
  nine N-1 recovery signer subsets. Lost cooperative nonce restoration failed
  closed and a fresh complete signing ceremony preserved the exact payment.
  Evidence: `/tmp/btc-presigned-offline.EKikvj/offline-browser-acceptance.json`;
  utility SHA256 `406a6b82dfd5d526007e06ad1709d9d77601900d05a64d07e3683f0092770252`.
  This proves that exact utility, not later fee-UI changes, physical passkeys,
  real Signet or production release readiness.
- Optimized browser evidence `/tmp/btc-presigned-browser.HF8xB1/presigned-browser-acceptance.json`
  passed three independent identities, six virtual PRF credentials, twelve
  browser-created preauthorizations, nine restoration receipts, interrupted
  funding-intent persistence, three wallet signatures and final approvals,
  and actual funding/solo/solo/final-sweep API broadcast and confirmation.
  Cooperative MuSig2 and mature recovery were genuinely browser-signed and
  accepted by Core policy. The bridge labels real regtest facts as Signet-format
  inputs only inside this test; it is explicitly not real Signet evidence.
  Later utility-download, readiness and fee-import changes need a fresh build.
- Offline fee browser evidence `/tmp/btc-presigned-offline.MR6h54/offline-browser-fees-acceptance.json`
  passed both P2TR and P2WPKH external Core wallets for funding, solo, cooperative,
  recovery and final-sweep parents: ten packages accepted, ten public drafts
  restored after reload, ten child replacements confirmed with unchanged parent
  and payout/refund. Utility SHA256
  `3afcdac5caf72eb0c03598ce8165c78961f4463f7ef50adf6f715f02b9599807`.
  The earlier full lifecycle artifact and this fee artifact have distinct hashes;
  final release requires a complete rerun of the same final utility.
- Fee PostgreSQL/Core evidence `/tmp/btc-presigned-db.9UL2WO/presigned-fee-db-acceptance.log`
  passed all five fee families: exact authority, passkey-counter challenge replay,
  approval versus send intent separation, lost reply recovery without resending,
  replacement supersession, confirmed restart and owner isolation. A subsequently
  added parent-confirmation-during-offline-signing regression reproduced a real
  stale-source rejection. Its targeted fix passed in
  `/tmp/btc-presigned-db.a59ur4/presigned-fee-db-acceptance.log`.
- Unified exact offline artifact evidence
  `/tmp/btc-presigned-offline.8kfy3x/offline-browser-acceptance.json` passed
  70 complete encrypted-kit restorations, all six full solo orderings,
  four cooperative rounds, nine recovery signer subsets, 31 browser-signed
  lifecycle transactions confirmed by Core and all ten native-wallet/parent
  fee rescues with replacement children confirmed. The utility hash is
  `3afcdac5caf72eb0c03598ce8165c78961f4463f7ef50adf6f715f02b9599807`;
  zero network requests and persistent secret storage. No real-Signet claim.
- The new `scripts/presigned-signet-lifecycle.mts` verifies the exact isolated
  default-Signet host and exposes explicit `init`, `status`, `fund` and `advance`
  operations. Its shared orchestration passed 19 full isolated-Core cases with
  fresh random participant keys, complete encrypted kit readback before wallet
  signing, durable exact transaction intents, all output checks and repeated
  resumed observations. Evidence: `/tmp/btc-presigned-live-runner.sP17kH` and
  `/tmp/btc-presigned-core-Hof2PW/resumable-lifecycle-runner.json`.
  Its later fee-aware and interruption-hardened runner passed in
  `/tmp/btc-presigned-core-Jvj0hy/resumable-lifecycle-runner.json` with private
  state `/tmp/btc-presigned-live-runner.IXoXTM`: all19 lifecycles, all five
  fee families with confirmed child replacements, three lost successful
  responses without duplicate sends, all19 pre-funding backup gates, retained
  interrupted setup and complete payout/refund/sponsor-change audits.
  Only a read-only live `status` was run; it found no initialized lifecycle,
  zero confirmed test sats and zero pending test sats.
- Native `pg_dump`/`pg_restore` evidence
  `/tmp/btc-presigned-restore.vqwsYf/acceptance.json` and
  `/tmp/btc-presigned-db.sOHtDa/presigned-restore-db-acceptance.log` passed
  actual full-database restoration, decryption of six recovered key envelopes,
  three owner-exit proofs per envelope and22 rejection boundaries.
  The new exact funding-state restore receipt shares a repeatable-read snapshot
  with the full database digest, binds every retained epoch and current custody
  material, and is enforced separately by the mainnet release gate.
  Counters/last-used timestamps may advance without changing restored keys.
  Synthetic PRF transport and funding coins in this drill do not prove physical
  devices, production TLS endpoints, real Signet or an authorized release.
- The expanded optimized-browser assertions passed in
  `/tmp/btc-presigned-browser.WhxHQa/presigned-browser-acceptance.json` and
  `/tmp/btc-presigned-core-JfFKh7/optimized-browser-acceptance.json` against
  optimized source `b4d2a9fbbd51dd60e6ca4a924f39a32ff3324958983dd07ec167cb11135153f2`.
  All five fee parent families passed signing/approval; funding, both solo
  exits, final sweep and their fee children were broadcast and confirmed.
  Four genuine passkey reauthentications included a deliberately absent session
  after final-sweep signing, without losing retained signatures or local gates.
  The preceding run failed after the real fifteen-minute session expired;
  production session duration was not relaxed.
  The outer shell then failed because its source was edited while it was
  running. Therefore this is a passed browser test, not a clean aggregate run.
  The exact web listener, test PostgreSQL and test Core were verified stopped.
  Browser/database wrappers now copy code-only private snapshots before starting
  services; that correction and the new aggregate plan require a clean rerun.
- `presigned:test:pure` and `presigned:test:local` now execute fixed matrices,
  bind commands/transcripts to the actual source digest and reject partial
  offline results. The graph-format suite now explicitly selects each requested
  network; changing only the environment previously left some fixture-only
  suites on their default Signet format. No earlier implicit second-format
  claim is treated as new proof. The first full36-step pure run passed at
  `/tmp/btc-presigned-acceptance.a9J3L6/run.json`, source
  `2f633c5a0b3f862a14007fb4baa11100ead8bd17cadde73f55efb6d28c6d099f`.
  Later evidence-reader hardening additionally verifies exact retained artifact
  names, full-game versus mainnet-refusal scope, native restored custody and
  every fixed image command/environment/zero exit. The updated evidence-parser
  regressions passed42 negative boundaries, including actual assembly CLI
  refusals with no release output; OCI metadata/hash regressions passed13.
  These are parser tests, not genuine image or release evidence.
- `presigned:test:container` now builds and runs the exact OCI artifact with
  rootless Podman, without publishing or mounting code. It verifies both encoded
  layer hashes and uncompressed filesystem digests, distinguishing a manifest
  digest from a local config ID. Actual preflight in `/tmp/btc-presigned-image.anZEQy`
  failed because Podman is absent; no container execution or host policy change.
  `presigned:assemble-acceptance` rereads full local/image artifacts and runs a
  fresh read-only live Signet verification before producing software evidence.
  It cannot yet produce a genuine complete receipt here.
- The fresh optimized mainnet-format browser and outer wrapper both passed in
  `/tmp/btc-presigned-browser.sJYGUU/presigned-browser-acceptance.json`, source
  `a25f001d5b1767f8692caf3c3e09030b2c6a0e809c9fe27dbb29ad34f206235e`.
  Three identities, six virtual PRF passkeys, twelve counterparty signatures
  and all portable/passkey restorations preceded an actual funding refusal.
  Without separate authorization the server created no wallet-signing intent,
  accepted no wallet signature, exported no wallet PSBT and made no send RPC.
  The build used isolated Core facts; it is neither actual mainnet spending nor
  real Signet or container execution. The web listener, test PostgreSQL pidfile
  and Core pidfile were checked after clean completion and were stopped.
  The initial local aggregate `/tmp/btc-presigned-acceptance.9q1cnd` was
  intentionally stopped at21/47 after a separate read-only probe found the
  operator import defect below. It is incomplete, not a passed aggregate.
- The new read-only lifecycle verifier passed in
  `/tmp/btc-presigned-core-QrEisK/resumable-lifecycle-runner.json`, source
  `a25f001d5b1767f8692caf3c3e09030b2c6a0e809c9fe27dbb29ad34f206235e`,
  private state `/tmp/btc-presigned-live-runner.ts7EMG`. All19 lifecycles and
  five fee replacements confirmed; it reread57 complete encrypted kits,
  validated80 hostile rejection records and independently rechecked active
  confirmations and exact payouts/refunds/sponsor changes. Wrong source,
  missing backup and actual block invalidation were rejected; reconsidering
  the block restored successful verification. Verification created no journal
  events and made no send requests. All19 pre-wallet backup gates and three
  lost replies without duplicate send passed; Core stopped. This remains
  isolated regtest, not default-Signet proof.
- A real `presigned:release-status` invocation with valid IDs failed before
  any prerequisite result because its dynamic server imports lacked the
  `react-server` runtime condition. The earlier missing-argument probe did not
  reach those imports. The supported npm command now supplies that condition;
  new clean-environment probes reach the missing-image and missing-TLS-database
  prerequisites without external access or any report. Updated boundary tests
  pass43 rejection cases. Exact-image validation now requires those later
  import probes as well as the three original argument guards.
- Fresh optimized mainnet-format browser and clean wrapper evidence after the
  operator fix is `/tmp/btc-presigned-browser.m2OsxO/presigned-browser-acceptance.json`,
  source `de696f2377451352d19393c28271c937d86caf79fb79fa4c7a9de56e0b23ebbc`.
  It passes the same complete custody/pre-funding refusal scope, not mainnet
  spending or image execution. Test web/PostgreSQL/Core were checked stopped.
  The local aggregate `/tmp/btc-presigned-acceptance.s051TD` passed36 fixed unit
  steps and the Core graph/spend suites, then failed at the solo-fee test's
  stale unconfirmed-funding expectation. It is not a passed aggregate.
- [PRESIGNED-OPERATOR-RUNBOOK.md](./PRESIGNED-OPERATOR-RUNBOOK.md) now documents
  V2 evidence, runtime configuration, participant funding/custody, exact database
  restoration, separate mainnet release, fee rescue and coordinator-free recovery.
  Preserved V1 status/deployment/passkey documents have explicit version notices.
- The solo-fee test incorrectly expected a V3 first exit to be rejected while
  V3 funding was unconfirmed. The old mixed-version rejection no longer applied
  after funding itself became V3. Core correctly permits one V3 child and
  rejects a third unconfirmed generation; the app's fee workflow separately
  requires confirmed round inputs. The corrected test explicitly verifies all
  three boundaries without changing production code. Full fee acceptance then
  passed in `/tmp/btc-presigned-core-nOPWnG/fee-acceptance.json`, including an
  actual eviction-driven floor rise from0.1 to2.102 sat/vB, unchanged payouts,
  fee rescue and confirmed replacement. Core stopped cleanly. This matches
  [BIP431](https://bips.dev/431/) and the
  [Core31.1 TRUC regression tests](https://github.com/bitcoin/bitcoin/blob/v31.1/test/functional/mempool_truc.py).
  The fresh full47-step run passed in `/tmp/btc-presigned-acceptance.LUbdiB`,
  source `49eacf7307d06c9a9d55b7f57edadb9c3dc0ca397cc15f42d100b39b1b049835`.
  The matching mainnet-format browser and outer wrapper passed in
  `/tmp/btc-presigned-browser.pcRYga/presigned-browser-acceptance.json`.
  Retained-evidence validation checked that exact source, six virtual PRF
  credentials and actual refusal before funding; no mainnet spending, physical
  device, full-game or image-execution claim. The exact web listener and private
  PostgreSQL/Core pidfiles were independently checked stopped. The full47-step
  aggregate and its copied evidence were then independently revalidated; see
  the current checkpoint above for the exact scope and remaining blockers.
