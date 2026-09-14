/** Synthetic temporary PUBLIC files only. Never calls production retention. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { syntheticPublicCacheRetentionScope, verifyPublicCacheRetention, preparePublicCacheRetention,
  reclaimPublicCacheRetention, restorePublicCacheRetention } from './lib/presigned-public-cache-retention.js';
import { withStoppedCoreDataDirectoryLock } from './lib/presigned-signet-cache.js';
import { acquireLifecycleProcessLock } from './lib/presigned-lifecycle-lock.js';
process.umask(0o077);
const startedAt=Date.now();
const progress=(stage:string)=>console.log(JSON.stringify({scope:'synthetic-retention-test-progress',stage,
  elapsedSeconds:Math.round((Date.now()-startedAt)/1000),pid:process.pid}));
// Keep long synchronous fsync/hash work observable. The child owns no files or
// authority, and exits on parent pipe closure even if the test is interrupted.
const heartbeat=spawn(process.execPath,['-e',
  'process.stdin.on("end",()=>process.exit(0));process.stdin.resume();setInterval(()=>console.log(JSON.stringify({scope:"synthetic-retention-test-heartbeat",parentPid:process.ppid})),30000)'],
  {stdio:['pipe','inherit','ignore']});
const interrupted=()=>{progress('external-SIGTERM');heartbeat.stdin.end();process.exit(143);};
process.once('SIGTERM',interrupted);
progress('begin');
const names = ['blk','rev'].flatMap(prefix => Array.from({length:145},(_,i)=>`${prefix}${String(i).padStart(5,'0')}.dat`));
const hash = (p:string) => createHash('sha256').update(readFileSync(p)).digest('hex');
let refusals=0;
async function refused(action:()=>Promise<unknown>) { await assert.rejects(action); refusals++; }
function fixture() {
  const root=mkdtempSync('/tmp/btc-public-cache-retention-test.');
  for(const name of ['target','keeper','custody']) mkdirSync(`${root}/${name}`,{mode:0o700});
  const scope=syntheticPublicCacheRetentionScope(root);
  for(const signet of [scope.target,scope.keeper]) {
    mkdirSync(`${signet}/blocks/index`,{recursive:true,mode:0o700});
    mkdirSync(`${signet}/chainstate`,{mode:0o700}); mkdirSync(`${signet}/indexes`,{mode:0o700});
    for(const path of [`${signet}/.lock`,`${signet}/blocks/.lock`])writeFileSync(path,'',{mode:0o600,flag:'wx'});
    for(const name of names)writeFileSync(`${signet}/blocks/${name}`,`PUBLIC synthetic ${name}\n`,{mode:0o600,flag:'wx'});
    for(const name of ['blk00145.dat','rev00145.dat','xor.dat'])writeFileSync(`${signet}/blocks/${name}`,`${signet}:${name}`,{mode:0o600,flag:'wx'});
    writeFileSync(`${signet}/blocks/index/000001.ldb`,'PUBLIC unique index',{mode:0o600,flag:'wx'});
    writeFileSync(`${signet}/chainstate/000002.ldb`,'PUBLIC unique state',{mode:0o600,flag:'wx'});
  }
  writeFileSync(`${root}/custody/wallet.dat`,'SYNTHETIC custody, not a real wallet',{mode:0o600,flag:'wx'});
  return {root,scope};
}
const positive=fixture(); const custodyBefore=hash(`${positive.root}/custody/wallet.dat`);
const firstOriginal=lstatSync(`${positive.scope.target}/blocks/blk00000.dat`,{bigint:true});
const dry=await verifyPublicCacheRetention(positive.scope);
progress('read-only-verification');
assert.equal(dry.entries.length,290); assert(!existsSync(positive.scope.records));
await refused(()=>verifyPublicCacheRetention({...positive.scope,target:`${positive.root}/custody`}));
const prepared=await preparePublicCacheRetention(positive.scope);
assert.equal(lstatSync(prepared.manifestPath).mode&0o777,0o400);
const input={manifestPath:prepared.manifestPath,approvedDigest:prepared.manifestDigest};
await refused(()=>reclaimPublicCacheRetention({...input,approvedDigest:'00'.repeat(32)},positive.scope));
await refused(()=>reclaimPublicCacheRetention({...input,manifestPath:`${positive.root}/custody/wallet.dat`},positive.scope));
const reclaimed=await reclaimPublicCacheRetention(input,positive.scope);
progress('290-reclaimed');
assert.equal(reclaimed.removedFilesThisInvocation,290);
for(const name of names)assert(!existsSync(`${positive.scope.target}/blocks/${name}`));
for(const name of ['blk00145.dat','rev00145.dat','xor.dat','.lock','index'])assert(existsSync(`${positive.scope.target}/blocks/${name}`));
assert.equal((await reclaimPublicCacheRetention(input,positive.scope)).removedFilesThisInvocation,0);
assert.equal(hash(`${positive.root}/custody/wallet.dat`),custodyBefore);
const restored=await restorePublicCacheRetention(input,positive.scope);
progress('290-restored');
assert.equal(restored.restoredFiles,290);assert.equal(restored.overwrittenFiles,0);
for(const name of names)assert.equal(hash(`${positive.scope.target}/blocks/${name}`),hash(`${positive.scope.keeper}/blocks/${name}`));
const after=lstatSync(`${positive.scope.target}/blocks/blk00000.dat`,{bigint:true});
for(const key of ['mode','uid','gid','mtimeNs','size'] as const)assert.equal(after[key],firstOriginal[key]);
assert.equal((await restorePublicCacheRetention(input,positive.scope)).restoredFiles,0);
await refused(()=>reclaimPublicCacheRetention(input,positive.scope)); // Old inode/ctime authority is never reused.
progress('positive-idempotence');

for(const kind of ['tail','wallet','keeper','target'] as const) {
  const {root,scope}=fixture(); const prepared=await preparePublicCacheRetention(scope);
  const path=kind==='tail'?`${scope.target}/blocks/blk00145.dat`:kind==='wallet'?`${root}/custody/wallet.dat`
    :`${kind==='keeper'?scope.keeper:scope.target}/blocks/blk00000.dat`;
  writeFileSync(path,`Synthetic changed ${kind}`);
  await refused(()=>reclaimPublicCacheRetention({manifestPath:prepared.manifestPath,approvedDigest:prepared.manifestDigest},scope));
  assert(existsSync(`${scope.target}/blocks/blk00001.dat`));
  progress(`refused-${kind}-mutation`);
}
for(const kind of ['symlink','hardlink'] as const) {
  const {root,scope}=fixture();const path=`${scope.target}/blocks/blk00000.dat`;
  renameSync(path,`${root}/original-block.dat`);
  if(kind==='symlink')symlinkSync(`${root}/custody/wallet.dat`,path);else linkSync(`${root}/custody/wallet.dat`,path);
  const before=hash(`${root}/custody/wallet.dat`); await refused(()=>verifyPublicCacheRetention(scope));
  assert.equal(hash(`${root}/custody/wallet.dat`),before);
  progress(`refused-${kind}`);
}
{
  const {scope}=fixture();await withStoppedCoreDataDirectoryLock(scope.target,async()=>{
    await refused(()=>verifyPublicCacheRetention(scope));
  });
  await withStoppedCoreDataDirectoryLock(scope.keeper,async()=>{
    await refused(()=>verifyPublicCacheRetention(scope));
  });
  const prepared=await preparePublicCacheRetention(scope);
  const lock=acquireLifecycleProcessLock(scope.records,'00'.repeat(32));
  try {await refused(()=>reclaimPublicCacheRetention({manifestPath:prepared.manifestPath,approvedDigest:prepared.manifestDigest},scope));}
  finally{lock.release();}
  progress('refused-held-kernel-locks');
}
{
  // Exact crash image: the durable reclaim intent exists and the first original
  // was quarantined but not unlinked. Restore retains its bytes and original inode.
  const {root,scope}=fixture();const prepared=await preparePublicCacheRetention(scope);
  const digest=prepared.manifestDigest;const path=`${scope.target}/blocks/blk00000.dat`;
  const before=lstatSync(path,{bigint:true});const custody=hash(`${root}/custody/wallet.dat`);
  writeFileSync(`${scope.records}/${digest}.reclaim-intent.json`,JSON.stringify({manifestDigest:digest,requiredKeeperRetention:true,files:names}),{flag:'wx',mode:0o400});
  renameSync(path,`${scope.target}/blocks/.retained-${digest}-blk00000.dat`);
  const result=await restorePublicCacheRetention({manifestPath:prepared.manifestPath,approvedDigest:digest},scope);
  assert.equal(result.restoredFiles,1);assert.equal(lstatSync(path,{bigint:true}).ino,before.ino);
  assert.equal(hash(`${root}/custody/wallet.dat`),custody);
  progress('quarantine-restored');
}
for(const variant of ['valid','changed','no-intent'] as const) {
  // Exact crash images of an incomplete restore. Only a proven source prefix
  // with its durable intent can be resumed; hostile partials remain untouched.
  const {scope}=fixture();const prepared=await preparePublicCacheRetention(scope);
  const digest=prepared.manifestDigest;const args={manifestPath:prepared.manifestPath,approvedDigest:digest};
  await reclaimPublicCacheRetention(args,scope);
  if(variant!=='no-intent')writeFileSync(`${scope.records}/${digest}.restore-intent.json`,
    JSON.stringify({manifestDigest:digest,requiredKeeperRetention:true,absentTargetsOnly:true,files:names}),{flag:'wx',mode:0o400});
  const partial=`${scope.target}/blocks/.restore-${digest}-blk00000.dat`;
  writeFileSync(partial,variant==='changed'?'WRONG':readFileSync(`${scope.keeper}/blocks/blk00000.dat`).subarray(0,10),{flag:'wx',mode:0o600});
  if(variant==='valid') {
    assert.equal((await restorePublicCacheRetention(args,scope)).restoredFiles,290);assert(!existsSync(partial));
  } else {
    const before=hash(partial);await refused(()=>restorePublicCacheRetention(args,scope));assert.equal(hash(partial),before);
    assert(!existsSync(`${scope.target}/blocks/blk00001.dat`));
  }
  progress(`restore-partial-${variant}`);
}
{
  const {scope}=fixture();const prepared=await preparePublicCacheRetention(scope);
  const args={manifestPath:prepared.manifestPath,approvedDigest:prepared.manifestDigest};
  await reclaimPublicCacheRetention(args,scope);
  writeFileSync(`${scope.target}/blocks/blk00000.dat`,'occupied unrelated synthetic file',{flag:'wx',mode:0o600});
  await refused(()=>restorePublicCacheRetention(args,scope));
  assert.equal(readFileSync(`${scope.target}/blocks/blk00000.dat`,'utf8'),'occupied unrelated synthetic file');
  assert(!existsSync(`${scope.target}/blocks/blk00001.dat`));
  progress('refused-occupied-restore');
}
{
  // Another owned process advertises the exact datadir; no synthetic RPC needed.
  const {scope}=fixture();
  const child=spawn(process.execPath,['-e','process.stdout.write("ready\\n");setInterval(()=>{},1000)','--',`-datadir=${scope.target.slice(0,-7)}`],
    {stdio:['ignore','pipe','ignore']});
  try {await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('exit',()=>reject(new Error('fixture process exited')));});
    await refused(()=>verifyPublicCacheRetention(scope));
  } finally {child.kill('SIGTERM');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}
  progress('refused-live-process');
}
{
  // A separate process races an original after the first validated quarantine.
  // Earlier exact duplicates may be reclaimed; the changed future file must survive.
  const {root,scope}=fixture();const prepared=await preparePublicCacheRetention(scope);
  const before=hash(`${root}/custody/wallet.dat`);
  const child=spawn(process.execPath,['--input-type=module','-e',
    'import fs from "node:fs";const dir=process.argv[1];fs.watch(dir,(event,name)=>{if(String(name).startsWith(".retained-")){fs.writeFileSync(dir+"/blk00144.dat","SYNTHETIC RACE");process.exit(0)}});process.stdout.write("ready\\n");',
    `${scope.target}/blocks`],{stdio:['ignore','pipe','ignore']});
  try {await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('exit',()=>reject(new Error('race fixture exited')));});
    await refused(()=>reclaimPublicCacheRetention({manifestPath:prepared.manifestPath,approvedDigest:prepared.manifestDigest},scope));
    assert.equal(readFileSync(`${scope.target}/blocks/blk00144.dat`,'utf8'),'SYNTHETIC RACE');
    assert.equal(hash(`${root}/custody/wallet.dat`),before);
  } finally {if(child.exitCode===null){child.kill('SIGTERM');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}}
  progress('refused-raced-future-file');
}
{
  // Kill only this synthetic operation's exact direct-child lock helper while
  // the parent is in synchronous work. Cached exit callbacks cannot protect it.
  const {root,scope}=fixture();const prepared=await preparePublicCacheRetention(scope);
  const before=hash(`${root}/custody/wallet.dat`);
  const child=spawn(process.execPath,['--input-type=module','-e',
    'import fs from "node:fs";const dir=process.argv[1];fs.watch(dir,(event,name)=>{if(!String(name).startsWith(".retained-"))return;for(const pid of fs.readdirSync("/proc").filter(p=>/^[1-9][0-9]*$/.test(p))){try{const args=fs.readFileSync("/proc/"+pid+"/cmdline").toString().split("\\0");const status=fs.readFileSync("/proc/"+pid+"/status","utf8");if(args[0]==="/usr/bin/python3"&&args.at(-2)===dir.slice(0,-7)+"/.lock"&&status.split("\\n").includes("PPid:\\t"+process.ppid)){process.kill(Number(pid),"SIGTERM");process.exit(0)}}catch(error){if(error.code!=="ENOENT"&&error.code!=="ESRCH")throw error}}});process.stdout.write("ready\\n");',
    `${scope.target}/blocks`],{stdio:['ignore','pipe','ignore']});
  try {await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('exit',()=>reject(new Error('lock race fixture exited')));});
    await refused(()=>reclaimPublicCacheRetention({manifestPath:prepared.manifestPath,approvedDigest:prepared.manifestDigest},scope));
    assert(existsSync(`${scope.target}/blocks/rev00144.dat`));assert.equal(hash(`${root}/custody/wallet.dat`),before);
  } finally {if(child.exitCode===null){child.kill('SIGTERM');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}}
  progress('refused-lost-POSIX-lock');
}
assert(refusals>=19);
process.removeListener('SIGTERM',interrupted);
heartbeat.stdin.end();await new Promise<void>(resolve=>heartbeat.once('exit',()=>resolve()));
console.log(JSON.stringify({passed:true,scope:'synthetic-temporary-public-cache-only',positiveReclaimedFiles:290,
  restoredFiles:290,hostileScopeMetadataAliasLockRaceAndOverwriteRefusals:refusals,productionCacheFilesChanged:0,
  interruptedQuarantineRestores:1,interruptedPartialCopyResumes:1,
  originalCustodyUnchanged:true,keeperBytesUnchanged:true,positiveEvidence:positive.root}));
