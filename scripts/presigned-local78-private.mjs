/** One-shot private LOCAL78 transport. No network, publication or acceptance rerun. */
import assert from 'node:assert/strict';
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ASSETS, MAX, PINS, candidateContext, capacity, expectedNames, hash, keys, ownedBytes,
  ownedDirectory, publicRun, reviewDirectory, reviewerDigest, strictJson, validateRetention,
  validateReview } from './presigned-local78-public-evidence.mjs';

let activeCapsule;
export function absent(path) {
  try { lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  throw new Error('destination or one-shot phase already exists');
}
export function writeExclusive(path, bytes) {
  ownedDirectory(dirname(path));
  const fd = openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
const writeJson = (path,value) => writeExclusive(path,`${JSON.stringify(value,null,2)}\n`);
export function canonicalJson(path, context) {
  const data = ownedBytes(path).toString('utf8'), value = strictJson(data,context.ts);
  assert.equal(data,`${JSON.stringify(value,null,2)}\n`,'noncanonical metadata');
  return value;
}
export function newCapsule(path) {
  assert(path === resolve(path)); ownedDirectory(dirname(path)); absent(path);
  capacity(dirname(path),1024*1024); mkdirSync(path,{mode:0o700}); ownedDirectory(path);
  activeCapsule = path;
}
function intent(capsule, phase, details = {}) {
  ownedDirectory(capsule); absent(join(capsule,'failure.json'));
  capacity(capsule,1024*1024);
  writeJson(join(capsule,`${phase}.intent.json`),{phase,createdAt:new Date().toISOString(),
    sourceCommit:PINS.candidate,sourceDigest:PINS.source,reviewerDigest:reviewerDigest(),...details});
  activeCapsule = capsule;
}
function candidateStillExact(context) {
  assert.equal(context.identity.presignedSourceDigest(),PINS.source);
  return reviewerDigest();
}
function utilityBytes(context) {
  const path=join(context.root,'public/offline/presigned-recovery.html'), stat=lstatSync(path);
  assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.uid===process.getuid()&&
    stat.size>0&&stat.size<=16*1024*1024&&realpathSync(path)===path);
  const bytes=readFileSync(path), after=lstatSync(path);
  assert(bytes.length===stat.size&&after.ino===stat.ino&&after.dev===stat.dev&&after.size===stat.size&&
    after.mtimeMs===stat.mtimeMs&&after.ctimeMs===stat.ctimeMs);
  return bytes;
}
function manifestFor(directory,names) {
  return names.map(name=>{const bytes=ownedBytes(join(directory,name));return {name,bytes:bytes.length,sha256:hash(bytes)};});
}
export function completedSource(directory,context) {
  ownedDirectory(directory);
  const names=expectedNames(context.plan), sourceNames=names.filter(name=>name!=='offline-recovery.html');
  const originalNames=[...sourceNames,...context.plan.map(command=>`${command.id}.json`)].sort();
  assert.deepEqual(readdirSync(directory).sort(),originalNames,'completed original run has missing or extra files');
  const run=canonicalJson(join(directory,'run.json'),context); publicRun(run,context);
  context.acceptance.validateLocalAcceptanceRun(directory,PINS.source,'local',PINS.protocol);
  for(const execution of run.commands)
    assert.deepEqual(canonicalJson(join(directory,`${execution.command.id}.json`),context),execution,'original command sidecar differs');
  const utility=utilityBytes(context);assert.equal(hash(utility),run.offlineUtilityDigest);
  const members=[...manifestFor(directory,sourceNames),{name:'offline-recovery.html',bytes:utility.length,sha256:hash(utility)}]
    .sort((a,b)=>a.name.localeCompare(b.name));
  const decodedBytes=members.reduce((total,item)=>total+item.bytes,0);assert(decodedBytes>0&&decodedBytes<=MAX);
  return {run,members,decodedBytes,original:manifestFor(directory,originalNames)};
}
async function pack(source,capsule,context) {
  const before=completedSource(source,context), codeDigest=candidateStillExact(context);
  assert(!capsule.startsWith(`${source}/`)&&!source.startsWith(`${capsule}/`));
  // The unchanged candidate packer simultaneously stages and restores exact files.
  // Reserve covers both copies, worst compressed bound and filesystem overhead.
  capacity(dirname(capsule),2*before.decodedBytes+MAX+4*PINS.files*8192+4*1024*1024);
  newCapsule(capsule);intent(capsule,'pack',{sourceRunDigest:before.run.runDigest});
  const evidence=join(capsule,'evidence');mkdirSync(evidence,{mode:0o700});
  const packer=await import(pathToFileURL(join(context.root,'scripts/lib/presigned-evidence-archive.ts')).href);
  const packed=await packer.packPresignedEvidence('local',source,join(evidence,ASSETS[0]),PINS.protocol);
  keys(packed,['passed','protocol','kind','evidenceKind','sourceDigest','evidenceDigest','archiveSha256',
    'archiveBytes','files','restoredBytesRevalidated','contentPrivacyReviewed','published',
    'realDefaultSignetVerified','releaseReceiptProduced','fundingAuthorized']);
  assert(packed.passed===true&&packed.protocol===PINS.protocol&&packed.kind==='presigned-v3-local-evidence-archive'&&
    packed.evidenceKind==='local'&&packed.sourceDigest===PINS.source&&packed.evidenceDigest===before.run.runDigest&&
    packed.files===PINS.files&&packed.restoredBytesRevalidated===true);
  for(const field of ['contentPrivacyReviewed','published','realDefaultSignetVerified','releaseReceiptProduced','fundingAuthorized'])assert.equal(packed[field],false);
  const archive=ownedBytes(join(evidence,ASSETS[0]),MAX,false);
  assert(hash(archive)===packed.archiveSha256&&archive.length===packed.archiveBytes);
  assert.deepEqual(completedSource(source,context),before,'original completed evidence changed while packing');
  assert.equal(candidateStillExact(context),codeDigest);capacity(capsule);
  const retention={version:1,protocol:PINS.protocol,kind:'presigned-v3-private-local78-test-evidence',origin:'local-executable-run',
    sourceCommit:PINS.candidate,sourceDigest:PINS.source,toolingBase:PINS.toolingBase,reviewerDigest:codeDigest,
    createdAt:new Date().toISOString(),assetName:ASSETS[0],archiveSha256:packed.archiveSha256,archiveBytes:packed.archiveBytes,
    decodedBytes:before.decodedBytes,evidenceDigest:before.run.runDigest,files:PINS.files,commands:PINS.commands,
    restoredBytesRevalidated:true,syntheticOnly:true,productionUsePermitted:false,realDefaultSignetVerified:false,
    physicalPasskeysVerified:false,releaseReceiptProduced:false,fundingAuthorized:false,published:false};
  validateRetention(retention);writeJson(join(evidence,ASSETS[1]),retention);
  writeJson(join(capsule,'pack.complete.json'),{passed:true,phase:'pack',candidatePackerReturned:true,
    originalEvidenceUnchanged:true,archiveSha256:packed.archiveSha256,evidenceDigest:before.run.runDigest,
    members:before.members,reviewerDigest:codeDigest,freeBytes:capacity(capsule),published:false,fundingAuthorized:false});
  return {passed:true,phase:'pack',commands:PINS.commands,files:PINS.files,archiveSha256:packed.archiveSha256,
    contentReviewCompleted:false,published:false,fundingAuthorized:false};
}
function originalPack(capsule,retention,context) {
  const receipt=canonicalJson(join(capsule,'pack.complete.json'),context);
  keys(receipt,['passed','phase','candidatePackerReturned','originalEvidenceUnchanged','archiveSha256','evidenceDigest',
    'members','reviewerDigest','freeBytes','published','fundingAuthorized']);
  assert(receipt.passed===true&&receipt.phase==='pack'&&receipt.candidatePackerReturned===true&&receipt.originalEvidenceUnchanged===true&&
    receipt.archiveSha256===retention.archiveSha256&&receipt.evidenceDigest===retention.evidenceDigest&&
    receipt.reviewerDigest===retention.reviewerDigest&&receipt.published===false&&receipt.fundingAuthorized===false);
  assert.deepEqual(receipt.members.map(item=>item.name).sort(),expectedNames(context.plan));
  let total=0;
  for(const item of receipt.members) {
    keys(item,['name','bytes','sha256']);assert(Number.isSafeInteger(item.bytes)&&item.bytes>=0&&item.bytes<=16*1024*1024);
    assert(/^[0-9a-f]{64}$/u.test(item.sha256));total+=item.bytes;
  }
  assert.equal(total,retention.decodedBytes);return receipt;
}
async function review(capsule,context) {
  const evidence=join(capsule,'evidence'),retention=canonicalJson(join(evidence,ASSETS[1]),context);
  validateRetention(retention);const packed=originalPack(capsule,retention,context);
  intent(capsule,'review',{archiveSha256:retention.archiveSha256});
  const result=await reviewDirectory(evidence,context);
  assert.deepEqual(manifestFor(`${evidence}.restored`,expectedNames(context.plan)).sort((a,b)=>a.name.localeCompare(b.name)),packed.members);
  assert.equal(candidateStillExact(context),retention.reviewerDigest);
  writeJson(join(capsule,'review.complete.json'),{passed:true,phase:'review',archiveSha256:retention.archiveSha256,
    contentReviewSha256:hash(ownedBytes(join(evidence,ASSETS[2]))),exactOriginalFileBytes:true,importExitCode:0,
    reviewerDigest:retention.reviewerDigest,freeBytes:capacity(capsule),published:false,fundingAuthorized:false});
  return {passed:true,phase:'review',commands:result.commands,files:result.files,published:false,fundingAuthorized:false};
}
async function roundtrip(source,capsule,context) {
  ownedDirectory(source);absent(join(source,'failure.json'));
  const evidence=join(source,'evidence');ownedDirectory(evidence);assert.deepEqual(readdirSync(evidence).sort(),[...ASSETS].sort());
  const retention=canonicalJson(join(evidence,ASSETS[1]),context),prior=canonicalJson(join(evidence,ASSETS[2]),context);
  validateRetention(retention);validateReview(prior,retention);const packed=originalPack(source,retention,context);
  const completed=canonicalJson(join(source,'review.complete.json'),context);
  keys(completed,['passed','phase','archiveSha256','contentReviewSha256','exactOriginalFileBytes','importExitCode',
    'reviewerDigest','freeBytes','published','fundingAuthorized']);
  assert(completed.passed===true&&completed.phase==='review'&&completed.archiveSha256===retention.archiveSha256&&
    completed.contentReviewSha256===hash(ownedBytes(join(evidence,ASSETS[2])))&&completed.exactOriginalFileBytes===true&&
    completed.importExitCode===0&&completed.reviewerDigest===retention.reviewerDigest&&completed.published===false&&completed.fundingAuthorized===false);
  assert(!capsule.startsWith(`${source}/`)&&!source.startsWith(`${capsule}/`));
  capacity(dirname(capsule),retention.archiveBytes+retention.decodedBytes+PINS.files*8192+4*1024*1024);
  newCapsule(capsule);intent(capsule,'roundtrip',{archiveSha256:retention.archiveSha256});
  const destination=join(capsule,'evidence');mkdirSync(destination,{mode:0o700});
  const inputs=ASSETS.map(name=>({name,bytes:ownedBytes(join(evidence,name),name===ASSETS[0]?MAX:16*1024*1024,false)}));
  assert.equal(hash(inputs[0].bytes),retention.archiveSha256);assert.equal(inputs[0].bytes.length,retention.archiveBytes);
  for(const input of inputs.slice(0,2)) {
    capacity(capsule,input.bytes.length+1024*1024);writeExclusive(join(destination,input.name),input.bytes);
    assert.deepEqual(ownedBytes(join(destination,input.name),MAX,false),input.bytes);capacity(capsule);
  }
  const repeated=await reviewDirectory(destination,context);assert.deepEqual(repeated,prior);
  assert.deepEqual(ownedBytes(join(destination,ASSETS[2])),inputs[2].bytes);
  assert.deepEqual(manifestFor(`${destination}.restored`,expectedNames(context.plan)).sort((a,b)=>a.name.localeCompare(b.name)),packed.members);
  for(const input of inputs)assert.deepEqual(ownedBytes(join(evidence,input.name),MAX,false),input.bytes,'original retained input changed');
  assert.equal(candidateStillExact(context),retention.reviewerDigest);
  writeJson(join(capsule,'roundtrip.complete.json'),{passed:true,phase:'roundtrip',archiveSha256:retention.archiveSha256,
    evidenceDigest:retention.evidenceDigest,exactOriginalFileBytes:true,exactReviewRepeated:true,originalThreeAssetsUnchanged:true,
    importExitCode:0,reviewerDigest:retention.reviewerDigest,freeBytes:capacity(capsule),published:false,fundingAuthorized:false});
  return {passed:true,phase:'roundtrip',commands:PINS.commands,files:PINS.files,published:false,fundingAuthorized:false};
}
export async function main(args) {
  process.umask(0o077);const [operation,source,capsule]=args;
  assert(['pack','review','roundtrip'].includes(operation));assert.equal(args.length,operation==='review'?2:3);
  assert(source===resolve(source));if(capsule!==undefined)assert(capsule===resolve(capsule));
  const context=await candidateContext();
  return operation==='pack'?pack(source,capsule,context):operation==='review'?review(source,context):roundtrip(source,capsule,context);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch {
    if(activeCapsule)try {writeJson(join(activeCapsule,'failure.json'),{passed:false,partialStatePreserved:true,automaticRetryPermitted:false,
      published:false,fundingAuthorized:false,reason:'private LOCAL78 phase refused; raw values omitted'});}catch{}
    console.error(JSON.stringify({passed:false,localArchiveAccepted:false,partialStatePreserved:true,published:false,
      fundingAuthorized:false,reason:'private LOCAL78 phase refused; raw values omitted'}));process.exitCode=1;
  }
}
