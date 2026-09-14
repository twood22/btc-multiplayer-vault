# Current project status

## 2026-09-14 — V3 integrated; full release acceptance still in progress

The replacement fixed-refund protocol, 21-signature ceremony, portable/passkey
restoration, runtime, fee rescue, protocol-bound database state and browser/offline
owner-only external-wallet withdrawal are implemented. Independent AI reviews
have not identified an unresolved money-authorization finding in those reviewed
paths. This is not a professional audit or a completed V3 release.

Actual isolated Core tests passed all six normal orderings, nine recovery
quorums and fresh-signature collusion negatives. Complete V3 database ceremony,
runtime, chain/reorg, fees, native restore and owner-withdrawal tests passed.
The complete saved-file offline suite passed all 19 lifecycles, 71 restorations,
31 confirmed browser-signed transactions and owner cash-outs. The final-source
previous candidate's hosted web workflow and both exact-image profiles passed. The full
combined suite and actual default-Signet matrix remain unfinished. Deployment and
rollback tooling passes 224 refusal controls, but actual exact-image execution
is still required. Several full lifecycle runs were interrupted by unexplained
SIGTERM signals; supervised local reruns preserve those failures separately.
No new public deployment or mainnet transaction has been performed.

The first frozen V3 public candidate (`19d82053`, source `2e47819d`) failed its
hosted acceptance run. The clean-checkout parser dependency and cash-out browser
selector were corrected. The earlier local browser's first-solo review failure
remains unexplained; its failed evidence is preserved. Corrected candidate
`cf528269` / source `21af8d9d` passed both image jobs in `34804929173`, but its
combined local job failed its final evidence check after 74/75 commands passed.
All seven V3 database children exited successfully; the native restoration
test's final stdout omitted its actual protocol identifier, so the unchanged
strict evidence validator correctly refused it. The minimal reporting correction
and 14 missing/wrong-protocol regressions passed, with independent AI review,
both typechecks and actual native V2/V3 restores (six keys, 22 refusals each).
Corrected source `61d3b2c5` requires fresh complete acceptance and image evidence.
Exact-image retention `34805003735` passed
both profiles; all six original test-evidence assets were downloaded and checked
against their retained hashes. Independent local mainnet-format archive
restoration, privacy review and actual candidate OCI validation passed for both
network profiles, including a separate root-agent rerun. These image tests use
isolated Core, not the public default-Signet network, and do not authorize funds.
Exact, recoverable duplicate public-cache reclamation
completed: 290 files/20.94 GiB removed with all keeper and protected-file checks
passing; custody, unique data and restoration instructions are retained.

The retained local run reached 65/75 commands before being deliberately stopped
after the hosted run proved the deterministic final evidence defect. Its partial
evidence and source-exact snapshot are preserved, not accepted. The correction
changes source identity; the complete local and image checks must run on that
new identity, without reusing the old images as final-source proof. Both final network-specific receipts
and their category dossiers must still be assembled after completed local and
public-Signet evidence; a receipt for one image cannot authorize the other.

Use [the single V3 checklist](./V3-ACCEPTANCE-CHECKLIST.md),
[participant guide](./V3-USER-GUIDE.md) and [release runbook](./V3-RELEASE-RUNBOOK.md)
for current work. Dated V2 results below remain historical, not reusable V3 proof.

## 2026-09-13 — Fixed-refund recovery design, not yet implemented

After rejecting the unrestricted recovery quorum's collusion risk, the user
requested a replacement design. [The V3 design](PRESIGNED-V3-FIXED-RECOVERY-DESIGN.md)
requires all current members to preauthorize exact equal refunds before funding,
plus separate N-1 trigger signatures after the per-coin delay. The old recovery
leaf must be replaced, not retained as an alternative. Recovery still permits
forced equal settlement after maturity; the largest-last payout applies to the
completed normal solo sequence, not to recovery.

A candidate-leaf experiment on network-disabled Core31.1 accepted all five
generic quorum choices, rejected 20 freshly re-signed collusion mutations, and
confirmed one fixed refund for each group size. It is not full V3 tree, graph,
browser, backup, fee-rescue, independent-review or release acceptance. The current
implementation remains V2 with its unrestricted delayed recovery. Only design
and status documentation changed in this task; no funds, runtime source or
deployment changed. The design records implementation and release gates.

## 2026-09-13 — New last-survivor payout schedule

User-authorized implementation: new V2 invitations commit `last-survivor-net-v1`.
Reserve both solo base fees plus the final sweep, then allocate 19:20:21 with
rounding to last. The 10,000-sat fixture pays 9,120 / 9,600 / 10,080 sats after
those fees. Existing schedules remain byte/digest compatible. Recovery is
unchanged: mature two-of-three, then one-of-two, can spend the whole current coin
to arbitrary destinations; app-proposed equal refunds are not script-enforced.
Targeted new-source verification is recorded below. The earlier full
Signet/image/independent acceptance does not cover this economic change. No
deployment, mainnet funding, public exposure or migration has been performed.

Verification for source `971fe733af3e66141e8a3073a766b65f1e11127a1f027d4ec8ccf4bf4bd4235e`:

- `src/presigned/economics-acceptance.ts`: 720 exact integer/rounding cases,
  144 signed exits, 96 signed sweeps and six restored kits across both network
  formats and all eight native-wallet combinations pass. The original fixture's
  golden graph digest is unchanged. The frozen original validator separately
  rejected the new economics marker, rather than silently reinterpreting it.
- `scripts/presigned-core-economics.mts`: all six new orderings and final sweeps
  confirmed on isolated Core31.1 regtest, paying 9,120 / 9,600 / 10,080 sats;
  twelve payout mutations rejected. Two additional cases establish that mature
  recovery quorums can choose an unrelated destination while the app refuses it.
- All four TypeScript configurations passed. The legacy roster suite passed
  all 24 checks; original-schedule graph, spend and fee cryptographic suites
  also passed. The full 42-command pure matrix was deliberately stopped after
  seven completed commands to separate CPU-heavy browser work; it is NOT a pass.
- The complete saved-file offline browser suite passed serially: all 19 new
  schedule lifecycles, 31 browser-signed transactions confirmed by Core, 70 kit
  restores, and ten original-schedule fee-rescue compatibility cases. Zero
  network requests and browser script errors. Utility SHA-256:
  `ed33a8114afd7680740bea70c569cfc9cf088c835c7e27b4971eb12542ef8ccb`.
- The fresh optimized web-app run passed on the same source digest: three
  independent browser participants, six virtual PRF passkeys, new-payout display
  and approval, backup/funding flow, cooperative and recovery signatures, both
  solo exits and the final sweep, all five fee-parent families, and session-loss
  reauthentication. Actual chain: isolated regtest, not public Signet/mainnet.

Earlier attempts remain qualified: a typecheck raced generated build files;
one Core test expected the wrong refusal wording (corrected, then passed);
two concurrent offline runs failed browser status checks at different stages.
Focused unchanged-code recovery/cooperation probes and the subsequent full
serial offline run passed, but do not establish the original failures' cause.
The first optimized browser run reached Core-accepted cooperative and recovery
signatures, then timed out waiting for a recovery fee-package download. It is
not counted as a successful complete browser run; the subsequent full serial
web run passed. No production timing or security checks were weakened to obtain
a passing result. Passing retries do not establish the earlier failures' cause.

## Previous frozen source — completed September 12 acceptance

Version boundary: `presigned-graph-v2` agent-executable software acceptance is
complete as of 2026-09-12 18:44 UTC, with the explicit qualifications below. Older checkpoints
and V1 status are preserved as dated history, not the current V2 verdict. See
[PRESIGNED-V2-PLAN.md](./PRESIGNED-V2-PLAN.md) for evidence and
[PRESIGNED-OPERATOR-RUNBOOK.md](./PRESIGNED-OPERATOR-RUNBOOK.md) for operation.
Physical passkey checks remain deferred. No mainnet spending, deployment or
migration of an existing funded vault is authorized.
Completed agent-executable software acceptance, 2026-09-12 18:44 UTC: BOTH actual
sequential final assemblies passed, first the Signet image profile and then the
mainnet IMAGE profile; both used actual default-Signet only. All 19 lifecycles,
five replacement fee families, 84 unique confirmed transactions and 20 capital
allocations are verified. Each assembler freshly decrypted/derived all 57
retained participant kits. The original native invocation completed and exited
successfully; the exact final return was confirmed and unspent on both nodes at
the retained observations. Root reviewed every retained final file and all
receipt/dossier bindings. Independent R01-R24 closing review and root verification
are complete: four requirements present, twenty qualified, zero pending, and no
actionable implementation finding. Physical-device checks alone remain deferred.
This is software acceptance with the explicit protocol and evidence limits below,
not production funding or deployment approval. Earlier pending observations below
are dated history, not the current state.

Case16 recovery confirmed at block321756 on BOTH nodes, exactly12 blocks after
Bob's exit at321744. The unchanged observer saw the exact Alice-only/Carol-empty
transaction rejected as non-BIP68-final at source depth11 (09:25:52), then in both
mempools at depth12 (09:29:17), and confirmed at09:34:49. It spends20,200 sats
into9,850 each for Alice and Carol plus500fee/190vB. There is no separately
captured root mature-positive testmempoolaccept result. Root1d1962 retains the
full confirmed proof, SHA5600ff3f60720d5928f3ca0fb98a4188264a52bf6f4fcfe9ec436b95ea12cbd6.

Case16's combined cryptographic review remains CLOSED (four rounds, nine exit
templates, twelve preauthorizations, nine absent designated-leaver signatures,
fourteen actual signatures,109 product plus1 independent refusals and163
primitive negative controls). Its NEW completed-DAG/report review is also
CLOSED: reviewer outera33180 and literal root replay9f2102 both exited0, with
identical complete4,870,344-byte stdout and empty stderr. Root5ad96e checked
all25 artifacts,746 source files,40 entrypoint records,982 dependencies, Node,
twelve public inputs and full recorded numeric/nanosecond metadata. All15
independent DAG/report controls and their positive baselines passed. Both saved
missing-signature recipes remove Alice: Bob witness slot0, recovery slot1.
Saved reports still do not bind hostile witness bytes or prove fresh Core tests.

The independent seven-leaf candidate equals root's complete capital inventory,
including every full parent transaction. Conservation is43,925 =42,343 leaves
+1,582 fees. Both-node af0d6e at10:03:32 confirms case17 allocation in321757:
all seven exact case16 outputs are consumed in chain and mempool-inclusive views.
42,343 =36,000 new-game targets +6,174 new reserve +169 fee;560vB/max561, no new
sponsors. Incoming7,743 and outgoing6,174 reserves are distinct. The complete
confirmed proof is a1133a7274db9e091c8af33a61ecb14f1a554adbba30c74cdf97af011f3ac4a7.

Case17's combined saved-public crypto review is now CLOSED. Reviewer894aa0 and
literal root replay5e060c both exited0, including actual child exits0. Their full
2,756,481-byte stdout buffers are byte-equal, SHA853de6d4502b32624a10ce7e403a32a60737ac87e0df43c047a06ee3a2f54358,
with empty stderr. Rootf37b0e bound actual launch/status bytes and all37 retained
reviewer-prefix members; root7ae914 rechecked746 source files,40 entrypoints,
982 dependencies, Node and all12 public records/74,003 bytes with complete
numeric/nanosecond metadata. Four rounds, nine exits, twelve preauthorizations,
nine absent designated-leaver finals and fourteen actual signatures passed,
plus109 product/1 independent refusals and163 primitive negative controls.
Carol witness slots are Carol0/Bob1/Alice2. Recovery is Bob64-byte slot0 and
Alice-empty slot1, CSV12,20,200 ->9,850 each for Alice/Bob +500 fee/190vB.

Case17's exact full-witness Bob-only recovery confirmed on BOTH nodes in
block321771, exactly12 blocks after Carol at321759. Root9ca9ce at12:26:16
observed allocation/funding/Carol/recovery at321757/321758/321759/321771.
The unchanged observer previously saw non-BIP68-final at source11, then exact
mempool presence at source12 (94ceb5 at12:19:50). No separate root mature-positive
testmempoolaccept result is claimed. Root8cc256 retained the full confirmed
proof and actual command/result: case17-recovery1226-two-node.json,29,581 bytes,
SHAf9ac6ef709b073c7ba4dca9223627e93fe603555b578202e063da5d1ea8d6d95.
The earlier depth11 proof remains a dated observation, not the current state.

Case17's independent completed-DAG/report audit is now CLOSED. The terminal
negative report was first read after native submission:466 bytes,
SHAcba978d230685b54a949fa4606ed704d9f192485ba2548115d8ac01c47b8ef4b.
Only the explicitly released initializer changed; seven other original artifacts
remained byte/metadata-equal. Reviewer0bafba and literal root replay1e62ce both
exited0 (actual child and outer), with identical complete4,870,281-byte stdout,
SHAbd99fed599e42a9616ffa342f98c1d6f5fc69d3ea5a56b678669e55549e2aa30,
and empty stderr. Root37595e verified all19 current prefix artifacts, preserving
the original15, and all12 public inputs/74,269 bytes. Root24b0f4 rehashed746 source
files,40 entrypoint records,982 dependency files,4 resolved dependencies and Node,
with all13 numeric/nanosecond fields, exact path sets and331 directory identities.
All15 independent DAG/report controls and fresh positive baselines passed.
Four nodes, five internal edges and seven leaves conserve42,343 =40,774 +1,569.
The candidate digest6d015e35a70d9f624400d4f3f14234de6f606e917e7901ddbf7c11f82999f1c6
matches root's independently computed case18 predecessor commitment.
These are independent saved-public checks, not fresh Core hostile tests or
new private restoration. Saved reports alone still do not bind hostile witnesses.
Rootbbf8be retained case17-root-dag-closure-v1.json,106,465 bytes,
SHAf5c11a4afe273d1933ed6959c4ca8d7d553c8799631425aca3ddb17ca87a4232.
The closed cryptographic suite was not rerun.

Case18 allocation confirmed on BOTH nodes at321772. Rootc68a73 at12:34:14
verified all seven exact case17 leaves consumed in chain and mempool views:
40,774 =36,000 funding targets +4,592 reserve +182 fee;604vB/max606, no new
sponsors. The complete proof case18-capital1234-two-node.json is39,990 bytes,
SHA013ce1643e717d69dbadc7a505526253392c6d25b25546bb207c7c07cba7c680;
root6ec766/0e439f retained original buffers and actual results. Rootde7d98
rehashed all107 public inputs/872,299 bytes, with stable current-read metadata.

Case18 funding confirmed on BOTH nodes at321774 in root19041b's13:08:05
interval. Exact full witnesses match; three12,000-sat allocation inputs fund the
30,000-sat vault plus three1,800-sat refunds and600 fee/354vB. The retained proof
case18-funding1308-two-node.json is24,994 bytes,
SHAa09a5dd1827dbebbf48cc9dea25f1b5c9c0cef4262feec63e3553fc8b6812d32.
The earlier root7e062c12:56:12 mempool proof is retained as a dated interval.

Carol's exact exit confirmed on BOTH nodes at321775. Root1f1054 at13:14:10
checked115 public files/921,721 bytes and60 RPC calls, zero wallet RPC.
It spends30,000 into9,500 for Carol plus20,200 Alice/Bob successor and300fee/230vB.
Case18 solo witness ordering is Alice0/Bob1/Carol2; the original Alice/Bob
preauthorizations are unchanged. The retained proof case18-carol1314-two-node.json
is28,930 bytes, SHAe45bd217dab048fbb3dce1244c39868abfeda83e32ee4f5d2866ad95437a31c4.
The saved first-nonempty missing-signature recipe removes Alice, not Carol.

Root first-read the exact terminal intent/signed pair at13:22:36 only after
native recovery waiting-csv. The recovery uses Alice's64-byte personal signature
in slot1, Bob-empty slot0, CSV12, and20,200 ->9,850 each +500fee/190vB.
Root2712a8 at13:36:14 observed BOTH nodes at tip321775, full allocation/funding/
Carol witnesses matching and the20,200-sat source unspent in both views.
Each node tested the exact saved recovery bytes and returned non-BIP68-final,
with matching txid4d05d4fead8bbd2771f162ab08395bfe989b9bf8aa6b8a0b5a6f9cb0de7920a1
and wtxidc8e0f1078c85af269f83bb56f4f8e6ae3c03ebd94ff10cdb4a5560c4f264b98b.
Carol's321775 anchor implies earliest recovery block321787;11 more tip blocks
were needed for next-block eligibility in that interval. Recovery was neither
known nor in either mempool. The117-file/926,262-byte proof,66 RPC/zero wallet RPC,
is case18-recovery1336-two-node.json,32,032 bytes,
SHA8ce37f86232b9246d0d686d509f3866e1b72803392e1bf2c38998f6f0b141934.
Source validators check three funding, three Carol and one recovery signature,
plus three historical receipt bindings; these are not independent primitive
verification or new private-restoration/release-chronology evidence.

A later independent repeat, rootd52c6f at14:16:15, found BOTH nodes at321777:
allocation/funding/Carol depths6/4/3, exact saved witnesses matching, and the
20,200-sat recovery source unspent in both chain and mempool-inclusive views.
Both nodes again rejected the exact recovery with non-BIP68-final and matching
txid/wtxid; it was neither known nor in either mempool. Nine further tip blocks
were then needed for next-block eligibility; earliest recovery remains321787.
The117-file/926,262-byte,66-RPC/zero-wallet-RPC proof is
case18-recovery1416-two-node.json,32,030 bytes,
SHAd122ed2aa212f347f08d3abde550f560296f05901caa9276cbe4200cbc326602,
retained381e48 with complete actual result. That is a dated premature interval.
Root03a5af at15:13:40 also saw exact non-BIP68-final rejection on BOTH nodes at
321781/Carol depth7; case18-recovery1513-two-node.json is32,032 bytes,
SHA2c47ccd16ff2235102cef8afce726cb168fda97c37dce02b4f831387e00c9d2b.

A dated independent interval, root3688bf at16:08:34, saw BOTH nodes at321787.
Carol has13 confirmations; the exact full-witness Alice-only recovery is mature
and in BOTH mempools, unbroadcast:false, but has zero confirmations. Carol:1 is
spent in mempool-inclusive views and remains unspent in chain-only views.
The117-file/926,262-byte proof uses64 read-only RPCs/zero wallet RPC and is
case18-recovery1608-two-node.json,31,492 bytes,
SHA8d13b8734a8245fb5b8276b44e11d602493fa18673546f1916ca652dc06b7097.
Root667598 retained the full original stdout;7cd3c7 retained command/actuals.
Root did not capture a one-block-early depth11 observation for case18: native
was last observed waiting atdepth10 before the mature mempool observation.
No separate root mature-positive testmempoolaccept result is claimed.

The exact case18 recovery is now confirmed on BOTH nodes at321791, with Carol's
source at321775:16 blocks elapsed, satisfying CSV12, not exactly12. Root0d1ff0
at16:50:04 matched full allocation/funding/Carol/recovery witnesses and active
anchors at a common stable tip321791,68 read-only RPCs and zero wallet RPC.
The117-public-file/926,262-byte proof is
case18-recovery1650-two-node-confirmed.json,31,765 bytes,
SHA0ca068ff6ab803451a467659b16fc44707569bbf3a1948fcaf9ce0ee6f907228.
Root53779a retained full stdout and24feda retained actual command/results.

Case18's combined saved-public cryptographic review is now CLOSED. Root reviewed
the original87,043-byte audit, its helpers and exact adaptations, then verified
the only two released initializer changes:92,009 bytes,
SHA03c2a72286c5f99002e8484f342d3a06aac752f3f6eee592b187498bf86e23d1.
The dated static preparation closure remains retained separately; it was not
misrepresented as signature acceptance.

Reviewer cfdf81/child489414 and literal root replay9dde8a/child491939 each exited0.
Their entire2,758,191-byte stdout buffers are byte-equal,
SHAa983cf4ce194061ac0d147a44302aac083eb22e858b974034e9a5bb08f296530,
with empty stderr and no timeout or limit failure. Rootdfcf16 compared complete
buffers and actual retained status bytes, not only hashes. Original33 artifacts
stayed unchanged; four root attempt files bring the prefix to37/15,950,696 bytes.
Fresh root a836ba preflight and6a7fc5 postflight checked both373-file source trees,
40 entrypoint records,982 dependencies in18 trees,3 resolved files, Node and
13 exact public inputs/99,760 bytes. Full13 numeric/nanosecond metadata, complete
path sets and directory identities remained consistent across the intervals.

Four rounds, nine exit templates, twelve preauthorizations, nine absent
designated-leaver final signatures and fourteen actual signatures passed.
All110 expected refusals passed:109 product guards and1 independent parent guard.
All163 negative-signature checks passed (15 setup/funding,44 stage-transaction,
100 wrong-role,4 changed-recovery-leaf), with positive baselines before and after.
No new signatures or alternative Bob recovery signature were generated.
Alice supplies recovery slot1, Bob is empty slot0; the saved Carol missing-signature
recipe removes Alice slot0, not designated Carol. Root's additional preauthorization
comparison required twelve unique exit/participant records and exact equality
after canonical sorting because the two raw result arrays use different orders.
The initial root ordering/projection diagnostic failures are retained, not product
failures and not changes to the audit or its result. Root05ec08 retained
case18-root-crypto-closure-v1.json,37,652 bytes,
SHAaf0171070c719607cec564374caac4cad150679abcef927ff847fa8ee1329c1b.

Case18 DAG/report PREPARATION was separately root-reviewed and replayed; that
dated preparation was not substantive DAG acceptance. Root read all64,133 audit bytes, wrapper/retainer/boundary source
and48 sequential adaptations, and reconstructed six creation-file buffers plus
the patch itself as the seventh initial artifact. Roota9519e at14:13:11 completed
all five static replays and five syntax checks with actual exits0. Complete
outputs match the sealed baseline except checkedAt; each full root stdout is
exactly reconstructible from that baseline and its recorded timestamp.
All13 preparation artifacts/7,478,005 bytes remained pinned. Root925929 retained
case18-root-dag-preparation-closure-v1.json,14,063 bytes,
SHAc5686ed3d8a322a968ed4923ffa434645e00b283347fecb9aef48ac7599dc0b6.
The11 known DAG public inputs total74,039 bytes; run is preparation-only context.
That closed preparation retained three literal-null gates. After the native
pending and independent mature-mempool observations, root613224 first-read the
actual terminal report at16:09:39:466 bytes,
SHA762050c67917cd6c29ab8b402b69ef79a6b0917c154b05701b1a135f8dbb3283.
Rootb1de8f retained its complete raw bytes, full13 numeric/nanosecond pin and
actual first-read command in case18-root-negative-terminal-first-read-v1.json,
7,241 bytes, SHA561bca503f7b794d84603eebd1bd9aff0d9bd85b804dec6de1e25670cd7c7f8f.
Root first authorized only the three exact initializer releases, verified their
complete forward/backout source equality, then separately released execution.
Reviewer2605bd/child505171 and rootc883ed/child508897 each exited0, child and outer,
with empty stderr and no timeout/limit failures. Root4393a3 compared all4,870,517
stdout bytes exactly, SHA653cdba7fe1475cdc80b60f1471b877dc2b90ca84e5e6479880069931164a9c8.
Fresh whole source/runtime guards186915 and942f58 match except checkedAt;
root6add5a and4393a3 rehashed56 prior files plus the four root attempt artifacts.
All15 independent hostile controls passed with fresh parses, changed-input pin
mismatches and positive baselines before/after the control set. They are not
new Core or signature tests. Four nodes, five internal edges and seven leaves
conserve40,774 =39,192 +1,582 fees. Candidate
1653fe72add0c4f00b6774ffe34584dbb06ea7579964a7d4e7ae3d5ca61db21a
matches the actual return's declared predecessor. Rootbbb345 retained
case18-root-dag-closure-v1.json,35,891 bytes,
SHAa0827db66c9bf8a2cf1ad952204c74606a4f2f3c59633bf26e9fa745d1269157.
Nine reviewer evidence-retainer initial-mode refusals were preserved; the exact
0664 files were whole-buffer checked before authorized0600/fsync correction.
No substantive audit was retried, and the closed crypto suite was not rerun.

Final-return observer PREPARATION was independently prepared and root-closed,
separately from its now-executed first bounded observation. Root read all35,542 helper bytes, the19,201-byte
template, all five whole-source adaptation blocks, three exact preparation
corrections and four frozen tsx loader files. Both input/execution initializers
were literal null at that dated preparation checkpoint. Reviewer syntaxe176d5 and root replay7a155c exited0;
root23e729/ad524b/8e40a6 whole guards match except checkedAt. All nine private
artifacts/248,971 bytes,12 known public inputs/99,560 bytes,11 complete
current/frozen source pairs, four inspected loader files and Node were unchanged.
This preparation did not rerun the complete373-file source/982-file runtime
inventories and did not evaluate product modules, loader or observer.

Root8a3348 retained case18-root-final-return-preparation-closure-v1.json,
27,160 bytes, SHA1d05357db60ee8381bf67aaa9fb1172a30bdac8f9da7e1c264d29f63c7ab0f85.
The actual return intent/signed records were first-read by root84f27a at16:50:01,
17,302 bytes/db927aa6d926127a82885025a9acd75453a2fa5e820449fb556842dd49b5a8c2
and1,863 bytes/e775908a9d1b3ee4059857192df336f8708f31889ddc84a936d65eba02d5be24.
Root3304f5 retained the full first-read record. After confirmed recovery and the
closed/replayed DAG, only the two exact helper initializer lines changed.
Root77b123 compared the whole released624,903-byte source forward and backward
against the preserved35,542-byte null source; released SHA
053fa195f81356683c5cbf233448bbc2bba2605ad02fc15a8ed04dda6f4d1072.
The gate inputs bind the actual DAG closure/result JSON pointers and full pins,
three exact new public files and an already prepared runtime manifest. Fresh
root6c1be1/6fa3f4 guards rehashed all982 frozen dependency files/32,121,488 bytes,
18 trees/95 directories and Node; full parsed guards match except checkedAt.
Plain Node strip-types evaluated built-in guards before deferred frozen tsx
registration. That loader/product path has now actually executed successfully.

Rootb7ae87 EXIT0 at17:11:45 passed the first bounded final-return observation.
Both nodes have tip321794, exact full parent/return witnesses, seven spent leaves
in mempool views and the sole unconfirmed return output. Source validation
accepted all seven native input signatures.39192 =39055 return +137 fee;
455vB/max456,300millisats/vB fee policy,338sat cap, zero other targets.
The exact txid is22315ee1cbb1f3f31763d6e749daa003f8cc6fc9e0a9280c6c4669989d299b43.
All15 public files/119,191 bytes and repeated exact UTXO/process/tip views passed,
106 read-only RPCs/zero wallet RPC. That dated return state was pending on BOTH nodes with
zero confirmations: observationChecksCompleted:true, finalReturnVerified:false.
Full proof case18-return1711-two-node-pending.json is26,059 bytes,
SHA1da74c62af5c3ecc94e36cf48bf9973e8b9cb04cbf10e321207d7c1b5ed2c4fa,
retainedaa46f7;69eac3 retained actual preflight/launch/exit/postflight evidence.
This is not a failure, confirmed-unspent return, native exit or whole-run pass.
No new signing/broadcast, wallet RPC, restoration or journal/lock writes occurred.

Native completion is now CLOSED: original invocation
13c96b7ff88041b8b56ae05b1e99f6e1 exited at 17:38:57 UTC with ExecMainCode1,
ExecMainStatus0, Resultsuccess, MainPID0 and NRestarts0. Actual observer2d452a
at17:39:23 reports complete:true and confirmed capital return. Its complete
retained window is case18-native1739-complete-actual-exit-window.json,
21,174 bytes/SHA99dfa0d62447917d39cf4546bbe7eba8acf0891ce485e0132216781671448a88.

The unchanged bounded final-return observer actually exited0 (d1c21f) at17:48:17.
Both nodes had stable tip321798 and the exact return anchored in321797 with two
confirmations, all seven source leaves consumed and the sole39,055-sat output
unspent in both chain and mempool-inclusive views. All seven source-validated
input signatures and exact saved parent/return txid/wtxid/witnesses matched.
The26,292-byte confirmed proof is case18-return1748-two-node-confirmed.json,
SHAe8ffcdd0a5ad3a740718b5f26a25f4e6dcc01974b34c3d9c8da31cf7183260d0;
its68,319-byte actual-result record retains preguarddd8737, actual launch/exit
and postguard5ace8e. Full source/runtime/input guards match except checkedAt.
This invocation used110 read-only RPCs and zero wallet RPCs; it did not sign,
broadcast, restore custody or write operation journals/locks.

Actual root63758c proved the original process absent and BOTH exact existing
lock inodes free by acquiring exclusive kernel FLOCKs through read-only FDs,
observing both held, then closing them and observing release. File contents and
full metadata stayed unchanged. No lock file was deleted or replaced. An earlier
inspection's overescaped proc-lock regex was not counted as free-lock proof.
The actual proof uses parsed device/inode tokens and is retained in
case18-root-native-no-writer-free-locks-v1.json,21,610 bytes,
SHAab5a193d3073230e1facb1ccab0418626a46dd37237134258d694cb02fa050eb.

The Signet-profile final assembler ran17:54:51.738-17:57:03.886 UTC, with actual
child0/null signal/no capture or spawn failure and outer5bfc47 EXIT0.
Root915c89 verified all15 retained files/41,464 bytes including nine original
dossiers byte-for-byte; roota93840 independently rebuilt all eight non-live
dossiers from the 52-command/both-image evidence, recomputed all nine category
commitments and both receipt commitments, and checked all40 public allocation
intent/signed records. Its closure is case18-root-signet-final-assembly-closure-v1.json,
52,026 bytes/SHA0d74a15b66f6cad8d9011565756584e8f41aeb556a09b1d9798d091cc5f0a9ae.
Software receipt c71a9c1a7e60b576305654e2b81e6b00a5e47b8e451dacd3bd42beac33d42201
binds live receipt54630763a0263af2a0c72aca390f4d1a873354835cc383addfb6a7d58de792e6.

Only after that closure/root review, the mainnet IMAGE-profile assembler ran
18:05:35.099-18:07:44.875 UTC on actual default-Signet. Its child also exited0
with null signal/no capture or spawn failure; outer4326b1 exited0.
Root2dc9d1 checked all15 retained files/41,469 bytes and nine original dossiers;
root42669a passed the same independent semantic, commitment and accounting checks.
Its closure is case18-root-mainnet-image-final-assembly-closure-v1.json,
53,125 bytes/SHA6e4f2c7b09e347afb1fc2ec91328f9ed4257b30c091e1c02fec1dd8e05ef3820.
Software receipt097750b6cc1f65b0ee8e2403754bba66c00f9a49c9b842b79c0d8270a8b70862
binds live receipt58b7d561ebc5de3b96ef77c829ef85fe333bfd45b8f2f1a8c42f01f8c4f4460d.
The exact Signet/mainnet image manifests remain af3369fb... and d94243ea...,
respectively; both receipts bind the tested full manifests and offline utility.

Both whole-run verifiers observed stable default-Signet tip321798. Capital is
89,570 =39,055 returned +50,515 confirmed fees (47,000 fixed +3,515 allocation
and final-return fees); 59 case transactions +five fee replacements +20 capital
allocations/return give84 unique txids. All nine recovery ages meet CSV12:
eight are12 blocks and case18 is16, not exactly12. Each final run restored57
CURRENT retained kits, while checking19 HISTORICAL independent pre-funding copy
checkpoints and83 HISTORICAL native restored-signature proofs. They did not
repeat19 independent-copy ceremonies or generate83 fresh native signatures.

Root220c8a rechecked all30 final file pins and all eight non-live whole buffers,
with equal live semantics apart from creation/digest/tip/confirmation fields.
Fresh whole current/frozen executable-source and both982-file runtime boundaries
match before/after both assemblies; latest guards65bd34/1111d3 pass.
Final rootc4b87f again proved no known writer and both exact FLOCKs free after the
second run. Only the two allowed lock diagnostic contents changed during each
actual verifier; root probes did not modify them. The paired proof is
case18-root-both-final-assemblies-paired-verification-v1.json,71,326 bytes,
SHA3dece21dd1796881d64149e9857ce051bbfb735c9e98a8d0ea1ad78b5c1240b0.
The whole final CLI includes wallet metadata/preflight reads, existing backup
hashes and kit decryption; it is not wholly zero-write/no-wallet. No new spend
signing or broadcasting, mainnet spending, public exposure or outreach occurred.

The dated full-objective requirements PREPARATION ledger was root-reviewed,
not final acceptance by itself:
24 requirements,55 paired source pins,52 recorded commands and15 exact public
result/artifact bindings. Its document pins are dated snapshots preceding these
updates; executable-source pins remain unchanged. The strongest automated passkey path uses real WebAuthn
routes with six virtual PRF authenticators and three participant contexts;
physical devices remain untested. Its browser funding/solo/sweep transactions
were mined in isolated regtest; browser cooperative/recovery packages have Core
mempool-acceptance evidence, not browser-mined lifecycle evidence. Separate Core
and live-Signet suites supply their own coverage. The ledger's illustrative final
commands do not replace root's established explicit Signet-environment commands.

Root retained and corrected two verifier assumptions: numeric DAG counts were
treated as arrays, and a four-field browser audit projection was compared as a
whole six-field object. An oversized read also produced truncated tool output
before narrower complete reads. These are retained diagnostic failures, not
product findings; no failed result was relabeled as a pass. Case17 reviewer
closure4c30a7 omitted six patch-newline bytes; checker-only correctionbeba8b
passed with the full original failure preserved. The root DAG-preparation
read command also had a pre-execution syntax error1698ed, then correctedb566c1.
The earlier case15 observer failure's cause remains unknown.

The mature N-1 personal-key quorum retains broad fresh authority to sign different
consensus-valid recovery payouts, including a whole-coin sweep. A pair is one-of-two.
Canonical equal refunds are application policy, not an on-chain covenant.
Exact solo preauthorizations bind their agreed payouts and successor vaults.
Historical reports/receipts do not establish custody chronology or new restoration.

The fresh official npm registry lockfile audit at2026-09-12 11:49:13 exited0
(actual npm PID468347 and outer2d41ae), with zero known advisories across the
reported149 dependencies, including development dependencies. This used the
frozen lockfile, ignored scripts, performed no install/audit-fix and changed no
source/dependency/configuration bytes. Root97ca94 verified the complete retained
capture, exact stdout/stderr and actual exits, all six current/frozen lock/config/
package files and Node/npm pins. The private/fsynced artifact is
dependency-audit-2026-09-12T114913Z.json,25,502 bytes,
SHAdc00353ae74579f30a31ca44407fd98cae5c4bd671098c4c3f2072bb52097ecd.
Registry advisories are not universal security proof; npm may use its normal cache.
Case ids are zero-based case-00 through case-18: all19 lifecycles, the final
return, both whole-run software assemblies and independent R01-R24/root closing
review now pass, subject to the explicit qualifications and deferred devices.
The dependency capture's ancillary remainingGates text mistakenly says cases18-19;
this is a retained numbering typo, not an additional case or an audit-result change.

Evidence index: live-run/presigned-v2-case10-checkpoint.vFDKJ2/
case16-root-confirmation-handoff.I2FTPn/INDEX.json,204871 bytes,
SHA94d0bf4e1cdf2d1ffc8d27b124f171426199a818bc89395017037b72088c1622.
Root c7dc31 reconciles the retained intervals and complete candidate; six successful
stable-metadata byte-slice checks through6681dc verify the entire private/fsynced
index. Case17 root records in the same checkpoint directory are
case17-root-crypto-closure-v1.json,190440 bytes,
SHAfa9d3ed5debe660f86d21de04dfe1b20b165f5af9d55291c17c9b23ef9251446,
and case17-root-dag-preparation-v1.json,121571 bytes,
SHAfc35a4869e8347713754d0e1db34ab9694f8c85f20d7b9b11e69e91517cb7e8d.
All ten stable-metadata byte-slice checks verify both entire private/fsynced
records. Earlier closed reviews remain closed. Source49e4240d and HEAD163afb1
remain unchanged; these updates do not change executable software.

Confirmed/unspent final return, original native complete:true and actual
same-invocation successful exit, no-writer/free-lock transition, BOTH sequential
actual final assemblies and root retained-byte/semantic review are CLOSED.
The independent closing R01-R24 review is also CLOSED: four requirements present,
twenty qualified and zero pending; no actionable implementation finding remains.
Reviewer0bce3e independently rebuilt52 commands and53 commitments, rehashed110
transcripts/artifacts, decoded20 allocation transactions/intent commitments and
verified both full receipts, all84 txids and capital conservation. It preserved
all material qualifications. Its final-live-acceptance-review-v1.IFhQLX/review.md
is19,651 bytes/SHAb35ca12344415df3f842c79287e97529a85bc520473658758224c0f2b6992b2a;
handoff.json is17,145 bytes/SHAa4b5025e26d45fb5b7a6e815691d3102ddfe6bd3759689f2a6cd4ebbfd2ced44.
Root2c7d6d freshly verified all15 sealed review files/436,371 bytes, exact directory
members and full numeric/nanosecond pins. Roota514df reconciled60 exact inputs,
all24 rows, both final receipts/exits and every allocation amount against its own
closed verification. The root closure is
case18-root-final-r01-r24-review-closure-1842-v1.json,41,685 bytes,
SHA3fd58fc4b844c94b2a418418b0dec97357d1debfee0d0b7b7cc15e186836aa1c.
No acceptance is inferred from preparation, a marker alone or a reviewer label.

A root evidence-accounting error is retained explicitly: failed absence check
4f9590 did not stop a later patch, replacing one older shared-note record.
The original32,294 bytes/SHA b7f1c27752d4a6a771df5f39d5e9ebfed9a6b85f6b1a29e93b473b80f905290a
were restored exactly, with unchanged inode/mode/birthtime but changed current
mtime/ctime. No historical timestamp equality is claimed. The new record uses a
distinct filename; incident case18-root-shared-record-recovery-incident-1826-v1.json
and reviewer22816a retain the failure and successful recovery. No product,
final dossier or current project-document bytes changed during that incident.

Physical-device checks alone are deferred. Mature N-1 recovery retains broad
whole-coin authority, not an equal-payout covenant; finite fee/sponsor liquidity,
relay competition and trusted same-origin client/device limits remain. Aggregate
final anchors omit witness bytes, so the closed exact-witness/crypto/DAG proofs
remain necessary. No mainnet spending, public exposure, provider-contact changes
or outreach is authorized. Two-node checks are dated, non-atomic observations;
private cookie/backup reads mean public-file counts are not the complete read
inventory. Persistent storage is required; whole-disk-loss protection and an
external professional audit are not claimed.

Historical V2 checkpoint (2026-09-11 22:43 UTC): dependency-security candidate
`49e4240d66a9780a7403996e4cca96478eb50e797e158ffb38157d910c9071ae`
updates Next.js and sharp for verified upstream advisories. The actual installed
packages and all four typechecks pass; a fresh audit reports zero known
vulnerabilities and the offline utility is byte-identical. The preceding 1cc
optimized browser run passed, but cannot certify changed dependencies. Its CI
was intentionally cancelled and its full private run never launched. See the
[security checkpoint](./DEPENDENCY-SECURITY-2026-09-11.md). Complete private local
acceptance now passes; complete 19-case funded default-Signet acceptance and both
final assemblies remain required.
Real default-Signet progress is 12/19 lifecycles (six solo, four cooperative,
two recovery) and all five confirmed fee replacements. Root's 44-RPC check at
21:18:09 confirms exact recovery without Bob in block 321677 on both nodes,
12 blocks after funding. The case11 independent capital/rejection follow-up and
root's exact full replay exited 0 with identical 14,374-byte outputs. Its seven
remaining outputs total 49,927 sats; the saved rejection reasons and two rebuilt
mutations pass their bounded public checks, not a new Core test execution.

Case12's exact allocation confirmed in321680 and funding in321681 on both
nodes. Root's66-RPC check at21:41:19 confirms all seven reviewed predecessor
outputs spent on chain:49,927 =36,000 game +13,745 reserve +182 fee sats.
The44-RPC funding check validates all37 public files472,610bytes, three native
signatures and exact finalization:36,000 =30,000 vault +5,400 refunds +600 fee.
At21:45:07 the39-record/42-RPC recovery check confirms the vault still unspent
at depth1 and exact Alice/Bob signatures with Carol absent. Both nodes refuse
the saved recovery as non-BIP68-final; earliest confirmation is321693 under
the current funding anchor. The21:52:06 refresh finds the same exact source
unspent at depth2 and recovery still premature. Independent case12 setup/funding
review is closed after root's exact full replay: all8 public files94,625bytes,
ten signatures and45 focused refusals pass with identical34,686-byte outputs.
It excludes the later terminal files. The same service is live, not complete.

The separate terminal-only review is now closed after root's exact full replay:
all5 public files67,531bytes, manual transaction/PSBT and BIP341 reconstruction,
Alice/Bob Schnorr signatures with Carol absent, Taproot membership and17 targeted
mutation cases pass. Both actual44,074-byte outputs are byte-identical. Product
refuses16 cases; the intent-only mutation is caught by the separate binding check.
Saved public capital accounting conserves49,927 =182 allocation fee +1,100 game
fees +48,645 sats in7 leaves, not current spendability or case completion.
At22:41:51 both nodes share321685, source remains exact/unspent at depth5 and
recovery is absent/non-BIP68-final; seven more tip blocks for next-block eligibility.
Mature Core/report verification, confirmed recovery and exact successor capital
transport remain open, as do all final whole-run gates.

Independent case11 public review is closed after root's full pinned replay.
All ten public files / 100,590 bytes, four Taproot rounds, nine exit commitments,
twelve counterparty preauthorizations and thirteen allocation/funding/recovery
signatures verify. All 94 local refusals and 91 altered-transaction signature
failures pass. Reviewer and root's actual 43,724-byte outputs match exactly.
The initial audit-harness dependency-path failure is retained; only that private
harness changed. These checks do not prove fresh private restoration or mature
Core acceptance, and do not replace the remaining whole-product audit.

The recovery fee review is closed: all 20 public records / 327,971 bytes remain
unchanged, Bob's 9,833-sat payout is preserved, and the 3,000-to-4,000-sat child
fee increase consumes only sponsor change. Reviewer and root's full original
36,539-byte audit command both exited 0 with identical 17,953-byte stdout and
48 local hostile refusals. Root's 22-record successor proof then reconstructs
51,213 = 36,000 game + 15,027 reserve + 186 fee sats, with eight verified input
signatures at 618 vB (619 maximum). These are scoped proofs, not final acceptance.

Runner update: session 5025 exited 0 at 19:08:36 without complete:true. Session
77644 later became unavailable and a fresh process scan found no writer; its
actual terminal exit status is unknown. No cause is established for either stop.
Read-only preflight at 19:29:13 verified checkpoint 1263, all 1,601 files,
10,411,235 bytes, all 20 public pins, source identity and free operation locks.
The unchanged follow command now runs as temporary user service
`presigned-v2-follow-vFDKJ2.service`, PID 250863, start ticks 10141900, with both
stable kernel locks held. Independent supervision review and root process/lock
checks pass. Restart is disabled; no boot enablement or new listener is created.
Stderr is intentionally not retained, so exceptions are not preserved diagnostics.
Use the runbook's live-service observer, not the old tool handles. Both final
assemblies still require complete:true AND the actual terminal native exit 0;
Result=success while the service is running proves neither.

Remaining: seven recovery lifecycles, confirmed/unspent final capital return,
both actual sequential final assemblies, retained-byte verification, independent
FINAL review and the full requirements audit. Physical devices remain deferred;
mainnet spending, public application exposure and outreach remain unauthorized.
The older explicitly dated records below are retained history.

The exact candidate is `163afb1ad68566c1ae33d59811b775add4988e12`. Its full private
52-command invocation actually exited0 at 03:31 UTC, including all 19 isolated
lifecycle cases (six solo, four cooperative, nine recovery), all five fee
families, database/build checks, full saved-file recovery and optimized browser.
Its 112-file archive is retained and independently byte-reviewed. Root rehashed
all 832 reviewed files, recomputed 53 commitments and independently compared all
112 archive members; original, copied and restored semantic validators pass. Both
normal image jobs passed; normal CI `34548633099` is now fully successful,
including all 52 commands and the optimized browser. Its 12 retained
log/receipt records total 326,450 bytes; root verified all bytes and 69
commitments. Normal-CI raw archives are not retained by that log-only workflow.
Independent fresh-log review passed, and root verified all 34 selected inputs
and exact reported command bindings; this remains log evidence, not raw archives.
Both retention jobs in `34549222062` passed on tooling `775f160`; the six exact
assets in test-only prerelease `386718829` are downloaded and verified. Both
actual 39-member archives passed all-layer content scanning, restoration and semantic validation;
independent actual-byte review passed, followed by root's complete 87-file
rehash and both semantic validators. This establishes current local and exact-image
evidence, not funded default-Signet or final software acceptance. Current
network-disabled seven-native-input rehearsal passed with
89,717 input sats, 147 fee sats and 89,570 confirmed return sats at 488vB; two
mutations were refused and neither real Signet wallet was opened.
The same-source unfunded default-Signet drill passed two wallet restarts, two complete
host restorations, ten rejection checks and two attempt-bound native signatures,
with zero wallet transactions, test sats or public sends. Root observed exit0
and stopped custody at that checkpoint. Independent review checked 28 safe
records / 35,295 bytes
and three public signatures (original receiving proof plus both restorations),
not private wallet bytes or a rerun. The same host was later started for chain
sync and is now caught up with ten peers, broadcasting disabled
and only loopback RPC. Before/after host audits found no security-policy change;
existing terminal/session diagnostic warnings remain. The test-transfer and
final-assembly entry points refuse missing full acceptance before
wallet/RPC/assembler activity.
Independent final-retention review found an inherited redundant post-marker
directory sync; it now occurs before the marker. Root rehashed all 44 reviewed
safe files, including 15 actual synthetic fixtures. Actual outer exit0 remains
required; a visible success record alone does not prove completed retention.
The private archive reviewer's synthetic test exposed nine non-ASCII numeric
headers incorrectly accepted after ASCII normalization. A raw-byte check fixes
that private decoder; the application candidate remained unchanged.
All 79 selected tests now pass (three positive, 76 negative), and all nine
retained malformed archives refuse. The corrected decompression test requires
the actual inflate-limit error after a valid gzip header. Root rehashed all
254 selected files and independently replayed the valid archive, nine old
refusals and inflate boundary. The corrected reader subsequently passed actual
complete-run review; diagnostic SHA-256:
`481e91ecdd18a9c26b173f4276e0b14f857006f1858683f38325556bb54034fd`.
The exact final notes passed independent review and root's 15-file / 877,821-byte
recheck. The authorized test-only prerelease was published at 03:57:18 UTC;
the actual publisher exited0 and a fresh root GET confirmed the six assets,
exact notes and candidate tag. This is not production or funding approval.
The bounded native test-capital transfer was prepared unsigned at 03:59 UTC:
seven native outputs total 89,717 sats, with a fixed 147-sat fee and a single
89,570-sat restored-wallet recipient. Root independently decoded both transaction
and PSBT, checked all four parent identities, recomputed both commitments and
verified the durable journal. Independent actual-intent review passed, followed
by root's 19-input rehash and eleven signing-digest comparisons. Exact signing
and broadcast invocations both exited0 after fresh gates. Root independently
verified three ECDSA and four Schnorr signatures, all SIGHASH_ALL; the saved
transaction is 488vB with the same recipient and 147-sat fee. The receiving
wallet's earlier pending seed confirmed before initialization. A two-node check
at 04:42 UTC verified that then-unspent seed at depth2. Fresh initialization passed
with actual native-wallet restoration for all83 targets; root reverified the
saved signatures, exact19-case plan and durable journal without RPC or writes.
The first allocation was submitted at04:44 UTC with one input/seven outputs,
334vB and a101-sat fee: 81,000 planned-output sats plus8,469 reserve sats. Root
checked every output and the signed template. That allocation is now confirmed;
the same resumable runner submitted the first game's funding-fee replacement
at 05:09 UTC. Funding and its replacement subsequently confirmed, followed by
both solo exits and the solo-fee replacement. The final sweep and approved
replacement were submitted by06:01 UTC and confirmed in block321589. The runner
reported the first case complete by06:30:50 UTC and submitted the next allocation.
Root's 05:18 read-only check
validated the exact funding signatures, six restoration-receipt bindings,
paired pre-funding checkpoint and both approved fee children. Both preserve
the participant's 1,800-sat refund; sponsor change alone covers the higher fee.
Root's 06:01 exit check and 06:08 terminal/capital check also exited0. Saved
signatures and all six hostile script rejections validate. The first-case graph
accounts for 89,570 sats as a101-sat allocation fee,13,800 in case/fee-child fees
and75,669 in terminal outputs. Fresh two-node verification at06:33 confirmed
all eight first-case transactions and absence of all three superseded children.
Root also verified the next allocation's exact predecessor commitment, ten
inputs and all signatures:75,669 =36,000 next-game inputs +39,442 reserve +227
fee, at 754 vB. Its exact bytes were pending on both nodes at 06:33; by 06:46
the same runner had confirmed the allocation and submitted the second scenario's
funding. Independent public-record review completed with
no actionable findings; root matched all 46 files and reported bindings at 06:49,
alongside its own semantic checks.
The second ordering, Alice/Carol/Bob, completed by 07:27:52 UTC. Root's 07:30
two-node check confirmed all five exact second-case transactions at active
anchors through block321595. Its separate 19-public-record check verified all
saved authorizations, six restoration-receipt bindings and the next allocation:
73,642 sats in seven exact predecessor outputs become 36,000 next-game sats,
37,460 reserve and a 182-sat fee at 604 vB. That Bob/Alice/Carol allocation later
confirmed, followed by funding and both designated-leaver exits. The third
ordering completed by 11:40:44 UTC. Root's 11:42 two-node check confirmed all
five exact transactions and active anchors, including Carol's final sweep in
block321612. Its 17-record terminal and 19-record successor checks verified
signatures, six restoration-receipt bindings, six saved hostile script rejections
and complete value conservation without new decryption or signing.
All seven remaining outputs total 71,660 sats: 36,000 next-game sats for
Bob/Carol/Alice, 35,491 reserve and a 169-sat fee at 560 vB. That fourth allocation
subsequently confirmed. The fourth ordering, Bob/Carol/Alice, completed by
12:11:30 UTC. Root's 12:13 two-node check confirmed all five exact transactions
and active anchors through Alice's final sweep in block 321619. Its separate
17-record terminal and 19-record successor checks verified all authorizations,
six restoration-receipt bindings, six saved hostile script rejections and the
complete value flow. All seven remaining outputs total 69,691 sats: 36,000 for
Carol/Alice/Bob, 33,509 reserve and a 182-sat fee at 604 vB. That fifth allocation
subsequently confirmed. The fifth ordering, Carol/Alice/Bob, completed by
12:28:45 UTC. Root's 12:27 two-node check confirmed all five exact transactions
and active anchors through Bob's final sweep in block 321624. Its 17-record
terminal check verified all authorizations, six public restoration-receipt
bindings, six saved hostile script rejections and complete value conservation.
The expanded 19-record check verified all seven successor inputs and signatures:
67,709 sats become 36,000 for Carol/Bob/Alice, 31,540 reserve and 169 fee at 560 vB.
The sixth allocation subsequently confirmed in block 321627. Root's 13:40:23
26-RPC/zero-wallet-call check observed its exact saved witnesses at an active
anchor on both nodes, with the exact sixth funding pending: 36,000 input sats,
35,400 output sats and a 600-sat fee at 352 vB. The separate 13:39:55 eight-record
public check verified its graph, immutable funding intent, signatures and six
restoration-receipt bindings. The original runner was live at that checkpoint.
Independent bounded review of the five completed cases found no actionable
issue across 110 public records / 1,075,347 bytes. Root separately rehashed every
record, inspected the read-only reproduction and ran it to actual exit0 at
13:46:35. All five capital totals, predecessor bindings and both ordered-manifest
commitments match. This is not an independent reviewer chain observation or
final whole-run review; public receipt bindings do not prove new decryption or
physical backup storage.
The sixth ordering, Carol/Bob/Alice, completed by 14:36:19 UTC. Root's 54-RPC
check exited0 at 14:36:05, confirming all five exact transactions and active
anchors on both nodes through Alice's final sweep in block 321632. Its 17-record
terminal check verified the 9,050-sat final payout, all authorizations, six
public restoration bindings, six saved hostile script rejections and complete
value conservation: 67,709 input sats =169 allocation fee +1,800 fixed case fees
+65,740 in seven outputs. The expanded 19-record successor check exited0 at
14:38:36: those seven exact outputs become 36,000 game funding, 15,000 agreed
cooperative fee sponsor, 14,548 reserve and 192 fee at 635 vB. Root's 22-RPC
check confirmed the exact allocation in block 321633 at 14:39:58. The new
cooperative funding has a 600-sat fee at 354 vB; its eight-record public check
exited0 at 14:40:58, followed by a 26-RPC check at 14:41:23 confirming the
allocation and exact funding pending on both nodes. Independent incremental
review of the sixth ordering and cooperative allocation passed at 14:42:30.
Root separately rehashed all 19 records /120,169 bytes and reproduced the exact
checks to actual exit0 at 14:47:58. Both manifests and all capital, successor,
signature and cooperative-sponsor bindings match. This public-evidence review
does not decrypt backups, replay Core mutations or replace final whole-run review.
The first cooperative case completed by 15:10:07 UTC. Root's 46-RPC/zero-wallet
check exited0 at 15:09:37, matching all four exact saved transactions and active
anchors on both nodes: allocation 321633, funding 321634, cooperative parent
and fee replacement 321635. The superseded child is absent on both nodes.
The aggregate key-path signature pays 9,900 sats to each participant; the
3,000-to-4,000-sat child replacement reduces only sponsor change from 12,000 to
11,000 sats. Complete conservation is 65,740 =192 allocation fee +4,900 fixed
case fees +60,648 in eight outputs. Independent 20-public-record review passed
at 15:10:38; root separately rehashed the 326,320 bytes and reproduced the exact
network-disabled command to exit0 at 15:17:24. Both manifests and all capital,
signature and fee-authority results match. Two saved Core rejections and two
local hostile-byte refusals are verified; no fresh Core replay, nonce/partial
transcript, private decryption or physical custody proof is inferred.
Root's 22-record successor check exited0 at 15:10:16: all eight exact outputs
become 36,000 game sats, 24,459 reserve and 189 fee at 628 vB for cooperative
after Alice exits. Its allocation confirmed in block 321636. The eight-record
funding check exited0 at 15:12:05; the 26-RPC check at 15:12:46 found its exact
funding pending on both nodes, with a 600-sat fee at 352 vB.
The cooperative-after-Alice case subsequently confirmed. Root's46-RPC check
exited0 at15:59:08, matching exact allocation321636, funding321637, Alice321638
and cooperative321639 active anchors on both nodes. The20,200-sat successor
pays9,950 sats each to Bob and Carol, with300 fee sats at154vB. Its full graph
conserves60,648 =189 allocation fee +1,200 case fees +59,259 in seven leaves.
The original runner actually exited143 at15:52:29; its cause is unknown.
Root's read-only resume preflight exited0 at15:58:39: no old writer or other
lifecycle operation, both kernel locks released, exact synchronized isolated
Core, matching current/frozen source and all1,278 files of checkpoint1087
verified against independent objects and the rollback anchor. The same frozen
follow command resumed the same journal without restoring, changing fees,
replacing funding or restarting Core. Its single process holds both locks.
The16-public-record successor check exited0 at16:00:46, revalidating all14
prior case records and the new exact seven-input allocation:
59,259 =36,000 game sats +23,077 reserve +182 fee at604vB. Root's22-RPC check
exited0 at16:02:19 with that allocation confirmed on both nodes in block321640.
The cooperative-after-Bob case confirmed through block321643; root's14-record
public check and46-RPC exact-witness/active-anchor check exited0 at16:17:12
and16:18:38. Bob receives9,500 sats; Alice and Carol receive9,950 each.
The final cooperative case, after Carol exits, confirmed through block321647.
Root's14-record public check exited0 at16:40:20, verifying Carol's required
final signature, both original counterparty witnesses, the exact Alice/Bob
successor and their aggregate cooperative signature. Its46-RPC check exited0
at16:41:04 with all four exact saved transaction hexes and active anchors on
both nodes. The graph conserves57,877 =169 allocation fee +1,200 case fees
+56,508 across seven leaves; Carol receives9,500 sats and Alice/Bob9,950 each.
The first recovery allocation passed its16-record predecessor/signature check
at16:44:39:56,508 =36,000 game sats +15,000 committed recovery sponsor +5,313
reserve +195 fee at647/max649vB. Its exact bytes were in both mempools at the
18-RPC/zero-wallet-call16:45:12 observation; this is not confirmation.
That allocation subsequently confirmed in block321648. The new eight-record
funding check exited0 at16:55:10; root's26-RPC check at16:56:10 matched its
exact saved354-vB funding in both mempools, with600 fee sats, and confirmed
the allocation's full hex and active anchor. No new decryption is inferred.
Funding subsequently confirmed in block 321650. The ten-record public check
exited 0 at 17:18:30, preserving all eight previous byte/hash bindings and
verifying the exact saved recovery intent and transaction. Bob and Carol's
direct Schnorr signatures validate; Alice's witness slot is empty. Payouts are
9,834 sats to Alice and 9,833 each to Bob/Carol, with 500 fee sats at 257 vB,
sequence 12 and the exact recovery leaf/control block. Four local hostile
mutations are refused. Root's 38-RPC/zero-wallet-call check exited 0 at 17:19:52:
both nodes share stable tip 321650, match all saved allocation/funding hexes
and active anchors, and observe funding:0 unspent at depth 1. Both reject the
exact signed recovery as `non-BIP68-final`; it is not in either mempool.
This is actual premature-spend evidence, not mature acceptance or completion.
Independent review of the ten public records found no actionable issue. Root
separately rehashed all 98,036 bytes, then reran the complete original audit
to actual exit 0 by 17:38:56; both command and stdout hashes match exactly.
Manual BIP341/Taproot and independent Schnorr checks, seven allocation-input
signatures, three funding signatures, 12 preauthorizations, three unique
receipts matching both arrays, and 38 local hostile refusals all pass.
The 17:39:18 two-node check again exits 0 with stable tip 321652, exact saved
allocation/funding witnesses and active anchors, and funding:0 unspent at
depth 3; both reject the exact recovery as `non-BIP68-final`. Reviewer chain
observation, private restoration, maturity and case completion are not inferred.
Ten of 19 cases are complete: all six solo orderings and all four cooperative;
no recovery case has completed. The old 29,700 participant/vault sats remain
excluded. The remaining nine recovery cases, the
recovery fee family, final capital return, both actual final assemblies,
retained-byte verification,
independent final review and the full requirements audit remain required.
Bounded independent review found no blocking defect in the intact saved-node
resume path. Root checked the cited source and reproduced its synthetic
witness-comparison example to actual exit0. The runner's confirmation helper
compares non-witness bytes; the separate two-node checks above compare full
saved transaction hex, so exact-witness claims rely on those checks. This
review did not inspect private/runtime state or approve the whole run.
The independent three-pair cooperative review is also closed. Root rehashed
all40 public files/246,455 bytes, then ran both full supplied original suites
to actual exit0 by17:03:50. Aggregate-key reconstruction, six original witness
reuses,18 public receipt bindings,12 saved Core rejection reports,18 local
negative checks and both successive allocation links match. The in-memory
receipt test confirms that its public hashes are attestations, not authenticated
fresh-decryption/storage evidence. This is not final whole-run review.
Both final helpers remain unexecuted.
Require complete:true AND actual exit0 from the same-state resumed writer;
the terminated original invocation remains a recorded exit143, not a pass.

Historical V2 checkpoint (2026-09-11 00:30 UTC): source
`1cc9f5f94e55bca6070fd294b4ab7e817d0a441d39764355b7401e11934f32cc`
corrects independently reproduced browser-harness failure-reporting and snapshot
privacy defects. It does not change the protocol or weaken an action/signing
assertion. All four typechecks passed, the final hydration-attribute correction
was rechecked by the web compiler, and both network-format custody suites pass
all 30 checks. Independent review verified six actual synthetic failure/timeout
cases and all 36 retained files. The real optimized application check is live;
fresh complete 52-command, image, real default-Signet and final-assembly evidence
remains required. Earlier image and local receipts cannot certify this source.

The preceding private source409cca25 run actually exited1 at 00:05:31 UTC after
51 passing commands. Its original failure was a 60-second refresh-chain click
timeout before Alice's recovery proposal; the HTML intercepted pointer events.
The underlying unresponsive-page cause is unproven. A separately demonstrated
automatic-snapshot privacy defect justified ending only its disposable browser,
which released the previously blocked original failure report. All 169 selected
files / 2,178,310 bytes are privately retained and independently verified as
failed-prefix evidence, not a complete pass. No recovered Signet coins moved.

Historical V2 checkpoint (2026-09-10 23:38 UTC; superseded as described above): onboarding-correction source
`409cca25c6f7fb93889b8b7ff1076772b4ca1ca8c9b2b13b11e64e8e03c44087`
addresses independently confirmed V2 legacy-instruction and PRF exception-cleanup
gaps. All four typechecks and 17 focused passkey tests pass. The private complete
52-command run started at 21:13 UTC and is still live at 51/52. Its complete
19-case isolated-Core lifecycle passed at 23:07 UTC, followed by all five
database suites, offline build and complete saved-file recovery/fee matrix.
Only optimized-browser acceptance remains live. Normal CI `34529963155`
passed all 52 local commands and both image jobs at 21:54 UTC; its receipts/logs
are retained, not its raw child/archive bytes. Both retention jobs also passed.
All six current draft assets are downloaded;
both 39-member archives passed local and independent actual-byte review, including
all 18 historical layers per image, restoration and semantic validation.
The separate optimized V2 browser run exited1 after 23.3 minutes at Carol's
final-sweep finalization, with a generic Core transport/read failure. A specific
timeout or resource-contention cause is not proven. Both legacy PRF browser
tests then passed. The new source-bound unfunded Signet host passed two restarts,
two whole-host restores and ten rejection checks, and is stopped with custody
intact. Current complete local evidence, all 19 funded default-Signet cases and
final assembly remain required. The new test-only release is still a draft;
no recovered coin was signed or sent. Earlier results cannot certify this source.

Historical source `9afe98cf` passed all 49
local commands and both genuine rootless image profiles, with complete local/OCI
archives retained. Its real default-Signet run began but lost its temporary
primary journal and participant material on reboot. A separate native wallet
backup was restored; the dated 16:30 UTC chain audit reconciled 89,717 native
wallet sats + 29,700 other known unspent sats + 9,568 confirmed fees = the original
128,985 test sats. No recovered coins have been spent by the new implementation.
Persistent journal/anchor, native-wallet restoration and same-identity host
recovery candidate `35d9038` / source `b8c4cf28` is now superseded. Its public CI
`34515524898` passed all 52 local commands and both genuine image jobs at
19:28 UTC. Both current OCI archives from retention run `34515940967` are
downloaded, restored and independently reviewed; their test-only prerelease is
still a draft at 20:44 UTC. The first host-local run passed 49 checks, including
all 19 isolated-Core cases, then exited unsuccessfully when the offline build
correctly refused dependencies symlinked outside its checkout. Its 158 retained
files are failed-prefix evidence, not a complete run. A new full 52-command
invocation began at 20:37 UTC with dependencies installed inside a fresh frozen
checkout; offline-build preflight passed. It was intentionally stopped at 40/52
at 20:52 UTC for the verified onboarding findings, not an observation timeout.
Its 128 retained files are explicitly incomplete superseded evidence.
All 19 new real default-Signet lifecycles and
final release assembly remain required. Historical passes cannot certify changed
source. See the V2 evidence plan for exact artifacts and outstanding work.

Last updated: 2026-09-05
Reviewed baseline: `71b1bd227a5f3f3d35fb8449776747d5d88d28c7`; current work is on
`codex/signet-readiness-hardening`, including liveness and Signet release fixes.
Implementation `3edb17c` is pushed in
[PR 2](https://github.com/twood22/btc-multiplayer-vault/pull/2), not merged or deployed.
Both exact-container profiles passed in
[run 34000624901](https://github.com/twood22/btc-multiplayer-vault/actions/runs/34000624901).

This is the current operational status and roadmap for the Bitcoin multiplayer
vault described in [`spec.md`](./spec.md). The production target remains
mainnet, while the next implementation and integration milestone is the default
global Bitcoin Signet described in
[`SIGNET-VALIDATION-PLAN.md`](./SIGNET-VALIDATION-PLAN.md). Historical
findings remain in [`REVIEW.md`](./REVIEW.md), and detailed product and
deployment gates remain in [`PASSKEY-PRODUCT.md`](./PASSKEY-PRODUCT.md) and
[`DEPLOYMENT.md`](./DEPLOYMENT.md).

The current Signet operator sequence is
[SIGNET-OPERATOR-RUNBOOK.md](./SIGNET-OPERATOR-RUNBOOK.md). Physical passkey checks
are deferred by the user to the first friends vault, not a separate test session.
They remain real onboarding/recovery checks before that vault is funded.

## Verdict

**The typed standard-Signet profile, offline/PostgreSQL/build/browser gates, and
a real three-wallet funding plus cooperative-spend checkpoint now pass. Hosted
Sigbash signing and the complete user-facing lifecycle remain blocked or
unproven; mainnet is still unauthorized.**

The repository implements the intended round-based game: Sigbash-enforced solo
withdrawals, participant-only BIP-327 MuSig2 cooperative exits, distributed
passkey-protected participant custody, timelocked recovery, final sweep, and
three-wallet funding preparation. Remaining limitations include Sigbash-registration
provenance, fee adaptation, final-sweep destination semantics, and external
operational proof. Sigbash declined mainnet SDK enablement for the current
experimental project but permits SDK testing on Signet. A real standard-Signet
vault was funded and cooperatively spent, but no hosted Sigbash signature or
complete user-facing run has been obtained, and no real mainnet transaction has
been authorized. See the
[`current code review and fixes`](./CODE-REVIEW-2026-09-05.md) and the
[`previous review`](./CODE-REVIEW-2026-08-17.md) for evidence and remaining risks.

## 2026-09-05 implementation checkpoint

The user reaffirmed a friendly holding vault and authorized code improvements.
The haircut/bonus economics, nine Sigbash policies, passkey custody, and specified
recovery trust model are unchanged. No operational database, live signer, wallet,
deployment, GitHub branch, or funds were modified for this checkpoint.

- Fixed concurrent readiness completion leaving nine valid receipts but no
  `ready` state. Exact receipt retries and migration 014 repair that old state.
- Removed the one-proposal-per-coin veto. Each participant can propose its own
  solo exit alongside shared cooperative/recovery proposals; the browser lets
  participants select which exact transaction to review/sign. Bitcoin
  confirmation, not proposal creation, still determines the winning spend.
- Protected approved/in-flight broadcasts from expiry. The watcher resumes
  interrupted approved or submitting intents, reports individual failures, and
  continues to observe competing transactions. Unavailable send/lookup responses
  preserve retryable intent; it retries only current inputs.
- Kept initial funding restart-locked after an uncertain send or resumed attempt.
  A fresh preflight rejection can still be released, but only by its owning
  attempt. Funding retry tokens now preserve PostgreSQL microsecond precision;
  the regression covers overlapping operators and exact-transaction recovery.
- Made full 32-revision custody history read/unlockable, with new writes disabled.
  Registration reserves space for both pending and completed recovery snapshots.
- Added real PostgreSQL regression tests and extended the three-browser MuSig2
  test with an independent solo proposal and shared-proposal selection. The
  production/container acceptance harness now also runs the database suite.
- Corrected evidence labels: `SigbashClient.verifyPSBT` calls SDK WASM locally
  (with possible metadata requests). It is not an independent hosted signing
  service acceptance. No new hosted signature was attempted or obtained here.
- Audited the remaining funding/passkey/HTTP/deployment boundaries and recorded
  coverage and limitations in the review. The complete Signet operator release
  ceremony remains pending; the private funding CLI still has mainnet-specific
  release contracts, and store tests do not establish that product milestone.

Migration `014_runtime_liveness` must run with the matching application release.
These changes are local and are not evidence of a pushed or deployed release.

## Independent testing follow-up

At the user's request, three independent agents tested transaction-state races,
custody boundaries, and the optimized browser path. All final runs passed,
including a new simultaneous expired-funding-claim probe, genuine 32-revision
encrypted-history recovery, and browser consent reset/expired selection. The
primary agent also reran core/web/network checks and the isolated Bitcoin Core
31.1 reorganization drill. No new application defect was demonstrated; no
production code or shared tests were changed during this testing follow-up.
See [the test report](./TEST-REPORT-2026-09-05.md) for exact coverage, corrected
probe assumptions, evidence, and the remaining live-provider/device limitations.

## Live Signet follow-up — 2026-09-05

The user subsequently authorized real Signet signing and broadcasts. Three
hosted signing attempts obtained no signature: the saved first-round PSBT with
stock encoding failed proof parsing, and both the wrapped first-round PSBT and
a fresh second-round PSBT reproduced `server_error: Signing service error`.
The valid transaction and all three negative-verification cases behaved as
expected before each signing attempt. No transaction was broadcast, no new key
was created, and no existing Signet coins or mainnet material were used.

This investigation also demonstrated an SDK 0.8.0 key-response correlation
defect: `listKeys()` issues concurrent KMC requests whose shared response event
can return one key's material for another key. Direct retrieval on a fresh
client with checkpoint binding avoids that defect in the reproducer, but the
application's browser/CLI provisioning still needs hardening. This is distinct
from the signing-service exception, which still occurs with the correct key.
See [the live report](./SIGNET-LIVE-TEST-2026-09-05.md) for current traces,
the offline SDK reproducer, chain checks, and the unfulfilled lifecycle gates.

## Signet readiness hardening follow-up — 2026-09-05

The user authorized completing the preparation and review work, with physical
passkeys deferred as described above. This supersedes the earlier implementation
checkpoint's pending provisioning/release code items, not its evidence limits.

- Browser and CLI now use the pinned SDK guard: sequential list hydration,
  fresh native clients for key-material/recovery requests, actual decrypted
  xpub/policy/share checks, late-response isolation, and round-specific signing
  initialization. No global SDK prototype patch or replacement signer.
- Live read-only checks retrieved the nine existing Signet keys under all three
  organizations and verified every checkpoint, deterministic participant share,
  and current-envelope recovery round trip, including slots 1 and 2. No new key,
  signature, or broadcast was created by these checks. Recovery without the
  server's current wrapping remains untested.
- Real runtime testing exposed a previously broken raw-vs-compiled policy
  comparison: the compiler adds inline address-list IDs. The application now
  preserves exact conditions/destinations, rejects preset/external/colliding
  IDs, and compares browser/CLI results to the pinned local compiler. This is
  consistency validation, not hosted-key provenance or a policy-root attestation.
- Fresh, unfunded Signet pair setup created two keys under new protected test
  organizations and preserved both recovery kits. It required two explicit
  same-checkpoint retries after the SDK's aggregation step reported a policy-root
  mismatch. A credential-free pinned-WASM probe independently produced two roots
  from 64 identical inputs despite identical compiled policy JSON. This is an
  intermittent upstream compilation defect, not a clean provisioning pass;
  its relationship to the hosted signing exception is still unknown.
- Signet has independent version-2 live-proof receipts, version-3 release
  artifacts, reviewed-digest variables/paths, and an explicit Signet broadcast
  acknowledgement. Both artifacts commit network and genesis; cross-network
  and legacy artifacts fail closed. The nine real readiness signatures, three
  final funding approvals, private Core, real-device, and mainnet enablement
  gates remain intact.
- Production builds now record their network. Startup rejects a missing,
  mixed, or wrong-network runtime before listening. The exact-container CI
  workflow passed on both profiles for implementation `3edb17c`, including
  PostgreSQL 16.15, six browser scenarios per image, and the operator probe.
- The actual guarded predeployment-signing CLI was then exercised with the
  fresh unfunded pair. At `2026-09-06T00:11:37.852Z` (September 5 local time), it
  reached policy acceptance, server nonce exchange and wrapped blind signing,
  then reproduced `server_error: Signing service error`. No receipt was written.
- Claude Fable performed bounded read-only SDK/release/compiler reviews. The
  compiler behavior and fixes were independently checked; details and final
  verification are in [SIGNET-READINESS-2026-09-05.md](./SIGNET-READINESS-2026-09-05.md).

Still blocked: the hosted signing exception, real predeployment signature,
private HTTPS deployment/registry-digest/restore evidence, and the complete
friends' user-facing lifecycle. No funding release report has been fabricated
or issued. `signetValidated`, `mainnetValidated`, and
`mainnetFundingAuthorized` remain false.

## Proven on this baseline

- The offline TypeScript, policy, PSBT, Taproot, MuSig2, recovery, consensus,
  custody, and product-conformance suite passes under Node 22.23.2.
- Web typechecking and isolated browser tests pass under Node 22.23.2.
- Both mainnet and default-global-Signet network acceptance pass. The Signet
  offline/web suite, fresh PostgreSQL 16 migration/database suite, optimized
  production build, and all six optimized three-browser scenarios pass.
- Nine fresh **10,000-sat-per-participant** Signet-only hosted Sigbash keys were
  created under three independent credential organizations, with protected
  recovery journals. An earlier nine-key 1-BTC policy set is retained only as
  non-fundable historical setup evidence. SDK local WASM
  `verifyPSBT` accepted the exact allowed transaction and rejected wrong-value,
  wrong-destination, and extra-output variants.
- Against the real confirmed vault outpoint
  `46fa0c249d7ccef642ef8b7d248c5fada161a571443e0b4721e03d7b7a518220:0`,
  SDK local WASM `verifyPSBT` accepted Alice's exact 9,500-sat first exit with 20,200
  sats re-vaulted and explicitly rejected wrong-amount, wrong-address, and
  extra-output PSBTs. The signing nullifier was reported available.
- Funding rejects non-canonical 65-byte Taproot signatures with an explicit zero
  sighash byte; all proposal types require fresh observations; recovery delay is
  bounded to the CSV-encodable range 1 through 65,535.
- At the 2026-08-31 checkpoint, Bitcoin Core 31.1 was fully synchronized against default global Signet in an
  isolated datadir with `txindex=1`. A faucet paid 82,132 sats in
  `c80ae308b476f73d6844aa75e713d33b9cb20428eca2d73c9917a58b5bcd8833`;
  `3bd606154ba8c7d6651861ff72f9a862f4b63fa13c1feba91d7e7bbcf193bc2c`
  split it into confirmed 20,000-sat Alice, Bob, and Carol wallet outputs.
- The exact three-wallet funding builder consumed one independently signed
  Taproot input from each Core wallet and confirmed transaction
  `46fa0c249d7ccef642ef8b7d248c5fada161a571443e0b4721e03d7b7a518220`,
  with one 30,000-sat round-one vault output, three 9,000-sat change outputs,
  and a 3,000-sat fee.
- The confirmed vault output was spent through its participant-only MuSig2
  key path by
  `ef01cb2027ca35b64e7d5390ffb7cd0b3b35e950658cfcc42684e35a57cad9f4`.
  The live audit verified the selected outpoint, Taproot key-path witness, no
  Sigbash keys in the cooperative path, three exact 9,900-sat refunds, and one
  confirmation. This isolated CLI signing checkpoint proves the consensus
  path, not three-device/passkey custody.
- `npm audit --audit-level=low` reports zero known vulnerabilities.
- The manual `Exact container acceptance` GitHub Actions run passed for the
  merged baseline: [run 32064526120](https://github.com/twood22/btc-multiplayer-vault/actions/runs/32064526120).
  It ran six isolated browser scenarios and the packaged, non-mutating operator
  probe against local image ID
  `sha256:d275c0d95ee4ec34564f36718fc1d1b4e433a91717b8f32a8a6e04db09a084b1`.
- That CI evidence is a tested local image ID, **not** a published registry
  manifest digest, deployed artifact, live-service test, funding approval, or
  mainnet authorization.

The pinned checkout/setup actions currently use Node 20 action runtimes that
GitHub forces onto Node 24. The application and acceptance suite still use the
repository's exact Node 22.23.2 runtime. Updating those actions is a maintenance
item, not evidence that the application ran under the wrong Node version.

## Explicitly unproven

- A complete real hosted-Sigbash signing flow on standard Signet. The
  2026-09-05 first- and second-round retests passed local verification but
  reproduced `server_error: Signing service error` with the transport wrapper.
  The separate upstream SDK multi-key response-correlation defect is now guarded
  in application provisioning; live retrieval/recovery passed for nine existing
  keys. Fresh provisioning also exposed intermittent compiler-root variation.
- Nine live readiness signatures, three physical-passkey identities, and the
  complete user-facing on-chain state machine.
- Sigbash mainnet enablement and one real, locally authorized mainnet signature.
- The nine participant-and-round readiness proofs using three independently
  owned Sigbash organizations and physical passkeys.
- Production HTTPS/RP configuration, encrypted database operations and restore,
  user-facing private Bitcoin Core operation, physical external-wallet signing,
  and real browser/device recovery drills.
- A published and independently reviewed registry manifest digest.
- Any deployment, mainnet funding/broadcast, or user-facing passkey-approved
  Signet funding/broadcast. The confirmed CLI checkpoint is operational evidence,
  not deployment authorization.

## Remaining risk and design work

- **Sigbash key provenance:** the coordinator checks browser-submitted key and
  policy data for internal consistency but has no Sigbash-signed or independently
  queried attestation that the provider issued that key with that policy. The
  existing positive readiness proof can be satisfied by possession of the
  registered leaf key and therefore does not close this gap.
  For the explicitly friendly test scope, this is a documented participant-trust
  assumption; it must not be presented as protection against dishonest peers.
- **Long-lived fee handling:** immutable low fixed fees and non-RBF sequences
  need a participant-approved fee-bump design or an explicit, tested alternative.
- **Final sweep semantics:** choose a separately approved destination or remove
  the current self-send and fee burn.

The protected live-proof receipt is local operator evidence, not a
provider-signed Sigbash attestation. Browser hostile-PSBT rejections are
browser-observed evidence; the server independently proves only the allowed
transaction and signature it can verify itself.

## Design decision requiring explicit funding-time review

The recovery leaf is an uncovenanted CSV-delayed `N-1` participant spend. After
the configured delay, `N-1` participants can send the entire current UTXO to
arbitrary outputs. In a two-participant round, that means one participant can
take the remaining pot after the delay. This is the specified liveness escape
hatch, not a Sigbash-enforced game withdrawal, and Bitcoin Script does not
constrain its outputs. It must be accepted as part of the trust model and given
a deliberately reviewed mainnet delay before any funds are approved.

## Questions for Sigbash

1. May the three participant-owned organizations each create their three
   immutable round-scoped keys on the default global Bitcoin Signet under the
   free SDK testing policy?
2. Can Sigbash provide a server-verifiable attestation binding organization,
   key ID/index, BIP-328 xpub, policy root, and the canonical compiled policy?
   If `policyRoot` is deterministic, how should an independent verifier
   recompute it? The pinned compiler now has a credential-free same-input root
   variation reproducer in `scripts/sigbash-policy-compiler-probe.mts`.
3. Does the current Signet service support the SDK contract used here,
   including immutable `REQKEY`, output destination/value constraints,
   input/output counts, recovery-kit export, and the expected rate limits?
4. Please confirm that descriptor `tr(SIGBASH_XPUB/0/*)` identifies the
   child-`0/0` policy leaf key while the SDK's identification key remains its
   distinct internal aggregate root. The code fails closed if that contract
   differs; it does not substitute another leaf-key candidate.
5. Is every signing route for the identification root/aggregate key subject to
   the same canonical policy, even though it is a separate bare Taproot leaf?
6. What service-side evidence can Sigbash provide for policy rejection,
   nullifier consumption, key/network identity, and signed-response fields?
7. What Signet rate, key-count, nullifier, and retention limits should the
   nine-key three-person validation respect?

## Roadmap and hard gates

These are sequential gates, not a deployment schedule:

1. **Network boundary — implemented:** retain the isolated default-global-Signet profile
   in [`SIGNET-VALIDATION-PLAN.md`](./SIGNET-VALIDATION-PLAN.md) without changing
   the round game or weakening the existing mainnet gates.
2. **In-repository safety pass — partial:** recovery bounds, stale-observation
   and funding-signature fixes were already present; readiness, proposal,
   broadcast, and custody liveness fixes are now regression-tested locally.
   Provider provenance, fee adaptation, and final-sweep semantics remain open;
   preserve the friendly-vault trust model when planning further changes.
3. **Signet infrastructure and coins:** run isolated default-Signet Core,
   Postgres, HTTPS/passkey, and independent observation boundaries; obtain a
   small faucet coin and split it into three participant-controlled wallet UTXOs.
4. **Real hosted-Sigbash proof:** create fresh Signet credentials and keys,
   resolve the historical signing failure, prove allowed signing and hostile
   rejection, and verify provider provenance as far as the service permits.
5. **Complete Signet product run:** execute all nine readiness proofs, funding,
   solo orderings, cooperative exits, recovery thresholds, final-owner flow,
   confirmation, restart, outage, fee, and reorganization drills using the real
   service and chain rather than fixtures.
6. **Independent Signet release review:** require no open critical/high funding
   issue and produce an explicitly non-mainnet report.
7. **Later commercial/mainnet decision:** only a separate decision may begin a
   new mainnet-scoped deployment and tiny-funding review. Every mainnet gate and
   explicit authorization remains required.

The faucet and CLI/Core funding/cooperative checkpoint are already complete.
The user-facing Signet funding gate still requires all nine real Sigbash
readiness signatures; the CLI checkpoint does not satisfy it. Mainnet remains
**unfunded** unless a later commercial and funding decision explicitly changes
that state.
