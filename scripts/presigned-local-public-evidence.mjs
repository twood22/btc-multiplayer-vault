/** Strict LOCAL publication review. It never rewrites a transcript or grants release. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OUTPUT_FIELDS } from './presigned-local-output-profile.mjs';

export const PINS = Object.freeze({ candidate: 'd907d42b49acb440394d703fca1e31d4e575f577',
  source: '61d3b2c5e0d37b49775b87c7554b644c4225a7afbaee358e2ad2f1b257780353',
  tag: 'presigned-v3-test-evidence-61d3b2c5-20260914', draftId: 388165893,
  protocol: 'presigned-graph-v3', repository: 'twood22/btc-multiplayer-vault' });
export const ASSETS = ['presigned-v3-local-test-evidence.tar.gz', 'presigned-v3-local-retention.json', 'presigned-v3-local-content-review.json'];
export const MAX = 64 * 1024 * 1024;
const HERE = dirname(fileURLToPath(import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
export const digest = value => { assert(typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)); return value; };
export function keys(value, expected) { assert(value && typeof value === 'object' && !Array.isArray(value)); assert.deepEqual(Object.keys(value).sort(), [...expected].sort()); }
export function ownedDirectory(path) {
  assert(resolve(path) === path && realpathSync(path) === path);
  const s = lstatSync(path); assert(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && !(s.mode & 0o077));
}
export function ownedBytes(path, maximum = 16 * 1024 * 1024, empty = true) {
  ownedDirectory(dirname(path)); const s = lstatSync(path);
  assert(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.getuid() && !(s.mode & 0o077) && s.size <= maximum && (empty || s.size > 0));
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const opened=fstatSync(fd);assert(opened.isFile()&&opened.nlink===1&&opened.uid===process.getuid()&&opened.ino===s.ino&&opened.dev===s.dev&&opened.size===s.size);
    const b=readFileSync(fd),after=fstatSync(fd),named=lstatSync(path);
    assert(b.length===s.size&&after.size===s.size&&after.mtimeMs===s.mtimeMs&&after.ctimeMs===s.ctimeMs&&named.ino===s.ino&&named.dev===s.dev&&!named.isSymbolicLink());
    return b;
  } finally {closeSync(fd);}
}
const phases=['candidate-identity','archive-import','run-schema','stderr-empty','stdout-schema','database-schema','browser-schema','offline-hash','candidate-semantic','post-review-source'];
const databaseLabels=['ceremony','runtime','chain-broadcast','fee','restore','cashout','protocol-queue'];
let failureContext={phase:'candidate-identity',command:null,label:null,plan:[]};
export function publicReviewFailure(phase,command,label,plan) {
  return {passed:false,localArchiveAccepted:false,uploaded:false,reason:'local content review refused; private values omitted',
    phase:phases.includes(phase)?phase:'candidate-identity',
    command:typeof command==='string'&&plan.some(item=>item.id===command)?command:null,
    databaseLabel:databaseLabels.includes(label)?label:null};
}
export function reviewStderr(bytes) {assert.equal(bytes.length,0,'unreviewed nonempty stderr');}
export function timestamp(value) { assert(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && new Date(value).toISOString() === value); }
export function strictJson(text, ts) {
  const value = JSON.parse(text); // Also rejects comments, trailing commas and non-JSON syntax.
  const ast = ts.parseJsonText('local-public.json', text); assert.equal(ast.parseDiagnostics.length, 0);
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set(); for (const property of node.properties) {
        assert(ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name));
        assert(!seen.has(property.name.text), 'duplicate JSON key'); seen.add(property.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); return value;
}
export async function candidateContext() {
  assert(!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN, 'publication token must not reach review');
  const root = process.cwd(); assert.equal(realpathSync(root), root);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim(), PINS.candidate);
  const identity = await import(pathToFileURL(join(root, 'scripts/presigned-build-identity.mjs')).href);
  assert.equal(identity.presignedSourceDigest(), PINS.source);
  assert.equal(process.versions.node, readFileSync(join(root, '.node-version'), 'utf8').trim());
  const acceptance = await import(pathToFileURL(join(root, 'scripts/lib/presigned-acceptance-run.ts')).href);
  const ts = (await import(pathToFileURL(join(root, 'node_modules/typescript/lib/typescript.js')).href)).default;
  const plan = acceptance.acceptancePlan('local', PINS.protocol); assert.equal(plan.length, 75);
  return { root, identity, acceptance, ts, plan };
}
export function expectedNames(plan) {
  const names = ['run.json', 'offline-recovery.html'];
  for (const command of plan) {
    names.push(`${command.id}.stdout.log`, `${command.id}.stderr.log`);
    if (command.category === 'database') for (const label of ['ceremony','runtime','chain-broadcast','fee','restore',
      ...(command.id === 'database-v3-all' ? ['cashout','protocol-queue'] : [])]) names.push(`${command.id}-${label}.log`);
    if (command.category === 'browser') names.push(`${command.id}-browser.json`);
  }
  assert.equal(names.length, 165); assert.equal(new Set(names).size, 165); return names.sort();
}
const actors = ['alice','bob','carol'];
const orders = actors.flatMap(a => actors.filter(b => b !== a).map(b => `${a}/${b}`));
const rounds = ['alicebobcarol','alicebob','alicecarol','bobcarol'];
const families = ['funding','solo','cooperative','recovery','final-sweep','cpfp-preserved-payout'];
const common = ['signet','mainnet','regtest','presigned-graph-v2','presigned-graph-v3',
  'last-survivor-net-v1','missing-carol-refund-to-native-wallet-v1', ...actors,...orders,...rounds,
  'p2wpkh','p2tr','p2tr-all','p2tr-default', ...families];
const substitutions = { network: ['signet','mainnet'], protocol: ['presigned-graph-v2','presigned-graph-v3'],
  boundaryProtocol: ['presigned-graph-v2','presigned-graph-v3'], first: actors, second: actors, omitted: actors,
  family: families, kind: families, walletKind: ['p2wpkh','p2tr'], 'source ?? \'funding\'': ['funding',...actors,...orders],
  'refund.roundId': rounds, 'refund.round.id': rounds, 'round.id': rounds, id:actors, refund:['0','329','330'],
  caseIndex:['0','1','2','3'], 'String(code)':['-5','-28','undefined'], expected:['absent','unknown'],
  'BITCOIN_NETWORK_CONFIG.addressLabel':['mainnet','default global Signet'],
  fault:['none','import','encrypt','identity-first','identity-second','participant'],
  label:['network','pruned','initial-sync','index-missing','index-unsynced','genesis','spent','coinbase','value','fractional-satoshi',
    'script','coin-tip','raw-id','raw-bytes','unconfirmed-parent','orphan','anchor-depth','active-height',
    'wrongGenesis','inactiveAnchor','movingTip','wrongTipIdentity','unconfirmedParent','malformedRaw','backendError','confirmedSpend',
    'unknownSpend','unknownSpendConfirmation','missingPendingTxid','malformedPendingTxid'] };

/** Strings come from pinned PUBLIC producer source, not evidence-derived values.
 * Unknown interpolation expressions are ignored, never widened to wildcards. */
export function producerLexicon(paths, context) {
  const strings = new Set(common); const templates = [];
  for (const path of paths) {
    assert(/^(?:src|web|scripts)\/[a-zA-Z0-9._/-]+\.[cm]?[jt]s$/u.test(path) && !path.includes('..'));
    const text = readFileSync(join(context.root, path), 'utf8');
    const ast = context.ts.createSourceFile(path, text, context.ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (context.ts.isStringLiteral(node) || context.ts.isNoSubstitutionTemplateLiteral(node)) {
        const s = node.text;
        // No opaque key/token constants are admitted as explanatory text.
        if (s.length <= 1500 && !/[\u0000-\u001f\u007f]/u.test(s) &&
          (!/^[A-Za-z0-9+/=_]{32,}$/u.test(s) || /^\/api\/[a-z/-]+$/u.test(s))) strings.add(s);
      } else if (context.ts.isTemplateExpression(node)) templates.push(node);
      if(context.ts.isBinaryExpression(node) && node.operatorToken.kind === context.ts.SyntaxKind.PlusToken) {
        const constant = item => context.ts.isStringLiteral(item) || context.ts.isNoSubstitutionTemplateLiteral(item) ? item.text :
          context.ts.isBinaryExpression(item) && item.operatorToken.kind === context.ts.SyntaxKind.PlusToken && constant(item.left) !== null && constant(item.right) !== null
            ? constant(item.left) + constant(item.right) : null;
        const joined=constant(node);if(joined!==null&&joined.length<=1500&&!/[\u0000-\u001f\u007f]/u.test(joined))strings.add(joined);
      }
      context.ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  for (let pass = 0; pass < 2; pass++) for (const node of templates) {
    let values = [node.head.text];
    for (const span of node.templateSpans) {
      const expression = span.expression.getText();
      const options = expression === 'stage' ? [...strings].filter(s => s.startsWith('offline browser ')) : substitutions[expression];
      if (!options || values.length * options.length > 512) { values = []; break; }
      values = values.flatMap(a => options.map(b => a + b + span.literal.text));
    }
    for (const s of values) if (s.length <= 1500 && /^[\x20-\x7e]*$/u.test(s)) strings.add(s);
  }
  return strings;
}
const hashPaths = /(?:^|\.)(?:sourceDigest|legacyGoldenDigest|sha256|utilitySha256|utilityInputDigest|blockHash|txid|wtxid|firstTxid|secondTxid|fundingTxid|childTxid|parentTxid|feeChildTxid|unchangedFundingTxid)$/u;
const tempPath = /^\/tmp\/(?:btc-presigned-core-[A-Za-z0-9]{6}|btc-presigned-(?:offline|live-runner|native-restore-check|restore)\.[A-Za-z0-9]{6})(?:\/(?:primary|wallet-restore-proof\.[A-Za-z0-9]{6}))?$/u;
export function validString(path, value, lexicon) {
  assert(typeof value === 'string');
  if (hashPaths.test(path) || path.startsWith('transactionIds.') || ['parent','originalChild','replacement'].includes(path)) { digest(value); return; }
  if (['evidence','restorationProof'].includes(path) && value.startsWith('/')) { assert(tempPath.test(value), 'unreviewed evidence path'); return; }
  if (path === 'ordering' || path.endsWith('.ordering')) { assert(orders.includes(value) || actors.some(a => actors.some(b => b !== a && actors.some(c => c !== a && c !== b && `${a}/${b}/${c}` === value)))); return; }
  if (path.endsWith('reject-reason') || path.endsWith('reject-details') || path === 'descendantRejection') {
    // Core 31.1 public policy strings. No arbitrary exception detail is allowed.
    assert(/^(?:TRUC-violation|bad-witness-nonstandard|min relay fee not met(?:, 1 < 36)?|mempool-script-verify-flag-failed \(Non-canonical signature: S value is unnecessarily high\)(?:, input 0 of [0-9a-f]{64} \(wtxid [0-9a-f]{64}\), spending [0-9a-f]{64}:[0-9]{1,2})?)$/u.test(value), 'unreviewed Core rejection');
    return;
  }
  assert(lexicon.has(value) || path.endsWith('strictReason') && /^presigned-v[23]: /u.test(value) && lexicon.has(value.replace(/^presigned-v[23]: /u,'')), 'string not grounded in pinned public producer');
}
export function validateRecord(value, fields, lexicon, path = '') {
  if (Array.isArray(value)) {
    assert(value.length <= 10000);
    if (fields[path] === 'e') { assert.equal(value.length, 0); return; }
    assert(Object.keys(fields).some(k => k === `${path}[]` || k.startsWith(`${path}[].`)), 'unknown array field');
    for (const item of value) validateRecord(item, fields, lexicon, `${path}[]`); return;
  }
  if (value !== null && typeof value === 'object') {
    assert(path === '' || Object.keys(fields).some(key=>key.startsWith(`${path}.`)), 'object substituted for scalar producer field');
    assert(Object.keys(value).length <= 150);
    for (const [key, item] of Object.entries(value)) {
      assert(!['__proto__','constructor','prototype'].includes(key));
      const child = path ? `${path}.${key}` : key;
      assert(Object.keys(fields).some(k => k === child || k.startsWith(`${child}.`) || k.startsWith(`${child}[]`)), 'unknown producer field');
      validateRecord(item, fields, lexicon, child);
    }
    return;
  }
  const type = value === null ? 'q' : { boolean:'b', number:'n', string:'s' }[typeof value];
  assert(type && fields[path]?.includes(type), 'wrong producer field type');
  if (type === 'n') assert(Number.isSafeInteger(value) && value >= 0);
  if (type === 's') validString(path, value, lexicon);
}
export function splitTranscript(text, ts) {
  assert(Buffer.byteLength(text) <= 16 * 1024 * 1024 && !text.includes('\r') && !text.includes('\u0000'));
  const records = [], lines = []; let buffer = '';
  for (const line of text.split('\n')) {
    if (!buffer && !line.startsWith('{')) { if (line) lines.push(line); continue; }
    buffer += `${line}\n`; assert(buffer.length <= 2 * 1024 * 1024);
    try { JSON.parse(buffer); } catch { continue; }
    records.push(strictJson(buffer, ts)); buffer = '';
  }
  assert.equal(buffer, '', 'incomplete JSON transcript'); return { records, lines };
}
export function producerPaths(command, context, label) {
  if (label) return [`web/tests/presigned-${label}-db-acceptance.ts`, 'scripts/lib/presigned-regtest.ts'];
  if (command.category === 'legacy') {
    const pkg = JSON.parse(readFileSync(join(context.root, 'package.json'), 'utf8'));
    return ['scripts/test-build-network.mjs', ...pkg.scripts['web:test'].match(/web\/tests\/[a-z-]+\.ts/gu)];
  }
  if (command.category === 'browser') return ['web/browser-tests/presigned-v2.spec.ts','web/browser-tests/presigned-v2-fixture.ts'];
  return command.executable === 'node' && command.args.at(-1).endsWith('.mts') || command.args.at(-1).endsWith('.ts')
    ? [command.args.at(-1), 'scripts/lib/presigned-regtest.ts', 'src/presigned/funding.ts', 'src/presigned/wallet.ts', 'src/presigned/types.ts',
      ...(command.args.at(-1)==='web/tests/presigned-custody-acceptance.ts'?['web/tests/presigned-browser-failure-acceptance.ts']:[])]
    : command.id === 'offline-build' ? ['scripts/build-presigned-offline.mjs'] : [];
}
function schemaId(command, label) {
  if (label) return `db-${label}`;
  if (command.id.startsWith('presigned-live-lifecycle')) return 'lifecycle';
  if(command.category === 'legacy') return 'legacy-unit-signet';
  return command.id.replace(/^((?:v3-)?crypto)-(?:signet|mainnet)-/u,'$1-NETWORK-');
}
export function reviewTranscript(command, text, context, label) {
  const { records, lines } = splitTranscript(text, context.ts);
  if (command.category === 'typecheck') { assert.equal(text, ''); return; }
  if (command.category === 'database' && !label || command.category === 'browser' && !label) {
    assert.equal(records.length, 0);
    const spec = 'presigned-(?:ceremony|runtime|chain-broadcast|fee|restore|cashout|protocol-queue)-db-acceptance';
    for (const line of lines) assert(command.category === 'database'
      ? new RegExp(`^(?:Running ${spec} on a disposable database|Passed ${spec}|Owner-only test evidence retained at /tmp/btc-presigned-db\\.[A-Za-z0-9]{6})$`, 'u').test(line)
      : /^(?:Owner-only browser acceptance evidence: \/tmp\/btc-presigned-browser\.[A-Za-z0-9]{6}|Owner-only acceptance evidence retained at \/tmp\/btc-presigned-browser\.[A-Za-z0-9]{6}|Optimized version-bound browser acceptance passed\. No public-network broadcasts; regtest identity bridge is test-only\.)$/u.test(line));
    return;
  }
  const fields = OUTPUT_FIELDS[schemaId(command,label)]; assert(fields, 'unreviewed command schema');
  const lexicon = producerLexicon(producerPaths(command,context,label),context);
  if (command.category === 'legacy') {
    const pkg = JSON.parse(readFileSync(join(context.root,'package.json'),'utf8'));
    lexicon.add(`> ${pkg.name}@${pkg.version} web:test`); lexicon.add(`> ${pkg.scripts['web:test']}`);
  }
  for (const line of lines) assert(lexicon.has(line), 'unreviewed plain-text output');
  for (const record of records) validateRecord(record, fields, lexicon);
}
export function publicRun(run, context) {
  keys(run,['version','protocol','kind','mode','sourceDigest','createdAt','completedAt','reviewedNodeVersion','commands','offlineUtilityDigest',
    'physicalPasskeysVerified','realSignetVerified','exactImageVerified','fundingAuthorized','runDigest']);
  assert(run.version === 3 && run.protocol === PINS.protocol && run.kind === 'presigned-v3-local-executable-run' && run.mode === 'local' && run.sourceDigest === PINS.source);
  for (const f of ['physicalPasskeysVerified','realSignetVerified','exactImageVerified','fundingAuthorized']) assert.equal(run[f],false);
  timestamp(run.createdAt); timestamp(run.completedAt); digest(run.offlineUtilityDigest); digest(run.runDigest);
  assert.equal(run.reviewedNodeVersion, readFileSync(join(context.root,'.node-version'),'utf8').trim());
  assert.equal(run.commands.length,75);
  run.commands.forEach((execution,index) => {
    keys(execution,['command','startedAt','completedAt','sourceDigest','exitCode','stdoutSha256','stderrSha256','artifactDigests','executionDigest']);
    assert.deepEqual(execution.command, context.plan[index]); timestamp(execution.startedAt); timestamp(execution.completedAt);
    assert(execution.sourceDigest === PINS.source && execution.exitCode === 0);
    for (const f of ['stdoutSha256','stderrSha256','executionDigest']) digest(execution[f]);
    assert(Array.isArray(execution.artifactDigests) && execution.artifactDigests.length <= 7);
    for (const artifact of execution.artifactDigests) { keys(artifact,['relativePath','sha256']); digest(artifact.sha256); assert(expectedNames(context.plan).includes(artifact.relativePath)); }
  });
}
export function reviewerDigest() {
  return hash(JSON.stringify(['presigned-local-public-evidence.mjs','presigned-local-output-profile.mjs','presigned-local-archive.py',
    'presigned-deployment-public-evidence.py','presigned-public-evidence.py'].map(name => [name,hash(readFileSync(join(HERE,name)))])));
}
export function validateRetention(value) {
  keys(value,['version','protocol','kind','sourceCommit','sourceDigest','toolingCommit','workflowRunId','draftId','assetName','archiveSha256','archiveBytes',
    'evidenceDigest','files','restoredBytesRevalidated','syntheticOnly','productionUsePermitted','realDefaultSignetVerified','physicalPasskeysVerified','releaseReceiptProduced','fundingAuthorized']);
  assert(value.version === 1 && value.protocol === PINS.protocol && value.kind === 'presigned-v3-public-local-test-evidence' && value.sourceCommit === PINS.candidate && value.sourceDigest === PINS.source && value.draftId === PINS.draftId && value.assetName === ASSETS[0]);
  assert(/^[0-9a-f]{40}$/u.test(value.toolingCommit) && /^[1-9][0-9]*$/u.test(value.workflowRunId));
  digest(value.archiveSha256); digest(value.evidenceDigest);
  assert(Number.isSafeInteger(value.archiveBytes) && value.archiveBytes > 0 && value.archiveBytes <= MAX && value.files === 165);
  assert(value.restoredBytesRevalidated === true && value.syntheticOnly === true);
  for (const key of ['productionUsePermitted','realDefaultSignetVerified','physicalPasskeysVerified','releaseReceiptProduced','fundingAuthorized']) assert.equal(value[key],false);
}
export async function reviewDirectory(directory, context) {
  const phase=(value,command=null,label=null)=>{assert(phases.includes(value));failureContext={phase:value,command,label,plan:context.plan};};
  phase('archive-import');
  ownedDirectory(directory); assert.deepEqual(readdirSync(directory).sort(),ASSETS.slice(0,2).sort());
  const retention = strictJson(ownedBytes(join(directory,ASSETS[1])).toString('utf8'),context.ts); validateRetention(retention);
  assert.equal(hash(ownedBytes(join(directory,ASSETS[0]),MAX,false)),retention.archiveSha256);
  assert.equal(lstatSync(join(directory,ASSETS[0])).size,retention.archiveBytes);
  const names = expectedNames(context.plan), allowlist = `${directory}.allowlist.json`, restored = `${directory}.restored`;
  ownedDirectory(dirname(directory)); writeFileSync(allowlist,JSON.stringify(names),{mode:0o600,flag:'wx'});
  execFileSync('python3',[join(HERE,'presigned-local-archive.py'),'import',join(directory,ASSETS[0]),allowlist,restored,retention.archiveSha256],
    {env:{PATH:process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',GITHUB_REPOSITORY_OWNER:process.env.GITHUB_REPOSITORY_OWNER},stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024,timeout:180000});
  phase('run-schema');const run = strictJson(ownedBytes(join(restored,'run.json')).toString('utf8'),context.ts); publicRun(run,context);
  assert.equal(run.runDigest,retention.evidenceDigest);
  for (const command of context.plan) {
    phase('stderr-empty',command.id);reviewStderr(ownedBytes(join(restored,`${command.id}.stderr.log`)));
    phase('stdout-schema',command.id);
    reviewTranscript(command,ownedBytes(join(restored,`${command.id}.stdout.log`)).toString('utf8'),context);
    if (command.category === 'database') for (const artifact of run.commands.find(e=>e.command.id===command.id).artifactDigests) {
      const label=artifact.relativePath.slice(`${command.id}-`.length,-4);
      phase('database-schema',command.id,databaseLabels.includes(label)?label:null);
      reviewTranscript(command,ownedBytes(join(restored,artifact.relativePath)).toString('utf8'),context,label);
    }
    if (command.category === 'browser') {phase('browser-schema',command.id);validateRecord(strictJson(ownedBytes(join(restored,`${command.id}-browser.json`)).toString('utf8'),context.ts),
      OUTPUT_FIELDS.browser,producerLexicon(producerPaths(command,context),context));}
  }
  phase('offline-hash');
  assert.equal(hash(ownedBytes(join(restored,'offline-recovery.html'))),run.offlineUtilityDigest);
  phase('candidate-semantic');
  context.acceptance.validateLocalAcceptanceRun(restored,PINS.source,'local',PINS.protocol);
  phase('post-review-source');
  assert.equal(context.identity.presignedSourceDigest(),PINS.source);
  assert.equal(hash(ownedBytes(join(directory,ASSETS[0]),MAX,false)),retention.archiveSha256);
  const review={...retention,kind:'presigned-v3-local-archive-content-review',passed:true,commands:75,reviewerDigest:reviewerDigest(),
    exactArchiveMembersInspected:true,canonicalOuterEnvelopeVerified:true,allTranscriptBytesInspected:true,
    candidateSemanticValidationRepeated:true,exactOfflineBytesVerified:true,universalSecretAbsenceProven:false};
  writeFileSync(join(directory,ASSETS[2]),`${JSON.stringify(review,null,2)}\n`,{mode:0o600,flag:'wx'});
  return review;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try { process.umask(0o077); assert.equal(process.argv.length,3); const result=await reviewDirectory(resolve(process.argv[2]),await candidateContext());
    console.log(JSON.stringify(result));
  } catch { console.error(JSON.stringify(publicReviewFailure(failureContext.phase,failureContext.command,failureContext.label,failureContext.plan))); process.exitCode=1; }
}
