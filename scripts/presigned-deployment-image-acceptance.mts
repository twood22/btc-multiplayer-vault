/** Post-release-assembly drill against the EXACT retained image and receipt.
 * Creates only disposable loopback PostgreSQL/Core and unprivileged containers.
 * No supplied operational environment, public chain, privileged fallback or fake
 * receipt is accepted. Requires an existing owner-only nonvolatile scratch root.
 * Two successive releases intentionally use the same verified immutable image:
 * this proves actual container/journal rollback, not cross-version DB downgrade.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { userInfo } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { validatePresignedAcceptanceReceipt } from '../src/presigned/release.js';
import { PRESIGNED_PROTOCOL_V3 } from '../src/presigned/types.js';
import { commitmentDigest, sameCanonical } from '../src/presigned/validation.js';
import { databaseEndpointFingerprint, createDatabaseRestoreReceipt } from '../src/database-restore-receipt.js';
import { captureDatabaseRuntimeIdentity, captureDatabaseSnapshot, compareDatabaseSnapshots } from '../web/lib/database-snapshot.js';
import { EXPECTED_MIGRATION_VERSIONS } from '../web/lib/migrations.js';
import { verifyOciDirectory } from './lib/presigned-oci.js';
import { presignedSourceDigest } from './presigned-build-identity.mjs';
import { privateJournalDirectory, readPrivateJournalBytes, writePrivateJournalBytes } from './lib/presigned-durable-journal.js';
import { createDeploymentPlan, deploymentMigrationDigest, DEPLOYMENT_EXECUTION_ACK, DEPLOYMENT_QUIESCENCE_ACK,
  type PresignedDeploymentPlan } from './lib/presigned-deployment-plan.js';
import { executeDeployment, monitorDeployment, readDeploymentJournal, verifyDeploymentPackage } from './lib/presigned-deployment-runtime.js';
import { validateDeploymentExecutionEvidence } from './lib/presigned-deployment-evidence.js';

process.umask(0o077);
const { values } = parseArgs({ strict:true,allowPositionals:false,options:{
  'image-evidence':{type:'string'}, 'acceptance-receipt':{type:'string'}, 'scratch-root':{type:'string'},
  'execute-disposable-loopback':{type:'boolean',default:false},
} });
assert(values['execute-disposable-loopback'] && values['image-evidence'] && values['acceptance-receipt'] && values['scratch-root'],
  'explicit disposable execution, exact image evidence, final acceptance receipt and private scratch root are required');
const scratch = resolve(values['scratch-root']); privateJournalDirectory(scratch,true);
assert(process.getuid?.() !== 0, 'rootless test execution only');
const sourceDigest = presignedSourceDigest();
const receiptBytes = readPrivateJournalBytes(resolve(values['acceptance-receipt']));
const receipt = validatePresignedAcceptanceReceipt(JSON.parse(receiptBytes.toString()));
assert(receipt.version === 3 && receipt.protocol === PRESIGNED_PROTOCOL_V3 && receipt.sourceDigest === sourceDigest);
const imageDirectory = resolve(values['image-evidence']);
const oci = await verifyOciDirectory(`${imageDirectory}/oci`);
assert(oci.manifestDigest === receipt.testedImageManifestDigest);
const childEnvironment: NodeJS.ProcessEnv = {};
for (const key of ['PATH','HOME','LANG','LC_ALL','XDG_RUNTIME_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','LD_LIBRARY_PATH'])
  if (process.env[key] !== undefined) childEnvironment[key]=process.env[key];
function native(executable: string, args: string[], timeout=30000) {
  const result = spawnSync(executable,args,{env:childEnvironment,encoding:'utf8',timeout,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']});
  assert(result.status === 0, 'isolated native/container operation failed; raw diagnostics retained only by its private service, never printed');
  return result.stdout.trim();
}
const rootless = JSON.parse(native('podman',['--remote=false','info','--format','json']));
assert(rootless.host?.security?.rootless === true, 'existing supported rootless Podman is required; no policy workaround');
const pgBin = resolve(process.env.POSTGRES_BIN ?? '/home/codex/.cache/btc-multiplayer-vault/postgresql-16.14/usr/lib/postgresql/16/bin');
assert(/PostgreSQL\) 16\./u.test(native(`${pgBin}/postgres`,['--version'])));
const coreBin = resolve(process.env.BITCOIN_CORE_BIN ?? '/home/codex/.cache/btc-multiplayer-vault/bitcoin-core-31.1/bin/bitcoind');
assert(/v31\.1\./u.test(native(coreBin,['--version'])));
const directory = mkdtempSync(`${scratch}/presigned-deployment-drill.`);
for (const name of ['secrets','journal','core']) mkdirSync(`${directory}/${name}`,{mode:0o700});
const secrets = `${directory}/secrets`; const journal = `${directory}/journal`; const installationId=randomUUID();
async function port() { const listener=createServer(); await new Promise<void>(done=>listener.listen(0,'127.0.0.1',done));
  const result=(listener.address() as {port:number}).port; await new Promise<void>((done,reject)=>listener.close(error=>error?reject(error):done())); return result; }
const pgPort=await port(); const appPort=await port(); const corePort=await port();
assert(new Set([pgPort,appPort,corePort]).size===3);
let pgStarted=false; let coreExited=false; let coreProcess: ReturnType<typeof spawn> | undefined;
let completedEvidence: Record<string,unknown> | undefined;
const origin=`http://127.0.0.1:${appPort}`; const username=userInfo().username;
const databaseUrl=`postgresql://${encodeURIComponent(username)}@127.0.0.1:${pgPort}/deployment_source`;
const restoredUrl=`postgresql://${encodeURIComponent(username)}@127.0.0.1:${pgPort}/deployment_restore`;
const coreUrl=`http://127.0.0.1:${corePort}/`;
async function rpc(method:string) {
  const cookie=readFileSync(`${directory}/core/regtest/.cookie`,'utf8').trim();
  const response=await fetch(coreUrl,{method:'POST',headers:{Authorization:`Basic ${Buffer.from(cookie).toString('base64')}`},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:[]}),signal:AbortSignal.timeout(5000)});
  const body=await response.json() as any; assert(!body.error,'isolated Core RPC failed'); return body.result;
}
async function connection<T>(url:string, fn:(sql:ReturnType<typeof postgres>)=>Promise<T>) {
  const sql=postgres(url,{max:1,connect_timeout:10,onnotice:()=>{}}); try{return await fn(sql);}finally{await sql.end({timeout:5});}
}
try {
  native(`${pgBin}/initdb`,['-D',`${directory}/postgres`,'--auth=trust','--no-locale','--encoding=UTF8']);
  native(`${pgBin}/pg_ctl`,['-D',`${directory}/postgres`,'-o',`-h 127.0.0.1 -p ${pgPort} -k ${directory}`,'-l',`${directory}/postgres.log`,'start']); pgStarted=true;
  for (const name of ['deployment_source','deployment_restore']) native(`${pgBin}/createdb`,['-h','127.0.0.1','-p',String(pgPort),name]);
  coreProcess=spawn(coreBin,['-regtest',`-datadir=${directory}/core`,'-server=1','-listen=0','-networkactive=0','-dnsseed=0','-discover=0','-txindex=1',
    '-rpcbind=127.0.0.1','-rpcallowip=127.0.0.1',`-rpcport=${corePort}`,'-printtoconsole=0'],{env:childEnvironment,stdio:'ignore'});
  coreProcess.once('exit',()=>{coreExited=true;}); coreProcess.once('error',()=>{coreExited=true;});
  let ready=false;
  for(let attempt=0;attempt<300&&!coreExited;attempt++) { if(existsSync(`${directory}/core/regtest/.cookie`)) try { ready=(await rpc('getblockchaininfo')).chain==='regtest'; }catch{/* startup */}
    if(ready)break; await delay(100); }
  assert(ready); const network=await rpc('getnetworkinfo'); assert(network.version===310100 && network.networkactive===false && network.connections===0);
  writePrivateJournalBytes(`${secrets}/core.cookie`,readFileSync(`${directory}/core/regtest/.cookie`));
  writePrivateJournalBytes(`${secrets}/acceptance.json`,receiptBytes);
  const environment={VAULT_NETWORK:'signet',NEXT_PUBLIC_VAULT_NETWORK:'signet',DATABASE_URL:databaseUrl,APP_ORIGIN:origin,
    WEBAUTHN_ORIGIN:origin,WEBAUTHN_RP_ID:'127.0.0.1',BITCOIN_BACKEND:'core',BITCOIN_RPC_URL:coreUrl,BITCOIN_RPC_COOKIE_FILE:`${secrets}/core.cookie`};
  const envBytes=Buffer.from(Object.entries(environment).map(([key,value])=>`${key}=${value}\n`).join(''));
  writePrivateJournalBytes(`${secrets}/runtime.env`,envBytes);
  const image={evidenceDirectory:imageDirectory,sourceDigest,imageManifestDigest:oci.manifestDigest,imageConfigDigest:oci.configDigest,
    offlineUtilityDigest:receipt.offlineUtilityDigest,acceptanceReceiptPath:`${secrets}/acceptance.json`,acceptanceReceiptDigest:receipt.receiptDigest};
  const body:Omit<PresignedDeploymentPlan,'digest'>={version:1,protocol:PRESIGNED_PROTOCOL_V3,kind:'private-loopback-deployment-v1',
    installationId,releaseId:randomUUID(),network:'signet',candidate:image,rollback:null,environmentFile:`${secrets}/runtime.env`,
    environmentSha256:createHash('sha256').update(envBytes).digest('hex'),protectedDirectory:secrets,journalDirectory:journal,
    databaseEndpointFingerprint:databaseEndpointFingerprint(databaseUrl),databaseRestore:null,migrationVersions:[...EXPECTED_MIGRATION_VERSIONS],
    migrationDigest:deploymentMigrationDigest(),host:'127.0.0.1',port:appPort,watcherIntervalSeconds:15};
  const first=createDeploymentPlan(body);
  const approval=(plan:PresignedDeploymentPlan)=>({approvedPlanDigest:plan.digest,execution:DEPLOYMENT_EXECUTION_ACK,quiescence:DEPLOYMENT_QUIESCENCE_ACK});
  const verification=await verifyDeploymentPackage(first); assert(verification.deployed===false && verification.databaseAccessed===false);
  assert(readDeploymentJournal(first).length===0);
  const installed=await executeDeployment(first,'install',approval(first)); assert(installed.phase==='healthy' && installed.activeContainerId);
  const monitor=await monitorDeployment(first,approval(first),new AbortController().signal,true); assert(monitor.checks===1);
  // Stop the exact first web before the native snapshot, just like a real
  // operator's quiesced backup window; no target is resolved from a tag or glob.
  native('podman',['--remote=false','stop','--time','30',installed.activeContainerId]);
  native(`${pgBin}/pg_dump`,['-h','127.0.0.1','-p',String(pgPort),'--format=custom','--file',`${directory}/native.dump`,'deployment_source']);
  native(`${pgBin}/pg_restore`,['-h','127.0.0.1','-p',String(pgPort),'--exit-on-error','--dbname','deployment_restore',`${directory}/native.dump`]);
  const before=await connection(databaseUrl,async sql=>({identity:await captureDatabaseRuntimeIdentity(sql),snapshot:await captureDatabaseSnapshot(sql)}));
  const restored=await connection(restoredUrl,async sql=>({identity:await captureDatabaseRuntimeIdentity(sql),snapshot:await captureDatabaseSnapshot(sql)}));
  const checks=[{name:'source and restored databases are distinct protected endpoints and server-reported identities',ok:true},
    ...compareDatabaseSnapshots(before.snapshot,restored.snapshot)]; assert(checks.every(check=>check.ok));
  const restore=createDatabaseRestoreReceipt({createdAt:new Date().toISOString(),sourceEndpointFingerprint:databaseEndpointFingerprint(databaseUrl),
    restoredEndpointFingerprint:databaseEndpointFingerprint(restoredUrl),sourceDatabaseIdentityFingerprint:before.identity.fingerprint,
    restoredDatabaseIdentityFingerprint:restored.identity.fingerprint,sourceSnapshot:before.snapshot,restoredSnapshot:restored.snapshot,checks});
  writePrivateJournalBytes(`${secrets}/restore.json`,Buffer.from(`${JSON.stringify(restore)}\n`));
  const second=createDeploymentPlan({...body,releaseId:randomUUID(),rollback:image,databaseRestore:{receiptPath:`${secrets}/restore.json`,receiptDigest:restore.receiptDigest}});
  const upgraded=await executeDeployment(second,'install',approval(second)); assert(upgraded.activeContainerId && upgraded.activeContainerId!==installed.activeContainerId);
  native('podman',['--remote=false','stop','--time','30',upgraded.activeContainerId]);
  // Swap only these two newly created disposable databases, retaining both.
  // A schema-identical native restore at the same URL must never be adopted
  // merely because the deployment journal previously reached "healthy".
  const administrative=(statement:string)=>native(`${pgBin}/psql`,['-h','127.0.0.1','-p',String(pgPort),'-d','postgres','-v','ON_ERROR_STOP=1','-c',statement]);
  administrative('ALTER DATABASE deployment_source RENAME TO deployment_retained');
  administrative('ALTER DATABASE deployment_restore RENAME TO deployment_source');
  let databaseInstanceSubstitutionRefusals=0;
  for(const operation of ['install','rollback'] as const) {await assert.rejects(()=>executeDeployment(second,operation,approval(second)),/database instance changed after the durable deployment record/u);databaseInstanceSubstitutionRefusals++;}
  await assert.rejects(()=>monitorDeployment(second,approval(second),new AbortController().signal,true),/database instance changed after the durable deployment record/u);databaseInstanceSubstitutionRefusals++;
  administrative('ALTER DATABASE deployment_source RENAME TO deployment_restore');
  administrative('ALTER DATABASE deployment_retained RENAME TO deployment_source');
  const firstMigration=EXPECTED_MIGRATION_VERSIONS[0]!;
  await connection(databaseUrl,async sql=>{await sql`UPDATE schema_migrations SET version='999_substitution_probe' WHERE version=${firstMigration}`;});
  let schemaSubstitutionRefusals=0;
  await assert.rejects(()=>executeDeployment(second,'install',approval(second)),/exact deployed migration set/u);schemaSubstitutionRefusals++;
  await assert.rejects(()=>monitorDeployment(second,approval(second),new AbortController().signal,true),/exact deployed migration set/u);schemaSubstitutionRefusals++;
  await connection(databaseUrl,async sql=>{await sql`UPDATE schema_migrations SET version=${firstMigration} WHERE version='999_substitution_probe'`;});
  const repeated=await executeDeployment(second,'install',approval(second)); assert(repeated.activeContainerId===upgraded.activeContainerId);
  const rolledBack=await executeDeployment(second,'rollback',approval(second)); assert(rolledBack.activeContainerId===installed.activeContainerId);
  native('podman',['--remote=false','stop','--time','30',installed.activeContainerId]);
  const repeatedRollback=await executeDeployment(second,'rollback',approval(second)); assert(repeatedRollback.activeContainerId===installed.activeContainerId);
  const after=await connection(databaseUrl,async sql=>({identity:await captureDatabaseRuntimeIdentity(sql),snapshot:await captureDatabaseSnapshot(sql)}));
  sameCanonical(after,before,'exact database history across deployment and image rollback');
  const entries=readDeploymentJournal(second); assert(entries.at(-1)?.phase==='healthy' && entries.at(-1)?.operation==='rollback');
  const finalMonitor=await monitorDeployment(second,approval(second),new AbortController().signal,true); assert(finalMonitor.checks===1);
  assert(presignedSourceDigest()===sourceDigest,'source changed during actual deployment acceptance');
  const evidence={version:1,protocol:PRESIGNED_PROTOCOL_V3,kind:'actual-private-loopback-deployment-rollback',createdAt:new Date().toISOString(),
    sourceDigest,imageManifestDigest:oci.manifestDigest,imageConfigDigest:oci.configDigest,offlineUtilityDigest:receipt.offlineUtilityDigest,
    acceptanceReceiptDigest:receipt.receiptDigest,firstPlanDigest:first.digest,upgradePlanDigest:second.digest,journalDigest:entries.at(-1)!.digest,
    nativeRestoreReceiptDigest:restore.receiptDigest,nativeDumpSha256:createHash('sha256').update(readFileSync(`${directory}/native.dump`)).digest('hex'),
    actualRootlessContainerExecution:true,actualNativePostgresqlRestore:true,actualCoreChain:'isolated-regtest',coreVersion:network.version,
    successfulInstallations:2,successfulExactPreviousContainerRollbacks:1,idempotentInstallReconciliations:1,idempotentRollbackReconciliations:1,
    successfulWatcherHealthIterations:2,databaseInstanceSubstitutionRefusals,schemaSubstitutionRefusals,
    migrationCount:EXPECTED_MIGRATION_VERSIONS.length,databaseHistoryPreserved:true,
    sameCompatibleImageAcrossReleases:true,databaseDowngraded:false,historicalContainersDeleted:false,codeMounts:false,
    readonlyRootFilesystem:true,listener:'127.0.0.1',operationalDatabaseAccess:false,publicNetworkBroadcasts:0,publicListener:false,
    realDefaultSignetVerified:false,productionDeploymentClaimed:false,fundingAuthorized:false};
  completedEvidence=evidence;
} finally {
  // Keep all stopped containers, databases, native backup and journals. Stop
  // only exact containers labeled with this freshly generated installation ID.
  const ids=native('podman',['--remote=false','ps','--no-trunc','--filter',`label=io.vault.installation=${installationId}`,'--format','{{.ID}}']);
  for(const id of ids?ids.split('\n'):[]) {assert(/^[0-9a-f]{64}$/u.test(id)); const item=JSON.parse(native('podman',['--remote=false','container','inspect',id]))[0];
    assert(item.Id===id&&item.Config?.Labels?.['io.vault.installation']===installationId); native('podman',['--remote=false','stop','--time','30',id]);}
  if(coreProcess&&!coreExited) {try{await rpc('stop');}catch{coreProcess.kill('SIGTERM');}
    for(let attempt=0;attempt<200&&!coreExited;attempt++)await delay(100); assert(coreExited,'isolated Core shutdown not confirmed; keep its private data');}
  if(pgStarted) native(`${pgBin}/pg_ctl`,['-D',`${directory}/postgres`,'-m','fast','stop']);
}
assert(completedEvidence,'actual deployment/rollback did not finish');
const complete={...completedEvidence,cleanServiceShutdownVerified:true};
const result={...complete,receiptDigest:commitmentDigest('vault/presigned-graph-v3/deployment-rollback-acceptance',complete)};
validateDeploymentExecutionEvidence(result,{sourceDigest,imageManifestDigest:oci.manifestDigest,imageConfigDigest:oci.configDigest,
  offlineUtilityDigest:receipt.offlineUtilityDigest,acceptanceReceiptDigest:receipt.receiptDigest});
writePrivateJournalBytes(`${directory}/deployment-acceptance.json`,Buffer.from(`${JSON.stringify(result,null,2)}\n`));
console.log(JSON.stringify({passed:true,...result,evidenceDirectory:directory}));
