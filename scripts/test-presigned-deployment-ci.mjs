/** Pure boundaries plus a synthetic Python subprocess; no Podman, GitHub or custody operations. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath,pathToFileURL } from 'node:url';
import {lstatSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import { DRILL_FIXTURE, FIXTURE_IMPORT_RELOCATIONS, prepareConfiguredFixture, reconstructOriginalFixture, validateDrillFixture, validateFixtureBytes, verifyPreparedFixture } from './presigned-deployment-fixture.mjs';
import { CHILD_FRAME_BOUNDS, CHILD_FRAME_BOUNDS_FILE, validateChildBoundsBytes, validateChildException } from './presigned-deployment-child-exception.mjs';
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
  stdoutBytes:0,stderrBytes:117,classifications:['uid-map-denied','operation-not-permitted'],realBinarySha256,
  exception:{class:null,code:null,frames:[]}};

test('genuine Podman failure diagnostics remain fixed enums and actual terminals, never a success authorization',()=>{
  const summary=publicPodmanDiagnostics([{...podmanRecord,operation:'info',exitCode:0,classifications:[]},podmanRecord],realBinarySha256);
  assert.deepEqual(summary,{recordSetValid:true,capturedCommands:2,failedCommands:1,
    firstFailures:[{operation:'image-probe',nativeClosed:true,exitCode:125,signal:null,elapsedMs:110,stdoutBytes:0,
      stderrBytes:117,classifications:['uid-map-denied','operation-not-permitted'],exception:{class:null,code:null,frames:[]}}],failuresTruncated:false});
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
  assert.deepEqual(JSON.parse(result.stdout),{passed:true,kind:'pure-podman-diagnostic-boundaries',checks:143,nativeCommandsExecuted:0});
});

test('configured fixture reverses exactly to the pinned original with one setting and twelve literal import relocations',()=>{
  const original=readFileSync(resolve('scripts/presigned-deployment-image-acceptance.mts'));
  const configured=readFileSync(fileURLToPath(new URL('./presigned-deployment-configured-fixture.mts',import.meta.url)));
  validateFixtureBytes(original,configured);assert.equal(FIXTURE_IMPORT_RELOCATIONS.length,12);
  assert.equal(reconstructOriginalFixture(configured.toString()),original.toString());
  for(const mutated of [configured.toString().replace("VAULT_CONFIRMATIONS_REQUIRED:'1'","VAULT_CONFIRMATIONS_REQUIRED:'2'"),
    configured.toString().replace("'./candidate/web/lib/migrations.js'","'./foreign/web/lib/migrations.js'"),
    configured.toString().replace('assert(completedEvidence','assert(true||completedEvidence'),configured.toString()+'\n']){
    assert.throws(()=>validateFixtureBytes(original,Buffer.from(mutated)));
  }
  assert.equal(configured.toString().split("VAULT_CONFIRMATIONS_REQUIRED:'1'").length,2);
  assert(configured.toString().includes("import postgres from 'postgres'"));
});

test('mandatory configured-fixture disclosure refuses substitutions, false stock-pass claims and arbitrary fields/getters',()=>{
  assert.deepEqual(validateDrillFixture({...DRILL_FIXTURE}),DRILL_FIXTURE);
  for(const key of Object.keys(DRILL_FIXTURE)){
    const changed={...DRILL_FIXTURE,[key]:typeof DRILL_FIXTURE[key]==='boolean'?!DRILL_FIXTURE[key]:secret};
    assert.throws(()=>validateDrillFixture(changed));
    const missing={...DRILL_FIXTURE};delete missing[key];assert.throws(()=>validateDrillFixture(missing));
  }
  for(const value of [undefined,null,{...DRILL_FIXTURE,privatePath:secret},Object.create(DRILL_FIXTURE)])assert.throws(()=>validateDrillFixture(value));
  let calls=0;const hostile={...DRILL_FIXTURE};Object.defineProperty(hostile,'profile',{enumerable:true,get(){calls++;return secret;}});
  assert.throws(()=>validateDrillFixture(hostile));assert.equal(calls,0);
});

test('unchanged candidate config refuses the original missing key and accepts the exact operator setting in an isolated VM',()=>{
  const source=readFileSync(resolve('web/lib/server/config.ts'),'utf8');
  const extract=signature=>{const begin=source.indexOf(signature);assert(begin>=0&&source.indexOf(signature,begin+1)===-1);
    const end=source.indexOf('\n}',begin);assert(end>begin);return source.slice(begin,end+2);};
  const required=extract('function required(name: string): string {').replace('function required(name: string): string {','function required(name) {');
  const chain=extract('export function chainConfirmationsRequired(): number {').replace('export function chainConfirmationsRequired(): number {','function chainConfirmationsRequired() {');
  const execute=env=>runInNewContext(required+'\n'+chain+'\nchainConfirmationsRequired();',{process:{env}},{timeout:1000});
  assert.throws(()=>execute({}));assert.throws(()=>execute({CHAIN_CONFIRMATIONS_REQUIRED:'1'}));
  assert.equal(execute({VAULT_CONFIRMATIONS_REQUIRED:'1'}),1);
  for(const value of ['0','145','-1','1.0',' 1','1e1'])assert.throws(()=>execute({VAULT_CONFIRMATIONS_REQUIRED:value}));
  const original=readFileSync(resolve('scripts/presigned-deployment-image-acceptance.mts'),'utf8');
  assert(!original.includes('VAULT_CONFIRMATIONS_REQUIRED'));assert(original.includes('const environment={'));
});

test('private fixture import aliases bind exact synthetic candidate targets, refuse replay and aliases, and never import the fixture',async()=>{
  const previous=process.cwd(),original=readFileSync(resolve('scripts/presigned-deployment-image-acceptance.mts'));
  const root=mkdtempSync(join(tmpdir(),'presigned-configured-fixture-test.')),candidate=join(root,'synthetic-candidate'),fixtureRoot=join(root,'fixture-root');
  try{
    const tooling=join(root,'synthetic-tooling');
    for(const dir of [candidate,join(candidate,'scripts'),join(candidate,'node_modules'),fixtureRoot,tooling])mkdirSync(dir,{mode:0o700});
    writeFileSync(join(candidate,'scripts/presigned-deployment-image-acceptance.mts'),original,{mode:0o600,flag:'wx'});
    for(const name of ['presigned-deployment-fixture.mjs','presigned-deployment-configured-fixture.mts'])
      writeFileSync(join(tooling,name),readFileSync(fileURLToPath(new URL('./'+name,import.meta.url))),{mode:0o600,flag:'wx'});
    const api=await import(pathToFileURL(join(tooling,'presigned-deployment-fixture.mjs')).href);
    process.chdir(candidate);
    const binding=api.prepareConfiguredFixture(fixtureRoot,candidate);api.verifyPreparedFixture(binding,candidate);
    assert.equal(lstatSync(binding.entry).mode&0o777,0o600);assert.equal(lstatSync(binding.directory).mode&0o777,0o700);
    assert.throws(()=>api.prepareConfiguredFixture(fixtureRoot,candidate));
    const alias=join(binding.directory,'candidate'),other=join(root,'other');mkdirSync(other,{mode:0o700});
    unlinkSync(alias);symlinkSync(other,alias,'dir');assert.throws(()=>api.verifyPreparedFixture(binding,candidate));
    unlinkSync(alias);symlinkSync(candidate,alias,'dir');api.verifyPreparedFixture(binding,candidate);
    const modules=join(binding.directory,'node_modules');unlinkSync(modules);symlinkSync(candidate+'/./node_modules',modules,'dir');
    assert.throws(()=>api.verifyPreparedFixture(binding,candidate));unlinkSync(modules);symlinkSync(candidate+'/node_modules',modules,'dir');
    api.verifyPreparedFixture(binding,candidate);
    unlinkSync(binding.entry);symlinkSync(resolve('scripts/presigned-deployment-image-acceptance.mts'),binding.entry);
    assert.throws(()=>api.verifyPreparedFixture(binding,candidate));
  }finally{process.chdir(previous);assert(root.startsWith(join(tmpdir(),'presigned-configured-fixture-test.'))&&lstatSync(root).uid===process.getuid());rmSync(root,{recursive:true});}
});

test('child frame caps are the exact UTF16 line lengths of the pinned candidate, not arbitrary numeric identifiers',()=>{
  validateChildBoundsBytes(readFileSync(CHILD_FRAME_BOUNDS_FILE));
  for(const [file,caps]of Object.entries(CHILD_FRAME_BOUNDS)){
    const lines=readFileSync(resolve(file),'utf8').split('\n');if(lines.at(-1)==='')lines.pop();
    assert.deepEqual(caps,lines.map(line=>Math.min(line.length+1,1024)));
  }
  assert.throws(()=>validateChildBoundsBytes(Buffer.from('{}')));
});

test('safe inner child exception reaches only a branded failed Podman summary with fixed known source frames',()=>{
  const exception={class:'Error',code:null,frames:[{file:'web/lib/server/config.ts',line:76},{file:'web/lib/server/config.ts',line:48},
    {file:'web/lib/server/vault-runtime-store.ts',line:648}]};
  const summary=publicPodmanDiagnostics([{...podmanRecord,operation:'run-watcher',exitCode:1,exception}],realBinarySha256);
  assert.deepEqual(summary.firstFailures[0].exception,exception);privateFree(summary);
  for(const changed of [{...exception,message:secret},{...exception,class:secret},{...exception,code:secret},
    {...exception,frames:[{file:secret,line:1}]},{...exception,frames:[{file:'/app/web/lib/server/config.ts',line:76}]},
    {...exception,frames:[{file:'web/lib/server/config.ts',line:CHILD_FRAME_BOUNDS['web/lib/server/config.ts'].length+1}]},{...exception,frames:[{file:'web/lib/server/config.ts',line:76,column:21}]},
    {...exception,frames:[exception.frames[0],exception.frames[0]]},{...exception,class:null}]){
    assert.throws(()=>publicPodmanDiagnostics([{...podmanRecord,exception:changed}],realBinarySha256));
  }
  let calls=0;const hostile={...exception};Object.defineProperty(hostile,'class',{enumerable:true,get(){calls++;return secret;}});
  assert.throws(()=>validateChildException(hostile));assert.equal(calls,0);
  const hostileFrames=[];Object.defineProperty(hostileFrames,'0',{enumerable:true,get(){calls++;return exception.frames[0];}});
  assert.throws(()=>validateChildException({...exception,frames:hostileFrames}));assert.equal(calls,0);
  const hostileFrame={...exception.frames[0]};Object.defineProperty(hostileFrame,'file',{enumerable:true,get(){calls++;return secret;}});
  assert.throws(()=>validateChildException({...exception,frames:[hostileFrame]}));assert.equal(calls,0);
});
