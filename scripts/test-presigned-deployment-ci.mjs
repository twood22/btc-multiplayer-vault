/** Pure boundaries plus a synthetic Python subprocess; no Podman, GitHub or custody operations. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertDrillCompleted, checkedDraft, INPUT_NAMES, makeDrillFailure, PINS,
  publicExceptionMetadata, publicFailureReport, publicPodmanDiagnostics, validateDrillTerminal, validatePins } from './presigned-deployment-ci.mjs';

const pins={
  ...PINS,candidateCommit:'1'.repeat(40),sourceDigest:'2'.repeat(64),
  draftTag:'presigned-v3-test-evidence-22222222-20260919',draftReleaseId:392238195,
  imageManifestDigest:`sha256:${'3'.repeat(64)}`,imageConfigDigest:`sha256:${'4'.repeat(64)}`,
  offlineUtilityDigest:'5'.repeat(64),acceptanceReceiptDigest:'6'.repeat(64),
  imageReceiptDigest:'7'.repeat(64),imageToolingCommit:'8'.repeat(40),
  imageWorkflowRunId:'9',imageScannerSha256:'a'.repeat(64),migrationCount:23,
  inputs:INPUT_NAMES.map(name=>({name,sha256:'b'.repeat(64),bytes:1})),
};
const draft={id:pins.draftReleaseId,tag_name:pins.draftTag,draft:true,prerelease:true,
  target_commitish:pins.candidateCommit,assets:[]};
const invoke=(body=draft,selected=pins)=>checkedDraft(selected,args=>{
  assert.deepEqual(args,['api',`repos/twood22/btc-multiplayer-vault/releases/${selected.draftReleaseId}`]);
  return JSON.stringify(body);
});

test('existing draft resolves through the exact numeric ID, with full identity readback',()=>{
  const result=invoke();
  assert.deepEqual(result,{tagName:pins.draftTag,isDraft:true,isPrerelease:true,
    targetCommitish:pins.candidateCommit,assets:[]});
});

test('invalid or unset release ID is refused before any GitHub read',()=>{
  for(const draftReleaseId of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'392238195',null]){
    assert.throws(()=>checkedDraft({...pins,draftReleaseId},()=>assert.fail('GitHub read with invalid release ID')));
  }
  assert.throws(()=>validatePins({...pins,acceptanceReceiptDigest:'UNSET_GENUINE_FINAL_ACCEPTANCE_RECEIPT'}));
});

test('ID, tag and immutable candidate substitutions are refused',()=>{
  for(const change of [{id:pins.draftReleaseId+1},{id:String(pins.draftReleaseId)},
    {tag_name:'another-tag'},{target_commitish:'c'.repeat(40)}]){
    assert.throws(()=>invoke({...draft,...change}));
  }
});

test('published or non-prerelease state and invalid asset inventory are refused',()=>{
  for(const change of [{draft:false},{draft:'true'},{prerelease:false},{prerelease:'true'},
    {assets:null},{assets:{}}]){
    assert.throws(()=>invoke({...draft,...change}));
  }
});

test('missing release, API failure and malformed response do not resolve a draft',()=>{
  assert.throws(()=>checkedDraft(pins,()=>{throw new Error('HTTP 404');}));
  assert.throws(()=>checkedDraft(pins,()=>'{invalid'));
  assert.throws(()=>invoke({}));
});

test('each read revalidates current draft state; prior valid metadata grants no reuse',()=>{
  invoke();
  assert.throws(()=>invoke({...draft,draft:false}));
});

const candidateRoot='/private/synthetic-candidate';
const emptyException={class:null,code:null,frames:[]};
const terminal={exitCode:1,signal:null,spawnErrorObserved:false,spawnErrorCode:null,
  elapsedMs:25050,stdoutBytes:37,stderrBytes:997,termination:'none'};
const secret='SYNTHETIC_SECRET_NEVER_PUBLIC';
const stack=`AssertionError [ERR_ASSERTION]: ${secret} postgresql://synthetic:password@private.invalid/database\n`+
  `    at native (${candidateRoot}/scripts/presigned-deployment-image-acceptance.mts:53:3)\n`+
  `    at <anonymous> (${candidateRoot}/scripts/presigned-deployment-image-acceptance.mts:94:3)\n`+
  '    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)\n'+
  `  code: '${secret}', sql: '${secret}', endpoint: 'https://private.invalid/'\n`;
const safeException={class:'AssertionError',code:'ERR_ASSERTION',frames:[
  {file:'scripts/presigned-deployment-image-acceptance.mts',line:53},
  {file:'scripts/presigned-deployment-image-acceptance.mts',line:94},
  {file:'node:internal/modules/esm/module_job',line:343},
]};
function privateFree(value) {
  const output=JSON.stringify(value);
  for(const rejected of [secret,candidateRoot,'password','private.invalid','postgresql://','https://',' sql','native (',':343:25'])assert(!output.includes(rejected));
}

test('exception projection retains only fixed class/code and public source file:line',()=>{
  const projected=publicExceptionMetadata(stack,candidateRoot);
  assert.deepEqual(projected,safeException);privateFree(projected);
  assert.deepEqual(publicExceptionMetadata(stack.replaceAll(candidateRoot,`file://${candidateRoot}`),candidateRoot),safeException);
});

test('arbitrary messages, properties and function names never reach diagnostic output',()=>{
  for(const injected of [`${secret}: SQL SELECT * FROM users`,`${secret}\"},\"passed\":true`,
    `GH_TOKEN=${secret}`,`DATABASE_URL=${secret}`,`+1-555-555-5555 ${secret}@example.invalid`,
    `${secret}\u001b[31m`,`${secret} http://private.invalid/?token=example`]){
    const projected=publicExceptionMetadata(stack.replace(`${secret} postgresql://synthetic:password@private.invalid/database`,injected),candidateRoot);
    assert.deepEqual(projected,safeException);privateFree(projected);
  }
  const named=stack.replace('at native (',`at ${secret} (`);
  assert.deepEqual(publicExceptionMetadata(named,candidateRoot),safeException);privateFree(publicExceptionMetadata(named,candidateRoot));
});

test('unknown class or code cannot become a public identifier',()=>{
  assert.deepEqual(publicExceptionMetadata(stack.replace('AssertionError',secret),candidateRoot),emptyException);
  const unknownCode=publicExceptionMetadata(stack.replace('ERR_ASSERTION',secret),candidateRoot);
  assert.deepEqual(unknownCode,{...safeException,code:null});privateFree(unknownCode);
  assert.deepEqual(publicExceptionMetadata(`Error [${'A'.repeat(65)}]: ${secret}\n`,candidateRoot),emptyException);
  assert.deepEqual(publicExceptionMetadata('ErrorCode: parser abuse\n',candidateRoot),emptyException);
});

test('private/outside paths, traversal, relative paths and invented Node modules are excluded',()=>{
  for(const path of ['/outside/private/scripts/presigned-deployment-image-acceptance.mts',
    `${candidateRoot}-suffix/scripts/presigned-deployment-image-acceptance.mts`,
    `${candidateRoot}/../synthetic-candidate/scripts/presigned-deployment-image-acceptance.mts`,
    `${candidateRoot}/scripts/../scripts/presigned-deployment-image-acceptance.mts`,
    `${candidateRoot}/scripts/%2e%2e/scripts/presigned-deployment-image-acceptance.mts`,
    `${candidateRoot}/scripts/private-file.mts`,'scripts/presigned-deployment-image-acceptance.mts',
    `https://private.invalid/${secret}`,`node:internal/${secret}`]){
    const projected=publicExceptionMetadata(`Error: ${secret}\n    at call (${path}:53:3)\n`,candidateRoot);
    assert.deepEqual(projected,{class:'Error',code:null,frames:[]});privateFree(projected);
  }
});

test('noncanonical frame numbers, delimiters, suffixes and control characters are excluded',()=>{
  const location=`${candidateRoot}/scripts/presigned-deployment-image-acceptance.mts`;
  for(const frame of [`    at call (${location}:0:3)`,`    at call (${location}:053:3)`,
    `    at call (${location}:53:0)`,`    at call (${location}:53:03)`,
    `    at call (${location}:185:3)`,`    at call (${location}:9999999:3)`,
    `    at call (${location}:53:3) ${secret}`,`    at call (${location}:53:3`,
    `    at ${location}:53:3)`,`\tat call (${location}:53:3)`,
    `    at call (${location}:53:3)\u001b[31m`,
    `    at call (${location}:53:3:4)`,`    at call ((${location}:53:3))`]){
    assert.deepEqual(publicExceptionMetadata(`Error: ${secret}\n${frame}\n`,candidateRoot),{class:'Error',code:null,frames:[]});
  }
});

test('multiline/parser abuse cannot resume a stack after message content',()=>{
  const frame=`    at call (${candidateRoot}/scripts/presigned-deployment-image-acceptance.mts:53:3)`;
  for(const intervening of [secret,'',`code: '${secret}'`,`{"passed":true,"token":"${secret}"}`,
    '    at invalid stack formatting',`    at ${'A'.repeat(2049)}`]){
    assert.deepEqual(publicExceptionMetadata(`Error: ${secret}\n${intervening}\n${frame}\n`,candidateRoot),{class:'Error',code:null,frames:[]});
  }
  for(const text of [stack+'Error: ambiguous second error\n',stack+'AssertionError: second\n',
    stack.replace('\n','\r\n'),stack+'\0',stack+'A'.repeat(65537)]){
    assert.deepEqual(publicExceptionMetadata(text,candidateRoot),emptyException);
  }
  for(const root of ['/',candidateRoot+'/../synthetic-candidate','relative',candidateRoot+'\0'])assert.deepEqual(publicExceptionMetadata(stack,root),emptyException);
});

test('diagnostic stack projection is finite, deduplicated and cannot reveal raw stack text',()=>{
  const repeated=`Error: ${secret}\n`+Array.from({length:20},(_,index)=>
    `    at call (${candidateRoot}/scripts/presigned-deployment-image-acceptance.mts:${index+1}:3)\n`).join('');
  const projected=publicExceptionMetadata(repeated,candidateRoot);
  assert.equal(projected.frames.length,4);privateFree(projected);
  const duplicate=`Error: ${secret}\n`+`    at call (${candidateRoot}/scripts/presigned-deployment-image-acceptance.mts:53:3)\n`.repeat(20);
  assert.equal(publicExceptionMetadata(duplicate,candidateRoot).frames.length,1);
});

test('public Node frame numbers are bounded by the exact reviewed runtime modules',()=>{
  for(const [file,max]of Object.entries({'node:internal/process/promises':498,'node:internal/errors':1925,
    'node:internal/assert/assertion_error':423,'node:internal/modules/esm/module_job':467,
    'node:internal/modules/esm/loader':1082,'node:internal/modules/run_main':188,
    'node:internal/child_process':1136,'node:events':1223,'node:fs':3383})){
    assert.deepEqual(publicExceptionMetadata(`Error: ${secret}\n    at call (${file}:${max}:1)\n`,candidateRoot),{class:'Error',code:null,frames:[{file,line:max}]});
    for(const line of [max+1,999999])assert.deepEqual(publicExceptionMetadata(`Error: ${secret}\n    at call (${file}:${line}:1)\n`,candidateRoot),{class:'Error',code:null,frames:[]});
  }
});

test('branded child failure publishes exact terminal/counts/elapsed and filtered initiating exception only',()=>{
  const error=makeDrillFailure(terminal,stack,candidateRoot);
  const report=publicFailureReport(error,'actual-isolated-drill',candidateRoot);
  assert.deepEqual(report,{passed:false,stage:'actual-isolated-drill',reason:'post-assembly test evidence refused; private failure details omitted',
    drill:{childClosed:true,...terminal,exception:safeException},releasePublished:false,privateDirectoryUploads:false,
    productionDeploymentClaimed:false,fundingAuthorized:false});privateFree(report);
  assert(Object.isFrozen(report.drill)&&Object.isFrozen(report.drill.exception)&&Object.isFrozen(report.drill.exception.frames));
  assert.throws(()=>{report.drill.exception.frames[0].file=secret;});
  terminal.elapsedMs=99999;
  assert.equal(publicFailureReport(error,'actual-isolated-drill',candidateRoot).drill.elapsedMs,25050);
  terminal.elapsedMs=25050;
});

test('timeout/signal, spawn error and output-limit exits remain failure even on exit zero',()=>{
  for(const change of [{exitCode:null,signal:'SIGKILL',termination:'timeout'},
    {exitCode:0,termination:'timeout'},{exitCode:0,termination:'output-limit'},
    {exitCode:-2,spawnErrorObserved:true,spawnErrorCode:'ENOENT'},
    {exitCode:0,spawnErrorObserved:true,spawnErrorCode:null},
    {exitCode:0,stdoutBytes:4*1024*1024+1},{exitCode:0,stderrBytes:4*1024*1024+1}]){
    const observed={...terminal,...change};assert.throws(()=>assertDrillCompleted(observed));
    const report=publicFailureReport(makeDrillFailure(observed,'{"passed":true}',candidateRoot),'actual-isolated-drill',candidateRoot);
    assert.equal(report.passed,false);assert.equal(report.drill.exitCode,observed.exitCode);
    assert.deepEqual(report.drill.exception,emptyException);privateFree(report);
  }
});

test('malformed terminal/counts/termination and extra private fields are refused',()=>{
  for(const change of [{exitCode:'1'},{exitCode:256},{exitCode:-4096},{exitCode:NaN},
    {signal:secret},{signal:'SIGKILL',exitCode:1},{spawnErrorObserved:'true'},
    {spawnErrorCode:'ENOENT'},{spawnErrorObserved:true,spawnErrorCode:secret},
    {elapsedMs:-1},{elapsedMs:1.5},{stdoutBytes:Number.MAX_SAFE_INTEGER,stderrBytes:1},
    {stderrBytes:Infinity},{stdoutBytes:'12'},{termination:secret},{privateKey:secret}]){
    assert.throws(()=>validateDrillTerminal({...terminal,...change}));
    assert.throws(()=>makeDrillFailure({...terminal,...change},stack,candidateRoot));
  }
});

test('only a true zero terminal within unchanged byte bound permits proof parsing',()=>{
  for(const bytes of [0,4*1024*1024])assert.doesNotThrow(()=>assertDrillCompleted({...terminal,exitCode:0,stdoutBytes:bytes,stderrBytes:0}));
  assert.throws(()=>makeDrillFailure({...terminal,exitCode:0},stack,candidateRoot));
  const forged=new Error(secret);forged.stack=`Error: ${secret}\n`;
  forged.drill={...terminal,childClosed:true,exception:{class:secret},passed:true};
  const report=publicFailureReport(forged,'actual-isolated-drill',candidateRoot);
  assert.equal(report.passed,false);assert(!('drill' in report));privateFree(report);
  assert.throws(()=>publicFailureReport(forged,secret,candidateRoot));
});

test('generic parent exceptions expose no message, properties or getter values',()=>{
  const parent=new TypeError(secret);parent.stack=stack.replace('AssertionError [ERR_ASSERTION]','TypeError');
  parent.message=`DATABASE_URL=${secret}`;parent.code=secret;parent.stderr=stack;parent.stdout=secret;
  const report=publicFailureReport(parent,'candidate-verification',candidateRoot);
  assert.deepEqual(report.exception,{...safeException,class:'TypeError',code:null});privateFree(report);
  let getters=0;
  const hostile={};for(const key of ['stack','name','message','code','drill'])Object.defineProperty(hostile,key,{get(){getters++;throw new Error(secret);}});
  assert.deepEqual(publicFailureReport(hostile,'pins',candidateRoot).exception,emptyException);assert.equal(getters,0);
  const native=new Error(secret);assert.deepEqual(publicFailureReport(native,'pins',candidateRoot).exception,{class:'Error',code:null,frames:[]});
  const nativeHostile=new Error(secret);Object.defineProperty(nativeHostile,'message',{get(){getters++;throw new Error(secret);}});
  assert.deepEqual(publicFailureReport(nativeHostile,'pins',candidateRoot).exception,emptyException);assert.equal(getters,0);
  for(const error of [null,undefined,secret,42]){const projection=publicFailureReport(error,'pins',candidateRoot);assert.deepEqual(projection.exception,emptyException);privateFree(projection);}
});

const realBinarySha256='a'.repeat(64);
const podmanRecord={version:1,operation:'image-probe',nativeClosed:true,exitCode:125,signal:null,elapsedMs:110,
  stdoutBytes:0,stderrBytes:117,classifications:['uid-map-denied','operation-not-permitted'],realBinarySha256};

test('genuine Podman failure diagnostics remain fixed enums and actual terminals, never a success authorization',()=>{
  const summary=publicPodmanDiagnostics([{...podmanRecord,operation:'info',exitCode:0,classifications:[]},podmanRecord],realBinarySha256);
  assert.deepEqual(summary,{recordSetValid:true,capturedCommands:2,failedCommands:1,
    firstFailures:[{operation:'image-probe',nativeClosed:true,exitCode:125,signal:null,elapsedMs:110,stdoutBytes:0,
      stderrBytes:117,classifications:['uid-map-denied','operation-not-permitted']}],failuresTruncated:false});
  const report=publicFailureReport(makeDrillFailure(terminal,stack,candidateRoot,summary),'actual-isolated-drill',candidateRoot);
  assert.equal(report.passed,false);assert.equal(report.drill.podman.failedCommands,1);privateFree(report);
  assert(Object.isFrozen(summary)&&Object.isFrozen(summary.firstFailures)&&Object.isFrozen(summary.firstFailures[0].classifications));
  assert.throws(()=>{summary.firstFailures[0].classifications[0]=secret;});
  const empty=publicPodmanDiagnostics([],realBinarySha256);
  assert.equal(publicFailureReport(makeDrillFailure(terminal,stack,candidateRoot,empty),'actual-isolated-drill',candidateRoot).passed,false);
  assert.throws(()=>makeDrillFailure({...terminal,exitCode:0},stack,candidateRoot,summary));
});

test('private Podman records refuse injected identifiers, fields, classifications and invented or absent native terminals',()=>{
  for(const change of [{operation:secret},{operation:'run-with-privileges'},{nativeClosed:false},{nativeClosed:'true'},
    {exitCode:null,signal:null},{exitCode:0,signal:'SIGKILL'},{exitCode:256},{exitCode:'0'},{signal:secret},
    {stdoutBytes:-1},{stderrBytes:1.5},{elapsedMs:Infinity},{classifications:[secret]},{classifications:['uid-map-denied','uid-map-denied']},
    {classifications:'permission-denied'},{argv:[secret]},{stderr:secret},{env:{TOKEN:secret}},{realBinarySha256:'b'.repeat(64)}]){
    assert.throws(()=>publicPodmanDiagnostics([{...podmanRecord,...change}],realBinarySha256));
  }
  assert.throws(()=>publicPodmanDiagnostics(Array(513).fill(podmanRecord),realBinarySha256));
  assert.throws(()=>makeDrillFailure(terminal,stack,candidateRoot,{recordSetValid:true,firstFailures:[{message:secret}]}));
  const many=publicPodmanDiagnostics(Array(8).fill(podmanRecord),realBinarySha256);
  assert.equal(many.firstFailures.length,4);assert.equal(many.failedCommands,8);assert.equal(many.failuresTruncated,true);privateFree(many);
  const signaled=publicPodmanDiagnostics([{...podmanRecord,exitCode:null,signal:'SIGKILL'}],realBinarySha256);
  assert.equal(signaled.firstFailures[0].signal,'SIGKILL');assert.equal(signaled.firstFailures[0].exitCode,null);
});

test('Python operation/cause/terminal/signal boundaries run synthetically without Podman or native children',()=>{
  const result=spawnSync('/usr/bin/python3',['-B',fileURLToPath(new URL('./presigned-deployment-podman-diagnostics.py',import.meta.url)),'--self-test-pure'],
    {env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},encoding:'utf8',timeout:10000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
  assert(result.status===0&&!result.error,'pure Python diagnostic boundary tests failed; private output omitted');
  assert(result.stderr.length===0);
  assert.deepEqual(JSON.parse(result.stdout),{passed:true,kind:'pure-podman-diagnostic-boundaries',checks:120,nativeCommandsExecuted:0});
});
