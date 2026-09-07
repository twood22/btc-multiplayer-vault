# Presigned V2 independent review checkpoint

Date: 2026-09-07 UTC. This is internal code review and executable regression
evidence, not an external security audit, production release or funding approval.

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
separate evidence, neither a privacy scan nor archive publication. Only public
logs/receipts remain retained outside the discarded runners; final durable
image archive retention and release assembly remain open.

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

Real default-Signet lifecycles, complete retained OCI/child-log evidence and final
acceptance assembly remain unproven. Actual OCI execution has now passed in CI.
Physical passkeys are explicitly deferred to friends' onboarding. Public source
and tests were separately authorized; no review or test authorizes mainnet
spending, public app exposure/deployment or outreach.
