/** A fixed executable plan, not an API for checking operator-supplied hashes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { commitmentDigest } from '../../src/presigned/validation.js';
import { presignedSourceDigest } from '../presigned-build-identity.mjs';

export type AcceptanceMode = 'pure' | 'local';
export interface AcceptanceCommand {
  id: string;
  executable: 'node' | 'bash' | 'npm';
  args: string[];
  network: 'signet' | 'mainnet';
  category: 'typecheck' | 'cryptographic' | 'core' | 'database' | 'offline-browser' | 'browser' | 'legacy';
}
const pureFiles = [
  'src/presigned/acceptance.ts', 'src/presigned/spends-acceptance.ts', 'src/presigned/fees-acceptance.ts',
  'src/presigned/funding-fees-acceptance.ts', 'src/presigned/spend-fees-acceptance.ts',
  'src/presigned/chain-acceptance.ts', 'src/presigned/core-acceptance.ts', 'src/presigned/runtime-acceptance.ts',
  'src/presigned/coin-observations-acceptance.ts', 'src/presigned/release-acceptance.ts',
  'web/tests/presigned-custody-acceptance.ts', 'web/tests/presigned-local-lock-acceptance.ts',
  'web/tests/presigned-browser-review-probe.ts', 'web/tests/presigned-chain-review-acceptance.ts',
];
export function acceptancePlan(mode: AcceptanceMode): AcceptanceCommand[] {
  assert(mode === 'pure' || mode === 'local');
  const plan: AcceptanceCommand[] = ['tsconfig.json', 'tsconfig.web.json', 'tsconfig.offline.json', 'tsconfig.scripts.json']
    .map((file, index) => ({ id: `types-${index}`, executable: 'node',
      args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', file], network: 'signet', category: 'typecheck' }));
  for (const network of ['signet', 'mainnet'] as const) for (const [index, file] of pureFiles.entries()) plan.push({
    id: `crypto-${network}-${String(index).padStart(2, '0')}`, executable: 'node',
    args: ['--conditions=react-server', '--import', 'tsx', file], network, category: 'cryptographic',
  });
  plan.push({ id: 'evidence-boundaries', executable: 'node', args: ['--import', 'tsx', 'scripts/presigned-evidence-acceptance.mts'],
    network: 'signet', category: 'cryptographic' });
  plan.push({ id: 'oci-boundaries', executable: 'node', args: ['--import', 'tsx', 'scripts/presigned-oci-acceptance.mts'],
    network: 'signet', category: 'cryptographic' });
  for (const network of ['signet', 'mainnet'] as const) plan.push({ id: `legacy-unit-${network}`, executable: 'npm',
    args: ['run', 'web:test'], network, category: 'legacy' });
  if (mode === 'local') {
    for (const file of ['presigned-core-acceptance', 'presigned-core-spends', 'presigned-core-fees',
      'presigned-core-funding-fees', 'presigned-core-spend-fees', 'presigned-core-observed-witnesses',
      'presigned-live-lifecycle-regtest']) plan.push({ id: file, executable: 'node',
      args: ['--import', 'tsx', `scripts/${file}.mts`], network: 'signet', category: 'core' });
    plan.push({ id: 'database-v2-all', executable: 'bash', args: ['scripts/run-presigned-db-acceptance.sh', 'all'],
      network: 'signet', category: 'database' });
    plan.push({ id: 'offline-build', executable: 'node', args: ['scripts/build-presigned-offline.mjs'], network: 'signet', category: 'offline-browser' });
    plan.push({ id: 'offline-full', executable: 'node', args: ['--import', 'tsx', 'scripts/presigned-offline-acceptance.mts'],
      network: 'signet', category: 'offline-browser' });
    plan.push({ id: 'optimized-browser', executable: 'bash', args: ['scripts/run-presigned-browser-acceptance.sh'],
      network: 'signet', category: 'browser' });
  }
  return plan;
}

/** No operational dotenv loaders, credentials, signing opt-ins, NODE_OPTIONS,
 * proxies or caller-selected test filters survive into an acceptance command. */
export function acceptanceEnvironment(network: 'signet' | 'mainnet'): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'POSTGRES_BIN', 'POSTGRES_LIB',
    'BITCOIN_CORE_BIN', 'PLAYWRIGHT_BROWSERS_PATH', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TERM']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, NODE_EXECUTABLE: process.execPath, VAULT_NETWORK: network, NEXT_PUBLIC_VAULT_NETWORK: network,
    NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'test', PRESIGNED_BROWSER_BUILD_APPROVED: 'true' };
}

export interface ExecutedCommand {
  command: AcceptanceCommand;
  startedAt: string;
  completedAt: string;
  sourceDigest: string;
  exitCode: 0;
  stdoutSha256: string;
  stderrSha256: string;
  artifactDigests: Array<{ relativePath: string; sha256: string }>;
  executionDigest: string;
}
export interface LocalAcceptanceRun {
  version: 2;
  protocol: 'presigned-graph-v2';
  kind: 'presigned-v2-local-executable-run';
  mode: AcceptanceMode;
  sourceDigest: string;
  createdAt: string;
  completedAt: string;
  reviewedNodeVersion: string;
  commands: ExecutedCommand[];
  offlineUtilityDigest: string | null;
  physicalPasskeysVerified: false;
  realSignetVerified: false;
  exactImageVerified: false;
  fundingAuthorized: false;
  runDigest: string;
}
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export function readPrivateAcceptanceFile(filename: string, maximumBytes = 16 * 1024 * 1024): Buffer {
  const parent = lstatSync(dirname(filename));
  assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid?.() &&
    (parent.mode & 0o077) === 0, 'acceptance evidence directory must be owner-only');
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 &&
      stat.size <= maximumBytes, 'acceptance evidence must be a bounded owner-only regular file');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export function parseAcceptanceJson(data: Buffer | string): unknown {
  try { return JSON.parse(data.toString()); }
  catch { throw new Error('acceptance evidence contains invalid JSON; contents deliberately omitted'); }
}
export function writeAcceptanceJson(filename: string, body: unknown) {
  writeFileSync(filename, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

/** Collect whole JSON objects from mixed command progress output. Strings and
 * braces inside strings are handled by JSON.parse, never by eval or a shell. */
export function acceptanceJsonRecords(data: string): Array<Record<string, any>> {
  const records: Array<Record<string, any>> = [];
  let buffer = '';
  for (const line of data.split('\n')) {
    if (!buffer && !line.startsWith('{')) continue;
    buffer += `${line}\n`;
    if (buffer.length > 2 * 1024 * 1024) throw new Error('acceptance JSON record exceeds its bound');
    try {
      const value = JSON.parse(buffer);
      if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value);
      buffer = '';
    } catch { /* Wait for a complete pretty-printed JSON object. */ }
  }
  assert(!buffer.trim(), 'acceptance output ended inside an incomplete JSON object');
  return records;
}
function resultPassed(record: Record<string, any>) {
  return record.passed === true || (Number.isSafeInteger(record.passed) && record.passed > 0) || record.status === 'passed';
}
export function validateCommandResults(command: AcceptanceCommand, stdout: string) {
  if (command.category === 'typecheck' || command.id === 'offline-build') return;
  const records = acceptanceJsonRecords(stdout);
  if (command.category === 'cryptographic') {
    assert(records.some(resultPassed), `${command.id} did not emit an actual successful suite result`);
    assert(!records.some(item => item.passed === false || item.status === 'failed'), `${command.id} reported a failed result`);
    if (command.args.at(-1) === 'src/presigned/acceptance.ts') {
      const result = records.findLast(resultPassed);
      assert(result?.network === command.network && result.nativeWalletCombinations === 8 && result.exitsPerCombination === 9,
        'graph acceptance did not cover the actual requested network and wallet matrix');
    }
  } else if (command.category === 'core') {
    assert(!records.some(item => item.passed === false || item.status === 'failed'), `${command.id} reported a failed result`);
    const record = records.findLast(resultPassed);
    assert(record, `${command.id} did not emit a successful Core summary`);
    assert(record.publicNetworkBroadcasts === 0, 'local Core proof cannot include a public-network broadcast');
    assert(record.coreVersion === 310100, 'unreviewed Core evidence');
    if (command.id === 'presigned-core-fees') assert(record.actualRollingFloorFromEviction === true &&
      record.adequatePackageAndReplacementConfirmed === true && record.fundingAndGraphUnchanged === true);
    if (command.id === 'presigned-core-funding-fees') assert(record.dynamicMempoolFloorRaisedByRealEviction === true &&
      record.adequatelySponsoredFundingAndReplacementConfirmed === true && record.exactGraphAndNineExitTxidsUnchanged === true);
  } else if (command.id === 'offline-full') {
    assert(!records.some(item => item.passed === false || item.status === 'failed'), 'offline proof reported a failed result');
    const record = records.findLast(resultPassed);
    assert(record?.completeLifecycleEvidence === true && record.completeFeeEvidence === true &&
      record.fullSoloOrderings === 6 && record.cooperativeRounds === 4 && record.recoverySignerSubsets === 9 &&
      record.actualBrowserSignedTransactionsConfirmedByCore === 31 && record.feeRescueWalletAndParentCases === 10 &&
      record.replacementFeeChildrenConfirmedByCore === 10 && record.networkRequests === 0 && record.persistentSecretStorage === false,
    'offline proof is partial or lacks actual Core lifecycle/fee confirmations');
    assert(record.utilitySha256 === sha256(readFileSync('public/offline/presigned-recovery.html')), 'offline proof is for a different artifact');
  }
}

export function validateBrowserAcceptance(json: any, sourceDigest: string, network: 'signet' | 'mainnet') {
  assert(json?.passed === true && json.protocol === 'presigned-graph-v2' && json.bundle === 'optimized-webpack-standalone' &&
    json.sourceDigest === sourceDigest && json.appNetwork === network && json.actualBitcoinChain === 'isolated-regtest' &&
    json.networkIdentityBridge === true && json.virtualPrfPasskeys === 6 && json.coreVersion === 310100 &&
    json.realSignetAcceptance === false && json.physicalPasskeyEvidence === false && json.publicNetworkBroadcasts === 0 &&
    json.mainnetFundingAuthorized === false && json.audit?.sensitiveRequestDetected === false,
  'browser evidence does not prove the required source, network and custody execution');
  assert.deepEqual(json.audit.forbidden, []); assert.deepEqual(json.audit.unexpected, []);
  if (network === 'signet') assert(json.completeGameExecution === true && Number.isSafeInteger(json.reauthentications) && json.reauthentications > 0,
    'Signet-format browser evidence must include full game execution and session reauthentication');
  else assert(json.mainnetFundingGateVerified === true && json.completeGameExecution === false,
    'mainnet-format browser evidence must prove the actual unauthorized funding refusal');
}

export function validateAcceptanceArtifacts(command: AcceptanceCommand, artifacts: ExecutedCommand['artifactDigests'],
  directory: string, sourceDigest: string) {
  const expected = command.category === 'database'
    ? ['ceremony', 'runtime', 'chain-broadcast', 'fee', 'restore'].map(name => `${command.id}-${name}.log`)
    : command.category === 'browser' ? [`${command.id}-browser.json`] : [];
  assert.deepEqual(artifacts.map(item => item.relativePath), expected, 'required acceptance artifacts are missing, duplicated or substituted');
  for (const artifact of artifacts) {
    const bytes = readPrivateAcceptanceFile(`${directory}/${artifact.relativePath}`);
    assert.equal(sha256(bytes), artifact.sha256, 'acceptance artifact changed');
    if (command.category === 'browser') validateBrowserAcceptance(parseAcceptanceJson(bytes), sourceDigest, command.network);
    else {
      const results = acceptanceJsonRecords(bytes.toString());
      assert(results.some(resultPassed) && !results.some(item => item.passed === false || item.status === 'failed'),
        'retained database suite did not pass');
      if (artifact.relativePath.endsWith('-restore.log')) {
        const restored = results.findLast(resultPassed);
        assert(restored?.restoredEncryptedKeys === 6 && restored.negativeBoundaries >= 22,
          'database evidence lacks the actual full restore and custody boundary drill');
      }
    }
  }
}

export async function executeAcceptanceCommand(command: AcceptanceCommand, directory: string, sourceDigest: string): Promise<ExecutedCommand> {
  assert.equal(presignedSourceDigest(), sourceDigest, 'source changed during acceptance; start a reviewed run of the new source');
  const startedAt = new Date().toISOString();
  const stdoutPath = `${directory}/${command.id}.stdout.log`; const stderrPath = `${directory}/${command.id}.stderr.log`;
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; let totalBytes = 0;
  const child = spawn(command.executable === 'node' ? process.execPath : command.executable, command.args,
    { cwd: process.cwd(), env: acceptanceEnvironment(command.network), stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = (target: Buffer[]) => (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes > 16 * 1024 * 1024) { child.kill('SIGTERM'); return; }
    target.push(Buffer.from(chunk));
  };
  child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', () => reject(new Error(`could not start fixed acceptance command ${command.id}`)));
    child.once('close', code => resolveExit(code));
  });
  const stdoutBytes = Buffer.concat(stdout); const stderrBytes = Buffer.concat(stderr);
  writeFileSync(stdoutPath, stdoutBytes, { mode: 0o600, flag: 'wx' });
  writeFileSync(stderrPath, stderrBytes, { mode: 0o600, flag: 'wx' });
  assert(totalBytes <= 16 * 1024 * 1024, 'acceptance command output exceeded its bound');
  assert.equal(exitCode, 0, `fixed acceptance command ${command.id} failed; inspect its owner-only log`);
  assert.equal(presignedSourceDigest(), sourceDigest, 'source changed during an executing suite; no valid receipt was produced');
  const output = stdoutBytes.toString(); validateCommandResults(command, output);
  const artifacts: Array<{ relativePath: string; sha256: string }> = [];
  const copyArtifact = (filename: string, label: string, validate?: (json: any) => void) => {
    const bytes = readPrivateAcceptanceFile(filename); const json = parseAcceptanceJson(bytes);
    validate?.(json);
    const relativePath = `${command.id}-${label}.json`;
    writeFileSync(`${directory}/${relativePath}`, bytes, { mode: 0o600, flag: 'wx' });
    artifacts.push({ relativePath, sha256: sha256(bytes) });
  };
  if (command.category === 'database') {
    const paths = [...output.matchAll(/Owner-only test evidence retained at (\/tmp\/btc-presigned-db\.[A-Za-z0-9]+)/gu)];
    assert.equal(paths.length, 1, 'database runner did not retain an exact disposable evidence directory');
    for (const name of ['ceremony', 'runtime', 'chain-broadcast', 'fee', 'restore']) {
      const bytes = readPrivateAcceptanceFile(`${paths[0]![1]}/presigned-${name}-db-acceptance.log`);
      const results = acceptanceJsonRecords(bytes.toString());
      assert(results.some(resultPassed) && !results.some(item => item.passed === false), `database ${name} proof is missing or failed`);
      const relativePath = `${command.id}-${name}.log`;
      writeFileSync(`${directory}/${relativePath}`, bytes, { mode: 0o600, flag: 'wx' });
      artifacts.push({ relativePath, sha256: sha256(bytes) });
    }
  } else if (command.category === 'browser') {
    const paths = [...output.matchAll(/Owner-only browser acceptance evidence: (\/tmp\/btc-presigned-browser\.[A-Za-z0-9]+)/gu)];
    assert.equal(paths.length, 1, 'browser runner did not retain an exact disposable evidence directory');
    copyArtifact(`${paths[0]![1]}/presigned-browser-acceptance.json`, 'browser', json =>
      validateBrowserAcceptance(json, sourceDigest, command.network));
  }
  validateAcceptanceArtifacts(command, artifacts, directory, sourceDigest);
  const body = { command, startedAt, completedAt: new Date().toISOString(), sourceDigest, exitCode: 0 as const,
    stdoutSha256: sha256(stdoutBytes), stderrSha256: sha256(stderrBytes), artifactDigests: artifacts };
  const execution = { ...body, executionDigest: commitmentDigest('vault/presigned-graph-v2/executed-command', body) };
  writeAcceptanceJson(`${directory}/${command.id}.json`, execution);
  return execution;
}

/** Re-read every transcript and auxiliary artifact; stale/tampered/incomplete
 * runs cannot be promoted merely because they contain a passed field. */
export function validateLocalAcceptanceRun(directory: string, expectedSource: string, requiredMode: AcceptanceMode): LocalAcceptanceRun {
  const run = parseAcceptanceJson(readPrivateAcceptanceFile(`${resolve(directory)}/run.json`)) as LocalAcceptanceRun;
  const { runDigest, ...body } = run;
  assert(run.version === 2 && run.protocol === 'presigned-graph-v2' && run.kind === 'presigned-v2-local-executable-run' &&
    run.mode === requiredMode && run.sourceDigest === expectedSource && run.fundingAuthorized === false &&
    run.exactImageVerified === false && run.realSignetVerified === false && run.physicalPasskeysVerified === false);
  assert.equal(commitmentDigest('vault/presigned-graph-v2/local-executable-run', body), runDigest);
  const plan = acceptancePlan(requiredMode);
  assert.deepEqual(run.commands.map(item => item.command), plan, 'missing or substituted fixed acceptance command');
  assert(run.reviewedNodeVersion === readFileSync('.node-version', 'utf8').trim());
  for (const execution of run.commands) {
    const { executionDigest, ...executionBody } = execution;
    assert.equal(commitmentDigest('vault/presigned-graph-v2/executed-command', executionBody), executionDigest);
    assert(execution.sourceDigest === expectedSource && execution.exitCode === 0);
    assert(Date.parse(execution.startedAt) >= Date.parse(run.createdAt) && Date.parse(execution.completedAt) <= Date.parse(run.completedAt) &&
      Date.parse(execution.completedAt) >= Date.parse(execution.startedAt));
    for (const [kind, digest] of [['stdout', execution.stdoutSha256], ['stderr', execution.stderrSha256]] as const) {
      const bytes = readPrivateAcceptanceFile(`${directory}/${execution.command.id}.${kind}.log`);
      assert.equal(sha256(bytes), digest, 'executed command transcript changed');
      if (kind === 'stdout') validateCommandResults(execution.command, bytes.toString());
    }
    validateAcceptanceArtifacts(execution.command, execution.artifactDigests, directory, expectedSource);
  }
  if (requiredMode === 'local') assert(run.offlineUtilityDigest === sha256(readFileSync('public/offline/presigned-recovery.html')));
  else assert.equal(run.offlineUtilityDigest, null);
  return run;
}
