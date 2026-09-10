# Presigned V2 independent review checkpoint

Date: 2026-09-07 UTC. This is internal code review and executable regression
evidence, not an external security audit, production release or funding approval.

## Persistent custody and host recovery review (2026-09-10 UTC)

The reboot loss of the original temporary Signet journal exposed a recoverability
failure, despite its passing historical 49-command suite and independent native
wallet backup. The backup recovered native wallet outputs, not missing participant
keys or the original run journal. The old funded graph remains bound to its old
source; this implementation creates a new persistent execution version.

Independent read-only reviews covered native proof binding, journal/anchor
restoration, stable single-writer locks, exact-host recovery and the unfunded
diagnostic. Findings reproduced or corrected include:

- Synthetic native signatures now commit the backup bytes, binary, exact source/
  run context, all targets, timestamp and fresh challenge. Editable receipt fields
  alone cannot rebind old signatures. All 83 native keys were restored and signed
  in actual offline Core; 15 binding/shutdown mutations refused.
- Ordinary journal operation refuses an unacknowledged head or missing anchor.
  Explicit recovery verifies all latest bytes before finishing an interrupted
  acknowledgement, never discarding a surviving newer/conflicting watermark.
  Missing/corrupt primary identity can be retained and restored; a valid foreign
  identity refuses. The 19-checkpoint/14-restore test passed 42 refusal cases.
- Primary cutover preflights same-filesystem placement before moving originals,
  then uses atomic no-overwrite/no-copy renames and flushes both parents. The
  actual cross-device negative leaves the original path intact. Immutable file
  publication no longer creates a crash window with two-link final objects.
- Copying public chain data holds Core's actual POSIX directory lock, not merely
  a process-name check or unrelated BSD lock. Source write permissions and the
  copied tree are checked. Actual live Core exclusion, competing lock attempts,
  clean release and killed-lock-owner refusal passed.
- Every whole-host restore has a new monotonic independently retained attempt.
  A new native proof commits that attempt. Normal start/funding, orphan newer
  completions and rolled-back primaries fail closed; explicit resume may complete
  identical interrupted replicas. Cleanup tracks newly launched hosts before
  post-spawn checks, without adopting unrelated pre-existing processes.
- The unfunded diagnostic requires specific expected gate failures (not arbitrary
  nonzero exits), uses locks around negative metadata injection, and retains only
  its own injected bytes. The actual unfunded default-Signet drill passed on
  source `b8c4cf28`: two same-wallet restarts, two whole-host restorations, ten
  specific refusals, two fresh attempt-bound signatures, unchanged address and
  zero wallet transactions/test sats. The test host stopped cleanly afterward.

The current-source isolated custody smoke passed two whole-primary restorations, two
initialization interruptions, all 83 wallet targets and reconciliation of lost
funding/replacement replies without duplicate sends. Final independent static
delta review found no additional actionable blocker within that bounded scope.
Fresh full 52-command,
both-image and funded default-Signet evidence remains pending for this source.
These are scoped internal reviews, not an independent external security audit.

## Low-capital follow-up review (2026-09-08 UTC)

Two independent source reviews and an independently implemented Core regression
runner cover the new sequential test-capital transport. The pure reviewer found
high-S ECDSA acceptance, unknown nested journal fields, and permissive hex
decoding. The implementation now shares the strict native-wallet verifier,
rejects unknown fields and noncanonical/bounded hex, and rejects journals beyond
the private reader's size bound before signing. Wallet Taproot signatures support
DEFAULT and ALL; participant payout signatures remain DEFAULT. Actual temporary
private-key buffers are cleared. Root reproduced passing pure tests under both
network configurations: ten valid transactions, eight accepted wallet-PSBT
normalization forms and 96 rejected mutations each.

The caller review found no high-impact custody or capital-confinement blocker,
but identified a fail-late historical funding-intent check. That exact check now
runs before a completed predecessor can authorize further recycling. Missing and
mismatched intent regressions are included in the new Core runner, alongside the
original backup, hostile-witness, lost-response and reorganization checks.

The first actual low-capital Core run refused initial allocation signing before
broadcast: Core 31.1 strips redundant `nonWitnessUtxo` from native-input PSBTs.
A separate isolated Core diagnostic confirmed unchanged unsigned bytes and exact
witness values/scripts, with only that redundant field removed. A second run
completed the first case and both historical-intent refusals, then exposed Core's
witness stripping in returned full-parent metadata. The diagnostic found all ten
mixed inputs retained exact values/scripts, parent txids and non-witness bytes.
The caller now requires exact witness prevouts and exact parent identity/
non-witness bytes when redundant parents are returned; the immutable intent
still independently validates every original full parent, input, output, fee
and final signature. No coin-selection fallback was introduced.

The next full local invocation on interim source `f889b15f` passed 44 of 49
commands and eight of 19 lifecycle cases, including the formerly failing mixed
wallet boundary. It was deliberately stopped on its exact network-disabled
regtest Core after measured 35-45 second advance intervals showed a test-deadline
risk; this was not a reproduced 60-minute timeout or a completed acceptance run.
All private evidence was retained, and the real Signet host was untouched. Both
actual image archives for that interim source were downloaded, hash-checked,
independently scanned and restored successfully, but remain draft/historical.

The revised isolated mining schedule checks the same saved recovery transaction
at depth 11 (rejected) and 12 (allowed) for all nine cases before the normal
runner continues. The exact 12-block rule and all existing case, fee, restart and
capital assertions remain; only redundant intermediate advances are removed.
A bounded 90-minute test deadline and 150-minute whole-CI deadline account for
the remaining sequential verification work. The evidence parser rejects missing
or altered CSV boundary counts; its 73 refusal checks and 19 archive negatives
pass. This test-source change requires fresh complete source-bound evidence.
Complete current-source Core/49-command/image/live-Signet results remain pending;
the dated checkpoints below retain their original historical scope.

## Original review checkpoint

Three independent reviewers examined custody/signature release, chain/send/fee
authority, and release/restore/evidence boundaries. They independently matched
the original source digest
`49eacf7307d06c9a9d55b7f57edadb9c3dc0ca397cc15f42d100b39b1b049835`.
That source passed the fixed 47-command local suite, but review identified
additional cases that the suite did not yet cover. Its source and actual evidence
are preserved privately in `live-run/presigned-v2-evidence.kg32fM/`; they must not
be relabeled as evidence for the corrections below.

## Findings and verification

| Finding | Correction | Root verification |
| --- | --- | --- |
| P2: accepted entries permanently occupy both oldest-100 retry queues | Order eligible records by `updated_at, id`; preserve exact authority, explicit send intent and attempt-result CAS | Before-fix chain/fee regressions failed; corrected two-batch tests reach the newer interrupted transaction/package without resending |
| P2: state-hash CAS permits stale same-state and advance/reorg/return (ABA) publications after lease loss | Migration021 adds a monotonic poll revision; compare it with the state digest under the vault lock, and advance it on successful and deferred publications | Actual Core/PostgreSQL reproduced availability overwrite, confirmation/invalidation ABA and erased deferred status; all three corrected schedules pass |
| Report CLI omitted the deployed offline utility check enforced by the actual funding gate | CLI, readiness and funding share the same utility/source/image inspection | Actual CLI rejects altered utility bytes before database access; a matching counterfactual fixture reaches only the missing-database prerequisite; zero network attempts and no report |
| Core evidence reader accepted an explicit failure followed by a passing summary | Reject explicit `passed: false` or `status: failed` anywhere in Core and full offline evidence | Root reproduced the Core parser issue in memory; new mixed-result/order negatives pass |
| Owned mutable envelope plaintext and PRF copies were not always cleared | Await crypto operations, then clear owned buffers in `finally`, including exceptional paths | Real WebCrypto buffer-reference checks pass on success, import/encryption error, round-trip mismatch, UTF-8 failure and new-secret failure; caller PRF remains unchanged |

The corrected source digest is
`80460afa6fb7f6ab1568f779efceb8abc4c247622f07fb08ef67c688e1e83267`.
All three reviewers independently matched it and rereviewed their bounded fixes
without new findings. Their rereviews were read-only; they did not run the root
agent's tests or approve a release.

Root test evidence for the corrections:

- Pre-fix chain/broadcast: `/tmp/btc-presigned-db.wXsGSk`, Core `hCnbcz`.
  Pre-fix fee queue: `/tmp/btc-presigned-db.XUn7CH`, Core `RsJasY`.
  These failed at the intended new regressions, not the earlier passing cases.
- Corrected chain/broadcast: `/tmp/btc-presigned-db.YblUsL`, Core `GHIG6Y`:
  12 passed groups and no findings. Corrected fee suite:
  `/tmp/btc-presigned-db.0SvheC`, Core `66xXqc`: all five fee families and fairness
  passed. Both Core nodes and both PostgreSQL instances were checked stopped.
- The queue-head records are deliberately invalid synthetic public metadata,
  not 100 genuine accepted Bitcoin transactions. The later target is a genuine
  Core-accepted transaction/package. The watcher race uses an explicit pause
  before persistence to model a lost session lease; the ABA test really mines
  and invalidates a Core block. Neither test claims a production outage.
- Scripts/web type checks, 49 evidence-negative boundaries and 22 mainnet-format
  custody cases passed. A fresh optimized mainnet-format browser passed in
  `/tmp/btc-presigned-browser.knCexA`: six virtual PRF credentials, complete
  pre-funding custody and actual unauthorized-funding refusal. Its test Core,
  PostgreSQL and web listener were checked stopped.

The corrected-source complete 47-command aggregate passed in
`/tmp/btc-presigned-acceptance.2snY8Z` from 07:05:42 to 08:05:09 UTC. Its parent
runner exited zero; root revalidated the fixed plan, retained transcripts,
required artifacts and exact utility, then verified service cleanup. The copied
run in `live-run/presigned-v2-evidence.Z5bbaY/local/` also revalidated with digest
`c57f61311e9e4cb3d105461f689d6b90dec089e1f7c17095e431edd7e5cd90a2`.
This includes both network-format custody matrices and the enhanced DB regressions,
not merely the targeted checks above. See
[PRESIGNED-V2-PLAN.md](./PRESIGNED-V2-PLAN.md) for current whole-product status.

## Public CI and export-permission follow-up

The user authorized public source/test publication on 2026-09-07, with zero-cost
testing. An independent outgoing-file review found no blocking operational
credential exposure; root additionally checked all382 current publication
candidates and excluded runtime evidence, wallets and dotenv files. This was
not a Git-history or ignored-file audit.

Independent CI review found no additional blocker after root fully qualified
the unchanged-digest Docker base image. Actual first-run image exports then
failed the existing private-owned-root check. The producer-only correction uses
a no-follow owned-directory descriptor to tighten that export to0700 inside its
already-private parent; the verifier was not relaxed. Root's16 OCI negatives
exercise unsafe parent permissions, symlink non-mutation and non-directory
refusal, followed by successful hash verification. Foreign-UID refusal was
code-reviewed, not exercised with a foreign-owned test directory. A focused
independent rereview found no blocking issue; that rereview was read-only.

New-source `09609ca8`, commit `2177e130`, subsequently passed the full47 local
suite and both real rootless production-image/browser profiles in public
run34146377273. Full per-job scope and receipt digests are in the evidence plan.

## Local-only evidence archive follow-up

An independent source-only custody review derived the exact minimal local/image
file sets from the retained-evidence validators. Selected successful database
logs contain test labels/results, and runtime wallets, cookies, browser profiles,
downloads and recovery kits are outside the required sets. Required rootless
engine and image-inspection transcripts still contain host/configuration
metadata: evidence-integrity validation is not a privacy scan or permission to
publish. OCI layers are exported before browser test custody is created.

A second independent reviewer inspected the local-only packager, CLI, transport
tests and acceptance-suite import and found no actionable defect. That reviewer
ran the synthetic archive test:17 negative boundaries and actual exact-byte
restoration, not a complete local or OCI dossier. Root additionally exercised
standalone offline-utility retention/digest refusal and input-root symlink
refusal (19 negatives total), fixed the test assertion's TypeScript overload,
and matched the CI call against its actual producer: image jobs retain the
utility inside verified OCI layers and do not assume a host-built utility.
The new CI call packs/restores full real dossiers only on disposable runners;
it uploads no archive. Run34150142799 on source536935c2 subsequently passed
the full47 local suite and both real image profiles, including actual
creation/restoration/revalidation of all three complete evidence archives.
Root independently checked public receipt/command/source commitments and
archive-result bindings. The19-case synthetic suite and real dossier runs are
separate evidence, neither a privacy scan nor archive publication. At that
checkpoint only public logs/receipts remained outside the discarded runners.
The separately approved image retention below supersedes that storage gap;
final release assembly remains open.

A separate same-source private full 47-command run passed at 19:45 UTC, after
which the guarded collector retained 102 local files and a 1,315,278-byte archive.
Its independent source-only review found no blocking issue; it distinguished
parent absence from successful exit and flagged incomplete-copy and filesystem
flush limits. Root separately checked the original terminal exit, corrected two
optional `process.getuid` TypeScript calls in the private collector, and verified
its strict typecheck and active-parent refusal before collection. The collector
then restored and revalidated the actual archive. Root reread all required bytes,
compared copies with originals and flushed the exact retained files/directories.
A subsequent independent read-only check accepted all 47 command records, the
102-file/member allowlist, actual archive/utility hashes and private permissions,
with no finding. This proves retained local evidence, not image retention,
content-privacy approval, off-host backup, release readiness or real Signet.

## Approved public test-image retention follow-up

The user separately authorized a clearly test-only prerelease in the existing
public repository. A separate tooling branch preserved candidate d5ff8e8/source
536935c2, its earlier complete local 47 proof and the original rollback baseline.
Run 34178522361 on tooling ee97b86 passed both genuine rootless image profiles,
actual packaging/restoration, full archive-content review and draft-only upload.
The six exact assets were published at 02:19 UTC on 2026-09-08. Exact identities
and the public release link are in the evidence plan.

The first two retention attempts passed image execution and packaging but
correctly blocked upload on a credential-pattern match. The source-only scan
identified a header-only Next documentation fixture, but did not identify the
actual runner failure. Inspection of the exact pinned public base reproduced
the failing path hash in GnuTLS. Root and an independent reviewer each matched
six complete known-answer self-test constants byte-for-byte to the exact Debian
source. The eventual exception is limited by immutable base-layer/library
hashes, exact path/offsets and matched-prefix hashes, with whole-layer digest
verification at EOF. No blanket dependency exemption or transcript redaction
was introduced; no matched key values were included in diagnostics.

The final scanner's 24 regression tests pass. An independent actual-base check
and 13 tamper negatives also pass, including changed offsets, paths, library and
layer bytes, copied application keys and the other credential rules. Canonical
single-gzip/USTAR envelope guards cover headers, padding and trailers. All 18
historical image layers and all 39 required outer members are inspected. Empty
Next action manifests and exact test-preview manifests are separately bounded;
their unused generated test-build keys become permanently public. This remains
a bounded review, not proof that arbitrary secrets cannot evade detection.

Before collection, independent review caught inherited archive-tool environment
options and an incomplete final asset-state check. The private collector now
uses minimal extraction/scanning environments, isolated Python, hashes all six
downloaded assets, and compares the exact asset ID/name/size/digest snapshot
before writing its retained receipt. Root reproduced failure under an unwanted
ambient tar option, then successfully read the actual earlier 102-member archive
with the isolated environment. The complete image collector subsequently passed
with those unwanted ambient options present, without inheriting them into tar.

Root restored and semantically revalidated both actual downloaded archives and
matched both local content-review reports to CI. An independent read-only check
repeated both trusted semantic validators, exact archive/member byte comparison,
the six recorded asset hashes and private ownership/permissions, with no finding.
The publisher's independent review also caught tag checking after publication;
the corrected preflight verifies the existing tag or a genuine HTTP 404 before the
exact-release-ID mutation. Pre/post asset snapshots and a post-publication tag
check passed, followed by an unauthenticated public read of all six assets.
Concurrent changes by another authorized repository maintainer are not atomically
locked by these API checks. No failed publication is automatically retried.

Original execution receipts and OCI bytes are unchanged. Both public images
are permanently synthetic-test-only: never supply real funds, participant
custody or operational credentials. This is not a production image release,
real default-Signet acceptance, physical-device evidence or funding authority.

## Limits retained

No new payment-authorization or coordinator-data signature-release bypass was
found in the reviewed boundaries. This is a scoped finding, not proof that all
bugs are absent. State publication and retry scheduling never substitute for
participant signatures, exact payouts, current source observations or separate
mainnet authorization.

Buffer clearing is best-effort: JavaScript strings, CryptoKey objects and
browser internals are not claimed erased. Malicious delivered browser code,
compromised unlocked devices, the explicitly inherited N-1 recovery collusion
tradeoff, outside sponsor liquidity and relay liveness remain limitations.
Restoring a database still requires stopping every old writer.

Real default-Signet lifecycles and final acceptance assembly remain unproven.
Actual OCI execution and complete retained test-image/child-log evidence now pass.
Physical passkeys are explicitly deferred to friends' onboarding. Public source
and tests were separately authorized; no review or test authorizes mainnet
spending, public app exposure/deployment or outreach.
