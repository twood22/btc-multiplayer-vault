/** Manual-only exact hosted LOCAL78 retention. No candidate changes or release publication. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ASSETS, MAX, PINS, candidateContext, capacity, ownedBytes, ownedDirectory, reviewerDigest,
  validateRetention, validateReview, verifyToolingBoundary } from './presigned-local78-public-evidence.mjs';
import { completedSource, writeExclusive } from './presigned-local78-private.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function hostedGate(environment, event) {
  assert(environment.GITHUB_ACTIONS === 'true' && environment.RUNNER_OS === 'Linux' && environment.RUNNER_ARCH === 'X64');
  assert(environment.GITHUB_EVENT_NAME === 'workflow_dispatch' && environment.GITHUB_REF === 'refs/heads/codex/presigned-v3-test-evidence');
  assert(environment.GITHUB_REPOSITORY === PINS.repository && event.repository?.private === false && event.repository?.full_name === PINS.repository);
  assert(event.inputs?.operation === 'local', 'local retention must be selected explicitly');
  assert(/^[0-9a-f]{40}$/u.test(environment.GITHUB_SHA ?? '') && /^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID ?? ''));
  assert(environment.PRESIGNED_ACCEPTANCE_PROTOCOL === PINS.protocol && environment.PRESIGNED_BUILD_PROTOCOL === PINS.protocol);
}
export function draftGate(release) {
  assert(release.id === PINS.draftId && release.tag_name === PINS.tag && release.draft === true && release.prerelease === true && release.target_commitish === PINS.candidate);
  assert(Array.isArray(release.assets));
}
export function uploadGate(release) {
  draftGate(release);assert(!release.assets.some(a=>ASSETS.includes(a.name)),'never overwrite retained evidence');
}
export function canonicalJson(path) {
  const data=ownedBytes(path).toString('utf8'),value=JSON.parse(data);
  assert.equal(data,`${JSON.stringify(value,null,2)}\n`,'noncanonical or duplicated transport metadata');return value;
}
async function main() {
  process.umask(0o077); const [operation,supplied]=process.argv.slice(2);
  if(operation === 'check-pins') { assert.equal(process.argv.length,3); verifyToolingBoundary();
    console.log(JSON.stringify({candidate:PINS.candidate,sourceDigest:PINS.source,draftId:PINS.draftId,tag:PINS.tag,commands:PINS.commands,files:PINS.files,manualOnly:true}));return; }
  assert(['run','upload'].includes(operation));assert.equal(process.argv.length,operation==='run'?3:4);
  hostedGate(process.env,JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')));
  verifyToolingBoundary();
  const privateRoot=join(process.env.RUNNER_TEMP,'presigned-v3-local78-retention'),directory=join(privateRoot,'evidence');
  assert(realpathSync(process.env.RUNNER_TEMP)===process.env.RUNNER_TEMP);
  const temp=lstatSync(process.env.RUNNER_TEMP);assert(temp.isDirectory()&&!temp.isSymbolicLink()&&temp.uid===process.getuid());
  if(operation==='run') {
    assert(!supplied && !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN && !process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY);
    const context=await candidateContext();capacity(process.env.RUNNER_TEMP,4*MAX+4*PINS.files*8192+4*1024*1024);
    mkdirSync(privateRoot,{mode:0o700});ownedDirectory(privateRoot);
    writeExclusive(join(privateRoot,'run.intent.json'),`${JSON.stringify({version:1,kind:'hosted-local78-run-intent',
      toolingCommit:process.env.GITHUB_SHA,workflowRunId:process.env.GITHUB_RUN_ID,sourceCommit:PINS.candidate,sourceDigest:PINS.source})}\n`);
    const before=new Set(readdirSync('/tmp').filter(n=>/^btc-presigned-archive-output\.[A-Za-z0-9]+$/u.test(n)));
    const child=spawn(process.execPath,['--import','tsx','scripts/presigned-ci.mts','local'],{env:process.env,stdio:['ignore','pipe','pipe']});
    let output='',length=0,lineBuffer='';
    for(const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{
      length+=chunk.length;if(length>2*1024*1024){child.kill('SIGTERM');return;}
      const text=chunk.toString();output+=text;lineBuffer+=text;
      for(;;){const at=lineBuffer.indexOf('\n');if(at<0)break;const line=lineBuffer.slice(0,at);lineBuffer=lineBuffer.slice(at+1);
        let value;try{value=JSON.parse(line);}catch{continue;}
        if(['started','passed'].includes(value?.stage)&&context.plan.some(c=>c.id===value.command))
          console.log(JSON.stringify({stage:value.stage,command:value.command}));
      }
    });
    const code=await new Promise((done,fail)=>{child.once('error',()=>fail(new Error('local acceptance child could not start')));child.once('close',done);});
    assert(code===0&&length<=2*1024*1024,'whole local acceptance failed; no upload permitted');
    assert.equal(context.identity.presignedSourceDigest(),PINS.source);
    const records=context.acceptance.acceptanceJsonRecords(output),packs=records.filter(r=>r.stage==='verified-local-only-archive');
    assert.equal(packs.length,1);const pack=packs[0];
    assert(pack.passed===true&&pack.protocol===PINS.protocol&&pack.kind==='presigned-v3-local-evidence-archive'&&pack.evidenceKind==='local'&&pack.sourceDigest===PINS.source&&pack.restoredBytesRevalidated===true&&pack.files===PINS.files);
    for(const field of ['contentPrivacyReviewed','published','realDefaultSignetVerified','releaseReceiptProduced','fundingAuthorized'])assert.equal(pack[field],false);
    const runs=records.filter(r=>r.stage==='verified-public-ci-receipt');assert.equal(runs.length,1);
    assert.equal(runs[0].receipt.runDigest,pack.evidenceDigest);
    const completed=records.findLast(r=>r.passed===true&&r.mode==='local'&&typeof r.evidence==='string');assert(completed);
    assert(/^\/tmp\/btc-presigned-acceptance\.[A-Za-z0-9]+$/u.test(completed.evidence));
    context.acceptance.validateLocalAcceptanceRun(completed.evidence,PINS.source,'local',PINS.protocol);
    const original=completedSource(completed.evidence,context);assert.equal(original.run.runDigest,pack.evidenceDigest);
    const created=readdirSync('/tmp').filter(n=>/^btc-presigned-archive-output\.[A-Za-z0-9]+$/u.test(n)&&!before.has(n));assert.equal(created.length,1);
    const bytes=ownedBytes(join('/tmp',created[0],'presigned-v3-local.tar.gz'),MAX,false);
    assert(hash(bytes)===pack.archiveSha256&&bytes.length===pack.archiveBytes);
    capacity(privateRoot,bytes.length+original.decodedBytes+PINS.files*8192+4*1024*1024);
    mkdirSync(directory,{mode:0o700});writeExclusive(join(directory,ASSETS[0]),bytes);
    const retention={version:1,protocol:PINS.protocol,kind:'presigned-v3-public-local78-test-evidence',origin:'github-actions-local',
      sourceCommit:PINS.candidate,sourceDigest:PINS.source,toolingBase:PINS.toolingBase,toolingCommit:process.env.GITHUB_SHA,
      workflowRunId:process.env.GITHUB_RUN_ID,draftId:PINS.draftId,reviewerDigest:reviewerDigest(),createdAt:new Date().toISOString(),
      assetName:ASSETS[0],archiveSha256:pack.archiveSha256,archiveBytes:pack.archiveBytes,decodedBytes:original.decodedBytes,
      evidenceDigest:pack.evidenceDigest,files:PINS.files,commands:PINS.commands,restoredBytesRevalidated:true,syntheticOnly:true,
      productionUsePermitted:false,realDefaultSignetVerified:false,physicalPasskeysVerified:false,releaseReceiptProduced:false,fundingAuthorized:false,published:false};
    validateRetention(retention);writeExclusive(join(directory,ASSETS[1]),`${JSON.stringify(retention,null,2)}\n`);
    assert.deepEqual(completedSource(completed.evidence,context),original,'original completed evidence changed');capacity(privateRoot);
    assert(!directory.includes('\n'));appendFileSync(process.env.GITHUB_OUTPUT,`directory=${directory}\n`);
    console.log(JSON.stringify({retainedLocally:true,contentPrivacyReviewed:false,uploaded:false,commands:PINS.commands,files:PINS.files}));
  } else {
    ownedDirectory(privateRoot);
    assert(supplied===directory&&process.env.GH_TOKEN&&!process.env.GITHUB_TOKEN&&process.env.GH_REPO===PINS.repository);
    assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(),PINS.candidate);
    ownedDirectory(directory);assert.deepEqual(readdirSync(directory).sort(),[...ASSETS].sort());
    const retention=canonicalJson(join(directory,ASSETS[1])),review=canonicalJson(join(directory,ASSETS[2]));
    validateRetention(retention);validateReview(review,retention);
    assert(retention.toolingCommit===process.env.GITHUB_SHA&&retention.workflowRunId===process.env.GITHUB_RUN_ID);
    const bytes=ownedBytes(join(directory,ASSETS[0]),MAX,false);assert(hash(bytes)===retention.archiveSha256&&bytes.length===retention.archiveBytes);
    const gh=args=>execFileSync('gh',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:2*1024*1024});
    const inspect=()=>JSON.parse(gh(['api',`repos/${PINS.repository}/releases/${PINS.draftId}`]));
    const before=inspect();uploadGate(before);
    // A lost upload response is not permission to retry or replace any asset.
    writeExclusive(join(privateRoot,'upload.intent.json'),`${JSON.stringify({version:1,draftId:PINS.draftId,
      workflowRunId:process.env.GITHUB_RUN_ID,toolingCommit:process.env.GITHUB_SHA,assets:ASSETS,
      archiveSha256:retention.archiveSha256})}\n`);
    gh(['release','upload',PINS.tag,...ASSETS.map(name=>join(directory,name))]);
    const after=inspect();draftGate(after);
    for(const original of before.assets) {
      const matches=after.assets.filter(a=>a.id===original.id);assert.equal(matches.length,1);
      for(const field of ['id','name','size','digest'])assert.equal(matches[0][field],original[field],'pre-existing draft asset changed');
    }
    for(const name of ASSETS) {
      const matches=after.assets.filter(a=>a.name===name);assert.equal(matches.length,1);
      const data=ownedBytes(join(directory,name),MAX,false);assert.equal(matches[0].size,data.length);
      assert.equal(matches[0].digest,`sha256:${hash(data)}`);
    }
    console.log(JSON.stringify({uploadedToExistingDraft:true,localEvidenceOnly:true,commands:PINS.commands,files:PINS.files,releasePublished:false,fundingAuthorized:false}));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try{await main();}catch{console.error(JSON.stringify({passed:false,reason:'local retention refused; private values omitted',releasePublished:false,fundingAuthorized:false}));process.exitCode=1;}
}
