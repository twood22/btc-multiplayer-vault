/** Pure policy + real private-file/journal checks, NOT deployment evidence. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, linkSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { databaseEndpointFingerprint } from '../src/database-restore-receipt.js';
import { EXPECTED_MIGRATION_VERSIONS } from '../web/lib/migrations.js';
import { PRESIGNED_PROTOCOL_V3 } from '../src/presigned/types.js';
import { commitmentDigest } from '../src/presigned/validation.js';
import { validateDeploymentExecutionEvidence } from './lib/presigned-deployment-evidence.js';
import { createDeploymentPlan, deploymentMigrationDigest, validateDeploymentPlan, validateDeploymentEnvironment,
  deploymentRunCommand, deploymentRuntimeEnvironment, DEPLOYMENT_EXECUTION_ACK, DEPLOYMENT_QUIESCENCE_ACK,
  validateDeploymentDatabaseIdentity, validateDeploymentContainerHardening, validateDeploymentProcessPrivileges,
  type PresignedDeploymentPlan } from './lib/presigned-deployment-plan.js';
import { readDeploymentEnvironment, readDeploymentJournal, appendDeploymentJournal, validateDeploymentApproval,
  executeDeployment } from './lib/presigned-deployment-runtime.js';

const directory = mkdtempSync(`${tmpdir()}/btc-presigned-deployment-policy.`);
const secrets = `${directory}/secrets`; const journal = `${directory}/journal`;
mkdirSync(secrets, {mode:0o700}); mkdirSync(journal, {mode:0o700});
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
// Public test-only fixture identity. Never a real receipt or service endpoint.
const environment = { VAULT_NETWORK:'signet', NEXT_PUBLIC_VAULT_NETWORK:'signet', DATABASE_URL:'postgresql://policy_fixture@127.0.0.1:65432/policy_only',
  APP_ORIGIN:'http://127.0.0.1:41234', WEBAUTHN_ORIGIN:'http://127.0.0.1:41234', WEBAUTHN_RP_ID:'127.0.0.1', BITCOIN_BACKEND:'core',
  BITCOIN_RPC_URL:'http://127.0.0.1:65431', BITCOIN_RPC_USERNAME:'public-fixture', BITCOIN_RPC_PASSWORD:'public-fixture-do-not-echo' };
const envBytes = Object.entries(environment).map(([key,value]) => `${key}=${value}\n`).join('');
writeFileSync(`${secrets}/runtime.env`,envBytes,{mode:0o600});
const image = { evidenceDirectory:`${directory}/absent-real-image`, sourceDigest:'11'.repeat(32), imageManifestDigest:`sha256:${'22'.repeat(32)}`,
  imageConfigDigest:`sha256:${'33'.repeat(32)}`, offlineUtilityDigest:'44'.repeat(32), acceptanceReceiptPath:`${secrets}/absent-real-receipt.json`,
  acceptanceReceiptDigest:'55'.repeat(32) };
const body: Omit<PresignedDeploymentPlan,'digest'> = { version:1,protocol:PRESIGNED_PROTOCOL_V3,kind:'private-loopback-deployment-v1',
  installationId:randomUUID(), releaseId:randomUUID(),network:'signet',candidate:image,rollback:null,
  environmentFile:`${secrets}/runtime.env`,environmentSha256:sha(envBytes),protectedDirectory:secrets,journalDirectory:journal,
  databaseEndpointFingerprint:databaseEndpointFingerprint(environment.DATABASE_URL),databaseRestore:null,
  migrationVersions:[...EXPECTED_MIGRATION_VERSIONS],migrationDigest:deploymentMigrationDigest(),host:'127.0.0.1',port:41234,watcherIntervalSeconds:30 };
const plan = createDeploymentPlan(body);
let negativeControls = 0;
function denied(fn: () => unknown) { assert.throws(fn); negativeControls++; }
async function deniedAsync(fn: () => Promise<unknown>) { await assert.rejects(fn); negativeControls++; }
assert.equal(validateDeploymentPlan(plan).digest,plan.digest);
assert.deepEqual(readDeploymentEnvironment(plan),environment);
for (const mutation of [ {version:2}, {protocol:'presigned-graph-v2'}, {kind:'public-deployment'}, {installationId:'anything'}, {releaseId:'anything'},
  {network:'regtest'}, {host:'0.0.0.0'}, {host:'::'}, {port:80}, {port:65536}, {port:1234.5}, {watcherIntervalSeconds:0},
  {watcherIntervalSeconds:3601}, {migrationVersions:[]}, {migrationDigest:'66'.repeat(32)}, {environmentSha256:'bad'},
  {databaseEndpointFingerprint:'bad'}, {rollback:undefined}, {databaseRestore:undefined}, {protectedDirectory:'/etc/private-secrets'},
  {environmentFile:`${directory}/other.env`}, {journalDirectory:secrets}, {journalDirectory:`${secrets}/journal`},
  {protectedDirectory:journal}, {protectedDirectory:'/tmp'}, {protectedDirectory:`${directory}/with,comma`}, {environmentFile:'relative.env'},
  {protectedDirectory:process.env.HOME,environmentFile:`${process.env.HOME}/private.env`},
  {protectedDirectory:`${process.cwd()}/private`,environmentFile:`${process.cwd()}/private/runtime.env`} ])
  denied(() => createDeploymentPlan({ ...body,...mutation } as any));
for (const mutation of [{ imageConfigDigest:'latest' },{ imageManifestDigest:'sha256:no' },{ sourceDigest:'bad' },
  { offlineUtilityDigest:'bad' },{ acceptanceReceiptDigest:'bad' },{ acceptanceReceiptPath:`${directory}/receipt.json` },
  { evidenceDirectory:'relative' },{ unexpected:true }]) {
  denied(() => createDeploymentPlan({ ...body,candidate:{...image,...mutation} } as any));
  denied(() => createDeploymentPlan({ ...body,rollback:{...image,...mutation} } as any));
}
for (const field of Object.keys(plan)) denied(() => { const bad = {...plan} as any; delete bad[field]; validateDeploymentPlan(bad); });
denied(() => validateDeploymentPlan({...plan,port:41235}));
for (const mutation of [{ NODE_OPTIONS:'--import hostile.js' },{ LD_PRELOAD:'hostile.so' },{ CONTAINER_HOST:'ssh://remote' },
  { DATABASE_URL:'postgresql://user@remote.invalid/other?sslmode=disable' },{ DATABASE_URL:'postgresql://user@127.0.0.1:65432/other' },
  { VAULT_NETWORK:'mainnet' },{ NEXT_PUBLIC_VAULT_NETWORK:'mainnet' },{ APP_ORIGIN:'http://public.invalid' },{ WEBAUTHN_ORIGIN:'https://elsewhere.invalid' },
  { APP_ORIGIN:'http://127.0.0.1:41234/path' },{ WEBAUTHN_RP_ID:'wrong.invalid' },{ BITCOIN_BACKEND:'esplora' },
  { BITCOIN_RPC_URL:'http://public.invalid' },{ BITCOIN_RPC_URL:'https://user:password@private.invalid' },{ BITCOIN_RPC_URL:'http://127.0.0.1/#fragment' },
  { BITCOIN_RPC_USERNAME:'' },{ BITCOIN_RPC_PASSWORD:'' },{ BITCOIN_RPC_COOKIE_FILE:`${secrets}/cookie` },{ BITCOIN_RPC_USER:'ambiguous' },
  { PRESIGNED_V2_BROADCAST_NETWORK:'mainnet' },{ PRESIGNED_V3_BROADCAST_NETWORK:'signet' },{ VAULT_DEMO_SEED:'fixture' },
  { DATABASE_RESTORE_RECEIPT:'/tmp/other.json' },{ PRESIGNED_V2_RELEASE_REPORT:`${directory}/report.json` },{ APP_ORIGIN:'\0' }])
  denied(() => validateDeploymentEnvironment(plan,{...environment,...mutation} as unknown as Record<string,string>));
const approval = { approvedPlanDigest:plan.digest,execution:DEPLOYMENT_EXECUTION_ACK,quiescence:DEPLOYMENT_QUIESCENCE_ACK };
validateDeploymentApproval(plan,approval);
for (const mutation of [{ approvedPlanDigest:'77'.repeat(32) },{ execution:'yes' },{ quiescence:'yes' },{ unexpected:true }]) {
  denied(() => validateDeploymentApproval(plan,{...approval,...mutation}));
  await deniedAsync(() => executeDeployment(plan,'install',{...approval,...mutation}));
}
const runtime = deploymentRuntimeEnvironment(plan,image,environment);
assert(!('PRESIGNED_V3_MAINNET_AUTHORIZATION' in runtime) && !('PRESIGNED_V2_BROADCAST_NETWORK' in runtime));
assert.equal(runtime.HOSTNAME,'127.0.0.1');
for (const role of ['web','watcher','migration'] as const) {
  const command = deploymentRunCommand(plan,role,Object.keys(runtime),1000,1000);
  for (const required of ['--pull=never','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','keep-id','--log-driver','none']) assert(command.args.includes(required));
  assert.equal(command.args[command.args.indexOf('--network')+1],'host');
  assert.equal(command.args[command.args.indexOf('--user')+1],'1000:1000');
  assert(command.args.includes(image.imageConfigDigest));
  assert(!JSON.stringify(command).includes(environment.BITCOIN_RPC_PASSWORD) && !JSON.stringify(command).includes(environment.DATABASE_URL));
  assert(!command.args.includes('--privileged') && !command.args.includes('--publish') && !command.args.includes('-p'));
  denied(() => deploymentRunCommand(plan,role,Object.keys(runtime),0,0));
  denied(() => deploymentRunCommand(plan,role,['NODE_ENV','NODE_ENV'],1000,1000));
}
const hardeningStart=negativeControls;
const inspection={EffectiveCaps:[],BoundingCaps:[],HostConfig:{CapAdd:[],CapDrop:['CAP_CHOWN'],SecurityOpt:['no-new-privileges'],UsernsMode:'private',
  PidsLimit:256,Memory:1073741824,CpuPeriod:100000,CpuQuota:200000,NanoCpus:2000000000,LogConfig:{Type:'none'},
  Tmpfs:{'/tmp':'rw,noexec,nosuid,size=64m','/run':'rw,noexec,nosuid,size=16m'}},
  Config:{CreateCommand:['podman','--remote=false',...deploymentRunCommand(plan,'web',Object.keys(runtime),1000,1000).args]}};
validateDeploymentContainerHardening(inspection);
validateDeploymentContainerHardening({...inspection,EffectiveCaps:null,BoundingCaps:null});
for(const mutation of [{EffectiveCaps:['CAP_NET_ADMIN']},{BoundingCaps:['CAP_CHOWN']},{EffectiveCaps:undefined},{BoundingCaps:undefined}])
  denied(()=>validateDeploymentContainerHardening({...inspection,...mutation}));
for(const mutation of [{CapAdd:['CAP_SYS_ADMIN']},{CapDrop:['ALL']},{SecurityOpt:[]},{SecurityOpt:['no-new-privileges','seccomp=unconfined']},
  {UsernsMode:'host'},{PidsLimit:0},{Memory:0},{CpuPeriod:0},{CpuQuota:-1},{NanoCpus:0},{LogConfig:{Type:'journald'}},
  {Tmpfs:{'/tmp':'rw,size=64m','/run':'rw,noexec,nosuid,size=16m'}},{Tmpfs:{'/tmp':'rw,noexec,nosuid,size=128m','/run':'rw,noexec,nosuid,size=16m'}}])
  denied(()=>validateDeploymentContainerHardening({...inspection,HostConfig:{...inspection.HostConfig,...mutation}}));
for(const field of Object.keys(inspection.HostConfig)) denied(()=>{const bad=structuredClone(inspection) as any;delete bad.HostConfig[field];validateDeploymentContainerHardening(bad);});
for(const flag of ['--userns','--cap-drop','--security-opt','--log-driver','--read-only-tmpfs=false']) denied(()=>{
  const bad=structuredClone(inspection);bad.Config.CreateCommand=bad.Config.CreateCommand.filter(item=>item!==flag);validateDeploymentContainerHardening(bad);
});
const kernel={status:'Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\nNoNewPrivs:\t1\n'+
  ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(name=>name+':\t0000000000000000\n').join(''),
  uidMap:'0 100000 1000\n1000 1000 1\n1001 101000 64536\n',gidMap:'0 100000 1000\n1000 1000 1\n1001 101000 64536\n',
  userNamespace:'user:[100]',hostUserNamespace:'user:[200]'};
validateDeploymentProcessPrivileges(kernel,1000,1000);
for(const mutation of [{status:kernel.status.replace('NoNewPrivs:\t1','NoNewPrivs:\t0')},{uidMap:'0 0 1000'},{gidMap:'1000 0 1'},
  {userNamespace:kernel.hostUserNamespace},{status:kernel.status.replace('Uid:\t1000','Uid:\t0')},{status:kernel.status.replace('Gid:\t1000','Gid:\t0')}])
  denied(()=>validateDeploymentProcessPrivileges({...kernel,...mutation},1000,1000));
for(const name of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) denied(()=>validateDeploymentProcessPrivileges({...kernel,
  status:kernel.status.replace(name+':\t0000000000000000',name+':\t0000000000000001')},1000,1000));
validateDeploymentDatabaseIdentity(plan,'88'.repeat(32),{fingerprint:'88'.repeat(32),migrationVersions:plan.migrationVersions});
for(const current of [{fingerprint:'99'.repeat(32),migrationVersions:plan.migrationVersions},{fingerprint:'88'.repeat(32),migrationVersions:[]},
  {fingerprint:'88'.repeat(32),migrationVersions:[...plan.migrationVersions.slice(0,-1),'999_substituted']},
  {fingerprint:'88'.repeat(32),migrationVersions:[...plan.migrationVersions].reverse()}]) denied(()=>validateDeploymentDatabaseIdentity(plan,'88'.repeat(32),current));
const runtimeHardeningRefusals=negativeControls-hardeningStart;
chmodSync(plan.environmentFile,0o644); denied(() => readDeploymentEnvironment(plan)); chmodSync(plan.environmentFile,0o600);
writeFileSync(`${secrets}/target.env`,envBytes,{mode:0o600}); symlinkSync(`${secrets}/target.env`,`${secrets}/symlink.env`);
denied(() => readDeploymentEnvironment(createDeploymentPlan({...body,environmentFile:`${secrets}/symlink.env`})));
linkSync(`${secrets}/target.env`,`${secrets}/hardlink.env`);
denied(() => readDeploymentEnvironment(createDeploymentPlan({...body,environmentFile:`${secrets}/hardlink.env`})));
denied(() => readDeploymentEnvironment(createDeploymentPlan({...body,environmentSha256:'99'.repeat(32)})));
const entries = readDeploymentJournal(plan);
const state = { operation:'install' as const,phase:'prepared' as const,candidateContainerId:null,previousContainerId:null,activeContainerId:null,databaseIdentity:null };
appendDeploymentJournal(plan,entries,state); appendDeploymentJournal(plan,entries,{...state,phase:'quiesced'});
assert.equal(readDeploymentJournal(plan).length,2);
denied(() => appendDeploymentJournal(plan,[],state));
denied(() => readDeploymentJournal(createDeploymentPlan({...body,installationId:randomUUID()})));
const last = `${journal}/${readdirSync(journal).sort().at(-1)!}`;
const original = readFileSync(last); const changed = JSON.parse(original.toString()); changed.phase='healthy';
writeFileSync(last,JSON.stringify(changed)); denied(() => readDeploymentJournal(plan)); writeFileSync(last,original);
writeFileSync(`${journal}/.partial-interrupted`,Buffer.from('retained interrupted journal bytes'),{mode:0o600}); denied(() => readDeploymentJournal(plan));
// The default CLI cannot silently execute when handed a policy-only fixture.
const planFile = `${secrets}/plan.json`; writeFileSync(planFile,JSON.stringify(plan),{mode:0o600});
const child = spawnSync(process.execPath,['--import','tsx','scripts/presigned-deployment.mts','--plan',planFile],
  {env:{PATH:process.env.PATH,HOME:process.env.HOME},encoding:'utf8',timeout:30000});
assert.equal(child.status,1); assert(!child.stdout.includes('deployed":true'));
assert(!`${child.stdout}${child.stderr}`.includes(environment.BITCOIN_RPC_PASSWORD));
assert(!`${child.stdout}${child.stderr}`.includes(environment.DATABASE_URL)); negativeControls++;
// Parser fixtures never leave this process and are never emitted as receipts.
const evidenceStart=negativeControls;
const pins={sourceDigest:image.sourceDigest,imageManifestDigest:image.imageManifestDigest,imageConfigDigest:image.imageConfigDigest,
  offlineUtilityDigest:image.offlineUtilityDigest,acceptanceReceiptDigest:image.acceptanceReceiptDigest};
const syntheticEvidenceBody={version:1,protocol:PRESIGNED_PROTOCOL_V3,kind:'actual-private-loopback-deployment-rollback',createdAt:new Date().toISOString(),
  ...pins,firstPlanDigest:'10'.repeat(32),upgradePlanDigest:'20'.repeat(32),journalDigest:'30'.repeat(32),nativeRestoreReceiptDigest:'40'.repeat(32),
  nativeDumpSha256:'50'.repeat(32),actualRootlessContainerExecution:true,actualNativePostgresqlRestore:true,actualCoreChain:'isolated-regtest',coreVersion:310100,
  successfulInstallations:2,successfulExactPreviousContainerRollbacks:1,idempotentInstallReconciliations:1,idempotentRollbackReconciliations:1,
  successfulWatcherHealthIterations:2,databaseInstanceSubstitutionRefusals:3,schemaSubstitutionRefusals:2,
  migrationCount:EXPECTED_MIGRATION_VERSIONS.length,databaseHistoryPreserved:true,sameCompatibleImageAcrossReleases:true,
  databaseDowngraded:false,historicalContainersDeleted:false,codeMounts:false,readonlyRootFilesystem:true,listener:'127.0.0.1',operationalDatabaseAccess:false,
  publicNetworkBroadcasts:0,publicListener:false,realDefaultSignetVerified:false,productionDeploymentClaimed:false,fundingAuthorized:false,cleanServiceShutdownVerified:true};
const syntheticEvidence={...syntheticEvidenceBody,receiptDigest:commitmentDigest('vault/presigned-graph-v3/deployment-rollback-acceptance',syntheticEvidenceBody)};
validateDeploymentExecutionEvidence(syntheticEvidence,pins);
for(const field of Object.keys(syntheticEvidence)) denied(()=>{const bad={...syntheticEvidence} as any;delete bad[field];validateDeploymentExecutionEvidence(bad,pins);});
for(const field of Object.keys(pins)) denied(()=>{const bad={...pins} as any;delete bad[field];validateDeploymentExecutionEvidence(syntheticEvidence,bad);});
for(const [key,value] of Object.entries(syntheticEvidenceBody)) if(typeof value==='boolean') denied(()=>{
  const body={...syntheticEvidenceBody,[key]:!value};
  validateDeploymentExecutionEvidence({...body,receiptDigest:commitmentDigest('vault/presigned-graph-v3/deployment-rollback-acceptance',body)},pins);
});
denied(()=>validateDeploymentExecutionEvidence({...syntheticEvidence,successfulInstallations:1},pins));
denied(()=>validateDeploymentExecutionEvidence(syntheticEvidence,{...pins,acceptanceReceiptDigest:'99'.repeat(32)}));
const exactImageEvidenceRefusals=negativeControls-evidenceStart;
console.log(JSON.stringify({passed:true,suite:'private-deployment-policy',protocol:PRESIGNED_PROTOCOL_V3,negativeControls,
  hardenedCommandRoles:3,realPrivateJournalChecks:true,exactImageEvidenceRefusals,runtimeHardeningRefusals,operationalDatabaseAccess:false,containerExecution:false,
  actualDeploymentRollbackVerified:false,publicNetworkBroadcasts:0,publicListener:false,fundingAuthorized:false}));
