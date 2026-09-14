# Presigned V2 operator and recovery runbook

Scope: `presigned-graph-v2` only. This is an operating procedure for the requested
product, not evidence of approval to deploy or fund it. Current results and
remaining requirements are in [PRESIGNED-V2-PLAN.md](./PRESIGNED-V2-PLAN.md).
Mainnet is the production target; mainnet spending, public app exposure and outreach
remain separately approval-gated. Physical passkeys are deferred to the friends'
onboarding, not claimed by virtual-authenticator tests.
Public source and synthetic-test publication were separately authorized; that
does not authorize app deployment or funding.

New vaults created after the 2026-09-13 economics update commit the explicit
`last-survivor-net-v1` marker. Verify all three participants see the same marker
and exact first/second/last amounts after configured base fees. Both app and
offline utility must support this schedule. Never add the marker to an existing
roster or reuse a previous source/image acceptance receipt for this update.
Recovery does not enforce equal refunds or registered destinations: once mature,
any two of three, or either one of a remaining pair, can spend the whole coin.

The previous frozen source's agent-executable software acceptance completed at 2026-09-12 18:44 UTC, including independent
R01-R24 closing review and root verification. Use the evidence and limitations
below; physical devices, mainnet spending and public deployment remain separate.

## 1. Preserve identity and rollback

- Keep the merged `sigbash-v1` baseline
  `202345ffd8bab35590fe15b98d966c4267f194ef`. Never change an existing vault's
  durable protocol, reinterpret a kit or delete an old funding epoch.
- Retain the exact tested source, image manifest, offline utility and private
  evidence. An image config ID is not an OCI manifest digest. Runtime network
  variables must match the network embedded when the image was built.
- Existing funded V2 vaults cannot be operated by a V1-only rollback. Before an
  application/database rollback, preserve all V2 kits, signed epochs and send
  journals and use a matching reviewed restore. Deleting a database or reverting
  code cannot revoke an already released Bitcoin signature.
- Keep participant secrets, wrapping keys, RPC cookies, database credentials,
  invite tokens and raw private test directories out of Git, shared logs and
  support messages. Invite URLs are bearer secrets, not publishable page links.

## 2. Establish actual software evidence

Use an isolated code-only checkout with the reviewed Node runtime and test
dependencies. Acceptance intentionally refuses operational Next.js dotenv files;
do not relocate or delete a running installation's credentials to satisfy it.

```bash
npm run presigned:test:local
npm run presigned:test:container -- signet
npm run presigned:test:container -- mainnet
```

The first command runs the fixed 55-step local matrix, including both network
formats, all Core families, five PostgreSQL suites, the complete saved-file
recovery browser and a fresh Signet-format web build. Container commands need
working local rootless Podman and never push an image. Do not enable privileged
containers or weaken host isolation when that prerequisite is unavailable.

The authorized standard public GitHub runners passed the historical 47-step
matrix and both exact-image profiles on source `536935c2`. The new low-capital
runner adds two pure signing/validation runs and requires new same-source
acceptance; old receipts cannot be reused. The original workflow publishes
normal test logs/receipts, not private wallets, recovery kits or whole runtime
directories. That log-only workflow does not retain all child transcripts and
OCI layers; a green run must not replace actual artifacts. The separately
approved test-only release route below now retains both complete image archives.
The interim `f889b15f` image archives are also retained and verified, but its local
run was stopped at 44/49 commands and eight lifecycle cases to revise regtest
mining. They do not establish acceptance of the revised source. The new regtest
checks recovery rejection at depth 11 and acceptance at depth 12 for all nine
cases; it mines intermediate blocks together without changing CSV12. Its
execution is bounded to 90 minutes, with 150 minutes for the complete CI suite.

Source `9afe98cf` subsequently passed all 49 local commands and both genuine
image profiles; its complete local archive and both test-only OCI archives are
retained. That is now historical evidence. The persistent-recovery changes add
two filesystem/locking runs and one actual native-wallet restore run, requiring
a new complete 52-command suite and both images on the new source digest.

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

Use the existing private `observe-follow.mjs` for actual writer identity/status.
The retained `verify-case13-capital-reuse.mts` verifies exact case12-to-case13
transport (42 public files;00:07:14 check exited0). The separate
`observe-case13-funding-two-node.mts` checks47 public files, exact allocation/funding
witnesses and both UTXO views; its00:12:02 check exited0 while funding remained in
both mempools. Both commands use `env -u NODE_OPTIONS TSX_DISABLE_CACHE=1 node
--import tsx` from the project root with the relative private-checkpoint script
path. Their exact one-line commands/hashes/outputs are in private CHECKPOINT.md.
Do not infer case13 CSV maturity from funding age. Wait for actual Alice-exit
bytes/confirmation and verify that successor before observing recovery eligibility.
No writer restart or fee change is needed for a healthy confirmation wait.
The added `observe-case13-alice-two-node.mts` uses the same invocation prefix
and validates all50 pinned public files, actual funding confirmation, exact
Alice-exit witnesses, unchanged counterparty preauthorizations and both successor
UTXO views. Its00:21:13 check exits0 with Alice pending; no recovery-height
anchor is claimed until that exit confirms. Source names the files
`step-alice.intent.json`, `step-alice.json` and `negative-alice.json`, not
`step-first` files. The independent setup review excludes those later records.

Historical checkpoint, 2026-09-11 22:43 UTC: 12/19 real default-Signet cases and all
five fee replacements are confirmed. Root's44-RPC check at21:18:09 confirms full
case11 recovery witnesses in321677 on both nodes,12 blocks after funding321665.
Both bounded independent case11 reviews and root's exact full replays are closed.
The seven-output capital DAG leaves49,927 sats. At21:29:43 root's62-RPC check
verifies exact case12 inputs/signatures and49,927 =36,000 game +13,745 reserve
+182 fee sats in both mempools. The later66-RPC check at21:41:19 confirms exact
allocation321680 and all7 inputs consumed on chain. Exact funding confirmed
in321681. At21:45:07 both nodes match all39 public files and show the30000-sat
vault unspent at depth1, with exact recovery absent/non-BIP68-final. Earliest
recovery block321693 under that funding anchor. The same service is live;
do not start another writer. The21:52:06 refresh finds depth2 and the same exact
premature refusal. Independent case12 setup/funding review and root's exact full
replay are closed; do not repeat that matrix during unchanged CSV waits. Later
mature Core/capital evidence still requires its distinct bounded review.
The22:13:40 two-node refresh matches all39 public pins477,849 bytes at stable
height321683: funding is exact/unspent at depth3 and recovery remains absent
and non-BIP68-final, with nine further tip blocks for next-block eligibility.
The22:14:23 native observation confirms the same actual runner and depth3.

Root's22:30:43 saved-public-byte capital audit now reconstructs case12's three
transactions:49,927 =182 allocation fee +600 funding fee +500 recovery fee
+48,645 sats in seven leaves. The exact script, command and14,821-byte output
are retained under the private checkpoint's `case12-public-capital-dag-v1`
prefix. This is not confirmation or current spendability. The separate five-file
independent terminal-signature review and root's exact full replay are CLOSED,
with byte-identical44,074-byte outputs and17 targeted mutations:16 product
refusals plus one independent intent-only binding refusal. The full verifier,
attempt ledger and root provenance are retained; do not repeat that closed matrix.
The22:41:51 two-node check verifies exact/unspent source depth5 at321685 and
premature recovery, seven tip blocks short of next-block eligibility. Mature
hostile controls, confirmation and exact successor capital transport remain
separate. Require all19 cases and actual successful native exit before assemblies.

The current retained read-only case12 chain observer is
`live-run/presigned-v2-case10-checkpoint.vFDKJ2/observe-case12-recovery-two-node.mts`.
Run it with `env -u NODE_OPTIONS TSX_DISABLE_CACHE=1 node --import tsx` from the
project root. It rehashes39 exact public files and distinguishes immature,
mempool and confirmed recovery states. A chain/mempool change during observation
can refuse a snapshot; reobserve the same run rather than launch another writer.
The read-only `verify-case12-capital-reuse.mts` in the same private directory
validates the exact successor allocation and distinguishes pending from confirmed
consumption on both nodes. It does not verify case12 funding or recovery. Both
helpers require the unchanged source and exact saved public files; a failed
observation is not authorization to bypass a guard or change the live journal.
The private CHECKPOINT.md in that directory also records freshly rehashed final
helper identities and recovered sequential invocation commands. They remain
unexecuted and gated on full evidence plus actual terminal native exit0.

The22:01:36 UTC capacity scan found1,841 primary entries and12,499,663 file
bytes, with46,918,463,488 filesystem bytes available. The largest backup
manifest is287,018 bytes;1,385 manifests total177,949,075 bytes, separate from
the primary128 MiB bound. No partial/vanished entries were observed. These are
interval metadata measurements, not atomic integrity, fresh restoration or
indefinite-wait proof. No restart, limit change or cleanup was performed.

Scope correction: the directory scan read metadata only, but its default
control validator also read and SHA256-hashed existing isolated test-wallet
backups. The original output's "no custody contents opened" description was
incorrect and remains preserved alongside `case12-capacity-scope-correction.json`
in the private checkpoint directory. Exact backup-read counts were not
instrumented; no backup/key bytes were printed, and no new restoration,
decryption, signature, wallet RPC, broadcast or journal write occurred. Keep
the readiness guard intact. The same qualification applies to the root
case12 two-node observers above: public-record counts are not full read
inventories, and fixed loopback RPC cookies are read privately. Independent
public-only review scripts have a separate scope. The earlier20:20 command's
full read footprint was not revalidated here; its old wording is not new proof.

The live writer is now temporary user service `presigned-v2-follow-vFDKJ2.service`.
It runs the unchanged frozen follow command against the same journal, with
Restart=no, RemainAfterExit=yes, umask0077 and no-new-privileges. It is not boot
enabled. PID250863/startTicks10141900 holds both operation locks. The original
5025 handle exited0 without complete:true at19:08:36; later 77644 became missing
and no writer remained. Its exit status and both interruption causes are unknown.
Never poll/restart those old handles. No Core node, seed, fees or source changed.

Use this retained read-only process observer from the project root:

```bash
env -u NODE_OPTIONS node /home/codex/btc-multiplayer-vault/live-run/presigned-v2-case10-checkpoint.vFDKJ2/observe-follow.mjs
```

It verifies the exact live unit/process and projects only public native summaries
from the mode0600 append-only stdout file. It distinguishes a currently running
unit's Result=success/ExecMainStatus=0 from an actual terminal exit. Require
complete:true, the actual terminal native exit0 and all full-run evidence before
either final assembly. The launcher's successful exit is not the runner's exit.
Stderr is intentionally discarded; do not claim preserved exception diagnostics.

The prepared retention wrapper checks the prior local-suite exit and the new
assembler child's exit; it does not itself capture or enforce the original
native writer's terminal status. Retain the actual complete-summary/exit
observer output for the same invocation, recheck that no writer holds either
operation lock, and bind that evidence in the final handoff before launching
the Signet profile. Start the mainnet-image profile only after the first actual
outer process exits0 and its retained evidence verifies. These remain explicit
operator gates, not facts established by a prepared file or launcher exit.

The verifyCompletedLiveLifecycle function forbids new signing, wallet RPC and
transaction broadcast. Its surrounding CLI makes a read-only getaddressinfo
wallet query during identity checks, acquires both operation locks and rewrites
their private diagnostic records. Verification also reopens and decrypts
participant offline backups; the control guard hashes existing native-wallet
backups. Do not describe the entire future CLI as zero wallet RPC, zero
filesystem writes or no restoration. Saved hostile reports and non-witness
confirmation comparisons retain their narrower scope; separate exact-witness and full-requirements
review is still required. No final assembler was run for this clarification.

The start wrapper refuses any existing unit and performs a fresh complete
read-only preflight. Do not use systemctl restart to bypass it. For an explicitly
needed stop, target only this unit, verify actual termination and released locks,
then inspect journal integrity before any same-state resume; stopping can escalate
from SIGTERM to SIGKILL after120 seconds. Let the user manager unload the stopped
transient unit; preserve all logs/journal/custody and never delete lock inodes.
No stop or rollback has been exercised for this new live invocation. Before/after
host audits retained the existing terminal diagnostic and security-service state;
their exit0 is not aggregate health or privileged UFW/SSH/SMART verification.

Root's additional lock probe at 20:06 initially assumed the kernel-reported lock
acquisition PID must equal the retaining runner PID. That assertion was wrong:
the reviewed implementation uses short-lived flock children and retains the
parent's open file descriptions. Corrected 20:07:06 verification confirms FD28 /
inode5133593 and FD30 / inode5506584 remain FLOCK ADVISORY WRITE locked. Verify
actual descriptor, inode, lock type and range; do not infer a lost lock merely
because its acquiring child exited. No runtime or lock-file change was made.

Eight recovery cases, final confirmed/unspent capital return, both actual
sequential final assemblies, retained-byte verification, independent FINAL review
and the full requirements audit remain. Physical-device tests stay deferred;
mainnet spending, public app exposure and outreach stay separately gated.
The prior dated checkpoints and old-handle instructions below are historical.

Dependency-security source 49e4240d
replaces affected Next.js/sharp versions. Its exact installed versions,
zero-known-advisory audit, typechecks and unchanged offline artifact are in the
[security checkpoint](./DEPENDENCY-SECURITY-2026-09-11.md). The former 1cc browser
pass cannot certify changed dependencies; that full private run never started,
CI was deliberately cancelled, and its empty test-only draft is not eligible for
publication. Rebind operational gates only to new complete reviewed acceptance.
All 19 funded default-Signet cases and final assembly remain required.
Do not reuse an old source-bound host or signed intent.
The new same-source unfunded host passed restart/restoration checks and was
stopped after that drill; its independent review covers safe public
records/signatures, not every private backup byte. It has since been started
and synchronized with default Signet, with wallet broadcasting disabled and only
loopback RPC. Full private local acceptance actually exited0
at 03:31 UTC; all 52 commands and the complete 112-file archive passed independent
byte review, followed by root's full rehash and semantic checks. Separately,
normal CI has passed the complete 52-command suite and both image jobs, with
logs/receipts retained separately from raw archives. Both image build/test
and retention profiles passed. All six assets are downloaded and both archives
passed content/restoration/semantic and independent actual-byte review; root
rehashed every selected original file and revalidated both image directories.
The exact final notes passed independent review and root's 15-record byte check.
The authorized test-only prerelease was published at 03:57 UTC, with actual
publisher exit0 and a fresh root check of notes, six assets and candidate tag.
Independent actual-intent review and root's exact-input/parent/PSBT/commitment
checks passed. Exact signing and broadcast then exited0 after fresh gates; root
verified all seven signatures and the unchanged147-sat fee/89,570-sat recipient.
At 04:42 UTC both nodes confirmed the same unspent 89,570-sat seed at depth2.
Fresh initialization passed, including actual restoration of all 83 reserved
native-wallet targets. Root reverified the exact 19-case plan, wallet proof and
current durable journal before the first allocation. That allocation was
submitted at 04:44 UTC: 81,000 planned-output sats, 8,469 reserve sats and a
101-sat fee. That allocation is now confirmed. The same runner submitted the
first game's funding-fee replacement at 05:09 UTC. Funding and that replacement,
both solo exits and the solo-fee replacement have since confirmed. The final
sweep and its approved replacement were submitted by06:01 UTC and confirmed
in block321589, completing the first lifecycle. The next allocation has also
confirmed, and the same runner submitted the second scenario's funding by 06:46.
Separate read-only checks
validated the saved funding signatures, restoration bindings, paired pre-funding
checkpoint, exact exit/sweep signatures, hostile script rejections and the
first-case capital graph without network calls or writes. A fresh06:33 two-node
check confirmed all eight exact first-case transactions and the absence of
superseded children. Root separately verified the next allocation's exact ten
predecessor outputs and all signatures:75,669 input sats,36,000 next-game sats,
39,442 reserve and 227 fee at 754 vB. Its exact bytes were pending on both nodes
at 06:33; it subsequently confirmed before the runner advanced. Do not treat
previously recycled graph outputs as still unspent. Independent review of the
46 public first-case/successor records passed, and root matched all exact file
hashes and reported bindings alongside its own semantic checks. The second
ordering, Alice/Carol/Bob, completed by 07:27:52 UTC. Root's fresh 07:30 two-node
check confirmed all five exact second-case transactions and active anchors;
its separate 19-public-record check verified saved authorizations, six receipt
bindings and the successor commitment. All seven terminal outputs, totaling
73,642 sats, fund the Bob/Alice/Carol allocation: 36,000 game sats, 37,460 reserve
and a 182-sat fee at 604 vB. That allocation subsequently confirmed. The third
ordering, Bob/Alice/Carol, completed by 11:40:44 UTC. Root's 11:42 two-node check
confirmed all five exact transactions and active anchors through block321612;
the separate 19-public-record check verified the full value flow, receipt
bindings and next allocation. All seven remaining outputs total 71,660 sats:
36,000 for Bob/Carol/Alice, 35,491 reserve and a 169-sat fee at 560 vB. That
allocation subsequently confirmed. The fourth ordering, Bob/Carol/Alice,
completed by 12:11:30 UTC. Root's 12:13 two-node check confirmed all five exact
transactions and active anchors through block 321619; the separate
19-public-record check verified the value flow, receipt bindings and next
allocation. All seven remaining outputs total 69,691 sats: 36,000 for
Carol/Alice/Bob, 33,509 reserve and a 182-sat fee at 604 vB. That allocation
subsequently confirmed. The fifth ordering, Carol/Alice/Bob, completed by
12:28:45 UTC. Root's 12:27 two-node check confirmed all five exact transactions
and active anchors through block 321624. The separate 17-record terminal and
19-record successor checks verified authorizations, public receipt bindings and
all seven remaining outputs: 67,709 sats become 36,000 for Carol/Bob/Alice,
31,540 reserve and a 169-sat fee at 560 vB. At 13:25 UTC the exact sixth
allocation remained in both mempools at stable tip 321626, with the original
runner live. Blocks 321625 and 321626 had not included it. Mempool acceptance, active
peer traffic and block fee statistics do not prove why a miner omitted a
transaction, and do not authorize changing this saved run's fees or inputs.
The same allocation subsequently confirmed in block 321627 without a fee or
input change. Root's 13:40 two-node check confirmed its exact saved witnesses
and observed the sixth funding pending on both nodes, with a 600-sat fee at
352 vB. A separate eight-public-record check verified its authorization,
immutable intent and six restoration-receipt bindings. Independent five-case
public-evidence review passed; root rehashed all 110 selected records and its
13:46 read-only reproduction exited0 with matching capital and manifest
commitments. This bounded review does not decrypt backups, re-observe the chain
for the reviewer or complete final whole-run review.
The sixth ordering, Carol/Bob/Alice, completed by 14:36:19 UTC. Root's 54-RPC
check confirmed all five exact transactions and active anchors on both nodes,
including Alice's final sweep in block 321632. Separate 17-record terminal and
19-record successor checks verified authorizations, public receipt bindings,
saved hostile rejections and all seven remaining outputs. The cooperative
allocation includes its agreed fee sponsor: 65,740 sats =36,000 game funding
+15,000 sponsor +14,548 reserve +192 fee at 635 vB. It confirmed in block 321633;
root's 14:41 two-node check observed the exact cooperative funding pending on
both nodes with a 600-sat fee at 354 vB. Its eight-public-record check verified
funding authority, exact allocation-confined inputs and six public restoration
bindings. Independent incremental sixth-case/successor review passed; root
separately rehashed all 19 records /120,169 bytes and reproduced the exact
checks to actual exit0 at 14:47:58. Both manifests and all capital, signature
and sponsor bindings match. This does not prove fresh decryption, reviewer
chain observation, physical storage or final whole-run acceptance.
Do not reuse a solo-only allocation shape for this cooperative fee-family case.
The first cooperative parent and fee replacement confirmed in block 321635.
Root's 15:09:37 check matched all four exact case transactions and active anchors
on both nodes and found the superseded child absent. All participant payouts
remain 9,900 sats; only sponsor change funds the approved replacement increase.
Independent 20-record /326,320-byte public review and root's exact reproduction
passed at 15:17:24. Aggregate-signature verification is not nonce/partial replay;
receipt bindings and saved Core rejections are not fresh decryption or Core replay.
The cooperative-after-Alice successor consumes all eight exact remaining outputs:
60,648 =36,000 game sats +24,459 reserve +189 fee at 628 vB. It has no additional
fee sponsor. Its allocation confirmed in block 321636; its exact funding remains
pending on both nodes at 15:12:46, with 600 fee sats at 352 vB.
The cooperative-after-Alice case subsequently confirmed through block321639;
root's15:59:08 two-node check matched all four exact transactions and anchors.
The original writer actually exited143 at15:52:29; its cause remains unknown.
Only after proving both old processes absent, no other lifecycle operation,
both kernel locks released, exact synchronized isolated Core and all1,278
checkpoint1087 files intact did root resume the same frozen follow command.
Both current and frozen source identities and the receiving-wallet backup
proof also matched. No source/fee/input change, restoration, replacement
funding or Core restart was performed. The resumed writer is the sole writer
and holds both stable operation-lock inodes. Never treat an observation timeout
as this actual terminal event, or delete a lock inode to resume.
The exact next allocation passed its16-record predecessor/signature check:
59,259 =36,000 game sats +23,077 reserve +182 fee at604vB, no new sponsor.
Root's16:02:19 check confirmed it on both nodes in block321640.
Both remaining cooperative cases subsequently confirmed through blocks321643
and321647. Their14-record checks verify exact required leaver witnesses,
successors, aggregate cooperative signatures, payouts and capital flow.
Root's46-RPC observations at16:18:38 and16:41:04 matched every saved full hex
and active anchor on both nodes. Ten of 19 cases are complete: six solo and
four cooperative. The first recovery allocation passed its16-record check:
56,508 =36,000 game sats +15,000 committed recovery sponsor +5,313 reserve
+195 fee at647/max649vB. Its exact bytes are pending on both nodes at16:45:12;
the18-RPC observation made no wallet call. This recovery is from the initial
round, without Alice, and retains the separate12-block maturity requirement.
The allocation subsequently confirmed321648. Its eight-record funding check
and26-RPC observation at16:55/16:56 verify exact funding pending on both nodes,
with600 fee sats at354vB. Do not count CSV maturity from the allocation: it
depends on confirmation of the exact recovery source, here funding:0.
Funding subsequently confirmed in block 321650. Root's ten-record check
exited 0 at 17:18:30: the saved recovery has Bob/Carol signatures, an empty
Alice slot, exact leaf/control block, sequence 12 and payouts 9,834/9,833/9,833
sats, with 500 fee sats at 257 vB. The 38-RPC check exited 0 at 17:19:52 with
both nodes at stable tip 321650, exact full allocation/funding hexes and active
anchors, and funding:0 unspent at depth 1. Both reject the exact signed bytes
as `non-BIP68-final`; neither has them in its mempool. The runner saves the
terminal intent and signatures before checking CSV maturity, but saves the
hostile-transaction report only after a mature positive Core control succeeds.
Do not treat a saved terminal file as a submitted or confirmed recovery, or
require the not-yet-created mature negative/fee reports during this wait.
Keep the same writer and 12-block delay; do not change fees or reinitialize.
The first-recovery public review is closed after root's ten-file/98,036-byte
rehash and actual exit 0 replay of the complete original audit by 17:38:56.
Its manual digest/Taproot/signature checks and 38 local refusals do not prove
maturity. At 17:39:18 a fresh 38-RPC observation finds both nodes at stable
tip 321652, funding:0 unspent at depth 3, and exact premature recovery still
rejected on both. Preserve that distinction when the runner advances.
Independent three-pair cooperative review is closed after root's40-file rehash
and actual exit0 reproductions of both full original suites by17:03:50.
Public receipt hashes remain attestations, not proof of fresh private restoration
or physical storage; neither that review nor these observations complete the run.
The remaining nine recovery cases, the recovery fee family,
final capital return, both actual final assemblies, retained-byte verification,
independent final review and the full requirements audit remain mandatory.
Run the two final helpers sequentially only after complete:true AND an actual
exit0 from the same-state resumed writer. Preserve the original exit143;
neither a completed stage nor a restart converts that invocation to success.
The historical 12:07 metadata-only capacity check found 4,196,524 primary bytes,
910 entries and a largest backup manifest of 141,776 bytes. A later 12:48
`du -sb` observation measured the primary tree at 4,893,543 bytes, with about
44.4 GiB available; it did not recount entries or backup-manifest sizes. These
are interval observations, not atomic integrity proof or indefinite-duration
guarantees; retain the existing limits and evidence.
A fresh metadata-only interval check exited 0 at 17:26:08: 1,423 primary files
plus 17 directories, 8,970,280 total file bytes and a 78,448-byte largest file.
The 1,173 backup manifests total 123,650,390 bytes; the largest is 223,044 bytes.
No transient partial entry was observed and approximately 44.06 GiB was available.
Primary limits remain 128 MiB and 20,000 entries, with 4,000,000 bytes per
file/manifest. Backup-manifest aggregate bytes are not primary-journal bytes.
No primary/snapshot contents were opened by this metadata scan; it is not an
atomic integrity check or a guarantee that arbitrarily long waiting will fit.
Do not repeat initialization/funding, replace
the seed, alter fees or launch a concurrent writer. Preserve and inspect the
exact saved run if the runner actually fails; an observation timeout is not
terminal. Current helper preparation and negative gate tests do not substitute
for completed real-chain evidence.
The separate current-source network-disabled seven-native shape
check passed with the exact 147-sat fee and 89,570-sat return at 488vB, without
opening either real wallet. It does not prove the fresh real inputs or approve
an unsigned live intent. The final-retention helper's corrected ordering and
synthetic fault cases passed review; require actual outer exit0, never only a
visible success marker. No old participant graph or its two other known leaves
may be substituted into the new test-capital transfer.

Historical checkpoint, 2026-09-11 00:30 UTC: source
`1cc9f5f94e55bca6070fd294b4ab7e817d0a441d39764355b7401e11934f32cc`
corrects failure reporting and automatic snapshot privacy in the browser test
harness. It keeps the existing game/signing checks and action deadlines; cleanup
has separate bounds, and the framework runner has an additional failure deadline.
Direct spec execution disables automatic page snapshots, not only screenshots,
video and tracing. Never restore broad DOM/error logging to diagnose custody
failures. Typechecks and both 30-check custody suites pass; six actual synthetic
failure/timeout cases and all 36 artifact files were independently reviewed.
The actual optimized application check is live. The prior private full run
exited1 at 51/52 after a refresh-chain click timeout; 169 selected files are
retained as failed evidence. Do not assemble them into a passing run or use the
older image approvals for this new source. Full new local/image acceptance,
reviewed source-bound funding preparation, all 19 real default-Signet cases and
final assembly remain required. No recovered test coins moved.

Historical checkpoint, 2026-09-10 23:38 UTC: onboarding-correction source
`409cca25c6f7fb93889b8b7ff1076772b4ca1ca8c9b2b13b11e64e8e03c44087`
has passed all four typechecks, 17 focused passkey checks and both legacy PRF
browser tests. The separate optimized V2 browser run failed at final-sweep
finalization after a generic Core transport/read error; retain the failed bytes
and do not infer a specific timeout or waive fresh chain checks. The complete
52-command invocation has run since 21:13 UTC and is at 51/52, not yet a full
pass. Its 19-case isolated-Core lifecycle, all five database suites, offline
build and full saved-file recovery/fee tests passed; optimized-browser is live. Current CI
`34529963155` passed all 52 local commands and both image jobs at 21:54 UTC;
retain its logs/receipts as log-only evidence, not raw archive custody. Both
retention jobs passed. Both actual image archives passed local and
independent byte/content/restoration/semantic review; all six downloaded asset
hashes and the unchanged draft were rechecked. The test-only release remains a
draft until complete private acceptance and exact final-note review pass.
The fresh source-bound unfunded host passed two restarts/two complete restores/
ten rejection checks and is stopped with custody intact. Full current evidence
and the new funded Signet lifecycle remain required. Do not repoint an old host
control or reuse historical acceptance artifacts. V2 onboarding must say both
distinct passkeys **and** a saved offline kit; Sigbash readiness belongs only
to the retained V1 flow. Avoid adding heavy parallel acceptance during host
recovery copying; this is scheduling guidance, not evidence for a failure cause.

Historical checkpoint, 2026-09-10 20:44 UTC: candidate `35d9038` / source
`b8c4cf28` passed the full 52-command public local job and both image jobs in
run `34515524898`. Both actual image archives from separate run `34515940967`
have been downloaded, restored and independently reviewed. Their test-only
prerelease remains a draft until complete private local retention and final-note
review finish. The first host-local invocation failed after 49 passing commands:
its offline build correctly refused the symlinked out-of-checkout dependencies.
The failed prefix is retained separately. The new full invocation began at
20:37 UTC after an actual inside-checkout dependency installation and successful
offline-build preflight, then stopped at 40/52 at 20:52 UTC when independently
confirmed onboarding findings superseded its source. Its 128 raw files are
separately retained as incomplete evidence. Always install dependencies inside the frozen checkout;
do not weaken the manifest boundary or combine partial invocations. These
results do not replace the outstanding new funded default-Signet run or final
acceptance assembly; never use these synthetic test images with real funds.

For complete **current-source** evidence directories, `npm run
presigned:pack-evidence -- local|signet-image|mainnet-image /absolute/evidence
/private/output.tar.gz` creates a new owner-only local archive. The output
parent must already be owned/private, and the output must be outside the input
directory. The packager takes an exact allowlist, not a recursive directory
copy: required receipts/transcripts, five selected database logs, browser/runtime
summary JSON, the verified OCI index/manifest/config/layers for image evidence,
and the exact tested offline utility in the local archive (image archives retain
it inside their OCI layers). It excludes wallets, cookies, databases,
browser profiles/downloads, participant backups and unrelated OCI blobs.
It validates the input, a fresh private copy and the actual restored archive,
preserving original committed bytes and `executionDirectory`. It rejects
symlinks, hardlinks, path traversal and overwriting an existing output. Archive
files are regular mode0600 entries; restored evidence belongs to the current
user. The matching source checkout remains required for semantic verification.

This is not a privacy scanner: required rootless engine transcripts contain
host/storage metadata, and inspected image configuration may contain environment
metadata. Review those exact files and image build contents before approving any
publication. Do not redact hashed transcripts or include wallet/kit directories.
All three profiles passed actual packaging/restoration on disposable runners in
run34150142799, but that original acceptance workflow **does not upload archives**;
its temporary bytes disappeared with the runners.

The separately approved
[test-only evidence prerelease](https://github.com/twood22/btc-multiplayer-vault/releases/tag/presigned-v2-test-evidence-536935c2-20260908)
now retains both complete image archives and four retention/content-review
records from run 34178522361. Those historical archives pin source `536935c2`;
publication tooling is on a separate branch. Each archive has 39 required files
and 18 actual OCI layers. All six downloads matched GitHub hashes; both complete
archives passed local content review, actual restoration, semantic validation
and independent member-by-member review. See the evidence plan for exact hashes.

These permanently public synthetic-test images must **never receive real funds,
participant custody or operational credentials**, or be promoted to production.
The bounded content review includes historical layers and canonical archive
metadata; exact public GnuTLS self-test constants and unused framework test-build
keys are explicitly documented. No wallet/recovery directory is included.
A checksum, archive or prerelease is not a completed release dossier, a real
default-Signet lifecycle, or funding/deployment authority.

The separate historical `536935c2` private local run completed all 47 commands at
19:45 UTC on 2026-09-07. Its 102 required local files and actually restored,
revalidated archive are now retained owner-only on the host; exact bindings and
independent verification are recorded in the V2 evidence plan. This supplies
the same-source local counterpart to the test-image archives above, but not the
remaining real default-Signet proof.

Real default-Signet evidence is separate. On the exact fresh isolated test host,
`presigned:signet-lifecycle` takes `status`, `init`, `fund`, `advance`, `follow` or `verify`
and the host's protected control-file path. `status` and `verify` are read-only.
`init` also requires `--capital-limit-sats=N --initial-outpoint=TXID:VOUT`.
Use one exact confirmed, non-coinbase native coin from that isolated wallet;
the current minimum bounded seed is 88,352 sats (the isolated regression uses
89,000). This preserves all 19 cases, five replacement families, 10,000-sat
deposits, 9,500/10,250-sat first/second payouts and CSV12. The separately funded
sponsor escrow is 15,000 sats per case; graph fees and payout economics are
unchanged. `fund`
allocates the first case only. `advance` recycles each fully settled case's exact
payouts, refunds, sponsor change and reserve into the next, with no wallet coin
selection or key import. Full intent and signed journals precede signing and
broadcast respectively; only the same exact transaction may be retried.
The 20 allocations, including final return, are capped at 338 sats each and
use exact integer ceiling at 300 millisatoshis/vB. Together with 47,000 sats of
fixed lifecycle fees, total in-run burn cannot exceed 53,760 sats. Final acceptance requires
all 84 unique transactions and a confirmed, unspent wallet return: at least
35,240 sats from an 89,000-sat seed. Any separately authorized seed consolidation
is outside that run and must have its own exact-input audit and fee bound.
A missing historical intent, foreign spender,
changed source, fee-policy refusal or unproven replacement stops progress; never
increase the budget, drop cases or relabel spent payouts as unspent to continue.
Sequential confirmations and nine separate CSV waits make this slower than the
historical fully prefunded parallel run. Only isolated random keys/test coins
may be used; this capital-transport helper is not a product withdrawal API.
Wait for reported confirmations/CSV maturity and resume the same directory;
never substitute regtest, custom Signet or deterministic public fixture keys.
Freeze executable source from host creation through final verification. `follow`
holds the same kernel-backed operation locks and repeats the same exact runner
every 30 seconds until completion or a verified refusal; it does not increase
fees, change source, or create a replacement run after a reboot. If the public
relay floor exceeds the approved transport fee, wait rather than change policy.

### Persistent isolated host and explicit recovery

The new version-3 host lives under the repository's ignored, owner-only
`live-run/presigned-v2-signet-host.*`, never `/tmp`. Independently named sibling
roots retain the full checkpoint objects/native-wallet backups and a separate
metadata-only rollback anchor. These are separate directories on this host,
not protection against whole-disk loss. A reboot does not automatically resume
the writer; use the exact control and source below. Do not reinterpret older
version-2 host controls or lost funded participant journals as this format.

Create a fresh host with `presigned:signet-host --
--stopped-chain-cache=/absolute/stopped/public/cache/signet`. Only public blocks,
chainstate and indexes are copied. The copier holds Core's actual POSIX data
directory lock through copying and destination validation; never copy a live
cache. No operational wallet is copied or loaded. Core starts offline with an
empty configuration, isolated wallet directory, loopback-only RPC,
`walletbroadcast=0`, and `persistmempool=0`.

Before publishing its receiving address, the host makes a native wallet backup
and restores it into a separate offline Core. Synthetic impossible-parent
signatures bind the actual backup, binary, source and exact receiving key.
Initialization separately reserves 82 exact native targets and proves all 83
receiving/reserved keys from another native restore before funding. Each case's
three complete encrypted participant kits and their wrapping material must also
restore from the independent full checkpoint before any wallet funding signature.
Checkpoint intent, exact signed bytes and acknowledgement precede each sign/send;
OS-held locks release on process death without deleting stale PID files.

- `presigned:signet-control -- start|status|stop /absolute/host/control.json`
  controls only that exact host/wallet. Read-only status and identity-safe stop
  remain available when source or backup validation prevents normal operation.
- `presigned:signet-restore -- journal /absolute/host/control.json` restores the
  newest exact journal to a new private tree, checks its custody, retains any
  damaged original, and atomically installs the verified tree at its original
  path. Missing/corrupt primary metadata is not a reason to discard a surviving
  newer independent or primary acknowledgement. A stale backup refuses.
- Whole-host recovery requires the original path to be absent and its Core
  stopped: `presigned:signet-restore -- host /absolute/backup/host-control.json
  --stopped-chain-cache=/absolute/stopped/public/cache/signet`. It preserves the
  original host/source/address and restores the pinned native wallet, not a new
  identity. An independently retained monotonic attempt record and a new
  attempt-bound native restoration proof gate normal restart and funding.
- `host-stage` takes the same arguments but stops offline before acknowledgement;
  `host-resume /absolute/backup/host-control.json` completes that exact pending
  attempt. Old completions, orphaned newer records and primary rollback cannot
  satisfy it. Interrupted replica publication can be repaired only by this
  explicit recovery path after actual proof validation.

All wallet files, private checkpoint objects, wrapping keys and restored clones
must remain owner-only and outside Git, image contexts and public dossiers.
An unfunded host recovery drill or native signature proof is not the required
19-case funded default-Signet acceptance. Never load an operational wallet to
replace a missing isolated host, or reinitialize over damaged funded custody.

Only after actual same-source local, both-image and live tests pass, assemble
software evidence with `presigned:assemble-acceptance`. Supply all six options:
`--local-run`, `--signet-image`, `--mainnet-image`, `--signet-control`, `--network`
and `--write-protected-receipt`. Paths must be absolute; the output must be new
and its parent owner-only. The assembler rereads artifacts and runs live Signet
verification now. It is not a facility for supplying invented passed flags.
Keep the dossier directory together with its source evidence. Assembly does not
grant deployment or spending authority.

## 3. Configure only the approved private installation

Configuration comes from the approved secret/environment mechanism, never image
build arguments or source-controlled secret files. A V2 instance needs:

| Configuration | Required binding |
| --- | --- |
| `VAULT_NETWORK`, `NEXT_PUBLIC_VAULT_NETWORK` | Same explicit network as the built image |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `APP_ORIGIN` | Reviewed RP and identical production HTTPS origins; do not change after passkey enrollment |
| `DATABASE_URL` | Exact PostgreSQL database; production release requires a non-local `sslmode=verify-full` endpoint |
| `BITCOIN_BACKEND=core`, `BITCOIN_RPC_URL` plus cookie **or** username/password | Authenticated private Core31.1, exact network/genesis, fully synchronized and non-pruned with synchronized `txindex`; no cleartext remote RPC |
| `CHAIN_OBSERVATION_ORIGINS`, `PRESIGNED_CHAIN_API_URL` | Independent allowed HTTPS Esplora base, no credentials; browsers must independently verify Bitcoin facts |
| `VAULT_CONFIRMATIONS_REQUIRED`, `VAULT_DEPOSIT_SATS`, `RECOVERY_DELAY_BLOCKS` | Explicit reviewed depth, equal deposit and relative timelock |
| `VAULT_FUNDING_FEE_SATS`, `VAULT_SOLO_FEE_SATS`, `VAULT_SOLO_FEE_BUDGET_SATS`, `VAULT_COOP_FEE_SATS`, `VAULT_RECOVERY_FEE_SATS`, `VAULT_FINAL_SWEEP_FEE_SATS` | Reviewed immutable economics, not a later fee override |

V2 has no Sigbash credential, hosted policy key or Sigbash readiness receipt.
That is an explicit protocol distinction, not a switch disabling V1 gates.
Do not use `VAULT_DEMO_SEED` for product custody or live acceptance.

The runtime roles are the migration job (`npm run web:migrate`), unprivileged web
role (the exact image's default startup command), and private one-shot watcher
(`npm run web:watch-chain`). The watcher can retry already authorized send
intents: it is not a read-only diagnostic. Schedule it only within the approved
installation. Never expose it as an HTTP endpoint. Select an explicit loopback
listener for host-local testing; no example here authorizes opening a listener
to other machines. Health readiness only proves operational availability and
the migration set; it always says `fundingAuthorized: false`.

## 4. Create a new V2 vault and complete custody

Once installation and participant onboarding are authorized, new vault creation
requires `web:create-invite -- --protocol presigned-graph-v2 --vault-name NAME
--participant alice --max-child-fee-sats CAP`. The deposit and delay environment
must be explicit. Use the returned exact vault ID for Bob and Carol's invites;
do not create three different vaults. Handle generated invite URLs through the
approved private delivery process, never public logs or automatic outreach.
An existing vault rejects a different protocol or inferred replacement settings.

Each participant completes these actions in their own browser:

1. Enroll two distinct PRF-capable passkeys; during actual onboarding, verify
   physical devices rather than treating six virtual credentials as that proof.
2. Compare the exact roster and economics with the other participants through
   an independent channel. Review the displayed final amount after base fees;
   the schedule does not promise that net payouts increase monotonically.
3. Choose one confirmed native P2WPKH or key-path P2TR wallet coin. It must cover
   the deposit, its deterministic funding-fee share and at least330 sats of
   refundable change. Change returns to that exact input-wallet script so its
   owner retains a funding-fee rescue path; this intentionally reuses an address.
4. Independently rebuild the frozen funding transaction and all nine exits,
   then release only the four counterparty signatures. The participant's own
   final leaver signatures remain private.
5. Save the complete encrypted portable kit, keep its independent wrapping
   secret separately, actually reopen the saved file, and restore with both
   passkeys. Save the verified offline HTML utility and public commitments too;
   compare its digest through an independently trusted artifact channel.
6. Only after local restoration checks pass, start wallet signing. This records
   an irrevocable local/server intent before PSBT export. Independently review
   the wallet transaction, import its signature and approve the exact completed
   funding bytes. Server readiness is not a substitute for local review.

Before any wallet-start intent, a new epoch requires unanimous digest-bound
restart approval. After an intent or released signature, retain the old epoch
and retry the exact transaction. A missing upload, failed download, browser
restart or fresh login does not make old signatures revocable. Sessions expire
after fifteen minutes; reauthenticate without clearing recovery material.

## 5. Mainnet funding requires a separate release

The software acceptance receipt, its independently reviewed digest, the exact
deployed image manifest and the explicit mainnet authorization must all match
before the mainnet wallet-signing workflow opens. Do not invent these artifacts
or set an authorization marker merely to exercise a test. Already funded exits
do not require a new initial-funding release report.

The software bindings are `PRESIGNED_V2_ACCEPTANCE_RECEIPT`,
`PRESIGNED_V2_ACCEPTANCE_RECEIPT_DIGEST` and `DEPLOYED_IMAGE_MANIFEST_DIGEST`.
The separately approved activation configures `PRESIGNED_V2_MAINNET_AUTHORIZATION`,
the exact `PRESIGNED_V2_BROADCAST_NETWORK` and `PRIVATE_BETA_MAX_DEPOSIT_SATS`.
Their presence is not a substitute for the user's actual authorization.

After an exact epoch is fully signed and unanimously approved, perform the
authorized encrypted database backup/restore and actually quiesce its source.
Use distinct, verified-TLS source and restored databases. The read-only command
`presigned:verify-database-restore` takes `--vault-id`, `--epoch-id`,
`--write-protected-receipt`, `--write-database-receipt` and
`--confirm-source-quiesced SOURCE_QUIESCED_FOR_BACKUP_RESTORE`. It does not perform
the backup, restore or pause. It compares full database contents plus that exact
approved funding state, all retained epochs and restored custody envelopes.

Configure both `DATABASE_RESTORE_RECEIPT`/`DATABASE_RESTORE_RECEIPT_DIGEST` and
`PRESIGNED_V2_FUNDING_RESTORE_RECEIPT`/`PRESIGNED_V2_FUNDING_RESTORE_RECEIPT_DIGEST`
from independently reviewed real outputs. The V2 operator commands load only an
explicit protected `BTC_VAULT_ENV_FILE` or injected environment; they do not
implicitly load a dotenv file.

`npm run presigned:release-status -- --vault-id ID --epoch-id ID` is read-only.
It checks the exact deployed offline utility, image and source before inspecting
the funding state, current coins, restored state, runtime and beta cap. Writing a report additionally requires
`--write-protected-report`, `--acknowledge-manual-review true` and
`--physical-passkeys-checked true`; those acknowledgements must describe actual
review/onboarding, never virtual-test substitutes. Configure its reviewed report
path and digest only through the separately approved release process. The
report expires after30 minutes, grants no authority itself and is rechecked
before an initial funding send. Participant broadcast approval is still required.
The report bindings are `PRESIGNED_V2_RELEASE_REPORT` and
`PRESIGNED_V2_RELEASE_REPORT_DIGEST`.

## 6. Ongoing operation, fees and coordinator loss

Keep signing, broadcast approval, send intent and confirmed activation distinct.
An accepted mempool transaction does not activate its next round. The watcher
tracks known graph transactions even if the coordinator never created a proposal;
an unavailable backend leaves the previous state intact. On a reorganization,
suspend affected descendants and reobserve exact coins and active anchors. Do
not erase proposals, old signatures or send journals to repair a disagreement.

Apply migration021 before starting this watcher version. Every successful or
deferred publication advances a monotonic `poll_revision`; identical state
hashes do not let an older worker overwrite a newer observation. Do not reset
that counter or edit watch rows to clear an error. An approved database restore
must stop all old watcher processes, not just obtain a new session lease: a
restored database is not a continuation of the old process's concurrency token.
Retry batches rotate retained accepted/deferred records by last attempt, so old
records do not permanently occupy the first100 positions. A fee package that
was merely approved remains outside that queue until an explicit send action.

Fee rescue preserves the full payout/refund and every parent/descendant txid.
Use a confirmed outside sponsor coin and independently approve the exact cap
and sponsor change. Only the initiating payout owner and sponsor sign their own
inputs. Save the public draft/completed package before leaving the page, then
refresh chain facts before restoring and approving it. Replace only the fee
child, never immutable funding or game parents. Parent confirmation while
offline signing was in progress is revalidated explicitly. Adequate fees,
sponsor liquidity and relay availability remain necessary; no bounded
confirmation-time guarantee is made.

If the coordinator is unavailable, open the saved, independently verified HTML
utility as a local file on a trusted device. It operates without service/network
requests. Restore the encrypted kit with its separate secret, obtain fresh
public coin observations from your own authenticated private Core using
`presigned:observe-coins`, and review their network, exact outpoints, active tip
and observation time. That helper is read-only and takes explicit `--network`,
`--rpc-url`, `--cookie-file`, repeated `--coin TXID:VOUT`, and a new `--output`.
Never send the cookie, participant secret or wrapping key to the utility provider.

The utility supports the owner's solo exits, interactive cooperative MuSig2,
mature N-1 recovery, final sweep and all five fee-parent families. Exchange only
the intended public contributions. A lost cooperative secret nonce requires a
fresh complete nonce ceremony, not reuse or reconstruction of an old nonce.
Review and submit the completed exact transaction/package through the separately
authorized private Bitcoin operator path. Completed signed bytes can be
broadcast by whoever receives them; do not treat deleting your copy as revocation.

The N-1 recovery condition permits the remaining quorum to take the coin after
CSV maturity (either member in a pair round). That inherited collusion tradeoff,
malicious browser-code delivery, stolen unlocked devices, wallet compatibility
and relay liveness remain explicit limits; see the
[protocol threat model](./PRESIGNED-PROTOCOL.md).
