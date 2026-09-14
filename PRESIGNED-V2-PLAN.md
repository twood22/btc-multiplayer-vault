# V2 implementation and evidence plan

## 2026-09-13 — Requested successor recovery design

The user rejected the unrestricted recovery quorum's collusion risk and requested
[fixed-refund recovery design](PRESIGNED-V3-FIXED-RECOVERY-DESIGN.md). This is a
proposed V3 protocol, not an implemented V2 change: exact all-member setup
authorizations plus separate delayed N-1 triggers, four refund templates and
nine additional setup signatures. The document separates candidate-leaf test
evidence from pending implementation, full-tree review and release acceptance.
Existing V2 funds and kits retain their original rules and warnings.

## 2026-09-13 — Authorized economics follow-up

New ceremonies use the explicit `last-survivor-net-v1` economics marker and a
19:20:21 split of the pool after normal solo/final-sweep fees. Rounding belongs
to last. Existing committed vaults and original-schedule test artifacts are
preserved, not silently upgraded. Client/server/offline validation shares the
same versioned rules; the setup screen shows net final payouts and the unchanged
unrestricted recovery quorum. Fresh exact-source release acceptance remains
required before the new version can be considered for mainnet.

## Previous frozen source — September 12 goal completion

Goal authorized 2026-09-06. Agent-executable software acceptance is complete as of
2026-09-12 18:44 UTC: all 19 real default-Signet lifecycles, five fee families, final capital
return, both sequential image-profile assemblies and independent R01-R24 review
passed with root verification. Physical-device checks remain deferred, and there
is no production release or funding approval. The earlier temporary-custody-loss
run is historical; the completed run used retained persistent custody. This does
not establish whole-disk-loss protection. Detailed qualifications follow.
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

## Current live acceptance (2026-09-12 02:40 UTC)

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

Exact helpers, source pins, commands, actual output hashes and recovery procedures
are retained in the private case10-checkpoint.vFDKJ2/CHECKPOINT.md bundle. The
unexecuted final assembly gates remain unchanged; running service success is not
native complete:true plus actual terminal exit0.

## Historical dependency-security candidate (2026-09-11 22:43 UTC)

Latest real-chain milestone:12/19 cases and all five confirmed fee replacements.
Root's44-RPC check at21:18:09 confirms exact case11 recovery in block321677 on
both nodes,12 blocks after funding. Actual9,573-byte output
`case11-two-node-confirmed.json` has SHA-256
`53a12d869677f1997db5a7a8ab6294fc9c465c33b5a0210bf39c2204e379c664`.
Independent capital/rejection follow-up40129/fc67c8 and root's full pinned replay
11699/e1d9d6 both exited0 with identical14,374-byte stdout, SHA-256
`86f9cc45fee125721360d7a640c6f654140a5e91a48d13210973e7a76990e979`.
The three-node DAG and11 pinned public files101,056bytes establish seven leaves:
51,213 =186 allocation fee +600 funding fee +500 recovery fee +49,927 leaves.
Both native rejection recipes match the actual report; this is not new Core RPC.

Root's62-RPC check47072/09ceaa exited0 at21:29:43, rehashing32 public files425,030
bytes and validating every exact case12 input, parent, owner, amount and signature.
The source-bound allocation is49,927 =36,000 game +13,745 reserve +182 fee,604vB.
Both nodes at321678 have it in their mempools, unbroadcast:false; all7 old outputs
remain exact unspent outputs in chain-only views. Actual14,015-byte output
`case12-capital-reuse-two-node.json` has SHA-256
`2db5f5341425c1239c661e7b16670b5886a4de1fe5115c35cae1662e0de243fb`.
The allocation subsequently confirmed321680, followed by exact funding321681.
Root's44-RPC funding check at21:40:25 validates all37 public files472,610bytes,
three signatures and exact finalization:36,000 =30,000 vault +5,400 refunds
+600 fee sats at354vB. Its66-RPC capital refresh at21:41:19 confirms all7 prior
outputs consumed on chain by that exact allocation. The39-record/42-RPC check
at21:45:07 validates exact Alice/Bob recovery signatures with Carol absent,
observes the30000-sat vault unspent at depth1 and gets non-BIP68-final for those
exact bytes on both nodes. Earliest recovery block321693 under the current anchor.
Actual11,732-byte `case12-funding-csv-two-node.json` has SHA-256
`738ea3fc880c385db319dd90574eeaa80632d0010941b113922a37cb832b8ecf`.
Independent case12 setup/funding review80999/d52b93 and root's literal full
replay40158/3d7d34 exited0. All8 public records94,625bytes match root's39-file
manifest; ten signatures, four Taproot rounds, nine exits, twelve preauthorizations
and45 focused refusals pass. Both actual34,686-byte outputs have SHA-256
`d3b9329eaa654e9cd1bb1be9211f11a26d1b9506f9f9caec261b3dd6047ba99f`.
Root read all394 verifier lines and checked exact script/metadata before/after.
The later terminal files are outside that independent review. A separate42-RPC
refresh at21:52:06 confirms source depth2 and the same exact premature refusal.
The same service remains live at21:53:01, without an actual terminal exit. The
private CHECKPOINT.md records full artifact identities, exact commands and root
reproduction provenance. No executable source, custody, fee or runtime change.

The separately scoped terminal review is now CLOSED: reviewer0e6408 exit0 and
root d6b1c4/session40908/cd7f99 exit0 ran the same complete328-line verifier.
Both44,074-byte outputs have SHA-256
`e6e0b0eb90c251f4ba0d106fe51aafcdedbeb98875ea028efb3b6323bca1a258`.
All5 public files67,531bytes match the separate chain and capital manifests.
Manual transaction/PSBT serialization, BIP341 digest, Alice/Bob primitive Schnorr
signatures, empty Carol slot and Taproot leaf/control membership pass. There are
17 terminal-only mutation cases:16 product refusals and one separate intent-only
binding refusal;23 nonempty mutant signatures fail primitive verification.
The complete ledger, exact command, metadata pins and root reproduction provenance
are retained. Root's initial readback assumed the tool result was at the wrapper
top level and failed; inspecting its actual nested result fixed only that diagnostic.

Root's separate saved-capital audit bac0f8 exit0 at22:30:43 reconstructs3 nodes,
11 outputs,4 consumed edges and7 leaves from8 public files94,251bytes:
49,927 =182 allocation fee +600 funding fee +500 recovery fee +48,645 leaves.
It does not establish current spendability, private restoration or completed-case
acceptance. At22:41:51 the exact two-node check74671/32fa67 exits0 with39 public
files477,849bytes, stable321685, source30000sats unspent at depth5 and exact recovery
absent/non-BIP68-final. Seven further tip blocks are needed for next-block
eligibility under the same funding anchor. Mature hostile reports, confirmed
recovery and successor capital reuse still need their own bounded review; do
not repeat either closed setup or terminal matrix during unchanged CSV waits.

Earlier20:13 milestone and evidence detail, preserved as dated history:

The first recovery uses Bob/Carol signatures without Alice; exact recovery
79cb7f31 and replacement 9e476e3d confirmed together in block 321662. Root's
19:35:38 48-RPC check matches all four case transactions and active anchors on
both nodes, with the original fee child absent. Root's 19:42:25 72-RPC check
also confirms the exact successor allocation in block 321663 and consumption
of all eight prior leaves, at stable tip 321664. These retain full raw witnesses,
not merely txids or non-witness serialization.

Retained current diagnostic bundle:
`live-run/presigned-v2-case10-checkpoint.vFDKJ2/`. The independent original R5
command is 36,539 bytes, SHA-256
`5db00e7427516ec11b76016f51d98779d6cf00f8ca4d3d254bc3049b1243fc97`.
Its stored script has one patch-added final LF (36,540 bytes, SHA-256
`0209b202be91796ba3e02091124f77577d537b1547cd588bd8c82a732663d246`).
Root removed precisely that LF in memory before literal execution. Reviewer
97253/36a7fb and root 34879/72804b both actually exited 0; both full stdout files
are exactly 17,953 bytes, SHA-256
`a48d2573ec1d3ca177e8748a0fa77974fcf048507070f9bb5db669c515d11e18`.
The ordered 20-file manifest SHA-256 is
`96f81af02d8fe65c08251d34914d39c826e0f99f64ba9294abf12eb4b9a17b17`.
Manual signature/Taproot checks and all 48 fresh-parse mutations pass. Historical
Core refusals and recorded timestamps are not fresh Core replay, actual custody
restoration or independently proven chronology.

Root's case11 allocation check 79913/c02209 exited 0 at 19:39:54, rehashing 22
records / 350,269 bytes. It recomputes predecessor
`1f520717d9885375ac1cff4f36ee259a2ba257ce07f69c4740092d05566c25c7`:
56,508 = 195 allocation + 5,100 case fees + 51,213 in eight leaves. The next
allocation is `a1b6bb3c30a2da185c2caac86b6d481ce3b72e98cc21902215ea6e96076eb573`;
51,213 = 36,000 game + 15,027 reserve + 186 fee, at 618/max619 vB. All eight
native signatures verify; no new sponsor is introduced. New intent/signed
records are 20,009/2,289 bytes with SHA-256
`3d500a318432031f2877793cc232eb08bd0e262ee64614f4dedb9d3b1ee21e37` /
`294d185cc29c355b901b3c8fa6757357712765875cfbd628bd3ad71a03027cf2`.

The same frozen run is now supervised by temporary user unit
`presigned-v2-follow-vFDKJ2.service` after the 19:08 exit0-without-completion and
a later missing foreground handle. Causes remain unestablished. Fresh complete
journal preflight passed before launch; no source, funds, fee or custody
replacement occurred. Independent supervision review and root's live PID/locks
check pass. There is no automatic restart or boot enablement. The operator
runbook supersedes the old handle instructions; a launcher's exit0 or a running
unit's Result=success is not native lifecycle completion.

The next recovery case (initial round, Bob absent) has exact funding confirmed
in block321665. Root's `observe-case11-two-node.mts` invocation72739/ed0e88
exited0 at19:58:50 after rehashing all29 public files403040bytes and42 read-only
RPCs, zero wallet calls. Both nodes share stable321666, match full allocation
and funding witnesses/active anchors, and show funding:0 unspent30000sats at
depth2. Both reject the exact saved recovery700d17d8 as non-BIP68-final; it is
absent from both mempools and txindexes. Earliest recovery block is321677 if the
funding anchor remains active. The actual9724-byte output is retained in the
diagnostic bundle as `case11-funding-csv-two-node.json`, SHA-256
`9517ecd52ff5bd773b74fc17528b33c1bddab7c95b079dcf2da4e0906fa37e2d`.
The15467-byte observer script has SHA-256
`dc22a5bbe7ab4235b8bb17d5e8cf273626761aca25fb5b0521097c5e1d3f0027`.
This checks historical public restoration bindings, not new private restoration,
mature hostile Core controls, confirmed recovery or final acceptance. A fresh
42-RPC check 56565/be8e1e exited 0 at 20:12:53 with both nodes at stable 321671,
the source unspent at depth 7 and the same premature rejection. Its actual
9,722-byte output is `case11-csv-depth7-two-node.json`, SHA-256
`a293c1b8adaef56f2c8f7175fd8e82d37827999c9f10b0e8659cc2caafdc713d`.
The live service remains waiting for CSV, with the same invocation/PID and no
terminal exit. The current and frozen source/HEAD both reverified at 20:12:49.

Independent case11 public review is closed after actual reviewer 40484/b4ee5f
and root pinned full replay 10454/1e91ec exited 0. The final verifier is 46,413
bytes, SHA-256 `21ff5afb761bb844dba371b5026fb6cb0a4ce7d8ce59f8d18c8153eb175ffed4`.
Root read all original lines and the complete import-only R2 correction, pinned
its hash and inode/metadata before/after execution, then rehashed all ten public
files / 100,590 bytes. Ordered LF manifest SHA-256:
`ca94227b0d4f5d6accb4e856276bf9ba80a88dd26e1962a63b903a50add70bde`.
Root 3eda60 at 20:11:57 verified exact 43,724-byte equality of reviewer stdout,
root's first run and its later pinned run; SHA-256
`837b2b3609b079f13e6a3e3d281e25dd2415717ea228bc3b7d056cf5cb88708c`.
All four Taproot rounds, nine exits, twelve public counterparty preauthorizations,
eight allocation/three funding/two recovery signatures, 94 fresh-parse refusals,
91 altered-transaction signature failures and 11 corrupt-native-signature failures
pass. No designated leaver signature is present in the public exit material;
actual Alice/Carol recovery signatures leave Bob's slot empty and payout unchanged.
Public receipts remain historical bindings, not new decryption or chronology proof.

The initial reviewer R1 exited 1 on its root/frozen dependency-path guard before
public-data validation. Its original 46,326-byte script, full 1,114-byte stderr
and attempt/lookup ledger remain retained. R2 explicitly resolves Bitcoin/Noble
from frozen node_modules; no product source or live state changed. Root's initial
pass overlapped that private script revision, so the later pre/post-pinned full
replay is the decisive reproduction. Actual root provenance is retained as
`case11-root-reproduction-provenance.json`, 2,152 bytes, SHA-256
`d9b2202eac42b924dbb3d2fa69c348c44fcc1b47384201e62f6400367f2efeb3`.

Root11209d at20:01:02 revalidated all six final helper/test/config identities
against their4507-byte preparation record, SHA-256
`58153cf99daa4e07bc2bdd2fa5bf7ad876be09e95a2c5e90ea85cb953fcb8148`.
Both final output roots remain absent. The private CHECKPOINT.md now records
the recovered exact sequential commands and three runtime helper pins. This is
identity recovery only, not another test run or execution of final assemblies.

Seven recovery lifecycles, final capital return, BOTH actual sequential assemblies,
retained-byte verification, independent FINAL review and full requirement audit
remain mandatory. No final helper has run. Preserve the pinned executable source
and HEAD until their source/HEAD-bound operations complete; only physical-device
checks are deferred and mainnet/public-app/outreach remain separately gated.

The dated earlier evidence below is historical where superseded above.

Source `49e4240d66a9780a7403996e4cca96478eb50e797e158ffb38157d910c9071ae`
contains the unchanged harness correction plus supported Next.js 16.3.3 and
sharp 0.35.4 security updates. The actual installed sharp native library uses
patched libheif 1.23.2. Before/after audits verify two affected packages then zero
known advisories; all four typechecks and the byte-identical offline utility pass.
Exact evidence, upstream links and limits are in the
[security checkpoint](./DEPENDENCY-SECURITY-2026-09-11.md).

The preceding 1cc optimized browser actually passed at 00:42:03 UTC, including the
complete game, all five fee families and four session reauthentications. Its
three retained artifacts total 61,022 bytes and match the original bytes. That
source's CI was deliberately cancelled for the confirmed dependency finding;
the private full 52-command wrapper was never launched, its draft remains empty and
unpublished, and its retention tooling was not pushed. These are not current
full acceptance. New full 52-command evidence, both image archives, reviewed
operational bindings, all 19 funded default-Signet cases and both final assemblies
remain required.

Current execution is pinned to commit
`163afb1ad68566c1ae33d59811b775add4988e12`. A clean detached checkout with a real
locked installation and all 133 offline inputs verified started the complete
private 52-command invocation at 01:05 UTC. It actually completed all 52 commands
and the original outer wrapper exited0 at 03:31 UTC. All 19 isolated-Core
lifecycle cases completed (six solo, four cooperative, nine recovery), including
all five fee families and each recovery's refusal at CSV depth11 followed by
the same bytes at depth12. Database suites, offline build, complete saved-file
recovery and optimized browser also passed. The browser used six virtual PRF
credentials and four genuine reauthentications; saved-file recovery confirmed
31 browser-signed transactions and ten replacement fee children, with zero
network requests and no persistent secret storage. These remain isolated-Core
results, not real default-Signet.

The complete private archive has 112 members / 1,319,334 compressed bytes.
Local run digest:
`e3742b80a67c6618b0a30da7d36fdd0be1eadd49ea485f087d91214483a1b6ab`.
Archive SHA-256:
`6723fbc495176336e72fe3cbec7b31b2aa4f42de4a33f6a9afb67c553031b600`.
Independent reviewer invocation also exited0. Root recomputed 53 commitments,
compared all 111 original/copied files plus the utility and all 112 decompressed
archive members, then rehashed all 832 independently reviewed inputs /
13,966,156 bytes. All 373 source entries, 133 offline inputs, 52 exact command
records and 112 newly restored members match. Original, copied and restored
semantic validators pass. Diagnostic SHA-256:
`481e91ecdd18a9c26b173f4276e0b14f857006f1858683f38325556bb54034fd`.
The lifecycle's 84 confirmed transactions and 83 native restoration signatures
are retained summary claims backed by pinned assertions, not independently
re-observed chain/signature material. Raw browser runtime logs, participant
custody journals and real-chain observations are outside this archive's scope.

Normal CI
`34548633099` has passed all three jobs. Its local 52-command run completed at
01:48:10 UTC, including optimized-browser execution from 01:42:05 UTC. All
12 current log/receipt/archive-result records are privately retained (326,450
bytes); root rehashed each and recomputed all 69 receipt/command commitments.
Local run digest:
`46496b01ec038ce0149b53d59c3fbece0613a0605dbec9a94fe821004ec0424b`.
The reported 112-file normal-CI archive is not retained by that log-only
workflow; do not substitute it for the separately retained private full archive.
Independent review matched all three fresh GitHub log downloads, all 12 retained
records, all 69 commitments and exact 52+7+7 command/timestamp ordering. Root
then rehashed all 34 selected safe inputs / 470,499 bytes, recomputed the 69
commitments and matched every diagnostic command to its retained receipt.
The original three jobs still report success. Combined diagnostic SHA-256:
`75bb7c71bebb09430ae45fe229698d727616905de2964aa311dbf563501c8fe4`;
detailed CI diagnostic SHA-256:
`48221e79baff38b4c4a3a0be4ad939184fca282ce21884f33e2e2539152177b3`.
This review does not recover the normal-CI archives or 132 raw child transcripts.

The private complete-run reviewer's original synthetic test found nine malformed
high-bit numeric headers accepted after ASCII decoding masked bit7. Historical
failure artifacts remain intact. Only that private decoder gained a raw-byte
ASCII guard; application source and the running acceptance candidate did not
change. The same 79 test identities now pass: three positive controls, 76
negative cases, all 78 unchanged candidate hashes, and a separate replay of the
nine retained malformed archives. The decompression test was also corrected to
require a canonical gzip header and actual `ERR_BUFFER_TOO_LARGE`; its former
early header refusal did not prove inflate-limit coverage. Diagnostic SHA-256:
`dcddda374fb87d158a865e6f9c175d4d8ee85a18c3162e271ced79cfff8c7710`.
Root rehashed 254 unique selected files / 628,697 bytes and independently
replayed the 112-member valid control, all nine prior failures and the inflate
boundary. This is synthetic parser evidence only. The corrected reader was
subsequently used for the actual complete-run review above, after root observed
the original wrapper's exit0; its synthetic pass alone supplied no approval.

The separate zero-cost public retention run `34549222062` passed both profiles
on tooling `775f160743e022ae10ccaddee4c3390ee2e9e28b`. All six assets are in
test-only prerelease `386718829`, tag
`presigned-v2-test-evidence-49e4240d-20260911`. All six downloads match the exact
asset hashes. Both actual 39-member archives passed canonical-envelope checks,
all 18 historical OCI layers / 25,882 entries per image, restoration and
semantic validation. Fresh pinned content-scanner reports match their hosted
reports; independent actual-byte review also passed. Download-verification
SHA-256: `0a7a9b1d1c0e7d6b297b96855765f198c4b6f3f155486d925ad26c17e5ad111a`.
This is bounded content review, not universal proof of secret absence or
approval to use the synthetic images with real custody.

Independent current image review compared every decompressed member to its
retained counterpart, enumerated all historical layers and checked embedded
source/network/offline utility bytes. Both fresh sequential scans actually
exited0 and matched hosted reports byte-for-byte. Root rehashed all 87 selected
original files / 2,191,967,390 bytes, checked four known collector-only hardlink
pairs (all 78 restored members remain single-link), reran both semantic
validators and verified the unchanged live draft/body/assets. Diagnostic SHA-256:
`d6cffbf12dabe3370e7c048dd30e5274bc3da08a0cb319729aff8d348e8101c7`;
retained image-review record SHA-256:
`0b5fbf52db6529eb02d55cee24ea752fe59c4eaa8abedf90d41e53612c926e13`.
This completes the image-review gate. The complete private local run and its
byte review now also pass. Exact final notes (3,382 bytes) passed independent
review of 13 claims, followed by root's complete 15-file / 877,821-byte rehash and
static publisher check. Note-review diagnostic SHA-256:
`d0f0aacd74c251db93958a82053ef18aeb4112f3770a32e3bb0eb463f605ef8f`.
The required private note-review binding SHA-256 is
`dacf4c0fab9b0a946aaccb67a3ee52bff120791f403ff69a4a18be7ee299ef52`.
After fresh draft/body/assets/current-CI checks, the authorized publisher
actually exited0 and the prerelease was published at 03:57:18 UTC. Root's fresh
03:58 UTC GET confirmed exact final notes, all six assets and candidate tag.
Publication-verification SHA-256:
`e89f3649ffc3b2f3210e59781c4c196d0308b22926708361e7c5c6338cb7f778`.
No production release, public application, mainnet spending or funding approval
is implied. The private 112-file local archive remains private.

The current unfunded default-Signet restoration drill actually exited0 at
01:03 UTC: two same-wallet restarts, two whole-host restorations, ten rejection
boundaries and two attempt-bound native signatures, with zero wallet transactions,
test sats or public sends. Root separately verified the stopped host and current
sequence2 completion. Receipt SHA-256:
`edd7c946e2620cf4d61d14b24770c495ec8f5577fd4a1974caa96ff51b4319ee`.
Independent bounded review checked all 28 safe records / 35,295 bytes, three
public native signatures, distinct signed challenges, paired attempts/completions
and five retained negative records. Root rehashed those records and nine source
files and reverified all three public signatures. Diagnostic SHA-256:
`019dd4171b1a88ec7132a5ca334536341585f2604fa4cd3eb3d73418c25c92b3`.
The reviewer did not read private wallet bytes, rerun the drill or independently
wait on its already-completed original invocation. Separate-directory retention
is not whole-disk-loss protection; at that checkpoint, funded default-Signet
lifecycles had not yet run.
At 01:54 UTC the same restored unfunded host was started for synchronization,
not funding. At 02:06 UTC it matched height/headers 321565, txindex synchronized,
ten active peers, zero confirmed/pending wallet sats, wallet broadcasting
disabled and loopback-only RPC. Before/after host audits exited0 with unchanged
security services and the existing terminal/unrestricted-session diagnostics.
Fresh unsigned transfer preparation completed at 03:59 UTC after rechecking
chain/recipient/input state. It keeps the same restored host and source.

The new private publication, transfer and final-retention helpers are pinned;
older helper outputs are not copied as approvals. Actual current publication, transfer and both final
assembly entry points refused missing full local evidence before their external
writes, wallet/transaction actions or assembler launch. The final helper's
46 boundary refusals, seven harmless child-capture cases and strict types pass;
this preparation is not software acceptance. Independent final-helper review
verified a corrected redundant directory-sync ordering issue and all 15 actual
synthetic fixture files. Root rehashed all 44 selected safe files / 235,206 bytes;
diagnostic SHA-256:
`eb66b74ae9ff3b3143d075a7d2b9fb2d2f874da29b5c070216641609f64c3105`.
The actual outer exit0 is still mandatory; a marker beside a failed invocation
is not complete retention. No final assembler has run.

The current seven-native-input isolated-Core check actually exited0 at
01:32:24 UTC: three P2WPKH and four P2TR inputs, 89,717 sats equals 147 fee plus
89,570 confirmed unspent return, actual 488vB below the fixed 490vB bound,
and two hostile mutations refused. Imported source was pinned before/after;
the network-disabled Core stopped before the receipt. Receipt SHA-256:
`84159725fb5a5ba5f0a70b1a227154336f633bf7956a96094460da86d0206074`.
Neither real Signet wallet was opened. This proves the native transaction shape,
not current public-chain inputs or a reviewed live unsigned intent.
The independent bounded review rehashed the receipt/runtime and reconstructed
the 490vB bound and fee arithmetic; it did not recompute the historical signed
transaction's reported 488vB. The fixture helper awaits Core termination but
does not assert Core exitCode0. No reliable historical fixture PID was retained,
so current process absence is not independently proven. Root observed the
original wrapper exit0; these distinct claims are not interchangeably stronger
evidence or transfer approval.
The actual fresh unsigned transfer contains exactly seven native wallet inputs
(three P2WPKH, four P2TR) totaling 89,717 sats, one restored-recipient output of
89,570 sats and a fixed 147-sat fee. The two other known participant/vault leaves
totaling 29,700 sats are excluded; no old participant graph is resumed.
Prepared record: 21,594 bytes, SHA-256
`46775d75c97c9cf3755ff2addb4d1658da5180771a1e898fec1b60e4ff5a3829`.
Root's 04:03 UTC read-only check decoded transaction/PSBT and four exact parent
transactions, recomputed both commitments, verified the recipient restoration
binding and durable journal, and independently derived the 1,957-weight / 490-vB
maximum. An initial checker invocation correctly refused its frozen-directory
cwd; rerunning only the inline checker from the required main cwd passed.
Independent actual-intent review passed. Root read the313-line checker and
rehashed all19 selected inputs/154,276bytes, matched all seven input rows/four
parent transactions and independently compared11 ALL/DEFAULT signing digests.
The standalone reviewer's optional-ECC address constructor failed; its preserved
one-line correction uses direct Bech32m for the already checked witness program.
Corrected syntax/runtime and preservation checks exited0. Final diagnostic:
`fa841fdc6a2a6cf218c70b088f255c3c8df224c70e6f8f4b1984562976fddfee`.
Stored audit review did not replace fresh chain or full recovery checks.
The exact signing invocation then exited0 after those fresh gates. Root verified
all three ECDSA and four Schnorr signatures against the independently reviewed
digests; all use SIGHASH_ALL. The exact saved transaction is931bytes/1,951weight/
488vB and preserves the147-sat fee and89,570-sat recipient. Signed-record SHA-256:
`f88c16a31795eded1f9a14143ca06a56a8466e6b721aaa9353515044b8fa3920`.
Exact broadcast also exited0 after fresh inputs/relay/recovery gates. Its saved
bytes were observed, with no duplicate transaction. The bracketed two-node
observation at04:17 UTC reported unconfirmed on one identical active tip at
height321579; the recipient subsequently reported89,570 pending and zero
confirmed sats. That pending checkpoint is now historical.

At 04:41 UTC the original read-only watcher completed after observing 89,570
confirmed sats and zero pending. A fresh two-node check at 04:42 UTC confirmed
the exact unspent seed in block321580, depth2, with unchanged saved witnesses.
Root rehashed the dated observation and all four immutable transfer records.
The fresh initialization invocation actually exited0, reserving the exact19
cases and verifying 83 native-wallet targets through an actual backup restore.
Root's separate no-RPC custody check reverified all83 signatures, the durable
journal and exact seed/plan before any allocation. Run SHA-256:
`b73a625fa5d9fa388fa50c7c140f841d8520411d8a9717c854c539df5c551c25`;
native restoration proof SHA-256:
`0b81d707fb0e31cb438c4d4900e047972a3319c572e2b01079d1c179c431c1a2`.
The first funding-allocation invocation actually exited0 at 04:44 UTC with a
submitted result. Its decoded transaction has one input/seven outputs, 334vB,
101 fee sats, 81,000 planned-output sats and 8,469 reserve sats; all outputs
match the exact run. Root revalidated the signatures and immutable template.
The first inline readback incorrectly looked for the fee on the witness record;
using the fee from its immutable intent corrected only that diagnostic.
The allocation subsequently confirmed. At 05:09 UTC the same resumable runner
submitted the first game's funding-fee replacement. Funding and that replacement
subsequently confirmed, followed by both solo exits and the solo-fee replacement.
The same live runner submitted the final sweep and its approved replacement by
06:01 UTC. They subsequently confirmed in block321589; the runner reported
the first case complete by06:30:50 UTC and submitted the next allocation.
Root's 05:18 read-only check exited0: 14 saved public records, six restoration
receipt bindings covering all nine owner exits, and paired checkpoint135 match
the exact graph. The pre-funding checkpoint contains complete custody and
signing intent without funding signatures. Actual funding signatures and both
fee-child candidates validate; each preserves the participant's 1,800-sat refund
while sponsor change alone funds the 3,000-to-4,000-sat fee increase. This was
saved-evidence verification, not fresh chain confirmation or new decryption;
no RPC, new signatures or writes occurred.
Root's 06:01 read-only exit check revalidated the designated-leaver signatures,
unchanged counterparty preauthorizations, exact successor and both hostile
script rejections for each exit. An inline comparison initially assumed a
Uint8Array had Buffer's equals method; normalizing only that diagnostic comparison
corrected the checker, which exited0 without changing source or transactions.
The 06:08 terminal/capital check exited0 over19 saved public records: Carol's
9350-sat source becomes a9050-sat payout with a300-sat/111vB sweep. Both210vB
fee children preserve that payout, with3000/4000 fees paid from sponsor change.
Core rejected the saved missing-signature and changed-payout mutants for script
reasons. The eight-transaction first-case graph contains no unrelated inputs;
89570 =101 allocation fee +13800 case/replacement-candidate fees +75669 in ten
terminal outputs. That earlier saved-byte check did not itself establish live
confirmation or UTXO availability.
Fresh two-node verification actually exited0 at06:33:26 UTC: all eight first-case
transactions have exact saved witnesses and active-chain anchors, including the
final sweep and replacement in block321589. All three superseded children are
absent. A separate no-RPC check exited0 at06:33:25 over22 public records,
recomputing the completed predecessor digest and verifying every next-allocation
input, output and signature. The ten exact prior payouts, refunds, sponsor
changes and reserve become36,000 next-game input sats,39,442 reserve sats and
a227-sat fee:75,669 total input sats,754vB actual/755vB maximum. No unrelated
coin is imported. Next-allocation intent SHA-256:
`9bf6551a3c710d30b7759451849a0f26cb696ef940e65afb694c44fa6a81cc27`;
signed record SHA-256:
`90e05c380b3cf41a1a079f208ad049e5cf4629a9d707ce138ccb6733641db0ed`.
That exact allocation was pending on both nodes at 06:33. By 06:46 the same
runner had confirmed it and submitted the second scenario's funding.
Independent review of the first case and successor found no
actionable issue in the 46 selected public records. Root independently checked
the fee authority/submission links, then rehashed all 775,519 reviewed bytes and
matched the reviewer's ordered-record digest and reported commitments at 06:49.
This is public-record verification, not a fresh private-backup decryption or
independent reviewer RPC check.

The second ordering, Alice/Carol/Bob, completed by 07:27:52 UTC. Root's separate
checks verified both solo exits' exact counterparty preauthorizations and
designated-leaver signatures. The final sweep spends Bob's 9,350-sat output with
one key-path signature, paying 9,050 sats with a 300-sat fee at 111 vB. All six
saved hostile mutations were rejected for script reasons. The 07:28 saved-data
check covered 17 public records, including six restoration-receipt bindings and
the immutable funding intent; it performed no decryption, signing, RPC or writes.
The five-transaction case graph closes exactly: 75,669 input sats =227 allocation
fee +1,800 fixed case fees +73,642 in seven terminal outputs. Those outputs are
9,500 for Alice, 10,250 for Carol, 9,050 for Bob, 5,400 in wallet refunds and
39,442 in reserve. Recomputed predecessor commitment:
`becc38614d08ac96a5174452796306598e82f629e55db78c5d420569ab3eb98f`.
Root's expanded 19-record check exited0 at 07:30:14, verifying every next-input
parent, signature and exact predecessor binding. The Bob/Alice/Carol allocation
consumes all seven leaves: 73,642 =36,000 next-game sats +37,460 reserve +182 fee,
604 vB actual/606 maximum. Intent SHA-256:
`19147fc95c16b9d8b9652fc5d7372889ace7708753233fb752d404a7433ea204`;
signed record SHA-256:
`1b84d0303930cc05529fb28ec7145b988508bebfdb97041df3a76274ea1a3c86`.
The separate 58-RPC/zero-wallet-call two-node check actually exited0 at 07:30:57:
all five second-case transactions match their saved witnesses and active anchors
at heights321591 through321595. Both nodes then held the exact next allocation
in their mempools, unconfirmed. No source, input, fee approval or runner changed.

The third ordering, Bob/Alice/Carol, completed by 11:40:44 UTC. Its allocation
confirmed at height321607, funding at321609, Bob's first exit at321610, Alice's
second exit at321611 and Carol's final sweep at321612. Root's separate live
checks validated the two exact counterparty signatures for Bob's exit and one
for Alice's, with each designated leaver supplying the required final signature.
The first payout is 9,500 sats; the second is 10,250. Carol's 9,350-sat output
is swept with one key-path signature into 9,050 sats and a 300-sat fee at111vB.
All six saved hostile mutations were rejected for script reasons.
The 11:18 saved-data check covered17 public records: complete authorizations,
six restoration-receipt bindings, immutable funding/exit intents and the complete
value graph. It performed no decryption, signing, RPC or writes. Public receipts
establish exact bindings, not a new decryption or physical-storage proof.
The five-transaction graph closes exactly:73,642 input sats =182 allocation fee
+1,800 fixed case fees +71,660 in seven terminal outputs. Those outputs are
9,500 for Bob,10,250 for Alice,9,050 for Carol,5,400 in wallet refunds and37,460
in reserve. Recomputed predecessor commitment:
`d2c0cb911f8748290eb27b1c52624a8b3265c01e416a88d8bec406f527aa5a32`.
Root's expanded19-record successor check exited0 at11:41:58, verifying every
next-input parent, signature and exact predecessor binding. The Bob/Carol/Alice
allocation consumes all seven leaves:71,660 =36,000 next-game sats +35,491 reserve
+169 fee,560vB actual/561 maximum. Intent SHA-256:
`1d15224cb54afd40bad11305f6d3ada4f7cdb0aeaecf6e6b5a196176992b25e1`;
signed record SHA-256:
`d27aaea956d285b1bd1d15be8e9d171c00446c9408b41dbaf155598615a8c251`.
The separate58-RPC/zero-wallet-call check actually exited0 at11:42:38: all five
third-case transactions match their saved witnesses and active anchors at the
heights above. Both nodes share stable tip321612 and hold the exact fourth
allocation in their mempools, unconfirmed. No source, fee approval, input set or
runner changed. These are root checks, not another independent reviewer run.

The fourth ordering, Bob/Carol/Alice, completed by 12:11:30 UTC. Its allocation
confirmed at height 321614, funding at 321615, Bob's exit at 321616, Carol's at
321618 and Alice's final sweep at 321619. Root verified the exact counterparty
preauthorizations and each designated leaver's required final signature.
Alice's owner-only sweep pays 9,050 sats from 9,350, with a 300-sat fee at 111 vB.
All six saved hostile mutations were rejected for script reasons.
The 12:06 saved-data check covered 17 public records: all authorizations, six
restoration-receipt bindings, immutable intents and the complete value graph.
It performed no decryption, signing, RPC or writes. The five-transaction graph
conserves 71,660 sats as 169 allocation fee, 1,800 fixed case fees and 69,691 in
seven terminal outputs: 9,500 for Bob, 10,250 for Carol, 9,050 for Alice, 5,400 in
wallet refunds and 35,491 reserve. Recomputed predecessor commitment:
`4be5e284c48a920cdeb77108e5b39633a4df623d7018a9f54333e9deede58fd9`.
Root's expanded 19-record check exited0 at 12:12:42, verifying every successor
input, exact parent witness, signature and predecessor binding. The Carol/Alice/Bob
allocation consumes all seven leaves: 69,691 =36,000 next-game sats +33,509 reserve
+182 fee, 604 vB actual/606 maximum. Intent SHA-256:
`06b661042ee75dbfd589027a246482d32a485fa79654c844ab71725e16291c1e`;
signed record SHA-256:
`93bccac3c3177e632fe5612f77eb3e0662e30d098e29393cce95f0e2b2ee4113`.
The separate 58-RPC/zero-wallet-call check exited0 at 12:13:35: all five fourth-case
transactions match exact saved witnesses and active anchors at the heights above.
Both nodes then shared stable tip 321619 and held the exact fifth allocation pending,
with a 182-sat fee at 604 vB. No source, fee approval, input set or runner changed.
Public receipt bindings are not a new decryption or physical-storage proof;
these root checks do not constitute another independent reviewer run.

The fifth ordering, Carol/Alice/Bob, completed by 12:28:45 UTC. Its allocation
confirmed at height 321620, funding at 321621, Carol's exit at 321622, Alice's at
321623 and Bob's final sweep at 321624. Root verified the exact counterparty
preauthorizations and both designated leavers' required final signatures. Bob's
owner-only sweep pays 9,050 sats from 9,350, with a 300-sat fee at 111 vB.
The 12:27:27 terminal check covered 17 public records: all authorizations, six
restoration-receipt bindings, six saved Core script rejections, immutable intents
and the complete value graph, without new decryption, signing, RPC or writes.
The five-transaction graph conserves 69,691 sats as 182 allocation fee, 1,800
fixed case fees and 67,709 in seven outputs: 9,500 for Carol, 10,250 for Alice,
9,050 for Bob, 5,400 in wallet refunds and 33,509 reserve. Predecessor commitment:
`15e121adf9b7168de3599cae8f35da7ac0aa8e14d450721a576a01628e0499ef`.
Root's 54-RPC/zero-wallet-call check exited0 at 12:27:56, confirming all five
exact saved transactions and active anchors on both nodes at stable tip 321624.
Its expanded 19-record successor check exited0 at 12:29:27 and verified all
seven exact predecessor inputs and signatures: 67,709 =36,000 next-game sats for
Carol/Bob/Alice +31,540 reserve +169 fee, 560 vB actual/561 maximum. Intent SHA-256:
`776ea3815e08d898d16b8437e8e9dadfed618f85283fd2a2a025f27a6faf1948`;
signed record SHA-256:
`030d8e247795a9e4ea8956f6da4f684d7df2798b811034a3b93c068afdc11060`.
The separate 18-RPC/zero-wallet-call observation at 13:25:01 bound that exact
signed record and found the sixth allocation still pending on both nodes at
stable tip 321626, unchanged at 169 fee sats and 560 vB. Blocks 321625 and 321626
had not included it; the cause is not established by mempool acceptance, peer
traffic or block statistics. The same runner remained live, with no source,
fee approval, input-set or custody changes.
The sixth allocation subsequently confirmed in block 321627. Root's separate
26-RPC/zero-wallet-call check exited0 at 13:40:23: exact saved allocation witnesses
and active anchors match on both nodes at stable tip 321627, while the exact
sixth funding remains pending in both mempools, unbroadcast false. Funding
conserves 36,000 input sats as 35,400 outputs and a 600-sat fee at 352 vB.
The separate eight-public-record check exited0 at 13:39:55, verifying the graph,
all allocation-confined funding inputs, immutable signing intent and six public
restoration-receipt bindings. Graph digest:
`ef6bb63d8b22619066c1622de8f8d557104a3ef2981cded72d4b8665f72c606e`;
funding-record SHA-256:
`ec3500fa7638d3068e3b04ba98078ca151f47741b669b56aed0eb65604f751b3`.
These are root public-record/chain checks, with no new decryption or signing.

Fresh bounded independent review of the five completed cases found no actionable
issue across 110 public records / 1,075,347 bytes: six allocation pairs, all five
completed cases, and all 27 first-case fee authority/candidate/submission records.
The reviewer recomputed the source identity and all five complete capital graphs
and predecessor bindings, including the first case's three approved replacements.
Its self-contained read-only reproduction actually exited0 at 13:41:56. Root
separately rehashed all 110 records, inspected the exact extracted read-only
helpers and reran the reproduction to actual exit0 at 13:46:35. Every path,
length, hash and case result matches. Ordered relative object-manifest SHA-256:
`7273a24af4136834b78824e5e665e040fd03608981013ade8903890781f9bf77`;
ordered absolute path/hash-pair manifest SHA-256:
`ce170727bad891defceeccc01293dbf8d2f5515150e058cb59f1c6f3f55e2091`.
This is public-evidence review, not reviewer RPC observation, private-backup
decryption, physical-storage proof or final whole-run acceptance. The sixth
case's funding is outside that independent review's scope.
The sixth ordering, Carol/Bob/Alice, completed by 14:36:19 UTC. Root's 17-record
terminal verification exited0 at 14:35:23: Alice's final sweep consumes the exact
9,350-sat successor and pays 9,050 sats with a 300-sat fee at 111 vB. Its single
64-byte key-path signature, both solo authorities and immutable intents, six
public restoration bindings and six saved Core hostile rejections validate.
The complete graph conserves 67,709 sats as 169 allocation fee, 1,800 fixed case
fees and 65,740 in seven leaves. Recomputed completed-case commitment:
`ad03e4fac5b2f797f886a5d363e4a12c76bf2851b91a1399f0d022c926993647`;
terminal-record SHA-256:
`042ad45c2e9b0b1cd9a7686222e9f37170f9b55dc3a947ba4b0c82cbdad94f4c`.
Root's 54-RPC/zero-wallet-call check exited0 at 14:36:05, confirming all five
exact case transactions and active anchors on both nodes at stable tip 321632.
The expanded 19-record check exited0 at 14:38:36, verifying all seven exact
successor inputs, parent witnesses and signatures. Unlike a solo-only successor,
the source-null cooperative case includes the agreed 15,000-sat fee sponsor:
65,740 sats =36,000 game funding +15,000 sponsor +14,548 reserve +192 fee,
635 actual vB /637 maximum signed vB. Allocation-intent SHA-256:
`ff2ec70f207fffdfcfcb8135a6e425d7033f5c08062e8ec4c54e82920b8dda57`;
signed-allocation SHA-256:
`e8a5678707b7108cdfebed9560de4452d04ca55f0c0dde319f7f02f857f98230`.
The separate 22-RPC check exited0 at 14:39:58, confirming the exact allocation
on both nodes in block 321633. Cooperative funding was then independently
checked in eight public records at 14:40:58: exact allocation-confined inputs,
immutable funding intent, full signatures and six public restoration bindings;
36,000 input sats =35,400 outputs +600 fee at 354 vB. Graph digest:
`912c2725cc24610a28bacc9981f2493e7d1d791150517c8b7023b52d69492b47`;
funding-record SHA-256:
`c8a08b79aa4368c9d4284a86de0b010e2b51539bf06dc50923e7754ad95cae05`.
Root's 26-RPC check exited0 at 14:41:23, confirming the allocation and exact
funding pending on both nodes at stable tip 321633. No signing, decryption,
wallet calls, source, fee, custody or journal changes occurred in these checks.
The incremental independent review of the sixth ordering and cooperative
allocation passed to actual exit0 at 14:42:30, with no actionable findings.
Its exact 19-record scope covers all 12 setup preauthorizations, both designated
leavers' final signatures, three original counterparty-signature matches,
funding finalization and immutable intent, six public restoration bindings,
six saved Core rejections, Alice's final sweep, the complete capital graph and
all exact cooperative successor inputs/signatures, including the fee sponsor.
Root separately rehashed all 19 records /120,169 bytes at 14:44:48, inspected
the exact network-disabled command and reran it to actual exit0 at 14:47:58.
Every record and capital/successor result matches. Relative object-manifest
SHA-256:
`dd2b247109d03ce47919070c3b870444fe23051ce8a394e2c7e74ec2c92eb9f9`;
absolute path/hash-pair manifest SHA-256:
`46c2ed1bbf6d47d109d6449af268f590b6b172184163d58283a5b802355e242a`.
This extends, without repeating, the earlier closed five-case review. It does
not re-observe the chain, replay Core mutations, decrypt backups, inspect the
private checkpoint, prove physical storage or review the new cooperative
funding; final whole-run independent review remains mandatory.
The first cooperative case completed by 15:10:07 UTC. Root's 20-public-record
check exited0 at 14:55:08, verifying the final threshold-three aggregate
key-path signature, exact funding:0 source and three 9,900-sat payouts with a
300-sat/197-vB parent fee. All nine fee records bind the same exact graph,
proposal, Alice payout owner, parent authority and allocation sponsor:3.
The 210-vB initial/replacement children pay 3,000/4,000 sats, preserving Alice's
9,900-sat payout and reducing only sponsor change from 12,000 to 11,000 sats.
Root's 46-RPC check exited0 at 15:09:37: exact allocation 321633, funding 321634,
and cooperative/replacement 321635 are confirmed on both nodes at stable tip
321635; the superseded child is absent. Full value conservation is
65,740 =192 allocation fee +4,900 fixed case fees +60,648 across eight leaves.
The predecessor commitment is
`98cc3eb8d9aadb6ce6ff350c20af4fce6689f6852b84c22da75329040687a748`.
Independent incremental 20-record /326,320-byte review exited0 at 15:10:38.
It independently rebuilt four aggregate public keys, scripts, trees and control
blocks, checked the complete nine-exit/12-preauthorization graph, all funding,
spend and fee signatures, six public restoration bindings, two saved Core
rejections and two actual local hostile-byte refusals. Root's separate readback
and exact command reproduction exited0, the latter at 15:17:24. Every file,
capital/fee result and both manifests match. Relative object-manifest SHA-256:
`a9fcf22c13df269bae09cb4cfed249fdb8a9340f382b3ead106596af8c49cd17`;
absolute path/hash-pair manifest SHA-256:
`e74ed1a1ecce032fb639c1e409e6e5b3e868b4ffd11635bd64186433d7998b08`.
Exact reproduced command SHA-256:
`8163012b943219b7cc27a813f1fa9b94c25b616f4b4007e6830f9e8488d61893`.
This public review did not replay nonce/partial contributions, decrypt backups,
inspect private checkpoints, re-observe the chain, replay Core mutations, prove
physical custody or cover the next case. The six receipts are two matching
sets of three, not six new independently replayed decryptions.
The separate 22-record successor check exited0 at 15:10:16. Cooperative after
Alice exits has no new fee sponsor: all eight exact predecessor outputs become
36,000 game sats, 24,459 reserve and 189 fee at 628 actual/629 maximum vB.
Allocation-intent SHA-256:
`be3cc0dfa654f323d5a6039f06085058da4332c9e925268115f1412c680f0e21`;
signed-record SHA-256:
`90b76ee08c82ba03a3f29193a8772b9e5fc7b7b432638441ba0c3ed68aa0fceb`.
The 22-RPC check at 15:10:47 confirmed that allocation in block 321636. The new
funding's eight-record public check exited0 at 15:12:05; its 26-RPC check at
15:12:46 observed exact funding pending on both nodes, with a 600-sat fee at
352 vB. Its record SHA-256 is
`479a0096cba3d2157a7d24d412f249b713d007b9319c7c0e08d033dc2bd7f3c5`.
The cooperative-after-Alice case subsequently confirmed. Its14-record public
check at15:35:49 verified Alice's designated-leaver final signature and exact
counterparty preauthorizations, then Bob/Carol's two-party aggregate key-path
signature consuming Alice:1. It pays9,950 sats each from20,200 sats, with300
fee sats at154vB. All immutable intents, six public receipt bindings and four
saved Core hostile rejections match; this is not fresh mutation replay,
backup decryption or nonce/partial-transcript replay. Full conservation is
60,648 =189 allocation fee +1,200 fixed case fees +59,259 across seven leaves.
Recomputed predecessor:
`5fe0d5268e77518a0adb36be527872f6143bd011b068ed36cb97382fd862d000`.
The terminal record is2146 bytes/SHA-256:
`2a1e77a0aa601a9e82c26abf1f2edf47ca57075cd603ee3e7eea796ca782b54e`.
Root's46-RPC/zero-wallet-call check exited0 at15:59:08, confirming the exact
allocation321636, funding321637, Alice321638 and cooperative321639 transactions
and active anchors on both nodes at the same stable tip.

The original follow invocation actually exited143 at15:52:29. The signal's
origin/cause is unproven. Its old writer and parent were absent, not merely
unobservable. Root's read-only preflight exited0 at15:58:39: no other lifecycle
operation, both stable kernel locks unheld, isolated Core PID103746 still exact,
synchronized and loopback-only, both current/frozen source hashes49e4240d,
receiving-wallet backup/proof valid, and all1,278 current files matching the
independently anchored checkpoint1087 (7,542,266 current bytes). The saved
cooperative terminal bytes above were unchanged. An initial supplementary
check used the wrong filename and refused; using the actual step-terminal.json
path passed. No failed check was converted into a pass without an actual rerun.
Root resumed the exact frozen follow command against the same control and
journal. The new writer PID182044/startTicks8881161 was alone and held both
operation locks at16:00:18; no restoration, Core restart, new seed, fee change
or executable-source change occurred. Its first snapshot advanced the eighth
case to complete and submitted the ninth allocation.
The16-public-record successor check exited0 at16:00:46. All14 previous public
records remain byte-identical. Cooperative after Bob exits consumes exactly
the seven preceding payouts/refunds/reserve:
59,259 =36,000 game sats +23,077 reserve +182 fee at604 actual/606 maximum vB.
Every input signature and predecessor binding validates; no new sponsor or
unrelated input was added. New allocation txid:
`3ac8c75d3e32f6ca7abb80308ed740318d7976c2dee63b360832d338a703b519`.
Intent17545 bytes/SHA-256:
`d38e880ab69d7658e5cd25b9bab60d6059235cecded5203504198242623c4781`;
signed record2281 bytes/SHA-256:
`7e32cd8012334af2eac8a858ad74abc9017fe713f96927523c6cc0bfc97f1158`.
The22-RPC/zero-wallet-call check exited0 at16:02:19 with exact saved witnesses
and active anchors on both nodes in block321640. Bounded independent review
found no blocking defect for this intact checkpointed saved-node resume.
Root verified the cited fast paths, lock lifetime, immutable-intent/send ordering,
fresh memory-only cooperative nonces and explicit damaged-state restoration
boundary. The reviewer's synthetic witness-comparison example was independently
reproduced by root to actual exit0: the runner's confirmed() helper compares
non-witness transaction bytes, not witnessed-byte equality. The separate46/22-RPC
checks above explicitly compare full raw.hex with the saved transaction hex.
Their exact-witness evidence does not rely on that weaker helper comparison.
Existing saved files bypass signing; later authorized steps can still sign, and
an interrupted unpublished cooperative final can use fresh nonces for the same
intent rather than reproducing unavailable pre-crash witness bytes. The reviewer
did not inspect private/runtime state, prove the cause of143 or approve the full
run. This closes the bounded resume review, not final whole-run review.

The cooperative-after-Bob case subsequently confirmed. Root's14-public-record
check exited0 at16:17:12, verifying Bob's required final signature and exact
Alice/Carol successor, followed by the pair's aggregate signature paying9,950
sats each. All intents, six public receipt bindings and four saved Core hostile
rejections match. The46-RPC/zero-wallet-call check exited0 at16:18:38 with every
saved full hex and active anchor on both nodes: allocation321640, funding321641,
Bob321642, cooperative321643. Full conservation is59,259 =182 allocation fee
+1,200 case fees +57,877 across seven leaves.
The16-record successor check at16:19:42 binds exactly those outputs to
cooperative after Carol:36,000 game sats +21,708 reserve +169 fee at560/max561vB.
Its eight-record funding check at16:21:07 verified the immutable funding
intent, exact allocation-confined inputs, authorizations and six public
restoration bindings; funding is36,000 in,35,400 out,600 fee at352vB.
Carol's11-record exit check exited0 at16:31:23. The expanded14-record terminal
check exited0 at16:40:20: Carol's required final signature and both original
counterparty witnesses bind9,500 sats to Carol and20,200 to the exact Alice/Bob
round. The pair's single64-byte committed aggregate-key signature consumes
Carol:1 and pays9,950 sats each with300 fee sats at154vB. Intent/proposal
rebuilding, all signatures, six public receipt bindings, four saved Core
rejections and the complete four-node DAG pass. This is not fresh private
decryption, nonce/partial replay or new Core mutation execution.
Full conservation is57,877 =169 allocation fee +1,200 case fees +56,508 across
seven leaves. Recomputed predecessor:
`140025fe74bb8b31a9bb67e3943894c9024a3eaf692800ca72d7074a1cb98385`.
Terminal record2146 bytes/SHA-256:
`174082de9d930bbf3f6317943218e09c3f966b519a5deadd942745f3ce4f71fb`.
Root's46-RPC/zero-wallet-call check exited0 at16:41:04 with every saved full
transaction hex and active anchor on both nodes at the same stable tip321647:
allocation321644, funding321645, Carol321646, cooperative321647.
The16-record recovery-allocation check exited0 at16:44:39, retaining all14
previous public byte/hash bindings and rebuilding the next intent solely from
those seven leaves. Case10 is initial-round recovery without Alice. Unlike
the preceding pair cases, it includes the committed15,000-sat recovery sponsor:
56,508 =36,000 game sats +15,000 sponsor +5,313 reserve +195 fee at647/max649vB.
All seven signatures validate: three participant P2TR DEFAULT, one native-wallet
P2TR ALL and three native-wallet P2WPKH ALL. New allocation txid:
`f7d4c3bf23578cf0107a69a1fd4bddc9290ef267d4673e2032f38bf53422c3d1`.
Intent17329 bytes/SHA-256:
`951d8c74fbcb25101028ec9cb8d85e8c6a2096cb1801fb89dcb20dc4b9c43ab6`;
signed record2367 bytes/SHA-256:
`f54e628d6567739f1d02df93b62e576c3379f7c546827314224fca5087362ba2`.
Its18-RPC/zero-wallet-call check exited0 at16:45:12: both synchronized nodes
hold the exact saved witnesses in their mempools, unbroadcast false, at stable
tip321647. No allocation confirmation or completed recovery is inferred.
The allocation subsequently confirmed321648. Root's eight-record funding
check exited0 at16:55:10: all inputs are confined to the exact allocation,
the saved funding intent and six public restoration bindings match, and the
authorizations verify36,000 input sats,35,400 output sats and600 fee sats at354vB.
Graph digest:
`a98f56b0fb07561fdf650df17a12757ca3e2b1811860da88f37ff895e311e7d6`.
Funding record1303 bytes/SHA-256:
`0218a5d7fb04e6864b4ffd72bf8fb5a539f7a501bbc44baa5148677a1e126119`.
The26-RPC/zero-wallet-call observation exited0 at16:56:10. Both nodes share
stable tip321648, confirm the allocation's exact full hex and active anchor,
and hold the exact funding bytes in their mempools, unbroadcast false.
Funding confirmation and the separate12-block recovery delay were pending at
that observation. Funding subsequently confirmed in block 321650.
The bounded three-pair cooperative review is closed. Root independently
rehashed all40 files/246,455 bytes and ran both full supplied original suites
to actual exit0 by17:03:50. Their direct aggregate-key, witness, receipt,
mutation, economics and successor results match; the detailed review records
the corrected command attribution and public-attestation/chronology limits.
This does not extend reviewer coverage to case10 or complete final review.

Root's ten-public-record recovery verification exited 0 at 17:18:30, retaining
all eight earlier byte/hash bindings. It rebuilds the exact saved terminal
intent/proposal and verifies the initial-round recovery from funding:0,
30,000 sats, version 3, locktime 0 and sequence 12. Exactly Bob and Carol supply
valid SIGHASH_DEFAULT Schnorr signatures; Alice's witness slot 0 is empty.
The exact recovery leaf/control block and all personal-key bindings match.
Payouts are Alice 9,834, Bob 9,833 and Carol 9,833 sats, with 500 fee sats at
257 vB. Missing signature, changed payout, changed delay and swapped witness
are locally refused; the changed payout also fails both primitive signature
checks. Recovery txid:
`79cb7f31145cfab5c5b2ffc131f9075a671bfa36c6edcda73583056d4141dbb3`.
Intent 2,135 bytes/SHA-256:
`fa7ad8685e5ed3888c5544253221b05744a5f5cd106596c2fb99e39a5f48e70e`;
signed record 3,104 bytes/SHA-256:
`b3ed706769849e018cee6b52600164679f3800be110cb3e5da35f18205567a49`.
Root's 38-RPC/zero-wallet-call check exited 0 at 17:19:52. Both Core 31.1 nodes
share stable default-Signet tip 321650, with exact saved allocation/funding
hexes at active anchors 321648/321650. Funding:0 is unspent at depth 1 and
matches the exact 30,000-sat source script. The recovery is absent from both
mempools; each node's `testmempoolaccept` matches its txid/wtxid and rejects
the exact saved signed bytes as `non-BIP68-final`. This does not prove mature
acceptance, eventual confirmation, recovery fee handling, new decryption or
case completion. No source, wallet, signing, custody, fee or journal mutation
was performed by these independent root checks.
The bounded case10 public review subsequently passed. Root separately rehashed
all ten records/98,036 bytes at 17:30:17; ordered LF-terminated name/length/hash
manifest SHA-256:
`f793985aa84f3a36fe6f43a90b0436979293968955cd5aa875d694d51bf2cca4`.
Root inspected and ran the complete original 26,334-byte reviewer command to
actual exit 0 by 17:38:56. Its exact command SHA-256 is
`f805c6dd7e5adf038a2a27b414ecb49286386c565f79350b249d6f9e6aa34a90`;
both actual 9,892-byte stdout strings have SHA-256
`5f13a1d515b1cf2dae8f7e9c2fc4ca170cf3bc7621510e6510948cec98c29e84`.
Manual BIP341 and Taproot reconstruction, independent noble Schnorr/ECDSA
verification, seven allocation and three funding signatures, 12 setup
preauthorizations, three unique receipts/nine owner-exit references matching
both receipt arrays, 38 local hostile refusals and two direct changed-payout
signature failures all match. Predecessor/checkpoint chains, decryption/storage
chronology, reviewer RPC, maturity and future recovery-fee evidence are outside
this ten-file review. Root's separate 38-RPC refresh exited 0 at 17:39:18:
both nodes share stable tip 321652, preserve all exact saved funding/allocation
hexes and active anchors, observe funding:0 unspent at depth 3, and reject the
exact signed recovery as `non-BIP68-final`. Neither node has it in its mempool.

Ten of 19 cases are complete. The remaining nine recovery cases,
the recovery fee family, final capital return, both actual
final assemblies, retained-byte verification, independent final review and the
full requirements audit remain required. Do not infer full acceptance from
six completed solo orderings and four cooperative cases. Both final helpers
remain unexecuted; require complete:true and actual exit0 of the same-state
resumed writer before either sequential assembly. Retain the original exit143
as a failure/termination record, never claim that original invocation passed.

## Historical browser-harness correction (2026-09-11 00:30 UTC)

Source `1cc9f5f94e55bca6070fd294b4ab7e817d0a441d39764355b7401e11934f32cc`
preserves the application protocol, custody and game assertions. The prior
private source409cca25 invocation exited1 at 00:05:31 UTC with 51/52 completed
commands. Its original failure was `refreshChain` before Alice's recovery
proposal: the click timed out after 60 seconds with HTML intercepting pointer
events. The cause of the unresponsive page is not established. Core had already
shut down at 23:31:49 UTC, but the catch awaited an unbounded DOM-text read before
logging any original source location. Separately, the installed framework's
automatic error-page snapshots were not disabled by trace/screenshot/video off.

A synthetic positive/negative control reproduced that snapshot gap without any
real custody data. After exact process-identity checks and a durable intervention
record, only the disposable Chromium process was sent SIGTERM to prevent an
automatic snapshot and release the original error. This was a deliberate
confirmed-defect intervention, not a restart following an observation timeout.
The actual failed child outcome and all 169 selected files / 2,178,310 bytes are
retained under the private current-acceptance root. Independent review and root
rehashing checked all bytes, 51 commitments, 102 transcripts, five database logs
and the exact intervention/probe bindings. Failed-retention SHA-256:
`fa61d911190cbfc212cd509fd20b16f78ae78dfd86430327810260ba4c94ca36`;
independent diagnostic:
`7a3b66ab722118920f199ce8bceb634cac74a635726d4c733b01e6cba7b55a2b`.
No browser snapshots, custody files or complete-run receipt were copied.

The corrected direct spec disables automatic page snapshots before any context
is created, emits only known stage names, bounded allowlisted source locations
and event counts before awaiting cleanup, and never serializes DOM text or raw
exceptions. Cleanup is separately bounded and cannot replace the original error
or turn failure into acceptance. Reloads now require actual removal of both
hydration attributes; they do not remove guards or force clicks. The 60-second
action checks and 45-minute test-body deadline are unchanged. A 47-minute
framework runner deadline is an additional failure guard, not a longer body
budget or a claim of a universally hard process-termination ceiling.

All four typechecks passed; after correcting the independent reviewer's attribute
presence finding, web types were rechecked. Both Signet- and mainnet-format
custody suites pass all 30 checks, including eight new failure-boundary tests.
Six actual synthetic cases cover safe error reporting, rejected/stalled cleanup,
test timeout before catch, and timeout with a private-like argument in a pending
password fill or evaluation. All 36 retained files / 23,326 bytes were independently
reviewed and rehashed by root; no generated sentinel or page snapshot remained.
The first four cases bind source a9cc9aa2, the final two bind current1cc9f5f9,
and the actual tested helper bytes are unchanged. Independent delta review:
`28a2125e91b0c17dfcad672d7c3f4baf4b4f3742daf710fc5ab35e68ba3a4300`.
These tests do not establish every framework serializer or actual expiry of the
47-minute runner deadline. The fresh optimized application run is live, with
complete new local/image evidence, final test-only notes/publication, all 19
funded default-Signet cases and both final assemblies still required. All prior
source-bound transfer/publication/assembly helpers must be separately rebound
and reviewed; no recovered coin was signed or sent.

## Historical onboarding-correction checkpoint (2026-09-10 23:38 UTC)

Source `409cca25c6f7fb93889b8b7ff1076772b4ca1ca8c9b2b13b11e64e8e03c44087`
corrects two independently reviewed gaps found during final coverage review:
V2 onboarding displayed V1 Sigbash/optional-recovery instructions, and primary/
resumed enrollment did not clear its owned PRF on crypto exceptions. Durable
authenticated vault membership now selects explicit version-specific guidance.
V2 requires both distinct passkeys and the saved offline kit plus independent
graph/payout verification; V1 guidance remains separate. Both enrollment paths
share a helper returning only ciphertext/public identity, with `finally` cleanup
of owned PRF/material/scalars. This is best effort, not a key-deletion security
assumption or a guarantee about immutable strings and browser internals.

All four typechecks and 17 focused passkey checks pass, including six exercised
success/fault paths inspecting actual owned buffers. Independent rereview found
no further actionable issue in this delta. Actual V2 and legacy browser fixtures
now assert their respective onboarding requirements. Both actual legacy PRF
browser tests pass. The separate optimized V2 invocation exited1 after 23.3
minutes at Carol's final-sweep finalization: a Core transport/read request failed,
then the stored-status assertion remained false for 60 seconds. Polling did not
retry the action. Independent review confirmed that this preceded deliberate
cookie expiry and was below both 45-minute ceilings; no specific transport
cause is proven. The exact failed log is retained separately, with no final-sweep
broadcast reached and no claim that local signing had not already occurred.
Neither the runtime deadline nor its safety gate was changed.

The new complete private 52-command invocation started at 21:13 UTC in an
immutable checkout with real inside-root dependencies and verified offline-build
preflight. It remains live at 51/52, with no full receipt yet. The complete
19-case isolated-Core lifecycle passed at 23:07:04 UTC after 82m43s, followed
by all five database suites and the offline build. Actual Core accounting
reconciled 89,000 starting sats = 47,000 fixed fees + 3,515 allocation fees +
38,485 confirmed return, with 57 recycled participant payouts, no unrelated
inputs and every terminal output/reserve consumed exactly once. All nine CSV12
cases refused at depth 11 and accepted the same stored transaction at depth 12.
The run exercised six lost replies, 84 durable-send checks, two primary-loss
restorations, two initialization interruptions, 83 actual restored native-key
signatures and all 19 restored case kits before funding, without regenerated
native targets. This is isolated regtest with zero public-network broadcasts,
not real default-Signet evidence. Independent partial-48 byte review passed:
144 private files / 157,472 bytes, 48 execution commitments and 96 transcript
hashes. Root rehashed every file, recomputed all commitments and checked four
pinned source files at 23:17 UTC. The diagnostic SHA-256 is
`a0c1fb9c9149f911dbf89879ef5bda75b8b78d580cc0d9d21506b39f22f6b37a`;
it is not a full-run approval. The 84 confirmed transactions are independently
derived from source-enforced checks, distinct from 84 durable-send checks and
89 submitted IDs (including five replaced children). Separately,
the complete saved-file check passed at 23:22:04 UTC on exact utility
`3afcdac5caf72eb0c03598ce8165c78961f4463f7ef50adf6f715f02b9599807`:
six solo orderings, four cooperative rounds, nine recovery subsets, 31 actual
browser-signed transactions confirmed by Core, 70 restored kits, ten fee cases
across both native wallet types and ten confirmed replacement children. It
made zero network requests and stored no persistent secrets. Its actual stdout
SHA-256 is `b31cc46091e914b5898ab31968e2c0bdd9426e7ddb06b39904b66b867434e591`.
Only the final optimized-browser check remains live; no complete archive yet.
Normal CI `34529963155`
completed all three jobs successfully at 21:54:37 UTC, including all 52 local
commands and both image profiles. Its actual local receipt has run digest
`2daa06b6ffa955b59177a4821cb13d385ac9d13728e6681748c6d06f191c1045`, with a
reported 112-file archive SHA-256
`475feb4631c0d1e94c8e49007fed7669abebf59440c70bf160478e60d1ed3456` (1,319,008 bytes).
Root recomputed the fixed plans and receipt/command commitments and retained
all three public job logs plus their receipt/archive-result/summary files.
This is log-only retention: the runner did not retain those raw child logs or
archives. Independent CI review passed: fresh GitHub responses match all three
saved public logs; all 12 retained files (327,162 bytes) stayed unchanged, and
69 canonical commitments were independently recomputed. Root rechecked those
files and commitments. The separate private full run and its actual raw archive
remain required. Retention CI `34530275095`
passed both jobs at tooling `c254e459f08eda5628c047152a2c09f54ea463b3`.
All six assets are attached to unpublished test-only draft `386622569` and
downloaded. Local scan/restoration/semantic validation passed at 21:31 UTC;
independent actual-byte review passed at 21:51 UTC. Both canonical outer archives
have 39 members, all 78 restored files match, and fresh pinned scanners examined
18 historical layers / 25,850 entries per image with reports byte-identical to
the hosted reports. Root rehashed all restored files and six downloads and
rechecked the unchanged draft at 21:53 UTC. The retained independent review binds
download-verification SHA-256
`843360bc3e093779eb475627c473ed83842c98d6428dcc27f720f5dbf7bd787b`.
Reviewed public self-test/framework constants remain permanently public on later
publication; this bounded review is not universal proof of secret absence.
New collector/publisher pins passed static review, types, 33 malformed-record
checks and missing-full publication refusal.

| Current test image | Archive SHA-256 | Tested OCI manifest |
| --- | --- | --- |
| Signet-format | `524136b0043ee8b7d984010fa30515e96839c5d60d693c068cf964d55edd6658` | `sha256:6eabe552f41a2153d13a3dccde4a3c107d1c2ec115efba9e6c89805109d4c857` |
| Mainnet-format | `2dbd45e00c5e50775357448f1b8e2906842e08d0fbd4b5645e7af8bfc16a8156` | `sha256:4e451092157137d94397786dedf54a8db501732f0e42621ca8141ba21fbc9e66` |

Signet-format proves the isolated browser game; Mainnet-format proves the
unauthorized-funding refusal, not mainnet spending. Publication still requires
the completed private run, exact retained-byte review and final-note review.

The current source's unfunded default-Signet host drill passed two same-wallet
restarts, two whole-host restorations, ten exact rejection checks and two fresh
attempt-bound native signatures. It remained at zero funds/transactions and
stopped with intact independent custody. A separately rebound native test-coin
transfer helper passed static review/types and refused missing full acceptance
before creating a journal or accessing RPC/signing. Its current-source isolated
shape proof and actual unsigned-intent review remain pending. The fixed plan and
all protocol/game/fee requirements are unchanged. Complete current local and
funded default-Signet evidence, test-only publication and final assembly remain
required.

The previous b8c4 clean invocation was intentionally stopped after 40 completed
commands at 20:52:17 UTC, before its first Core test initialized a node. Its real
child exited1 and all 128 selected files were retained separately as superseded
incomplete evidence. This was a response to confirmed findings, not a timeout
or a shortened acceptance pass. Both b8c4 image archives and their unpublished
draft remain historical, unchanged; no recovered test coin was signed or sent.

## Historical persistent-recovery checkpoint (2026-09-10 UTC)

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
checks and one native-wallet restore check. The candidate is frozen at commit
`35d9038102ea7c4735a1f49d6dae69899124f1d1`, source `b8c4cf28` above. Public CI
`34515524898` completed all three jobs successfully at 19:28 UTC. Its actual local
log reports 52/52 with run digest
`5add2368bc6ab81e2491c609265750c80904483d18d5da087d3c02f29d64f38e` and a restored
112-file archive SHA-256
`3ebd5920f448301adffc783b57676334370ec76231dc6cd606c12a87abfd8757`.
That log-only runner did not retain its archive after exit. The separate
18:37 UTC host-local invocation exited unsuccessfully at 20:28 UTC after 49
passing commands. Its full isolated-Core lifecycle passed all 19 cases, five
fee families, six lost replies, nine exact CSV12 boundaries, two primary-loss
restorations and two initialization interruptions. Its capital audit was
89,000 = 47,000 fixed fees + 3,515 allocation fees + 38,485 returned sats.
The subsequent offline build correctly refused dependencies symlinked outside
the detached checkout. All 158 selected raw files, including the exact failure,
are retained as failed-prefix evidence; no complete-run receipt was generated.

A new full 52-command invocation started at 20:37:49 UTC on the same frozen
candidate/source, with an actual inside-checkout `npm ci` installation. An
independently reviewed preflight verified the real dependency directory, all
133 offline manifest inputs and the actual utility hash before starting.
At 20:44 UTC it remains live; its wrapper fsyncs progress and only assembles
complete retained evidence after the full original child exits successfully.
No successful prefix, suffix or separate diagnostic is combined into a pass.
Publication and native-transfer gates now require this new invocation.

Separate retention tooling commit `646aa9e7fac48ce3cd8f6efc7098e98053686878`
pinned that same candidate. Run `34515940967` passed both genuine image profiles.
All six assets of draft `presigned-v2-test-evidence-b8c4cf28-20260910` were
downloaded and actually restored/revalidated at 19:02 UTC. Independent review at
19:16 UTC rehashed all assets, compared all 78 required members, and reran the
pinned content scanner over both images' 18 historical layers (25,848 layer
members per image). Both canonical outer archives contain 39 required files.

| Current test image | Archive SHA-256 | Tested OCI manifest |
| --- | --- | --- |
| Signet-format | `40bb308081c5160680a6596c8d70cf0d1c898be9c3d67ef1cc098bbc2c152385` | `sha256:57785eb59a9f7c2de466aa8f892e8bfa9e16bebf4fbb17295ed44f8745395ad9` |
| Mainnet-format | `eecc9ba1636717128592a831eb857213743b005e9da717e8f9a14df2ea9e2e46` | `sha256:c31772c543c8692d1a7fce28729c71dd987ec6fe7e72fe355147396538037032` |

The Signet-format image proves the isolated-Core browser game, not public Signet;
the mainnet-format image proves pre-funding custody and authorization refusal,
not mainnet spending. The draft remains unpublished at this checkpoint.
Publication additionally requires the actual complete private run and independent
review bound to its exact archive/retention/child-exit bytes and final public
notes. No funding authority or complete software release is inferred.
A new funded default-Signet 19-case/five-fee-family run and final release
assembly remain required.
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
