# Bitcoin Multiplayer Savings Vault

## Current development: V3 fixed-refund vault

New V3 implementation is under executable acceptance. It replaces unrestricted
delayed quorum recovery with exact pre-approved equal refunds and separate
trigger keys. All 21 setup signatures and verified portable/passkey restoration
are required before honest-client funding. Individually owned payouts can be
sent to an owner-reviewed external wallet through the browser or saved-file tool.

This is not a completed V3 release or a mainnet-safety claim. See the
[V3 checklist](./V3-ACCEPTANCE-CHECKLIST.md), [design](./PRESIGNED-V3-FIXED-RECOVERY-DESIGN.md),
[decisions](./IMPLEMENTATION-DECISIONS.md), [participant guide](./V3-USER-GUIDE.md)
and [release runbook](./V3-RELEASE-RUNBOOK.md). Historical V2 vaults and evidence
below retain their original meaning; they do not establish V3 acceptance.

## Historical V2 development and evidence

2026-09-13 update: new vaults now use `last-survivor-net-v1`, splitting the pool
19:20:21 after reserving normal solo and final-sweep fees, with rounding to last.
For 10,000 sats each and 1,200 sats total base exit/sweep fees, withdrawals are
9,120 / 9,600 / 10,080 sats. Existing vaults keep their signed original schedule.
Recovery remains unrestricted delayed N-1 signing, not an enforced fair refund.
This changed source needs fresh release acceptance; the completed September 12
acceptance below belongs to the previous frozen source, not this update.

The authorized replacement architecture is `presigned-graph-v2`: three-person
game economics enforced by exact pre-signed transactions, Taproot/Miniscript
spending conditions, participant-only MuSig2 cooperation and N-1 CSV recovery.
There is no online policy signer after setup. Each leaver keeps its final exit
signature; all participants restore complete offline and two-passkey backups
before the honest client releases a funding signature.

See [the v2 protocol and threat model](./PRESIGNED-PROTOCOL.md) and
[the implementation/evidence ledger](./PRESIGNED-V2-PLAN.md). The
[V2 operator/recovery runbook](./PRESIGNED-OPERATOR-RUNBOOK.md) separates this
protocol from preserved V1 deployment instructions. The previous frozen source's agent-executable software
acceptance is complete as of 2026-09-12 18:44 UTC: the browser/passkey, Core, real default-Signet,
and both final image-profile gates passed, followed by independent R01-R24 review
and root verification. Qualifications and evidence are recorded below. Physical
passkey checks remain deferred to friends' onboarding. No mainnet spending,
deployment, public listener or outreach is authorized by this work.

New vault creation requires an explicit `--protocol presigned-graph-v2` or
`--protocol sigbash-v1`; the durable protocol cannot be changed later. Never
point v2 transactions or API calls at an existing v1 vault. The merged v1
rollback baseline is `202345ffd8bab35590fe15b98d966c4267f194ef`.

V2 acceptance commands (each Core/database runner uses disposable private
resources and labels regtest evidence explicitly):

```bash
npm run presigned:test:pure
npm run presigned:test:local
npm run presigned:offline:test
npm run presigned:test:db
npm run presigned:test:live-runner
PRESIGNED_BROWSER_BUILD_APPROVED=true npm run presigned:test:browser
PRESIGNED_BROWSER_BUILD_APPROVED=true PRESIGNED_BROWSER_NETWORK=mainnet npm run presigned:test:browser
```

`presigned:test:pure` executes a fixed, source-bound two-network cryptographic
and legacy-regression plan plus all four typechecks. `presigned:test:local`
adds the complete Core, database, saved-file browser and fresh optimized-app
matrix. It refuses changed source, failed subprocesses, partial offline results,
or modified retained transcripts. Retained browser/database artifacts are
rechecked for their exact required scope, not only their hashes. Its owner-only `run.json` is local evidence,
not a software release receipt. Node22.23.2, Core31.1, PostgreSQL16 and Chromium
are required; `BITCOIN_CORE_BIN`, `POSTGRES_BIN`, `POSTGRES_LIB` and
`PLAYWRIGHT_BROWSERS_PATH` support reviewed private runners outside this host.

An exact-image run additionally requires a functioning **local rootless Podman**:

```bash
npm run presigned:test:container -- signet
npm run presigned:test:container -- mainnet
```

These commands build the production Dockerfile, export and hash the actual OCI
manifest/config/layers, execute the immutable image without mounted code, and
run its real browser and operator-entrypoint checks. Nothing is pushed. The
Signet-format image exercises the full game against isolated Core; the mainnet
image proves the complete pre-funding passkey/backup ceremony and refusal to
release funding without separate authorization. It does not bypass the real
mainnet release gate with fabricated evidence. The local host currently has no
container engine, but both genuine rootless image profiles now pass in the
authorized public CI. The standalone browser and synthetic OCI metadata tests
remain separately scoped; they are not substitutes for those image executions.

Public CI is explicitly authorized for the existing repository. The
`Presigned V2 acceptance` workflow runs the full local matrix and both exact-image
profiles on standard `ubuntu-24.04` runners when this V2 branch is pushed.
It refuses private-repository execution, uses no paid runner, cache, artifact
upload, registry push or deployment, and publishes only progress and verified
synthetic-test receipts in normal job logs. Wallets, cookies, encrypted recovery
kits and complete private test directories are never uploaded. Retained OCI
bytes and a complete release dossier are not supplied by this log-only workflow;
public CI success does not authorize funding or establish real default-Signet.

[Run 34150142799](https://github.com/twood22/btc-multiplayer-vault/actions/runs/34150142799)
passed all three jobs on 2026-09-07: the full 47-command local suite and both
exact-image profiles, on executable source `536935c2` (commit `3f0d621`).
The Signet-format image completed the full isolated-Core browser game; the
mainnet-format image passed the complete pre-funding ceremony and authorization
refusal. All three complete evidence archives were created, restored and
revalidated on the runners; the local-only `presigned:pack-evidence` command
does not upload them. A separate current-source private run also passed all 47
commands at 19:45 UTC; its exact 102-file local evidence set and restored,
revalidated archive are retained owner-only on the host. Actual default-Signet
lifecycles and final release assembly remain outstanding. See the V2 evidence
plan for the distinct run/archive hashes.

The separately approved
[test-only prerelease](https://github.com/twood22/btc-multiplayer-vault/releases/tag/presigned-v2-test-evidence-536935c2-20260908)
now retains both actual image archives and their four review/retention records.
Run 34178522361 passed both genuine image profiles on the same source `536935c2`.
All six downloaded assets matched GitHub's hashes; both archives passed actual
content review, restoration and semantic validation, followed by an independent
member-by-member review. Each includes all 39 required files and 18 OCI layers.
The publication tooling is separate from the frozen application candidate.
These permanently public synthetic-test images must **never be used with real
funds, participant custody or operational credentials**. This is not a production
release, funding authority or real default-Signet evidence.

The public `536935c2` evidence above is historical. Source `9afe98cf` subsequently
passed all 49 local commands and both genuine image profiles; its complete
local and OCI archives are retained. The first real default-Signet run did begin,
but reboot loss of its temporary primary journal and participant material
prevented continuation. A separate surviving native-wallet backup was restored
offline, then audited against the chain: at 2026-09-10 16:30 UTC, 89,717 sats
remained in seven native wallet outputs, 29,700 sats in two other known leaves,
and 9,568 sats were confirmed fees. That closes the original 128,985-sat ledger;
it is not a completed lifecycle or authority to spend those outputs.

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

Historical verification checkpoint, 2026-09-11 22:43 UTC: dependency-security source
`49e4240d66a9780a7403996e4cca96478eb50e797e158ffb38157d910c9071ae`
patches Next.js/sharp upstream advisories; installed packages, all four typechecks
and the unchanged offline utility pass their focused checks. A fresh audit reports
zero known vulnerabilities. The preceding 1cc browser game passed, but full
local/image and real default-Signet acceptance must use the new dependency set.
Real default-Signet progress is 12/19 lifecycles: all six solo, four cooperative
and two recovery cases. All five fee families have confirmed replacements.
Both nodes confirm the second recovery, without Bob, in block 321677, exactly
12 blocks after funding. Both bounded case11 independent reviews are closed and
root-reproduced, including the exact seven-output capital DAG and saved native
rejection recipes. These public checks do not prove fresh private restoration
or independent historical Core-test chronology.
Case12's exact allocation and funding confirmed in blocks321680/321681 on both
nodes. All seven reviewed predecessor outputs are consumed on chain, preserving
49,927 =36,000 game +13,745 reserve +182 fee sats. At21:45:07 the vault remains
unspent at depth1; both nodes reject the exact recovery without Carol as
non-BIP68-final. Earliest recovery block is321693 under the current anchor.
The21:52:06 refresh finds source depth2 and the same premature refusal.
Independent case12 setup/funding review is closed after root's exact full replay;
all ten signatures and45 focused refusals pass with byte-identical output.
The separate terminal review is now also closed: independent and root runs have
identical44,074-byte outputs, verifying exact Alice/Bob recovery signatures,
Taproot membership and17 focused mutation cases (16 product refusals plus one
separate intent-binding check). Saved capital accounting gives48,645 sats in
seven leaves; it does not prove their current spendability. At22:41:51 both
nodes verify source depth5 and the same premature refusal, with seven further
tip blocks needed for next-block eligibility under the unchanged funding anchor.
The same temporary, non-restarting service remains live. Seven recovery cases,
confirmed/unspent capital return, both actual final assemblies and the full final
audit remain unfinished. Source, custody, fees and runtime are unchanged.
The current service procedure and exit-versus-completion distinction are in the
[operator runbook](./PRESIGNED-OPERATOR-RUNBOOK.md); earlier dated snapshots below
are historical, not instructions to poll the old process handles.
All three current normal-CI jobs passed, including the full 52-command suite and
optimized browser. Both archive-retention jobs passed. All six assets are in
the authorized test-only prerelease published at 03:57 UTC; both downloaded
39-member archives passed content scanning, restoration, semantic validation
and independent byte review.
Root rehashed all 87 selected evidence files and reran both semantic validators.
The full private 52-command invocation exited0 at 03:31 UTC. Its exact 112-file
archive is retained and independently byte-reviewed; root rehashed all 832
reviewed inputs and independently compared every archive member. The actual
optimized browser passed with six virtual PRF credentials and four genuine
reauthentications. The same-source unfunded default-Signet
restoration drill passed two wallet restarts, two whole-host restores and ten rejection
checks; independent public-record/signature review passed. The same
host is now synchronized with default Signet, with wallet broadcasting disabled.
This is not funded lifecycle acceptance, off-host backup
proof or permission to transfer coins.
The current seven-native-input isolated-Core rehearsal passed: 89,717 test sats
equals 147 fee plus 89,570 confirmed return, with both hostile mutations refused
and neither real Signet wallet opened. Final-retention helper review and its
synthetic fault tests also passed, not the actual final assembly.
Exact release-note review and root's independent 15-record check passed; the
publisher actually exited0, followed by a fresh check of the six assets, exact
notes and candidate tag. A fresh seven-native-output test transfer was prepared
unsigned: 89,717 sats in, 147 fee, 89,570 to the restored isolated recipient.
Independent actual-intent review and root's exact-byte/digest recheck passed.
Exact signing and broadcast then exited0; root independently verified all seven
signatures and the unchanged recipient/147-sat fee at488vB. At 04:42 UTC both nodes
confirmed the same then-unspent seed. Fresh initialization and all83 native-wallet
restoration checks passed, followed by root's no-RPC custody recheck. The first
allocation is now confirmed: 81,000 sats in planned test outputs, 8,469 reserved,
and a101-sat fee. The first solo-order scenario is now complete, including its
final sweep and all three approved fee replacements. Both nodes independently
confirm the exact eight-transaction graph; superseded fee children are absent.
Root's saved-evidence checks passed for restoration bindings, exact signatures,
hostile script rejections, payout-preserving fee children and the full first-case
capital graph. The final sweep preserves Carol's 9,050-sat payout; no unrelated
inputs enter that graph. The next allocation consumes exactly its ten remaining
outputs: 75,669 sats become 36,000 for the next game, 39,442 reserved and a 227-sat
fee. It confirmed before the second scenario's funding. Independent review of
46 first-case/successor public records passed;
root matched every hash and independently verified the calculations and bindings.
The second ordering, Alice/Carol/Bob, completed by 07:27:52 UTC; root verified its
five exact transactions and active anchors on both nodes. Its complete value
flow, six restoration-receipt bindings and next allocation also passed saved-byte
checks: 73,642 sats in seven outputs become 36,000 for Bob/Alice/Carol, 37,460
reserved and a 182-sat fee. That allocation subsequently confirmed. The third
ordering, Bob/Alice/Carol, completed by 11:40:44 UTC. Root verified all five exact
transactions on both nodes, including Carol's final sweep in block321612.
Its complete value flow and the fourth allocation passed a 19-public-record
check: all seven remaining outputs total 71,660 sats, becoming 36,000 for
Bob/Carol/Alice, 35,491 reserved and a 169-sat fee at 560 vB. That allocation
subsequently confirmed. The fourth ordering, Bob/Carol/Alice, completed by
12:11:30 UTC. Root verified all five exact transactions and active anchors on
both nodes, including Alice's final sweep in block 321619. A separate
19-public-record check verified the complete value flow and fifth allocation:
69,691 sats in seven outputs become 36,000 for Carol/Alice/Bob, 33,509 reserved
and a 182-sat fee at 604 vB. That allocation subsequently confirmed. The fifth
ordering, Carol/Alice/Bob, completed by 12:28:45 UTC. Root's 12:27 two-node check
confirmed all five exact transactions and active anchors through Bob's final
sweep in block 321624. A separate 19-public-record check verified the complete
value flow and sixth allocation: 67,709 sats in seven outputs become 36,000 for
Carol/Bob/Alice, 31,540 reserved and a 169-sat fee at 560 vB. The sixth allocation
subsequently confirmed in block 321627. Root's 13:40 two-node check confirmed its
exact saved witnesses and observed the sixth funding pending on both nodes:
36,000 input sats, 35,400 output sats and a 600-sat fee at 352 vB. Its separate
eight-record check verified the funding authorization and six public restoration
receipt bindings. Independent five-case public-evidence review passed; root
rehashing and a successful 13:46 reproduction matched all 110 records / 1,075,347
bytes, all five capital graphs and successor commitments. This is not a fresh
private-backup decryption or final whole-run review. The original runner was
live at that checkpoint; mempool acceptance is not confirmation.
The sixth ordering, Carol/Bob/Alice, completed by 14:36:19 UTC. Root's 14:36
two-node check confirmed all five exact transactions and active anchors through
Alice's final sweep in block 321632. Its 17-record terminal check verified the
9,050-sat final payout, all signatures, six public receipt bindings, six saved
hostile script rejections and the complete capital graph. The expanded 19-record
check verified the cooperative successor, including its agreed fee sponsor:
65,740 sats in seven exact inputs become 36,000 game funding, 15,000 sponsor,
14,548 reserve and 192 fee at 635 vB. That allocation confirmed in block 321633.
Root's 14:41 two-node check observed its exact funding pending on both nodes,
with 600 fee sats at 354 vB; a separate eight-record funding check verified its
authorization and six public restoration bindings. Independent incremental
review of the sixth ordering and cooperative allocation passed. Root separately
rehashed all 19 records /120,169 bytes and reproduced the exact checks to exit0
at 14:47:58, matching both manifests and the complete capital/sponsor bindings.
This bounded review is not fresh decryption, reviewer chain observation or final
whole-run acceptance.
The first cooperative case and its fee replacement subsequently confirmed.
Root's 15:09:37 two-node check matched all four exact transactions and active
anchors through block 321635; the superseded child is absent and all three
9,900-sat payouts are preserved. Independent review of its 20 public records
/326,320 bytes passed; root reproduced the exact command to exit0 at 15:17:24,
matching both manifests, all signature/fee bindings and complete value flow.
This verifies the final aggregate signature, not a nonce/partial transcript or
new private-backup decryption. The next case, cooperative after Alice exits,
has a confirmed allocation in block 321636: 60,648 sats become 36,000 game sats,
24,459 reserve and 189 fee. Its exact funding is pending on both nodes at the
15:12:46 observation, with a 600-sat fee at 352 vB.
The cooperative-after-Alice case subsequently confirmed through block 321639;
root's 15:59:08 two-node check matched all four exact transactions and active
anchors. Bob and Carol each receive 9,950 sats after Alice's 9,500-sat exit.
The original runner actually exited143 at 15:52:29; the cause is unknown.
Before resuming the same frozen source and journal, root verified the old
processes absent, both kernel locks released, the isolated node synchronized,
and all 1,278 current files matching the independently anchored checkpoint.
No restoration, replacement funding, fee change or Core restart was needed.
The single resumed writer advanced to cooperative after Bob exits. Root's
16-record check revalidated all prior public bytes and its exact seven-input
allocation: 59,259 =36,000 game sats +23,077 reserve +182 fee at604vB.
The allocation confirmed on both nodes in block321640 at the16:02:19 check.
The cooperative-after-Bob and cooperative-after-Carol cases subsequently
confirmed through blocks321643 and321647. Root's separate14-record public
checks verify each designated leaver's9,500-sat exit, exact successor and
remaining pair's aggregate cooperative signature paying9,950 sats each.
The46-RPC checks at16:18:38 and16:41:04 matched all four saved full transaction
hexes and active anchors for each case on both nodes. The first recovery
allocation uses only the final cooperative case's seven remaining outputs:
56,508 =36,000 game sats +15,000 committed fee sponsor +5,313 reserve +195 fee.
It passed its16-record check; the exact647-vB transaction is pending on both
nodes at16:45:12. Ten of 19 cases are complete: six solo and four cooperative.
The allocation subsequently confirmed in block321648. The eight-record funding
check and26-RPC observation at16:55/16:56 verify its exact funding pending on
both nodes, with600 fee sats at354vB. The independent three-pair cooperative
review is closed: root matched all40 files/246,455 bytes and reran both full
supplied original suites to actual exit0 by17:03:50. No fresh private decryption,
reviewer chain observation or final whole-run approval is inferred.
The first recovery funding subsequently confirmed in block 321650. Root's
ten-public-record check exited 0 at 17:18:30: Bob and Carol's direct Schnorr
signatures validate, Alice's witness slot is empty, and the immutable recovery
pays Alice 9,834 sats and Bob/Carol 9,833 each, with 500 fee sats at 257 vB.
Four local hostile mutations are refused. The 38-RPC/zero-wallet-call check
exited 0 at 17:19:52: both nodes have the same stable tip 321650 and exact saved
allocation/funding hexes at active anchors. Funding:0 is unspent at depth 1;
the exact signed recovery is absent from both mempools and both nodes reject
it as `non-BIP68-final`. This proves premature rejection, not maturity,
recovery confirmation, fee-family completion or new private restoration.
Independent review of the ten public records is closed: root rehashed all
98,036 bytes and reran the complete original audit to actual exit 0 by 17:38:56,
including manual signature-digest/Taproot reconstruction and 38 local hostile
refusals. Original command and stdout hashes match exactly. A fresh 38-RPC
observation at 17:39:18 finds both nodes at stable tip 321652, funding:0 unspent
at depth 3, and the same exact recovery still rejected as `non-BIP68-final`.
This bounded review does not complete a recovery lifecycle or final acceptance.
The remaining nine recovery cases, the recovery fee family, final capital
return, both actual final
assemblies, retained-byte verification,
independent final review and the full requirements audit remain required.
Final assembly still requires complete:true and an actual successful exit of
the same-state resumed writer; the original exit143 is retained, not relabeled.
See the [security checkpoint](./DEPENDENCY-SECURITY-2026-09-11.md); no production
or mainnet funding approval is claimed.

Historical verification checkpoint, 2026-09-11 00:30 UTC: source
`1cc9f5f94e55bca6070fd294b4ab7e817d0a441d39764355b7401e11934f32cc`
adds independently reviewed browser-failure privacy and bounded cleanup, without
changing the game or weakening signing checks. Both 30-check custody suites and
typechecks pass; six actual synthetic failure/timeout cases passed their scoped
privacy checks. The fresh optimized application run is live. The preceding
private invocation failed at 51/52 on a refresh-chain click timeout; all 169
selected files are retained and independently reviewed as failed evidence.
Fresh full local/image evidence, all 19 funded default-Signet cases and final
assembly remain required. Earlier receipts and unpublished draft images cannot
certify changed source; no recovered test coins have moved.

Historical onboarding-correction source:
`409cca25c6f7fb93889b8b7ff1076772b4ca1ca8c9b2b13b11e64e8e03c44087`.
Independent review caught legacy Sigbash/optional-recovery instructions on the
V2 success screen and missing exception-path cleanup of onboarding PRF material.
Both are corrected: V2 explicitly requires both distinct passkeys and a saved
offline kit; initial and resumed enrollment share tested best-effort cleanup.
All four typechecks and 17 focused passkey checks pass. At 23:38 UTC, current CI
`34529963155` has passed all 52 local commands and both image profiles; both
retention jobs also passed. CI receipts/logs are privately retained, not their
raw child/archive bytes. All six downloaded
assets and both 39-member archives passed local and independent actual-byte,
content, restoration and semantic review. Their test-only release remains draft.
At that checkpoint, the complete private invocation had passed 51/52 checks,
including all 19 isolated-Core lifecycle cases,
all five database suites and the complete saved-file recovery/fee tests.
It subsequently failed as described above; there is no complete receipt.
The separate optimized V2 browser run failed during final-sweep finalization
with a Core transport/read error; its underlying cause is unproven and its
retained log is explicitly a failure. Both legacy PRF browser tests pass.
A new unfunded Signet host passed two restarts, two complete restores and ten
rejection checks, then stopped with custody intact. Complete current local
evidence, the funded default-Signet matrix and final assembly remain required.

The previous persistent-recovery candidate was commit `35d9038`, executable
source `b8c4cf28`. On 2026-09-10, public CI run `34515524898` passed the complete
52-command local suite and both genuine image profiles. Separate retention run
`34515940967` produced both exact OCI archives; all six downloaded assets passed
hash, content, restoration and independent member-by-member review. At 20:44 UTC,
their test-only prerelease remains a draft. The first host-local run passed 49
checks, including all 19 Core lifecycles, then failed the offline build because
its symlinked dependencies were outside that checkout. Its failed evidence is
retained separately. A fresh full 52-command invocation began at 20:37 UTC with
an actual inside-checkout dependency installation and a verified offline-build
preflight. That invocation was intentionally stopped at 40/52 at 20:52 UTC when
the onboarding findings superseded its source; 128 raw files were separately
retained as incomplete evidence. A new
funded 19-case default-Signet run and final release assembly remain required.
Historical test receipts cannot certify this changed source.

The saved offline utility has passed the full six-ordering/four-cooperative/
nine-recovery matrix and all ten native-wallet fee cases on one exact artifact.
The historical all-at-once runner passed those 19 lifecycle cases, five fee
families and lost-reply recovery against isolated Core. Neither establishes real
Signet or complete acceptance of the new low-capital runner.
For the fresh isolated default-Signet host, `presigned:signet-lifecycle` accepts
`status`, `init`, `fund`, `advance`, `follow` or `verify`, followed by that host's exact owner-only
`control.json` path. `status` is read-only. `init` additionally requires
`--capital-limit-sats=N --initial-outpoint=TXID:VOUT`: one exact, confirmed,
non-coinbase native output owned by the fresh isolated wallet. It reserves fresh
wallet targets and commits that coin and budget. The lower bound is 88,352 sats;
89,000 sats is used by isolated regression for the complete 19-case/five-fee-family
matrix; its complete current-source acceptance remains required.
`fund` signs and submits only the initial bounded allocation. Each subsequent
case receives all prior verified participant payouts, funding refunds, sponsor
change and the unused reserve through one exact journaled allocation. Participant
payout keys are restored locally and never imported into Core; Core cannot
select other wallet coins. Every case retains 10,000-sat deposits, 9,500/10,250-sat
first/second payouts and CSV12. Only sponsor escrow (15,000 sats) and test-capital
transport changed; the actual graph fees and game economics did not.
Twenty allocations, including the final wallet return, each have a hard
338-sat fee cap; the calculation is integer ceiling at 300 millisatoshis/vB.
The fixed lifecycle fees total 47,000 sats, making total in-run burn at most
53,760 sats and the final return at least 35,240 sats from an 89,000-sat seed.
Any separate seed consolidation needs its own exact-input audit and fee bound.
No automatic fee or budget increase
is permitted. If the exact inputs cannot meet policy or confirmation conditions,
the run retains its state and reports the unresolved condition.
The isolated regtest mines directly to recovery boundary heights, verifies the
same stored transaction is rejected at depth 11 and accepted at depth 12 for
every recovery case, then resumes the ordinary runner. Its bounded 90-minute
execution deadline and the CI suite's 150-minute deadline change no block delay
or substantive acceptance requirement. Real Signet still waits for real blocks.
`advance` performs one resumable pass and reports pending confirmations/CSV;
`follow` keeps the same exclusive writer active between 30-second observations.
`verify` is a separate read-only check of all completed lifecycles, decrypted
backups, active confirmations, replacements, exact historical payouts and the
closed 84-transaction capital DAG with its confirmed unspent final return; it cannot prepare,
sign or broadcast. Retain the exact source checkpoint: changing executable source
after `init` invalidates the run binding rather than silently reinterpreting it.
Never supply an operational wallet or deterministic fixture keys. Keep the
entire private run directory, its separate wrapping-key files and the isolated
Core wallet; they are recoverable test state, not publishable evidence.
The new host uses persistent private primary/full-backup/rollback-anchor roots,
actual native restoration signatures for all 83 receiving/reserved wallet keys,
complete per-case participant-kit restore checks before funding, and explicit
same-identity recovery after journal or whole-primary loss. Incomplete or stale
host-restoration acknowledgements cannot enable restart or funding. These
separate directories do not protect against whole-disk loss. See the
[persistent recovery procedure](./PRESIGNED-OPERATOR-RUNBOOK.md#persistent-isolated-host-and-explicit-recovery).

After every actual requirement passes on the same source, the private
`presigned:assemble-acceptance` command requires absolute paths via `--local-run`,
`--signet-image`, `--mainnet-image`, `--signet-control` and
`--write-protected-receipt`, plus `--network mainnet` or `--network signet`.
It rereads the complete artifacts and invokes the real Signet verifier now;
there is no argument for supplying a success flag or an invented evidence hash.
The output must not already exist and its directory must be owner-only.
Review and retain the resulting evidence, source and exact OCI directory.
The receipt neither authorizes mainnet activity nor claims physical passkeys.

Mainnet release requires both the general database-restore receipt and a new
`PRESIGNED_V2_FUNDING_RESTORE_RECEIPT` with its independently reviewed
`PRESIGNED_V2_FUNDING_RESTORE_RECEIPT_DIGEST`. The read-only
`presigned:verify-database-restore` command compares explicitly configured
`DATABASE_URL` and `RESTORED_DATABASE_URL` (distinct, verified-TLS databases).
It requires `--vault-id`, `--epoch-id`, two distinct output paths via
`--write-protected-receipt` and `--write-database-receipt`, and
`--confirm-source-quiesced SOURCE_QUIESCED_FOR_BACKUP_RESTORE`.
It does not pause services, perform a restore, authorize spending or replace
the remaining real-network, release-assembly and physical-device checks.

## Preserved v1 implementation and historical evidence

The sections below describe the unchanged `sigbash-v1` product and its historical
limitations. They are not v2 acceptance, release or funding authorization.

A mainnet-production-target implementation of the round-based product governed
by the [authoritative product specification](./spec.md): Alice, Bob, and Carol each
contribute the configured deposit to a shared Taproot vault. Solo withdrawals
follow the original incentive proportions (first out takes a 5% haircut,
later leavers get a bonus) enforced by a Sigbash policy co-signer; the
cooperative exit is a MuSig2 key-path spend of the participants' personal keys
with Sigbash completely uninvolved.

The passkey-backed user product is being built without changing those vault
semantics. Sigbash declined experimental mainnet SDK enablement, so the next
real integration target is the default global Bitcoin Signet; see
[`SIGNET-VALIDATION-PLAN.md`](./SIGNET-VALIDATION-PLAN.md). The current code is
now parameterized behind one typed `mainnet`/default-global-`signet` boundary;
the active validation profile is Signet and cross-network inputs fail closed.
Its current status and hard gates are documented in [`STATUS.md`](./STATUS.md)
and [`PASSKEY-PRODUCT.md`](./PASSKEY-PRODUCT.md). It is not approved for mainnet
funding or deployment. The reviewed container and operator topology are in
[`DEPLOYMENT.md`](./DEPLOYMENT.md); those artifacts prepare the real service
but do not relax the live Sigbash gate.
The active network-specific sequence is
[SIGNET-OPERATOR-RUNBOOK.md](./SIGNET-OPERATOR-RUNBOOK.md).

This repo was originally generated by Codex and then reviewed and reworked —
see `REVIEW.md` for the defects found (including a cross-round policy
confusion attack and a consensus-invalid recovery path), how the current
design fixes them, and historical signet service evidence. That evidence does
not prove mainnet access or signing; see REVIEW.md "Live Sigbash findings".

## Status at a glance

| Capability | State |
|---|---|
| Vault tree, addresses, taproot construction | ✅ consensus-verified |
| Cooperative exit (interactive BIP-327 MuSig2 ceremony) | ✅ consensus + isolated three-browser signing verified; physical-device run remains required |
| Timelocked recovery (N−1 multi_a) | ✅ consensus + distributed passkey-browser verified |
| Final sweep | ✅ consensus + owner-only passkey-browser verified |
| Mainnet + default-global-Signet address, PSBT, policy, RPC, explorer, and database boundary | ✅ both offline suites; fully synced Signet Core plus confirmed real-chain checkpoint |
| Sigbash policy enforcement + tamper rejection | ⚠️ SDK local WASM verification accepted the exact spend of a real confirmed 30,000-sat Signet vault and rejected wrong amount, wrong address, and extra output; this is not hosted-signer acceptance or provider attestation |
| Sigbash co-signing a live Signet withdrawal | ⛔ reproduced on 2026-09-05 for first- and second-round policies: local verification passes, hosted signing returns `server_error: Signing service error` |
| Real standard-Signet coins | ✅ faucet coin confirmed, split into three separately controlled wallet inputs, exact three-wallet funding confirmed, and cooperative vault spend confirmed |
| Per-participant key custody | ✅ browser-distributed and passkey protected |
| Recoverable passkey custody + encrypted Sigbash credentials/kits | ✅ implemented; real authenticator run still required |
| Browser PRF setup/recovery/sign-in/unlock | ✅ Chromium + two virtual authenticators; physical devices still required |
| Optimized standalone user-facing bundle | ✅ passkey + cooperative/recovery/final-sweep/three-wallet-funding Chromium gate; deployed registry digest still required |
| Packaged private operator runtime | ✅ non-mutating fail-closed probe passed in the exact local image |
| Engine-enabled exact-image CI gate | ✅ [both profiles passed](https://github.com/twood22/btc-multiplayer-vault/actions/runs/34000624901) for implementation `3edb17c`; local image evidence only, not deployment |
| Immediate session revocation and vault-tab cleanup | ✅ browser + PostgreSQL verified |
| Immutable three-passkey roster gate | ✅ implemented; PostgreSQL 16 migrations verified, real authenticator run still required |
| User-facing solo/cooperative/recovery/final signing | ✅ implemented and server re-authorized |
| Independent exit proposals and interrupted broadcast recovery | ✅ PostgreSQL regression verified; browser can select a shared proposal without blocking its own solo exit |
| Passkey-bound three-wallet funding, external signatures, final approval, and unanimous restart | ✅ implemented; real wallets/authenticators still required |
| Operator-gated initial funding broadcast + private confirmation watcher | ✅ implemented; isolated CLI/Core three-wallet funding confirmed on Signet, user-facing passkey-gated execution still required |
| PostgreSQL funding/broadcast replay, concurrency, and restart checks | ✅ verified on disposable PostgreSQL 16 |
| Disposable Core reorganization drill against PostgreSQL state | ✅ Bitcoin Core 31.1 runner exercised locally; not live-mainnet proof |
| Database-atomic sensitive-operation rate limits | ✅ implemented and concurrency-verified |
| Predeployment live Sigbash signing proof | ✅ network-specific commands/receipts implemented; real hosted signature still blocked |
| Guarded Sigbash provisioning and recovery | ⚠️ nine existing keys verified and two fresh unfunded pair keys backed up; intermittent SDK compiler-root mismatch remains; fresh friends ceremony unproven |
| Signet-specific release and immutable browser network | ✅ separate artifacts, approval flag, build profile, and fail-closed startup; no live release issued |
| Read-only post-deployment funding report | ✅ implemented; currently fails closed on missing external gates |
| Runs without local Bitcoin Core | ✅ `BITCOIN_BACKEND=esplora` |

The [2026-09-05 review and fixes](./CODE-REVIEW-2026-09-05.md) cover readiness
concurrency, independent proposals, broadcast expiry/reconciliation, and custody
history exhaustion. Migration `014_runtime_liveness` is required for this code;
these local checks are not a deployment or live Sigbash proof.

The subsequent [live Signet investigation](./SIGNET-LIVE-TEST-2026-09-05.md)
reproduced the provider failure and separately found an SDK concurrent
key-response mix-up. The [readiness follow-up](./SIGNET-READINESS-2026-09-05.md)
adds the browser/CLI guard, real-key recovery checks, compiler compatibility,
and Signet release path. No hosted signature or new broadcast was obtained;
the live release gate remains closed. Physical passkey checks are deferred to
onboarding for the first friends vault, not marked complete by virtual tests.

## Requirements

- Node.js exactly 22.23.2, matching `.node-version` (the code is strict TypeScript, run via `tsx` with no build
  step; `npm test` typechecks with `tsc --noEmit` before running the suite)
- Nothing else for local mode. Live mode needs participant-specific Sigbash
  access for the selected network and a matching backend. Chain reads can use configured Esplora,
  but the private initial-funding release deliberately requires Bitcoin Core's
  `testmempoolaccept`. Those external gates are not currently proven.
- A Bitcoin Core backend must be fully synchronized, non-pruned, and started
  with `txindex=1`; the service rechecks configured-network identity and synchronized
  transaction-index capability before every sensitive RPC operation.

## Run

```bash
npm install
npm run product:conformance # local mechanics and product-surface contract
npm test                    # full offline acceptance suite
```

`SIGBASH_MODE=local` (the default) runs everything offline: it builds the
vault tree, real Taproot addresses for the configured network, Sigbash policies,
and real PSBTs; signs and finalizes them with deterministic local keys; and verifies
the same policy constraints the live Sigbash server would enforce.

## Architecture

**One vault UTXO per round.** In the illustrative 1-BTC-per-player schedule,
round one is `{Alice,Bob,Carol}` holding 3 BTC and the three possible round-two
vaults hold the ~2.05 BTC leftover. The private pilot amount is intentionally
undecided and must be much smaller, while preserving the same configured
proportions. A solo
withdrawal spends the entire current vault UTXO into exactly two outputs:
the leaver's pinned payout (index 0) and the next round's vault (index 1).
Ordering needs no counter — the second transaction for the same round is a
double-spend.

**Each vault output is one Taproot output:**

- *Key path*: standard **BIP-327 MuSig2 KeyAgg** of the current participants'
  personal keys (validated against the official BIP-327 test vectors). No
  Sigbash key is ever in the key path; the cooperative exit works with
  Sigbash offline or hostile.
- *Two distinct Sigbash-related tapscript leaves per participant*: a
  `pk(child 0/0)` policy-spend leaf and a bare `pk(internal root)`
  identification leaf required by the historically observed SDK/service input
  recognition behavior. The local product authorizes only the policy leaf.
  Whether the provider subjects every signing path for the identification root
  to the same policy is an explicit pre-funding question.
- *One timelocked recovery leaf*: `older(RECOVERY_DELAY_BLOCKS)` +
  `multi_a(N-1, personal keys)` so a vanished participant cannot freeze the
  vault forever.

**One Sigbash key per (participant, round) — nine keys total.** This is the
load-bearing deviation from a literal reading of the spec ("each participant
gets their own Sigbash key"). A single key with an OR-of-rounds policy is
confusable: the round-two branch (1.025 BTC to the leaver, leftover to the
*other participant's personal address*) can be satisfied while spending the
round-one 3 BTC coin, because Sigbash policies don't see which UTXO is being
spent. With round-scoped keys, a key's signature is only valid for the one
tapscript leaf that contains it, which exists in exactly one round's vault —
the confusion is impossible by construction, and `npm test` includes a
regression test that builds the attack transaction and proves no key/policy
combination accepts it.

**Each key's policy** (all conditions, AND-ed; immutable at creation):

- output 0 value `EQ` the round's payout; destination pinned to the leaver's
  registered address
- output 1 destination pinned to the next round's vault (or the last
  participant's payout address in round two); value `GTE` a floor that caps
  the fee burn at 10,000 sats per withdrawal
- `TX_OUTPUT_COUNT EQ 2`, `TX_INPUT_COUNT EQ 1`
- `REQKEY` in descriptor mode (`tr(SIGBASH_XPUB/0/*)`): Sigbash proves its own
  key is the tapscript leaf being satisfied, resolved from the key's xpub at
  registration time — no circular dependency on knowing the key in advance

Because pair-round policies pin only payout addresses, and round-one policies
pin the pair-round vault addresses, the nine keys can be created immutably in
two phases (pair keys → pair vault addresses → round-one keys). No
admin-only `updateable` keys, no `updatePolicy()`, no 24-hour signing
cooldowns.

## What `npm test` proves

- Spec audit: amounts, vault tree, no Sigbash keys in any key path, policy
  shape, per-round leaf key uniqueness, fee-burn bounds.
- Every policy compiles through the installed `@sigbash/sdk` policy builder.
- PSBT acceptance: structural checks plus tamper rejection (wrong amount,
  wrong address, extra output, cross-round attack, multi-input attack).
- **Consensus acceptance**: the official BIP-327 KeyAgg vectors, then every
  transaction shape the vault can emit — both solo withdrawals, the final
  sweep, round-one and pair-round cooperative exits, and 2-of-3 and 1-of-2
  recoveries with a vanished signer — is fully signed and then verified by an
  independent checker (`src/consensus.js`) that recomputes the control-block
  merkle commitment and BIP-341 sighash, verifies every Schnorr signature,
  emulates the CHECKSIG/CHECKSIGADD/NUMEQUAL and CSV/BIP-68 semantics, and
  enforces a 1 sat/vB relay-fee floor.
- The offline state-transition harness: three deposits, first withdrawal
  (0.95), rejected double-spend, second withdrawal (1.025), final sweep;
  timelocked recovery before/after the delay.

## Key custody (production, each friend on their own device)

The offline fixture derives all keys from one seed. In the product, no one
should hold anyone else's keys:

```bash
# Each participant, on their own machine, with their own secret:
export VAULT_PARTICIPANT_SECRET="$(openssl rand -hex 32)"   # back this up
npm run vault-keygen -- --participant alice
# → prints a PUBLIC roster entry (no private keys). Send it to the others.

# Everyone collects the 3 roster entries and confirms identical addresses:
npm run verify-roster -- --roster '[<alice-entry>,<bob-entry>,<carol-entry>]'
# → prints the round-one funding address. Every participant must see the SAME
#   address (it is order-independent) before anyone funds it.
```

`vault-keygen` currently emits offline Sigbash leaf fixtures alongside the
real personal and payout public keys. Do not fund that roster as-is. The
mainnet product still needs the live Sigbash setup phase to replace those
fields with service-created leaf keys before the funding address is final.

## Cooperative exit ceremony (interactive MuSig2)

The trust-minimized exit runs the real BIP-327 two-round protocol across the
participants' devices, so no machine ever holds another's key:

```bash
npm run ceremony-start -- --roster '<roster>' --round alice,bob,carol \
  --txid <vault_txid> --vout <n> --value-sats <sats> --script-pubkey <hex>
# → context. Each participant runs, on their own machine:
export VAULT_PARTICIPANT_SECRET='<this-participant-secret>'
npm run ceremony-nonce -- --roster '<roster>' --context '<context>' \
  --txid <vault_txid> --vout <n> --value-sats <sats> --script-pubkey <hex> \
  --secnonce-file ./cooperative-exit.secnonce
npm run ceremony-partial -- --roster '<roster>' --context '<context>' \
  --pubnonces '<all-pubnonces>' --txid <vault_txid> --vout <n> \
  --value-sats <sats> --script-pubkey <hex> \
  --secnonce-file ./cooperative-exit.secnonce
# Then anyone aggregates:
npm run ceremony-aggregate -- --roster '<roster>' --context '<context>' \
  --pubnonces '<all-pubnonces>' --partials '<all-partials>' \
  --txid <vault_txid> --vout <n> --value-sats <sats> --script-pubkey <hex>
# → final signed transaction, ready to broadcast.
```

The secret nonce is never printed or accepted on the command line. It is
created as a new owner-only file, bound to the participant, round, message,
and public nonce, then destroyed before the partial signature is generated.

## Command reference

Everything is `npm run <command> [-- args]`. Offline: `setup`, `vault-keygen`,
`verify-roster`, `cooperative`,
`solo`, `recovery`, `offline:state-machine`, `signed-local-run`, `funding-manifest`,
`watch-manifest`, `vault-output`, `funding-psbt`, `solo-psbt`,
`sign-solo-psbt`, `cooperative-psbt`, `sign-cooperative-psbt`,
`recovery-psbt`, `recovery-share`, `recovery-aggregate`,
`sign-recovery-psbt` (single-machine test harness only), `final-sweep-psbt`,
`sign-final-sweep-psbt`, `policy-check-psbt`, `inspect-psbt`,
`psbt-acceptance`, `dual-leaf-acceptance`, `custody-acceptance`,
`network-acceptance`, `audit`,
`sdk-policy-check`.

Bitcoin Core mainnet RPC: `rpc-gettxout`, `rpc-decode-tx`,
`rpc-testmempoolaccept`, `rpc-submit`, `rpc-broadcast`, `rpc-tx-status`,
`rpc-find-output`, `rpc-import-watchonly`, `rpc-walletprocesspsbt`,
`rpc-combinepsbt`, `rpc-finalizepsbt`, `verify-vault-utxo`,
`cooperative-readiness`, `recovery-readiness`.

Live Sigbash: `sigbash-live-setup`, `sigbash-sign-psbt`, `live-readiness`,
`live-predeployment-setup`, `live-predeployment-proof`,
`live-solo-withdrawal`, `live-solo-tamper-check`, `live-solo-audit`,
`live-cooperative-audit`, `live-recovery-audit`, `live-final-sweep-audit`,
`live-run-audit`, `live-acceptance-evidence`.

Runtime spends never broadcast during signing or finalization. After
reviewing the exact finalized transaction, an eligible signer must check the
mainnet warning and complete a separate passkey assertion. The server submits
only those stored bytes. Set `VAULT_CONFIRMATIONS_REQUIRED` deliberately for
the private beta. Run `npm run web:watch-chain` from a private scheduler to
resume an interrupted approved runtime submission, activate the exact
operator-submitted initial funding transaction, and advance later broadcast
proposals only after the backend returns the exact bytes with that confirmation
depth. The command holds a dedicated PostgreSQL session advisory lease for its
entire run; an overlapping scheduler invocation reports that it took no action
and exits successfully, while a crashed process releases the lease with its
database connection. It retains each confirmation block hash and continues
checking confirmed state: an orphaned anchor causes an atomic rollback to the
exact prior coin,
while the same transaction re-included deeply enough is reanchored without
changing product state. RPC unavailability never counts as reorganization
evidence. Initial funding itself has no HTTP broadcast route.

Before a funded release, exercise the identical reconciliation and database
boundary against an actual disposable Core node:

```bash
npm run web:test:core-reorg
```

The runner downloads the official x86-64 Bitcoin Core 31.1 archive only when
needed and verifies its pinned SHA-256 checksum. It creates isolated Core and
PostgreSQL data directories, mines a throwaway transaction, invalidates its
block, proves an RPC outage leaves state untouched, re-includes it in a
replacement block, and invalidates that block again to prove rollback. It then
stops both services and trashes the temporary wallet, chain, database, and test
keys. Set `BITCOIN_CORE_BIN`, `POSTGRES_BIN`, and, when necessary,
`POSTGRES_LIB` to use reviewed local installations. This is a real backend
failure drill, not permission to use regtest in the product and not evidence of
Sigbash or Bitcoin mainnet readiness.

`web:verify-database-restore` closes the production restore-evidence boundary.
With the source quiesced, it opens read-only repeatable snapshots against the
selected production database and an isolated restored database with a distinct
server-reported database name, compares the
complete public schema and every application row, and writes an owner-only
receipt containing only endpoint fingerprints, counts, and digests. The
pre-funding release report authenticates that receipt, requires it to name the
configured production endpoint, and rejects it after 24 hours. It never logs
database URLs or row contents and does not perform, replace, or schedule the
provider's encrypted backup itself.

`policy-check-psbt` and `sigbash-sign-psbt` infer the round from the PSBT's
input scriptPubKey, so you only pass `--participant`.

## Live Sigbash mode

1. **Set a real seed.** Every live command refuses to run while
   `VAULT_DEMO_SEED` is the public default:

   ```bash
   export VAULT_DEMO_SEED="$(openssl rand -hex 32)"   # back this up
   ```

2. **Credentials.** Put the Sigbash triplet in `.env` (see `.env.example`).
   Each participant should hold their own triplet
   (`SIGBASH_API_KEY_ALICE=...` etc.); the unsuffixed triplet is the fallback
   for single-operator runs — in that case one machine holds every browser
   share, which is suitable only for isolated testing and unacceptable for
   real funds.
   Locally generated credentials are signet-only until Sigbash enables their
   organization hash for mainnet. The user-facing passkey flow generates these
   triplets automatically, but it cannot grant that external entitlement; all
   three independent participant organization hashes must be enabled.

   For the separate command-line predeployment proof credential, create a new
   owner-only file without printing or overwriting secrets:

   ```bash
   npm run sigbash-bootstrap
   ```

   This exclusively creates `live-run/proof-credentials.env` inside an
   owner-only directory, including a fresh proof vault seed and the reviewed
   Sigbash runtime pins, and prints only its non-secret `apikeyHash`. It refuses
   to follow a linked target or overwrite an existing file, and durably syncs
   the owner-only file and directory before reporting success. `live-run` is
   excluded from both Git and the container build context. Back up that
   credential file before asking Sigbash to enable the hash for mainnet.

   Every CLI command loads its selected protected environment before importing
   vault configuration and refuses linked or group/other-readable files or a
   parent directory where another user could replace them. The proof commands
   select the credential file above automatically; general CLI commands default
   to `.env`. The proof seed, economics, runtime pins, and credentials therefore
   reach one consistent configuration snapshot.

   For command-line credentials, print only the non-secret activation value
   without exposing the triplet:

   ```bash
   npm run sigbash-proof-org-id
   ```

3. **Create the nine keys:**

   ```bash
   SIGBASH_MODE=live npm run sigbash-live-setup
   ```

   This creates the six pair-round keys, derives the pair vault addresses,
   then creates the three round-one keys with those addresses pinned, and
   prints `envExports`: a `SIGBASH_LEAF_KEYS_JSON` value plus one
   `SIGBASH_KEY_ID_<PARTICIPANT>_<ROUND>` per key. Export all of them before
   running any other command. Before a created or crash-resumed key is added
   to the non-secret setup checkpoint, the command immediately exports its
   recovery kit to owner-only `live-run/recovery-kits.jsonl`. It refuses to
   resume a checkpoint without the matching kit. This journal contains
   private-key-equivalent recovery material: never print it, copy it into an
   environment variable, or commit it. Back it up separately with the
   credential file. Never fund a printed helper `p2trAddress`.

   The smaller deployment gate uses `live-predeployment-setup`. It creates
   only one real pair's two keys and writes their non-secret derived
   configuration to owner-only `live-run/predeployment.env`; the corresponding
   `live-predeployment-proof` package command loads it together with the
   separately protected credential file automatically. Each key's recovery
   kit is durably written first to owner-only
   `live-run/predeployment-recovery-kits.jsonl`; a retry lists the live keys
   and resumes only the single key whose mainnet network and canonical policy
   match. Back up both secret files before continuing. Never fund the proof
   address. A successful real signing run exclusively writes an owner-only
   `live-run/predeployment-proof-receipt.json`; review its consensus evidence
   and bind its `proofDigest` into the later funding release environment. The
   command and receipt retain only the explicit public signing-result fields;
   unexpected provider-response fields are discarded.

   *Leaf-key contract:* the tapscript leaf key is derived from each key's
   BIP-328 xpub at child path 0/0, matching the SDK's documented
   `tr(SIGBASH_XPUB/0/*)` multisig convention. The descriptor-mode `REQKEY`
   in every policy makes Sigbash verify this itself at signing time. If a live
   `verifyPSBT` fails on `REQKEY`, stop and confirm the mainnet derivation
   contract with Sigbash. Do not substitute another candidate or rebuild the
   vault around an unverified assumption.

4. **Only after all nine browser readiness proofs pass and a separate funding
   approval is given, fund round one** with the exact configured output. The
   funding builder requires exactly one distinct P2WPKH or P2TR input from each
   participant, a relayable fee, and no dust change; it derives the output from
   the private beta's committed tiny-mainnet economics:

   The web vault now performs the real preparation ceremony: each friend enters
   one wallet outpoint and change address, independently observes the coin on
   mainnet, and approves that exact commitment with a passkey. Once all three
   approvals exist, every browser rebuilds the same canonical unsigned PSBT.
   Set `VAULT_FUNDING_FEE_SATS` explicitly before opening this ceremony. Each
   external wallet then signs only its own P2WPKH or P2TR input. Browser and
   server independently verify and normalize that signature while discarding
   wallet metadata. The service applies all three signatures to the pristine
   PSBT, and every friend uses a passkey again to approve the exact finalized
   witness transaction. A stale input, fee, or signature can be invalidated
   only by three passkeys approving the same exact state and reason; the reset
   leaves an immutable public-fingerprint audit event.

   ```bash
   npm run funding-psbt -- --inputs-json '[{"participantId":"alice",...},...]' --fee-sats 3000
   ```

   After independently reviewing the successful live Sigbash proof and all
   automated and manual gates, set `DEPLOYED_IMAGE_MANIFEST_DIGEST` to the exact
   published registry manifest digest (`sha256:<64 lowercase hex>`) and write a
   fresh protected report only after the three final passkey approvals. Do not
   substitute a local Docker image ID:

   ```bash
   npm run web:release-status -- \
     --write-protected-report live-run/funding-release-report.json \
     --confirm-manual-gates REVIEWED_EVERY_MANUAL_FUNDING_GATE
   ```

   Record its non-secret `reportDigest` and exact path in the protected
   operator environment. The private command authenticates that owner-only
   artifact and requires it to bind the same vault, finalization, transaction,
   live proof, and deployed registry manifest digest within a 30-minute window.
   The funding-broadcast job must carry the same independently reviewed
   `DEPLOYED_IMAGE_MANIFEST_DIGEST`. A separate explicit operator
   decision can then submit only the unanimously approved bytes through private
   Bitcoin Core preflight:

   ```bash
   npm run web:broadcast-funding -- \
     --vault-id <uuid> \
     --finalization-digest <browser-shown-finalization-digest> \
     --live-sigbash-proof-digest "$LIVE_SIGBASH_MAINNET_PROOF_DIGEST" \
     --release-report-digest "$FUNDING_RELEASE_REPORT_DIGEST" \
     --confirm-mainnet-broadcast BROADCAST_EXACT_APPROVED_FUNDING_TRANSACTION
   ```

   The private watcher activates that exact output only after
   `VAULT_CONFIRMATIONS_REQUIRED`. `web:record-funding` remains a manual
   recovery boundary for the same exact-byte and confirmation-block checks:

   ```bash
   npm run web:record-funding -- --vault-id <uuid> --txid <round1_txid> --vout <n>
   ```

   Submission first requires Bitcoin Core `testmempoolaccept` to return the
   exact txid, vsize, and fee. Activation checks exact unanimously approved
   witness bytes, mainnet identity, unspent status, three unique P2WPKH or P2TR
   inputs, the canonical input/output order, exactly one roster-derived vault
   output, non-dust change, fee sanity, vault readiness, and the configured
   confirmation depth before the database can become active.
   The watcher keeps checking the recorded block after activation. If mainnet
   removes it, the successor coin becomes orphaned, the exact prior coin and
   vault status are restored atomically, participant observations of the
   orphaned coin are cleared, and the event retains only public chain
   fingerprints. Already-broadcast descendants remain tracked; unsigned
   descendants require a fresh ceremony after their ancestor reconfirms.
   The chain structure cannot identify the human owner of each input, so the
   three friends must still review their own wallet's input and the final
   transaction before signing. The recorder is not an HTTP route and must not
   be run until funding has been separately approved.

5. **Solo withdrawal** (Alice leaves first):

   ```bash
   npm run solo-psbt -- --round alice,bob,carol --leaver alice --txid <round1_txid> --vout <n> --value-sats 300000000
   npm run policy-check-psbt -- --participant alice --psbt-base64 <psbt>
   SIGBASH_MODE=live npm run live-solo-tamper-check -- --round alice,bob,carol --leaver alice --txid <round1_txid> --vout <n>
   SIGBASH_MODE=live npm run sigbash-sign-psbt -- --participant alice --psbt-base64 <psbt>
   npm run rpc-testmempoolaccept -- --hex <txHex>
   npm run rpc-submit -- --hex <txHex>
   ```

   `verifyPSBT()` always runs before `signPSBT()` so failures surface without
   consuming a signing nullifier; the tamper check proves wrong-amount,
   wrong-address, and extra-output variants are rejected live.

6. **Cooperative exit / recovery / final sweep** use the corresponding
   `*-psbt` + `sign-*-psbt` pairs and the `live-*-audit` commands, exactly as
   in local mode — neither path contacts Sigbash. Recovery requires the vault
   UTXO to have at least `RECOVERY_DELAY_BLOCKS` confirmations
   (`recovery-readiness` checks this).

## Fees

- Solo withdrawals: fee comes out of the leftover; the policy floor caps the
  burn at 10,000 sats per withdrawal.
- Cooperative exit: the pot is split equally after a ~900 sat miner fee
  (a zero-fee transaction would never relay). "Full deposit back" is
  therefore full deposit minus ~300 sats each in round one; a pair-round
  cooperative exit also returns the departed player's haircut surplus
  instead of burning it.
- Recovery: 1,500 sats, split across the recovered outputs.

## Trust model and caveats — read before funding anything

- **Live Sigbash signing is not proven.** Fresh Signet keys exist and the SDK's
  local WASM verifier accepts the allowed PSBT while rejecting hostile variants, but the
  hosted signer currently returns `server_error: Signing service error`. Signet
  evidence is never a substitute for a later mainnet proof.
- **The recovery leaf is an N-1 collusion path after the delay.** Once a vault
  UTXO sits `RECOVERY_DELAY_BLOCKS` (default 6, ~1 hour) without moving, any
  N-1 of the current participants can co-sign the recovery leaf and send the
  whole pot wherever they agree — in a pair round that is *one* person. The
  spec mandates this leaf, while the offline fixture uses a short delay. Before
  funding, choose and review a production `RECOVERY_DELAY_BLOCKS` value and
  treat the leaf as the explicit trust trade-off it is.
- **Solo withdrawals trust Sigbash for policy, never for custody.** A hostile
  Sigbash can refuse to co-sign (griefing) but can never move funds — exits
  remain available via the cooperative key path or the recovery leaf.
- **Cooperative exit is now trust-minimized in ceremony too.** The
  `ceremony-*` commands run the real interactive BIP-327 MuSig2 protocol
  (validated against the official vectors), so no machine holds all keys. The
  single-process `signCooperativeExitPsbt` remains only as an offline-test
  convenience and is not used in the ceremony path.
- **Key custody.** `vault-keygen`/`verify-roster` let each participant generate
  keys from their own secret and confirm identical vault addresses before
  funding. The default `VAULT_DEMO_SEED` is public and live commands refuse it.
- **Network-typed and still release-gated.** Every executable address, PSBT,
  policy, SDK, RPC, explorer, database, and custody path is bound to the selected
  `mainnet` or default-global-`signet` profile; amounts and fees remain
  env-overridable (`VAULT_DEPOSIT_SATS`, `VAULT_*_FEE_SATS`). Passing Signet can
  never authorize mainnet. A deliberately tiny amount profile, reviewed recovery
  delay, unanimous roster, and live Sigbash signature remain mandatory.
- **Browser Sigbash registration is not provider-attested.** The coordinator
  verifies the submitted xpub, derived leaves, index, and policies for internal
  consistency, but it cannot currently prove to the other participants that
  Sigbash issued the key or committed the claimed policy. Until Sigbash provides
  a verifiable attestation or a trusted read-only verification path is added, a
  dishonest participant could register a self-controlled leaf and bypass the
  game policy outside this application. This is a hard pre-funding blocker.
- **Exit fees are committed and not dynamically bumpable.** Choose them for a
  long-lived mainnet vault only after adding a participant-approved fee-bump or
  explicitly tested CPFP/RBF procedure; the small-deposit defaults are not a
  production fee market strategy.
