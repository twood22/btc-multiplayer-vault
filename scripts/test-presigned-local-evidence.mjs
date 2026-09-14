/** Synthetic privacy/transport tests. Never runs Core, browsers, a database or uploads. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT_FIELDS } from './presigned-local-output-profile.mjs';
import { PINS, ASSETS, candidateContext, expectedNames, strictJson, splitTranscript, producerLexicon,
  validateRecord, validString, publicRun, validateRetention, reviewerDigest, publicReviewFailure, reviewStderr } from './presigned-local-public-evidence.mjs';
import { hostedGate, draftGate, validateReview } from './presigned-local-ci.mjs';

const here=dirname(fileURLToPath(import.meta.url)), context=await candidateContext();
let controls=0;const denied=run=>{assert.throws(run);controls++;};
const names=expectedNames(context.plan);assert(names.length===165&&new Set(names).size===165);
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
hostedGate(env,event);
for(const [field,value]of Object.entries({...env,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'unapproved/repository',
  RUNNER_OS:'Windows',GITHUB_SHA:'unset',GITHUB_RUN_ID:'0',PRESIGNED_BUILD_PROTOCOL:'presigned-graph-v2',GITHUB_ACTIONS:'false',RUNNER_ARCH:'ARM64'}))
  if(value!==env[field])denied(()=>hostedGate({...env,[field]:value},event));
for(const changed of [{...event,inputs:{operation:'images'}},{...event,inputs:{}},{...event,repository:{private:true,full_name:PINS.repository}}])denied(()=>hostedGate(env,changed));
const release={id:PINS.draftId,tag_name:PINS.tag,draft:true,prerelease:true,target_commitish:PINS.candidate,assets:[]};draftGate(release);
for(const [field,value]of [['id',1],['tag_name','different'],['draft',false],['prerelease',false],['target_commitish','main'],['assets',null]])denied(()=>draftGate({...release,[field]:value}));
const retention={version:1,protocol:PINS.protocol,kind:'presigned-v3-public-local-test-evidence',sourceCommit:PINS.candidate,sourceDigest:PINS.source,
  toolingCommit:'a'.repeat(40),workflowRunId:'123',draftId:PINS.draftId,assetName:ASSETS[0],archiveSha256:'b'.repeat(64),archiveBytes:100,evidenceDigest:'c'.repeat(64),
  files:165,restoredBytesRevalidated:true,syntheticOnly:true,productionUsePermitted:false,realDefaultSignetVerified:false,physicalPasskeysVerified:false,releaseReceiptProduced:false,fundingAuthorized:false};
validateRetention(retention);
for(const [field,value]of [['version',3],['protocol','presigned-graph-v2'],['files',164],['archiveBytes',0],['archiveBytes',65*1024*1024],
  ['sourceCommit','0'.repeat(40)],['sourceDigest','0'.repeat(64)],['assetName','presigned-v3-signet-test-evidence.tar.gz'],['unknown','private'],
  ['syntheticOnly',false],['restoredBytesRevalidated',false],...['productionUsePermitted','realDefaultSignetVerified','physicalPasskeysVerified','releaseReceiptProduced','fundingAuthorized'].map(f=>[f,true])])
  denied(()=>validateRetention({...retention,[field]:value}));
const review={...retention,kind:'presigned-v3-local-archive-content-review',passed:true,commands:75,reviewerDigest:reviewerDigest(),
  exactArchiveMembersInspected:true,canonicalOuterEnvelopeVerified:true,allTranscriptBytesInspected:true,candidateSemanticValidationRepeated:true,exactOfflineBytesVerified:true,universalSecretAbsenceProven:false};
validateReview(review,retention);
for(const [field,value]of [['commands',74],['reviewerDigest','a'.repeat(64)],['allTranscriptBytesInspected',false],['candidateSemanticValidationRepeated',false],
  ['exactOfflineBytesVerified',false],['universalSecretAbsenceProven',true],['unknown','private'],['sourceDigest','a'.repeat(64)]])denied(()=>validateReview({...review,[field]:value},retention));
const run={version:3,protocol:PINS.protocol,kind:'presigned-v3-local-executable-run',mode:'local',sourceDigest:PINS.source,
  createdAt:'2026-09-14T00:00:00.000Z',completedAt:'2026-09-14T01:00:00.000Z',reviewedNodeVersion:readFileSync('.node-version','utf8').trim(),
  commands:context.plan.map(command=>({command,startedAt:'2026-09-14T00:00:00.000Z',completedAt:'2026-09-14T01:00:00.000Z',sourceDigest:PINS.source,
    exitCode:0,stdoutSha256:'a'.repeat(64),stderrSha256:'b'.repeat(64),artifactDigests:[],executionDigest:'c'.repeat(64)})),
  offlineUtilityDigest:'d'.repeat(64),physicalPasskeysVerified:false,realSignetVerified:false,exactImageVerified:false,fundingAuthorized:false,runDigest:'e'.repeat(64)};
publicRun(run,context); // Public shape only; deliberately not executable acceptance evidence.
for(const altered of [{...run,commands:run.commands.slice(1)},{...run,fundingAuthorized:true},{...run,privateKeyHex:'f'.repeat(64)},
  {...run,createdAt:'2026-09-14 private'},{...run,commands:[{...run.commands[0],command:{...run.commands[0].command,args:['private-secret']}},...run.commands.slice(1)]}])denied(()=>publicRun(altered,context));
const secret='synthetic-private-token-never-publish';
const child=spawnSync(process.execPath,[join(here,'presigned-local-ci.mjs'),'upload','/private'],{encoding:'utf8',env:{PATH:process.env.PATH,GH_TOKEN:secret}});
assert.equal(child.status,1);assert(!`${child.stdout}${child.stderr}`.includes(secret));controls++;
console.log(JSON.stringify({passed:true,suite:'local-public-evidence-boundaries',negativeControls:controls,profileSchemas:Object.keys(OUTPUT_FIELDS).length,
  expectedFiles:165,sourceGroundedFixtures:true,actualLocalAcceptanceExecuted:false,uploads:0,networkCalls:0}));
