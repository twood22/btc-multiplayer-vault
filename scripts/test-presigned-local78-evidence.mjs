/** Synthetic privacy/transport tests. Never runs Core, browsers, a database or uploads. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT_FIELDS } from './presigned-local78-output-profile.mjs';
import { PINS, ASSETS, candidateContext, expectedNames, strictJson, splitTranscript, producerLexicon,
  validateRecord, validString, publicRun, validateRetention, reviewerDigest, publicReviewFailure, reviewStderr, reviewTranscript, validateReview, hash,
  toolingIdentity, verifyToolingBoundary } from './presigned-local78-public-evidence.mjs';
import { writeExclusive, absent } from './presigned-local78-private.mjs';
import { hostedGate, draftGate, uploadGate, canonicalJson } from './presigned-local78-ci.mjs';

const here=dirname(fileURLToPath(import.meta.url)), context=await candidateContext();
let controls=0;const denied=run=>{assert.throws(run);controls++;};
const names=expectedNames(context.plan);assert(names.length===171&&new Set(names).size===171);
reviewStderr(Buffer.alloc(0));for(const value of ['private token','warning','\n','{}'])denied(()=>reviewStderr(Buffer.from(value)));
const privateValue='private-diagnostic-never-publish';
assert.equal(publicReviewFailure('database-schema','database-v3-all','restore',context.plan).databaseLabel,'restore');
assert(!JSON.stringify(publicReviewFailure(privateValue,privateValue,privateValue,context.plan)).includes(privateValue));
const hostile=new Error(privateValue);Object.defineProperty(hostile,'message',{get(){throw new Error(privateValue);}});
assert(!JSON.stringify(publicReviewFailure(hostile,hostile,hostile,context.plan)).includes(privateValue));controls+=3;
assert(!names.some(n=>n.includes('/')||/wallet\.dat|\.dump$|\.cookie|browser\.log$/u.test(n)));
for(const text of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"nested":{"a":1,"a":2}}',
  '{"a":true,}', '{/* note */"a":true}', '{"a":NaN}', '{"a":Infinity}', '{"a":true} secret'])denied(()=>strictJson(text,context.ts));
assert.deepEqual(strictJson('{"a":[true,1,null,"text"]}',context.ts),{a:[true,1,null,'text']});
for(const text of ['{"passed":true}\r\n','{unfinished\n','\u0000','{"a":1,"a":2}\n'])denied(()=>splitTranscript(text,context.ts));
const lexicon=producerLexicon(['src/presigned/fees-acceptance.ts','src/presigned/types.ts'],context);
assert(lexicon.has('Completed signet nine-exit / three-wallet positive fee matrix'));
assert(lexicon.has('Completed mainnet nine-exit / three-wallet positive fee matrix'));
validString('stage','Completed signet nine-exit / three-wallet positive fee matrix',lexicon);
for(const value of ['private-invitation-secret-never-publish','a'.repeat(64),'Y'.repeat(128),'/home/codex/.codex/private','https://private.invalid/secret'])
  denied(()=>validString('checks[]',value,lexicon));
validString('txid','a'.repeat(64),lexicon);
for(const value of ['a'.repeat(63),'g'.repeat(64),'A'.repeat(64),'a'.repeat(64)+'private'])denied(()=>validString('txid',value,lexicon));
for(const value of ['TRUC-violation, private secret','min relay fee not met, private','unknown-policy','bad-witness-nonstandard private'])
  denied(()=>validString('mempoolRejection.reject-details',value,lexicon));
// Genuine unchanged Core 31.1 observed-witness runs have both 350-vB/35-sat
// and 351-vB/36-sat outcomes. These are privacy-shape controls, not new evidence.
for (const path of ['mempoolRejection.reject-details','results[].mempoolRejection.reject-details']) {
  for (const value of ['min relay fee not met','min relay fee not met, 1 < 35','min relay fee not met, 1 < 36']) validString(path,value,lexicon);
  for (const number of ['0','1','2','34','37','350','360','035','036','-35','+35','35.0','3.5e1','35 36','35, 36','35secret','３５'])
    denied(()=>validString(path,`min relay fee not met, 1 < ${number}`,lexicon));
  for (const suffix of [' private','a'.repeat(64),'\n','\r','\t','\u0000','\u007f','\nprivate'])
    for (const value of ['min relay fee not met, 1 < 35','min relay fee not met, 1 < 36'])
      denied(()=>validString(path,`${value}${suffix}`,lexicon));
  for (const value of [' min relay fee not met, 1 < 35','min relay fee not met, 2 < 35','min relay fee not met, 0 < 35',
    'min relay fee not met, 01 < 35','min relay fee not met, 1<35','min relay fee not met, 1 <  35','min relay fee not met, 1 <= 35'])
    denied(()=>validString(path,value,lexicon));
}
validString('descendantRejection','TRUC-violation',lexicon);
validString('mempoolRejection.reject-details',`mempool-script-verify-flag-failed (Non-canonical signature: S value is unnecessarily high), input 0 of ${'a'.repeat(64)} (wtxid ${'b'.repeat(64)}), spending ${'c'.repeat(64)}:3`,lexicon);
for(const path of ['/tmp/btc-presigned-core-ABC/../../wallet.dat','/tmp/private-secret','/home/codex/private','/tmp/btc-presigned-core-ABC/.cookie',
  `/tmp/btc-presigned-restore.${'a'.repeat(64)}`,'/tmp/btc-presigned-restore.abc','/tmp/btc-presigned-restore.abcdefg',
  `/tmp/btc-presigned-native-restore-check.Ab12Cd/wallet-restore-proof.${'b'.repeat(64)}`])
  denied(()=>validString('evidence',path,lexicon));
validString('evidence','/tmp/btc-presigned-core-Ab12Cd',lexicon);
validString('evidence','/tmp/btc-presigned-restore.Ab12Cd',lexicon);
validString('restorationProof','/tmp/btc-presigned-native-restore-check.Ab12Cd/wallet-restore-proof.Ef34Gh',lexicon);
for(const fields of Object.values(OUTPUT_FIELDS)) {
  denied(()=>validateRecord({privateKeyHex:'a'.repeat(64)},fields,lexicon));
  denied(()=>validateRecord({unknown:'private value'},fields,lexicon));
  denied(()=>validateRecord(JSON.parse('{"__proto__":{"private":"value"}}'),fields,lexicon));
  const [field,type]=Object.entries(fields).find(([f,t])=>!/[.\[\]]/u.test(f)&&t==='n')??[];
  if(field)for(const value of [-1,Infinity,NaN,'1',Number.MAX_SAFE_INTEGER+1])denied(()=>validateRecord({[field]:value},fields,lexicon));
}
const fixture={passed:true,network:'signet',nativeWalletCombinations:8,exitsPerCombination:9,
  kind:'offline-cryptographic-acceptance',protocol:'presigned-graph-v2',bitcoinCoreVerified:false,browserVerified:false,publicNetworkBroadcasts:0,checks:[]};
validateRecord(fixture,OUTPUT_FIELDS['crypto-NETWORK-00'],producerLexicon(['src/presigned/acceptance.ts'],context));
for(const mutation of [{...fixture,checks:['a'.repeat(64)]},{...fixture,checks:[{name:'private',privateKeyHex:'a'.repeat(64)}]},
  {...fixture,passed:'true'},{...fixture,network:{secret:'private'}},{...fixture,network:{}},{...fixture,passed:{}},
  {...fixture,publicNetworkBroadcasts:{}}])denied(()=>validateRecord(mutation,OUTPUT_FIELDS['crypto-NETWORK-00'],lexicon));
const env={GITHUB_ACTIONS:'true',RUNNER_OS:'Linux',RUNNER_ARCH:'X64',GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_REF:'refs/heads/codex/presigned-v3-test-evidence',GITHUB_REPOSITORY:PINS.repository,GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123',
  PRESIGNED_ACCEPTANCE_PROTOCOL:PINS.protocol,PRESIGNED_BUILD_PROTOCOL:PINS.protocol};
const event={repository:{private:false,full_name:PINS.repository},inputs:{operation:'local'}};
hostedGate(env,event);toolingIdentity(env.GITHUB_SHA,env);toolingIdentity(PINS.toolingBase,{});
// Pure synthetic identities; no real hosted run or commit is fabricated.
toolingIdentity('b'.repeat(40),{PRESIGNED_REVIEWED_TOOLING_COMMIT:'b'.repeat(40)});
for(const [head,environment] of [['b'.repeat(40),{}],['b'.repeat(40),{PRESIGNED_REVIEWED_TOOLING_COMMIT:'a'.repeat(40)}],
  ['b'.repeat(40),{PRESIGNED_REVIEWED_TOOLING_COMMIT:'UNSET'}],['b'.repeat(40),{...env}],
  [env.GITHUB_SHA,{...env,PRESIGNED_REVIEWED_TOOLING_COMMIT:env.GITHUB_SHA}],
  [env.GITHUB_SHA,{...env,GITHUB_EVENT_NAME:'push'}],[env.GITHUB_SHA,{...env,GITHUB_REF:'refs/heads/main'}],
  [env.GITHUB_SHA,{...env,GITHUB_REPOSITORY:'unapproved/repository'}],[PINS.toolingBase,{GITHUB_ACTIONS:'false'}]])
  denied(()=>toolingIdentity(head,environment));
for(const [field,value]of Object.entries({...env,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'unapproved/repository',
  RUNNER_OS:'Windows',GITHUB_SHA:'unset',GITHUB_RUN_ID:'0',PRESIGNED_BUILD_PROTOCOL:'presigned-graph-v2',GITHUB_ACTIONS:'false',RUNNER_ARCH:'ARM64'}))
  if(value!==env[field])denied(()=>hostedGate({...env,[field]:value},event));
denied(()=>hostedGate({...env,PRESIGNED_ACCEPTANCE_PROTOCOL:'presigned-graph-v2'},event));
for(const changed of [{...event,inputs:{operation:'images'}},{...event,inputs:{}},{...event,repository:{private:true,full_name:PINS.repository}},
  {...event,repository:{private:false,full_name:'unapproved/repository'}}])denied(()=>hostedGate(env,changed));
const release={id:PINS.draftId,tag_name:PINS.tag,draft:true,prerelease:true,target_commitish:PINS.candidate,assets:[]};draftGate(release);uploadGate(release);
for(const [field,value]of [['id',388165893],['tag_name','presigned-v3-test-evidence-61d3b2c5-20260914'],['draft',false],['prerelease',false],['target_commitish','main'],['assets',null]])
  denied(()=>draftGate({...release,[field]:value}));
for(const name of ASSETS)denied(()=>uploadGate({...release,assets:[{name}]}));
uploadGate({...release,assets:[{name:'presigned-v3-signet-test-evidence.tar.gz'}]});
const retention={version:1,protocol:PINS.protocol,kind:'presigned-v3-public-local78-test-evidence',origin:'github-actions-local',
  sourceCommit:PINS.candidate,sourceDigest:PINS.source,toolingBase:PINS.toolingBase,toolingCommit:verifyToolingBoundary(),
  workflowRunId:process.env.GITHUB_ACTIONS==='true'?process.env.GITHUB_RUN_ID:'123',draftId:PINS.draftId,reviewerDigest:reviewerDigest(),
  createdAt:'2026-09-19T00:00:00.000Z',assetName:ASSETS[0],archiveSha256:'b'.repeat(64),archiveBytes:100,decodedBytes:200,
  evidenceDigest:'c'.repeat(64),files:171,commands:78,restoredBytesRevalidated:true,syntheticOnly:true,
  productionUsePermitted:false,realDefaultSignetVerified:false,physicalPasskeysVerified:false,releaseReceiptProduced:false,
  fundingAuthorized:false,published:false};
validateRetention(retention);
for(const [field,value]of [['version',3],['protocol','presigned-graph-v2'],['files',170],['archiveBytes',0],['archiveBytes',65*1024*1024],
  ['sourceCommit','0'.repeat(40)],['sourceDigest','0'.repeat(64)],['assetName','presigned-v3-signet-test-evidence.tar.gz'],['unknown','private'],
  ['syntheticOnly',false],['restoredBytesRevalidated',false],...['productionUsePermitted','realDefaultSignetVerified','physicalPasskeysVerified','releaseReceiptProduced','fundingAuthorized'].map(f=>[f,true])])
  denied(()=>validateRetention({...retention,[field]:value}));
const review={...retention,kind:'presigned-v3-public-local78-content-review',passed:true,importExitCode:0,
  exactArchiveMembersInspected:true,canonicalOuterEnvelopeVerified:true,allTranscriptBytesInspected:true,candidateSemanticValidationRepeated:true,exactOfflineBytesVerified:true,universalSecretAbsenceProven:false};
validateReview(review,retention);
for(const [field,value]of [['commands',77],['reviewerDigest','a'.repeat(64)],['allTranscriptBytesInspected',false],['candidateSemanticValidationRepeated',false],
  ['exactOfflineBytesVerified',false],['universalSecretAbsenceProven',true],['unknown','private'],['sourceDigest','a'.repeat(64)]])denied(()=>validateReview({...review,[field]:value},retention));
const run={version:3,protocol:PINS.protocol,kind:'presigned-v3-local-executable-run',mode:'local',sourceDigest:PINS.source,
  createdAt:'2026-09-14T00:00:00.000Z',completedAt:'2026-09-14T01:00:00.000Z',reviewedNodeVersion:readFileSync('.node-version','utf8').trim(),
  commands:context.plan.map(command=>({command,startedAt:'2026-09-14T00:00:00.000Z',completedAt:'2026-09-14T01:00:00.000Z',sourceDigest:PINS.source,
    exitCode:0,stdoutSha256:'a'.repeat(64),stderrSha256:'b'.repeat(64),artifactDigests:(command.category==='database'
      ?['ceremony','runtime','chain-broadcast','fee','restore',...(command.id==='database-v3-all'?['cashout','protocol-queue']:[])]
        .map(label=>`${command.id}-${label}.log`):command.category==='browser'?[`${command.id}-browser.json`]:[])
      .map(relativePath=>({relativePath,sha256:'a'.repeat(64)})),executionDigest:'c'.repeat(64)})),
  offlineUtilityDigest:'d'.repeat(64),physicalPasskeysVerified:false,realSignetVerified:false,exactImageVerified:false,fundingAuthorized:false,runDigest:'e'.repeat(64)};
publicRun(run,context); // Public shape only; deliberately not executable acceptance evidence.
for(const altered of [{...run,commands:run.commands.slice(1)},{...run,fundingAuthorized:true},{...run,privateKeyHex:'f'.repeat(64)},
  {...run,createdAt:'2026-09-14 private'},{...run,commands:[{...run.commands[0],command:{...run.commands[0].command,args:['private-secret']}},...run.commands.slice(1)]}])denied(()=>publicRun(altered,context));
const secret='synthetic-private-token-never-publish';
const child=spawnSync(process.execPath,[join(here,'presigned-local78-private.mjs'),'upload','/private'],{encoding:'utf8',env:{PATH:process.env.PATH,GH_TOKEN:secret}});
assert.equal(child.status,1);assert(!`${child.stdout}${child.stderr}`.includes(secret));controls++;
const hostedChild=spawnSync(process.execPath,[join(here,'presigned-local78-ci.mjs'),'upload','/private'],{encoding:'utf8',env:{PATH:process.env.PATH,GH_TOKEN:secret}});
assert.equal(hostedChild.status,1);assert(!`${hostedChild.stdout}${hostedChild.stderr}`.includes(secret));controls++;
// Source-grounded synthetic outputs, never actual acceptance evidence.
const protocolList=['presigned-graph-v2','presigned-graph-v3'];
const cli={passed:true,suite:'presigned-observe-coins-actual-cli',commandCount:30,negativeCases:24,
  successfulProducerConsumerCases:6,protocols:protocolList,networks:['mainnet','signet'],
  legacyV2DefaultPreserved:true,preCookieArgumentRejection:true,requests:1,
  readOnlyMethods:['getblockchaininfo','getblockhash','getblockheader','getindexinfo','getrawtransaction','gettxout','gettxspendingprevout'],
  evidence:'loopback-synthetic-rpc-only',syntheticRpcFixture:true,productionRpcOrChainContact:false,
  actualChainEvidence:false,realCredentials:false,signed:false,broadcast:false};
const source={passed:true,suite:'presigned-offline-current-shared-source',checks:444,positiveCases:220,negativeCases:224,
  graphSources:16,ageBoundaryCases:64,pendingConflictCases:32,protocols:protocolList,networks:['mainnet','signet'],
  syntheticPublicFixturesOnly:true,actualChainEvidence:false,rpc:false,signed:false,broadcast:false};
const fees={passed:true,kind:'actual-saved-html-fee-review-boundary',sourceDigest:PINS.source,
  suiteSha256:'a'.repeat(64),artifactSha256:'b'.repeat(64),manifestSha256:'c'.repeat(64),inputDigest:'d'.repeat(64),
  protocols:protocolList,validPackages:16,rejectedImports:24,refusedActions:144,asyncInvalidations:6,validFundingPackages:2,
  fundingConflictingImportsRejected:2,fundingIncompleteFinalizationsRefused:4,actualBrowserExecuted:true,
  syntheticPublicFixturesOnly:true,actualBlockchainContact:false,networkRequests:0,publicNetworkBroadcasts:0};
const coin={passed:true,checks:76,protocols:protocolList,networks:['mainnet','signet'],actualChainEvidence:false};
for(const [id,fixture] of [['observation-cli-boundaries',cli],['offline-source-boundaries',source],
  ['offline-fee-review-boundaries',fees],['crypto-signet-08',coin]]) {
  const command=context.plan.find(c=>c.id===id);assert(command);
  const text=JSON.stringify(fixture)+'\n';reviewTranscript(command,text,context);
  for(const key of Object.keys(fixture)) {const missing={...fixture};delete missing[key];denied(()=>reviewTranscript(command,JSON.stringify(missing),context));}
  for(const changed of [{...fixture,unknown:'private-value'},{...fixture,privateKeyHex:'a'.repeat(64)},
    {...fixture,passed:'true'},{...fixture,protocols:['unapproved-protocol']},{...fixture,protocols:['a'.repeat(64)]}])
    denied(()=>reviewTranscript(command,JSON.stringify(changed),context));
  for(const changed of ['',text+text,text+'{}\n',text+'private-value\n'])
    denied(()=>reviewTranscript(command,changed,context));
}
for(const key of ['sourceDigest','suiteSha256','artifactSha256','manifestSha256','inputDigest'])
  for(const value of ['a'.repeat(63),'g'.repeat(64),'A'.repeat(64),'a'.repeat(64)+'secret'])
    denied(()=>reviewTranscript(context.plan.find(c=>c.id==='offline-fee-review-boundaries'),JSON.stringify({...fees,[key]:value}),context));
for(const [key,value] of [['origin','github-actions'],['commands',75],['commands',79],['files',165],['decodedBytes',0],
  ['decodedBytes',65*1024*1024],['toolingBase','0'.repeat(40)],['reviewerDigest','0'.repeat(64)],['published',true],
  ['workflowRunId','0'],['draftId',388165893],['toolingCommit','0'.repeat(40)],['jobId','123']])
  denied(()=>validateRetention({...retention,[key]:value}));
for(const [key,value] of [['importExitCode',1],['exactArchiveMembersInspected',false],['published',true]])
  denied(()=>validateReview({...review,[key]:value},retention));
for(const changed of [run.commands.slice(0,75),[...run.commands,run.commands[0]],
  [...run.commands.slice(1),run.commands[0]],run.commands.map((execution,index)=>index===0?{...execution,exitCode:1}:execution)])
  denied(()=>publicRun({...run,commands:changed},context));
for(const command of context.plan.filter(item=>['database','browser'].includes(item.category))) {
  const index=context.plan.indexOf(command),execution=run.commands[index];
  for(const artifacts of [[],execution.artifactDigests.slice(1),[...execution.artifactDigests,execution.artifactDigests[0]],
    [{...execution.artifactDigests[0],relativePath:'wallet.dat'},...execution.artifactDigests.slice(1)]]) {
    const commands=run.commands.map((item,i)=>i===index?{...item,artifactDigests:artifacts}:item);
    denied(()=>publicRun({...run,commands},context));
  }
}
for(const [id,fixture] of [['observation-cli-boundaries',cli],['offline-source-boundaries',source],['crypto-signet-08',coin]]) {
  const command=context.plan.find(item=>item.id===id);
  context.acceptance.validateCommandResults(command,JSON.stringify(fixture),PINS.protocol);
  denied(()=>context.acceptance.validateCommandResults(command,JSON.stringify({...fixture,protocols:['presigned-graph-v2']}),PINS.protocol));
  denied(()=>context.acceptance.validateCommandResults(command,JSON.stringify({...fixture,actualChainEvidence:true}),PINS.protocol));
}
const feeCommand=context.plan.find(item=>item.id==='offline-fee-review-boundaries');
for(const changed of [{...fees,sourceDigest:'0'.repeat(64)},{...fees,validPackages:15},{...fees,refusedActions:143},
  {...fees,protocols:['presigned-graph-v2']},{...fees,actualBlockchainContact:true}])
  denied(()=>context.acceptance.validateCommandResults(feeCommand,JSON.stringify(changed),PINS.protocol));
const offline={passed:true,protocol:PINS.protocol,utilitySha256:'a'.repeat(64),utilityInputDigest:'b'.repeat(64),
  browserOfflineMode:true,networkRequests:0,exactArtifactInputsVerified:true,mainnetBoundaryProtocols:protocolList,
  persistentSecretStorage:false,actualBrowserSignedTransactionsConfirmedByCore:31,restoredKits:1,fullSoloOrderings:6,
  cooperativeRounds:4,recoverySignerSubsets:9,feeRescueWalletAndParentCases:10,feeChildrenAcceptedThenReplaced:10,
  replacementFeeChildrenConfirmedByCore:10,ownedPayoutCashoutsConfirmed:12,cashoutPayoutFamilies:['solo'],
  cashoutOwnerAndReviewMutationRefusals:37,recoveryMissingObservationRefusals:9,recoveryImmatureRefusals:9,
  recoveryWrongSourcePeerRefusals:1,recoveryAsyncSourceInvalidations:2,recoveryObservedSourceReviews:21,
  completeLifecycleEvidence:true,completeFeeEvidence:true,completeCashoutEvidence:true,publicNetworkBroadcasts:0,
  chain:'isolated-regtest',realDefaultSignetEvidence:false,checks:[],evidence:'/tmp/btc-presigned-offline.Ab12Cd'};
const offlineCommand=context.plan.find(item=>item.id==='offline-full');
reviewTranscript(offlineCommand,JSON.stringify(offline),context);
for(const key of ['recoveryMissingObservationRefusals','recoveryImmatureRefusals','recoveryWrongSourcePeerRefusals',
  'recoveryAsyncSourceInvalidations','recoveryObservedSourceReviews']) {
  const missing={...offline};delete missing[key];denied(()=>reviewTranscript(offlineCommand,JSON.stringify(missing),context));
  for(const value of [-1,0.5,'9',{},null])denied(()=>reviewTranscript(offlineCommand,JSON.stringify({...offline,[key]:value}),context));
}
denied(()=>reviewTranscript(offlineCommand,JSON.stringify(offline)+'\n'+JSON.stringify(offline),context));
const scratch=mkdtempSync('/tmp/synthetic-local78-exclusivity.');
const target=join(scratch,'marker.json');writeExclusive(target,Buffer.from('synthetic-original'));
const stat=lstatSync(target);denied(()=>writeExclusive(target,Buffer.from('replacement')));denied(()=>absent(target));
assert.equal(readFileSync(target,'utf8'),'synthetic-original');assert.equal(lstatSync(target).ino,stat.ino);
absent(join(scratch,'missing'));mkdirSync(join(scratch,'existing'),{mode:0o700});denied(()=>writeExclusive(join(scratch,'existing'),'replacement'));
const canonicalPath=join(scratch,'canonical.json');writeExclusive(canonicalPath,JSON.stringify({passed:true},null,2)+'\n');
assert.deepEqual(canonicalJson(canonicalPath),{passed:true});
for(const [index,text] of ['{"passed":true,"passed":false}\n','{"passed":true}\n','{"passed":true} secret'].entries()) {
  const path=join(scratch,`hostile-${index}.json`);writeExclusive(path,text);denied(()=>canonicalJson(path));
}
assert.equal(context.identity.presignedSourceDigest(),PINS.source);
console.log(JSON.stringify({passed:true,suite:'local78-hosted-evidence-boundaries',negativeControls:controls,profileSchemas:Object.keys(OUTPUT_FIELDS).length,
  expectedFiles:171,sourceGroundedFixtures:true,actualLocalAcceptanceExecuted:false,uploads:0,networkCalls:0}));
