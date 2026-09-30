/** One manually dispatched, post-assembly, same-image deployment TEST drill.
 * No runtime keys, databases, journals or custody directories are uploaded.
 * All pins stay invalid until the genuine final receipt and images exist.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, constants, createReadStream, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROTOCOL = 'presigned-graph-v3';
const REPOSITORY = 'twood22/btc-multiplayer-vault'; // Exact existing authorized repository; never caller-selected.
const REF = 'refs/heads/codex/presigned-v3-test-evidence';
const TOOLING = dirname(fileURLToPath(import.meta.url));
const STAGES = ['pins','download','input-review','candidate-verification','load-retained-image','actual-isolated-drill','proof-review','draft-upload'];
let phase = 'pins';
function progress(stage) {
  assert(STAGES.includes(stage)&&stage!=='pins');
  phase=stage;console.log(JSON.stringify({stage,scope:'post-assembly-isolated-deployment-test'}));
}
export const INPUT_NAMES = ['presigned-v3-signet-test-evidence.tar.gz', 'presigned-v3-signet-retention.json',
  'presigned-v3-signet-content-review.json', 'presigned-v3-signet-executable-acceptance.json'];
export const OUTPUT_NAMES = ['presigned-v3-signet-deployment-acceptance.json', 'presigned-v3-signet-deployment-retention.json'];
export const PINS = {
  candidateCommit: '94dc1046a29d2b027fc8186baa5932c1b1ab236a', sourceDigest: '83e9001523b7029a0da6e945be5e6258d5f50ed6f4f529cab9e70413cf7127bc',
  draftTag: 'presigned-v3-test-evidence-83e90015-20260919', draftReleaseId: 392238195,
  imageManifestDigest: 'sha256:961b777c3b18c706cc855abe159f57414957bd68839650544d0c71c81d93f39f', imageConfigDigest: 'sha256:033df0088f6625356330d64ad8900b99c1d19869f0c0a7fcb72f2a12412b8644',
  offlineUtilityDigest: '4b135ee6ac1ba1a02b4a5722a00ca703a7f3cbac23b6643467ebe9da4ab6db38', acceptanceReceiptDigest: '238fa6e550d27f3555d2efe944511e9a1e61b9fb6dd57a4402131c3ea065030a',
  imageReceiptDigest: 'a60084c71aad4bd908ca6da85ae6ce08617c68bce5917699204f0270d83118ca', imageToolingCommit: '749ba3dffd65912b62cdfd13dd0e3d200d5e2fdd',
  imageWorkflowRunId: '35473374308', imageScannerSha256: '815b768c09085f859266479a3dfb4707273f925e4680760f224cae85e508b1fd',
  migrationCount: 23,
  inputs: [
    {name:INPUT_NAMES[0],sha256:'2f333b3dd59e999ead3d5a079f3c27cd806d4a706af0fc6ecddf9f87e54663d4',bytes:258803763},
    {name:INPUT_NAMES[1],sha256:'d5656834f41f5cd5db6d7549d6fc946b998d6427a86f8bbfa13a9ab2e76cfecf',bytes:884},
    {name:INPUT_NAMES[2],sha256:'ff188973fd5be3aa9b93b8a8438fd43d00f5c1e17f84d33d79638d694dc971c7',bytes:1364},
    {name:INPUT_NAMES[3],sha256:'e252e6e9ab444141343d2e0c4e2c5c10b9334cf89a61f23ce097c3e9f1d00315',bytes:2931},
  ],
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => {
  if (value === null || ['string','boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number') { assert(Number.isSafeInteger(value)); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  assert(value && Object.getPrototypeOf(value) === Object.prototype);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const digest = (domain, body) => sha(`${domain}\n${canonical(body)}`);
const hex = (value, length=64) => assert(typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(value));
const exact = (value, keys) => assert(value && !Array.isArray(value) && typeof value === 'object' &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
const timestamp = value => assert(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
export function validatePins(pins = PINS) {
  exact(pins, Object.keys(PINS));
  hex(pins.candidateCommit,40); hex(pins.imageToolingCommit,40);
  for (const key of ['sourceDigest','offlineUtilityDigest','acceptanceReceiptDigest','imageReceiptDigest','imageScannerSha256']) hex(pins[key]);
  for (const key of ['imageManifestDigest','imageConfigDigest']) assert(/^sha256:[0-9a-f]{64}$/u.test(pins[key]));
  assert(new RegExp(`^presigned-v3-test-evidence-${pins.sourceDigest.slice(0,8)}-[0-9]{8}$`, 'u').test(pins.draftTag));
  assert(Number.isSafeInteger(pins.draftReleaseId) && pins.draftReleaseId > 0);
  assert(typeof pins.imageWorkflowRunId === 'string' && /^[1-9][0-9]*$/u.test(pins.imageWorkflowRunId));
  assert(Number.isSafeInteger(pins.migrationCount) && pins.migrationCount > 0 && pins.migrationCount <= 200);
  assert(Array.isArray(pins.inputs) && pins.inputs.length === INPUT_NAMES.length);
  pins.inputs.forEach((item,index) => {
    exact(item,['name','sha256','bytes']); assert(item.name === INPUT_NAMES[index]); hex(item.sha256);
    assert(Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= (index === 0 ? 2*1024**3-1 : 1024*1024));
  });
  return pins;
}
const PROOF_HASHES = ['sourceDigest','offlineUtilityDigest','acceptanceReceiptDigest','firstPlanDigest','upgradePlanDigest',
  'journalDigest','nativeRestoreReceiptDigest','nativeDumpSha256','receiptDigest'];
const PROOF_FLAGS = { actualRootlessContainerExecution:true, actualNativePostgresqlRestore:true, databaseHistoryPreserved:true,
  sameCompatibleImageAcrossReleases:true, databaseDowngraded:false, historicalContainersDeleted:false, codeMounts:false,
  readonlyRootFilesystem:true, operationalDatabaseAccess:false, publicListener:false, realDefaultSignetVerified:false,
  productionDeploymentClaimed:false, fundingAuthorized:false, cleanServiceShutdownVerified:true };
const PROOF_COUNTS = { coreVersion:310100,successfulInstallations:2,successfulExactPreviousContainerRollbacks:1,
  idempotentInstallReconciliations:1,idempotentRollbackReconciliations:1,successfulWatcherHealthIterations:2,
  databaseInstanceSubstitutionRefusals:3,schemaSubstitutionRefusals:2,publicNetworkBroadcasts:0 };
export function validatePublicProof(proof, pins) {
  validatePins(pins);
  exact(proof,['version','protocol','kind','createdAt',...PROOF_HASHES,'imageManifestDigest','imageConfigDigest',
    ...Object.keys(PROOF_FLAGS),...Object.keys(PROOF_COUNTS),'actualCoreChain','migrationCount','listener']);
  assert(proof.version === 1 && proof.protocol === PROTOCOL && proof.kind === 'actual-private-loopback-deployment-rollback' &&
    proof.actualCoreChain === 'isolated-regtest' && proof.listener === '127.0.0.1' && proof.migrationCount === pins.migrationCount);
  timestamp(proof.createdAt);
  for (const key of PROOF_HASHES) hex(proof[key]);
  for (const [key,value] of Object.entries({...PROOF_FLAGS,...PROOF_COUNTS})) assert(proof[key] === value);
  for (const key of ['sourceDigest','imageManifestDigest','imageConfigDigest','offlineUtilityDigest','acceptanceReceiptDigest']) assert(proof[key] === pins[key]);
  assert(proof.firstPlanDigest !== proof.upgradePlanDigest);
  const {receiptDigest,...body} = proof;
  assert(receiptDigest === digest('vault/presigned-graph-v3/deployment-rollback-acceptance',body));
  return proof;
}
const TRANSPORT_KEYS = ['version','protocol','kind','createdAt','candidateCommit','sourceDigest','toolingCommit','workflowRunId',
  'inputs','proof','imageManifestDigest','imageConfigDigest','offlineUtilityDigest','acceptanceReceiptDigest',
  'runnerSha256','boundaryHelperSha256','imageScannerSha256','actualDrillCompleted','cleanServiceShutdownVerified',
  'scope','privateDirectoryUploads','productionDeploymentClaimed','fundingAuthorized'];
export function validateTransport(record, pins, context) {
  validatePins(pins); exact(record,TRANSPORT_KEYS); timestamp(record.createdAt);
  assert(record.version === 1 && record.protocol === PROTOCOL && record.kind === 'presigned-v3-public-deployment-test-retention' &&
    record.candidateCommit === pins.candidateCommit && record.toolingCommit === context.toolingCommit && record.workflowRunId === context.workflowRunId &&
    record.actualDrillCompleted === true && record.cleanServiceShutdownVerified === true && record.scope === 'isolated-regtest-same-image-rollback' &&
    record.privateDirectoryUploads === false && record.productionDeploymentClaimed === false && record.fundingAuthorized === false);
  hex(record.toolingCommit,40); assert(/^[1-9][0-9]*$/u.test(record.workflowRunId));
  for (const key of ['sourceDigest','imageManifestDigest','imageConfigDigest','offlineUtilityDigest','acceptanceReceiptDigest','imageScannerSha256'])
    assert(record[key] === pins[key]);
  assert(canonical(record.inputs) === canonical(pins.inputs));
  for (const key of ['runnerSha256','boundaryHelperSha256']) {hex(record[key]); assert(record[key] === context[key]);}
  exact(record.proof,['name','sha256','bytes','receiptDigest']); assert(record.proof.name === OUTPUT_NAMES[0]);
  hex(record.proof.sha256);hex(record.proof.receiptDigest);
  assert(Number.isSafeInteger(record.proof.bytes) && record.proof.bytes > 0 && record.proof.bytes <= 65536);
  return record;
}
function ownedDirectory(path) {
  assert(path === resolve(path) && realpathSync(path) === path);
  const stat=lstatSync(path); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode&0o077) === 0);
}
function readOwned(path, maximum=65536) {
  ownedDirectory(dirname(path)); assert(realpathSync(path) === path);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=fstatSync(fd);assert(stat.isFile()&&stat.uid===process.getuid()&&stat.nlink===1&&(stat.mode&0o077)===0&&stat.size>0&&stat.size<=maximum);return readFileSync(fd);}
  finally {closeSync(fd);}
}
function writeExclusive(path, bytes) {
  ownedDirectory(dirname(path)); const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {writeFileSync(fd,bytes);fsyncSync(fd);} finally {closeSync(fd);}
}
async function hashOwned(path, maximum=2*1024**3-1) {
  ownedDirectory(dirname(path));assert(realpathSync(path)===path);
  const stat=lstatSync(path);assert(stat.isFile()&&stat.uid===process.getuid()&&stat.nlink===1&&(stat.mode&0o077)===0&&stat.size>0&&stat.size<=maximum);
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
  const after=lstatSync(path);assert(after.ino===stat.ino&&after.dev===stat.dev&&after.size===stat.size&&after.mtimeMs===stat.mtimeMs&&after.ctimeMs===stat.ctimeMs);
  return {sha256:hash.digest('hex'),bytes:stat.size};
}
function hostEnvironment() {
  const result={};for(const key of ['PATH','HOME','LANG','LC_ALL','XDG_RUNTIME_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','LD_LIBRARY_PATH',
    'POSTGRES_BIN','POSTGRES_LIB','BITCOIN_CORE_BIN','GITHUB_ACTIONS','RUNNER_TEMP','GITHUB_REPOSITORY_OWNER'])
    if(process.env[key]!==undefined)result[key]=process.env[key];
  return result;
}
function privateCommand(executable,args,env=hostEnvironment(),timeout=180000) {
  return execFileSync(executable,args,{env,encoding:'utf8',timeout,maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']}).trim();
}
function context() {
  assert(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_OS==='Linux'&&process.env.RUNNER_ARCH==='X64'&&process.getuid()>0);
  assert(process.env.GITHUB_EVENT_NAME==='workflow_dispatch'&&process.env.GITHUB_REF===REF&&process.env.GITHUB_REPOSITORY===REPOSITORY);
  hex(process.env.GITHUB_SHA,40);assert(/^[1-9][0-9]*$/u.test(process.env.GITHUB_RUN_ID??''));
  assert(process.env.PRESIGNED_ACCEPTANCE_PROTOCOL===PROTOCOL&&process.env.PRESIGNED_BUILD_PROTOCOL===PROTOCOL);
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  assert(event.repository?.private===false&&event.repository.full_name===REPOSITORY);
  assert(privateCommand('git',['rev-parse','HEAD'])===PINS.candidateCommit);
  assert(privateCommand('git',['-C',dirname(TOOLING),'rev-parse','HEAD'])===process.env.GITHUB_SHA);
  const temporary=process.env.RUNNER_TEMP;assert(temporary&&realpathSync(temporary)===temporary&&lstatSync(temporary).uid===process.getuid());
  return {root:join(temporary,'presigned-v3-deployment-ci'),toolingCommit:process.env.GITHUB_SHA,workflowRunId:process.env.GITHUB_RUN_ID,
    runnerSha256:sha(readFileSync(fileURLToPath(import.meta.url))),boundaryHelperSha256:sha(readFileSync(join(TOOLING,'presigned-deployment-public-evidence.py')))};
}
function github(args) {
  assert(process.env.GH_TOKEN&&process.env.GH_REPO===REPOSITORY);
  return privateCommand('gh',args,{...hostEnvironment(),GH_TOKEN:process.env.GH_TOKEN,GH_REPO:REPOSITORY});
}
export function checkedDraft(pins=PINS, readGithub=github) {
  validatePins(pins);
  // GitHub's tag lookup omits draft releases. Resolve the exact reviewed ID,
  // then recheck its full identity before every download and upload boundary.
  const api=JSON.parse(readGithub(['api',`repos/${REPOSITORY}/releases/${pins.draftReleaseId}`]));
  const draft={tagName:api.tag_name,isDraft:api.draft,isPrerelease:api.prerelease,targetCommitish:api.target_commitish,assets:api.assets};
  assert(api.id===pins.draftReleaseId&&draft.tagName===pins.draftTag&&draft.isDraft===true&&draft.isPrerelease===true&&draft.targetCommitish===pins.candidateCommit&&Array.isArray(draft.assets));
  return draft;
}
async function downloadAsset(asset, item, directory) {
  assert(Number.isSafeInteger(asset.id)&&asset.id>0&&asset.name===item.name&&asset.size===item.bytes);
  const fd=openSync(join(directory,item.name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  const child=spawn('gh',['api',`repos/${REPOSITORY}/releases/assets/${asset.id}`,'-H','Accept: application/octet-stream'],
    {env:{...hostEnvironment(),GH_TOKEN:process.env.GH_TOKEN,GH_REPO:REPOSITORY},stdio:['ignore','pipe','pipe']});
  let bytes=0,errors=0,failed=false;
  const stop=()=>{failed=true;child.kill('SIGKILL');};const timer=setTimeout(stop,10*60*1000);
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>item.bytes){stop();return;}writeFileSync(fd,chunk);});
  child.stderr.on('data',chunk=>{errors+=chunk.length;if(errors>65536)stop();});
  try {const code=await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);});
    assert(code===0&&!failed&&bytes===item.bytes,'bounded exact input download did not complete');fsyncSync(fd);
  } finally {clearTimeout(timer);closeSync(fd);}
}
async function verifyInputFiles(root) {
  assert(canonical(JSON.parse(readOwned(join(root,'pins.json'),1048576)))===canonical(PINS));
  const directory=join(root,'downloads');ownedDirectory(directory);assert.deepEqual(readdirSync(directory).sort(),[...INPUT_NAMES].sort());
  for(const item of PINS.inputs)assert.deepEqual(await hashOwned(join(directory,item.name)),{sha256:item.sha256,bytes:item.bytes});
}
const DRILL_OUTPUT_LIMIT = 4*1024*1024;
const DIAGNOSTIC_LIMIT = 65536;
const EXCEPTION_CLASSES = new Set(['Error','AssertionError','TypeError','RangeError','SyntaxError','ReferenceError','URIError','AbortError','AggregateError']);
const EXCEPTION_CODES = new Set(['ERR_ASSERTION','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_OUT_OF_RANGE',
  'ERR_MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED','ERR_UNKNOWN_FILE_EXTENSION','ERR_INVALID_URL',
  'ERR_UNHANDLED_ERROR','ERR_WORKER_OUT_OF_MEMORY','ABORT_ERR','ENOENT','EACCES','EPERM','EADDRINUSE','ECONNREFUSED','ETIMEDOUT','ENOBUFS','ENOMEM']);
const SIGNALS = new Set(['SIGHUP','SIGINT','SIGQUIT','SIGILL','SIGTRAP','SIGABRT','SIGBUS','SIGFPE','SIGKILL','SIGUSR1','SIGSEGV',
  'SIGUSR2','SIGPIPE','SIGALRM','SIGTERM','SIGSTKFLT','SIGCHLD','SIGCONT','SIGSTOP','SIGTSTP','SIGTTIN','SIGTTOU',
  'SIGURG','SIGXCPU','SIGXFSZ','SIGVTALRM','SIGPROF','SIGWINCH','SIGIO','SIGPWR','SIGSYS']);
// Only public source files in the already-pinned candidate, with their exact
// maximum line numbers. Neither arbitrary paths nor function names are emitted.
const CANDIDATE_FRAMES = new Map(Object.entries({
  'scripts/presigned-deployment-image-acceptance.mts':184,'scripts/lib/presigned-deployment-runtime.ts':444,
  'scripts/lib/presigned-deployment-plan.ts':202,'scripts/lib/presigned-deployment-evidence.ts':41,
  'scripts/lib/presigned-image-evidence.ts':72,'scripts/lib/presigned-oci.ts':148,
  'scripts/lib/presigned-durable-journal.ts':340,'scripts/lib/presigned-lifecycle-lock.ts':28,
  'scripts/lib/presigned-acceptance-run.ts':529,'scripts/presigned-build-identity.mjs':42,
  'src/presigned/release.ts':142,'src/presigned/validation.ts':105,'src/database-restore-receipt.ts':260,
  'web/lib/database-snapshot.ts':225,'web/lib/database-config.ts':63,'web/lib/migrations.ts':28,
}));
// Exact public Node22.23.2 module lengths also bound frame numbers; arbitrary
// large numeric values in untrusted stderr are not diagnostic identifiers.
const NODE_FRAMES = new Map(Object.entries({'node:internal/process/promises':498,'node:internal/errors':1925,
  'node:internal/assert/assertion_error':423,'node:internal/modules/esm/module_job':467,
  'node:internal/modules/esm/loader':1082,'node:internal/modules/run_main':188,
  'node:internal/child_process':1136,'node:events':1223,'node:fs':3383}));
const drillFailures = new WeakMap();
const nativeStackGetter=Object.getOwnPropertyDescriptor(new Error(),'stack')?.get;
const nativeErrorPrototypes=new Set([Error,assert.AssertionError,TypeError,RangeError,SyntaxError,ReferenceError,URIError,AggregateError].map(type=>type.prototype));
export function publicExceptionMetadata(text, candidateRoot) {
  const empty = () => ({class:null,code:null,frames:[]});
  if(typeof text!=='string'||Buffer.byteLength(text)>DIAGNOSTIC_LIMIT||text.includes('\0')||text.includes('\r')||
    typeof candidateRoot!=='string'||candidateRoot!==resolve(candidateRoot)||candidateRoot==='/'||/[\x00-\x1f]/u.test(candidateRoot))return empty();
  const lines=text.split('\n');
  // Accept one anchored, allowlisted Node exception header only. Its message
  // and all object properties, SQL, native diagnostics and other text are ignored.
  const headers=lines.flatMap((line,index)=>{
    if(line.length>2048)return [];
    const match=/^([A-Za-z]+)(?: \[([A-Z][A-Z0-9_]{0,63})\])?:/u.exec(line);
    return match&&EXCEPTION_CLASSES.has(match[1])?[{index,kind:match[1],code:EXCEPTION_CODES.has(match[2])?match[2]:null}]:[];
  });
  if(headers.length!==1)return empty();
  const header=headers[0],frames=[];
  // Frames must be adjacent stack lines immediately after the header. A
  // multiline message cannot provide a frame after intervening private text.
  for(const line of lines.slice(header.index+1)) {
    if(line.length>2048)break;
    const match=/^ {4}at (?:[A-Za-z0-9_$.[\]<> ]{1,160} \(([^()]{1,2048})\)|([^()]{1,2048}))$/u.exec(line);
    if(!match)break;
    const location=/^(.+):([1-9][0-9]{0,5}):([1-9][0-9]{0,5})$/u.exec(match[1]??match[2]);
    if(!location)break;
    const path=location[1],lineNumber=Number(location[2]);
    const candidate=[...CANDIDATE_FRAMES].find(([file,maximum])=>lineNumber<=maximum&&
      (path===join(candidateRoot,file)||path===pathToFileURL(join(candidateRoot,file)).href));
    const file=candidate?.[0]??(NODE_FRAMES.has(path)&&lineNumber<=NODE_FRAMES.get(path)?path:null);
    if(file&&!frames.some(frame=>frame.file===file&&frame.line===lineNumber)&&frames.length<4)frames.push({file,line:lineNumber});
  }
  return {class:header.kind,code:header.code,frames};
}
function exceptionFromError(error,candidateRoot) {
  try {
    const stack=Object.getOwnPropertyDescriptor(error,'stack');
    let value=typeof stack?.value==='string'?stack.value:'';
    // Node 22 uses a built-in lazy stack accessor. Never invoke a caller's
    // replacement stack/name/message getters or an unknown error prototype.
    if(!value&&nativeStackGetter&&stack?.get===nativeStackGetter&&nativeErrorPrototypes.has(Object.getPrototypeOf(error))&&
      ['name','message'].every(key=>!Object.getOwnPropertyDescriptor(error,key)?.get))value=nativeStackGetter.call(error);
    return publicExceptionMetadata(value,candidateRoot);
  } catch {return {class:null,code:null,frames:[]};}
}
export function validateDrillTerminal(record) {
  exact(record,['exitCode','signal','spawnErrorObserved','spawnErrorCode','elapsedMs','stdoutBytes','stderrBytes','termination']);
  assert(record.exitCode===null||Number.isSafeInteger(record.exitCode)&&record.exitCode>=-4095&&record.exitCode<=255);
  assert(record.signal===null||SIGNALS.has(record.signal));
  assert(record.signal===null||record.exitCode===null);
  assert(typeof record.spawnErrorObserved==='boolean'&&(record.spawnErrorCode===null||EXCEPTION_CODES.has(record.spawnErrorCode)));
  assert(record.spawnErrorObserved||record.spawnErrorCode===null);
  for(const key of ['elapsedMs','stdoutBytes','stderrBytes'])assert(Number.isSafeInteger(record[key])&&record[key]>=0);
  assert(Number.isSafeInteger(record.stdoutBytes+record.stderrBytes));
  assert(['none','timeout','output-limit'].includes(record.termination));
  return record;
}
export function assertDrillCompleted(record) {
  validateDrillTerminal(record);
  assert(record.exitCode===0&&record.signal===null&&!record.spawnErrorObserved&&record.termination==='none'&&
    record.stdoutBytes+record.stderrBytes<=DRILL_OUTPUT_LIMIT,'actual drill did not complete; no proof may be retained');
}
export function makeDrillFailure(record,stderr,candidateRoot) {
  validateDrillTerminal(record);
  assert.throws(()=>assertDrillCompleted(record),'a successful child cannot be classified as failed');
  const error=new Error('actual drill did not complete; no proof may be retained');
  const exception=publicExceptionMetadata(stderr,candidateRoot);
  exception.frames.forEach(Object.freeze);Object.freeze(exception.frames);Object.freeze(exception);
  drillFailures.set(error,Object.freeze({childClosed:true,...record,exception}));
  return error;
}
export function publicFailureReport(error,stage,candidateRoot) {
  assert(STAGES.includes(stage));
  const drill=drillFailures.get(error);
  return {passed:false,stage,reason:'post-assembly test evidence refused; private failure details omitted',
    ...(drill?{drill}:{exception:exceptionFromError(error,candidateRoot)}),
    releasePublished:false,privateDirectoryUploads:false,productionDeploymentClaimed:false,fundingAuthorized:false};
}
async function boundedDrill(root, args) {
  const log=join(root,'drill.stdout.log'),err=join(root,'drill.stderr.log');
  const descriptors=[log,err].map(path=>openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600));
  const started=process.hrtime.bigint();
  const child=spawn(process.execPath,args,{env:{...hostEnvironment(),PRESIGNED_ACCEPTANCE_PROTOCOL:PROTOCOL,PRESIGNED_BUILD_PROTOCOL:PROTOCOL},
    detached:true,stdio:['ignore','pipe','pipe']});
  let stdoutBytes=0,stderrBytes=0,termination='none',killTimer,diagnosticBytes=0;const chunks=[],diagnosticChunks=[];
  const stop=reason=>{if(termination==='none')termination=reason;try{process.kill(-child.pid,'SIGTERM');}catch{}
    if(!killTimer)killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},10000);};
  const timer=setTimeout(()=>stop('timeout'),45*60*1000);
  [child.stdout,child.stderr].forEach((stream,index)=>stream.on('data',chunk=>{
    if(index===0)stdoutBytes+=chunk.length;else stderrBytes+=chunk.length;
    if(stdoutBytes+stderrBytes>DRILL_OUTPUT_LIMIT){stop('output-limit');return;}
    writeFileSync(descriptors[index],chunk);
    if(index===0)chunks.push(chunk);
    else if(diagnosticBytes<DIAGNOSTIC_LIMIT){const retained=chunk.subarray(0,DIAGNOSTIC_LIMIT-diagnosticBytes);diagnosticBytes+=retained.length;diagnosticChunks.push(retained);}
  }));
  try {
    let spawnErrorObserved=false,spawnErrorCode=null;
    const terminal=await new Promise(done=>{
      child.once('error',error=>{spawnErrorObserved=true;const code=Object.getOwnPropertyDescriptor(error,'code')?.value;
        spawnErrorCode=EXCEPTION_CODES.has(code)?code:null;});
      child.once('close',(exitCode,signal)=>done({exitCode,signal}));
    });
    const record={...terminal,spawnErrorObserved,spawnErrorCode,elapsedMs:Number((process.hrtime.bigint()-started)/1000000n),
      stdoutBytes,stderrBytes,termination};
    try {assertDrillCompleted(record);}catch {throw makeDrillFailure(record,Buffer.concat(diagnosticChunks).toString(),process.cwd());}
    return Buffer.concat(chunks).toString();
  } finally {clearTimeout(timer);clearTimeout(killTimer);for(const fd of descriptors){fsyncSync(fd);closeSync(fd);}}
}
async function main() {
  process.umask(0o077);assert(process.argv.length===3);const operation=process.argv[2];
  assert(['check-pins','download','run','upload'].includes(operation));validatePins();
  if(operation==='check-pins') {
    if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`candidate=${PINS.candidateCommit}\n`);
    console.log(JSON.stringify({pinsComplete:true,candidate:PINS.candidateCommit,sourceDigest:PINS.sourceDigest,executionStarted:false}));return;
  }
  const ctx=context(),root=ctx.root;
  if(operation==='download') {
    progress('download');
    checkedDraft();mkdirSync(root,{mode:0o700});mkdirSync(join(root,'downloads'),{mode:0o700});
    writeExclusive(join(root,'pins.json'),Buffer.from(`${JSON.stringify(PINS)}\n`));
    const draft=checkedDraft();
    for(const item of PINS.inputs){const matches=draft.assets.filter(asset=>asset.name===item.name);assert(matches.length===1&&matches[0].size===item.bytes);
      await downloadAsset(matches[0],item,join(root,'downloads'));}
    await verifyInputFiles(root);checkedDraft();console.log(JSON.stringify({downloadedPinnedPublicInputs:true,files:4,executionStarted:false}));return;
  }
  ownedDirectory(root);await verifyInputFiles(root);
  if(operation==='run') {
    assert(!process.env.GH_TOKEN&&!process.env.GITHUB_TOKEN&&!process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY);
    progress('input-review');
    privateCommand('python3',[join(TOOLING,'presigned-deployment-public-evidence.py'),'prepare',root],hostEnvironment(),15*60*1000);
    progress('candidate-verification');
    const load=path=>import(pathToFileURL(resolve(path)).href);
    const {presignedSourceDigest}=await load('scripts/presigned-build-identity.mjs');assert(presignedSourceDigest()===PINS.sourceDigest);
    const {validatePresignedAcceptanceReceipt}=await load('src/presigned/release.ts');
    const receipt=validatePresignedAcceptanceReceipt(JSON.parse(readOwned(join(root,'downloads',INPUT_NAMES[3]))));
    assert(receipt.version===3&&receipt.protocol===PROTOCOL&&receipt.receiptDigest===PINS.acceptanceReceiptDigest&&
      receipt.sourceDigest===PINS.sourceDigest&&receipt.testedImageManifestDigest===PINS.imageManifestDigest&&receipt.offlineUtilityDigest===PINS.offlineUtilityDigest);
    const {validateRetainedImageEvidence}=await load('scripts/lib/presigned-image-evidence.ts');
    const {verifyOciDirectory,assertOciRuntimeImage}=await load('scripts/lib/presigned-oci.ts');
    const imageDirectory=join(root,'image');const evidence=await validateRetainedImageEvidence(imageDirectory,PINS.sourceDigest,'signet',PROTOCOL);
    assert(evidence.receiptDigest===PINS.imageReceiptDigest);const oci=await verifyOciDirectory(join(imageDirectory,'oci'));
    assert(oci.manifestDigest===PINS.imageManifestDigest&&oci.configDigest===PINS.imageConfigDigest&&oci.architecture==='amd64'&&oci.network==='signet');
    assert(JSON.parse(privateCommand('podman',['--remote=false','info','--format','json'])).host?.security?.rootless===true);
    progress('load-retained-image');
    privateCommand('podman',['--remote=false','load','--input',join(imageDirectory,'oci')],hostEnvironment(),10*60*1000);
    const loaded=JSON.parse(privateCommand('podman',['--remote=false','image','inspect',PINS.imageConfigDigest]));assert(loaded.length===1);assertOciRuntimeImage(oci,loaded[0]);
    const scratch=join(root,'scratch');mkdirSync(scratch,{mode:0o700});
    progress('actual-isolated-drill');
    const stdout=await boundedDrill(root,['--import','tsx','scripts/presigned-deployment-image-acceptance.mts',
      '--execute-disposable-loopback','--image-evidence',imageDirectory,'--acceptance-receipt',join(root,'downloads',INPUT_NAMES[3]),'--scratch-root',scratch]);
    const summary=JSON.parse(stdout.trim());assert(summary.passed===true&&typeof summary.evidenceDirectory==='string');
    assert(dirname(summary.evidenceDirectory)===scratch&&/^presigned-deployment-drill\.[A-Za-z0-9]{6}$/u.test(summary.evidenceDirectory.split('/').at(-1)));
    ownedDirectory(summary.evidenceDirectory);
    const proofBytes=readOwned(join(summary.evidenceDirectory,'deployment-acceptance.json'));const proof=JSON.parse(proofBytes);
    const {passed:_passed,evidenceDirectory:_directory,...summarizedProof}=summary;
    assert(canonical(summarizedProof)===canonical(proof));progress('proof-review');
    validatePublicProof(proof,PINS);
    const {validateDeploymentExecutionEvidence}=await load('scripts/lib/presigned-deployment-evidence.ts');
    const expected=Object.fromEntries(['sourceDigest','imageManifestDigest','imageConfigDigest','offlineUtilityDigest','acceptanceReceiptDigest'].map(key=>[key,PINS[key]]));
    validateDeploymentExecutionEvidence(proof,expected);assert(presignedSourceDigest()===PINS.sourceDigest);await verifyInputFiles(root);
    mkdirSync(join(root,'outputs'),{mode:0o700});writeExclusive(join(root,'outputs',OUTPUT_NAMES[0]),proofBytes);
    const transport={version:1,protocol:PROTOCOL,kind:'presigned-v3-public-deployment-test-retention',createdAt:new Date().toISOString(),
      candidateCommit:PINS.candidateCommit,sourceDigest:PINS.sourceDigest,toolingCommit:ctx.toolingCommit,workflowRunId:ctx.workflowRunId,
      inputs:PINS.inputs,proof:{name:OUTPUT_NAMES[0],sha256:sha(proofBytes),bytes:proofBytes.length,receiptDigest:proof.receiptDigest},
      ...expected,runnerSha256:ctx.runnerSha256,boundaryHelperSha256:ctx.boundaryHelperSha256,imageScannerSha256:PINS.imageScannerSha256,
      actualDrillCompleted:true,cleanServiceShutdownVerified:true,scope:'isolated-regtest-same-image-rollback',
      privateDirectoryUploads:false,productionDeploymentClaimed:false,fundingAuthorized:false};
    validateTransport(transport,PINS,ctx);writeExclusive(join(root,'outputs',OUTPUT_NAMES[1]),Buffer.from(`${JSON.stringify(transport,null,2)}\n`));
    privateCommand('python3',[join(TOOLING,'presigned-deployment-public-evidence.py'),'inspect-outputs',root]);
    console.log(JSON.stringify({passed:true,actualDrillCompleted:true,receiptDigest:proof.receiptDigest,filesRetained:2,
      privateDirectoryUploads:false,productionDeploymentClaimed:false,fundingAuthorized:false}));return;
  }
  // Upload imports no candidate modules and never passes GH_TOKEN to a candidate
  // process or the privacy scanner. Only these two metadata files are eligible.
  progress('proof-review');
  privateCommand('python3',[join(TOOLING,'presigned-deployment-public-evidence.py'),'inspect-outputs',root]);
  const proof=validatePublicProof(JSON.parse(readOwned(join(root,'outputs',OUTPUT_NAMES[0]))),PINS);
  const transport=validateTransport(JSON.parse(readOwned(join(root,'outputs',OUTPUT_NAMES[1]))),PINS,ctx);
  assert(transport.proof.receiptDigest===proof.receiptDigest);
  assert.deepEqual(await hashOwned(join(root,'outputs',OUTPUT_NAMES[0]),65536),{sha256:transport.proof.sha256,bytes:transport.proof.bytes});
  const draft=checkedDraft();assert(!draft.assets.some(asset=>OUTPUT_NAMES.includes(asset.name)),'never overwrite retained proof');
  progress('draft-upload');
  github(['release','upload',PINS.draftTag,'--repo',REPOSITORY,...OUTPUT_NAMES.map(name=>join(root,'outputs',name))]);
  checkedDraft();console.log(JSON.stringify({uploadedToExistingDraft:true,files:2,releasePublished:false,privateDirectoryUploads:false,
    productionDeploymentClaimed:false,fundingAuthorized:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {await main();} catch(error) {
    console.error(JSON.stringify(publicFailureReport(error,phase,process.cwd())));process.exitCode=1;
  }
}
