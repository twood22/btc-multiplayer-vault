/** Actual CLI producer against bounded loopback SYNTHETIC RPC replies only.
 * No Bitcoin node, wallet, real credentials, real coins, signing or broadcasting.
 * Chain names/genesis values exercise validation, not native-chain evidence. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import { validatePresignedCoinObservations, presignedObservedFeeCoin } from '../src/presigned/coin-observations.js';
import { createPresignedFixture } from '../src/presigned/fixtures.js';
import { PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, type PresignedProtocol } from '../src/presigned/types.js';
import { genesisHash, presignedVersion } from '../src/presigned/validation.js';
import { assertReviewedNodeRuntime } from '../src/runtime-version.js';
import type { BitcoinNetworkName } from '../src/types.js';

assertReviewedNodeRuntime();
assert.equal(process.argv.length, 2, 'this isolated acceptance command accepts no arguments');
process.umask(0o077);
const directory = mkdtempSync(join(tmpdir(), 'btc-presigned-observation-cli.'));
const cookiePath = join(directory, 'synthetic.cookie');
const blockedCookiePath = join(directory, 'cookie-open-must-not-be-reached.fifo');
const syntheticCookie = 'synthetic-observation-fixture:public-test-value';
writeFileSync(cookiePath, syntheticCookie, { flag: 'wx', mode: 0o600 });
// O_RDONLY on this writerless FIFO blocks. Argument rejection must exit normally,
// not hit the child's watchdog: this checks the real CLI's pre-cookie boundary.
execFileSync('mkfifo', [blockedCookiePath]);
const tip = '55'.repeat(32); const anchor = '44'.repeat(32); const spender = '77'.repeat(32);
const parent = new bitcoin.Transaction(); parent.version = 2;
parent.addInput(Buffer.from('11'.repeat(32), 'hex'), 1);
parent.addOutput(Buffer.from(`5120${'22'.repeat(32)}`, 'hex'), 12_000n);
parent.addOutput(Buffer.from(`0014${'33'.repeat(20)}`, 'hex'), 13_000n);
const txid = parent.getId();
let network: BitcoinNetworkName = 'signet';
let fault: 'none' | 'chain' | 'genesis' | 'pruned' | 'index' = 'none';
let requests = 0; let commandCount = 0; let negativeCases = 0; let fixtureFailed = false;
const methods = new Set<string>();
const server = createServer(async (request, response) => {
  try {
    assert(++requests <= 512, 'synthetic RPC request bound exceeded');
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/');
    assert.equal(request.headers.authorization, `Basic ${Buffer.from(syntheticCookie).toString('base64')}`);
    let body = ''; for await (const chunk of request) { body += String(chunk); assert(body.length <= 4096); }
    const input = JSON.parse(body) as { method: string; params: unknown[]; id: string };
    assert.equal(input.id, 'presigned-public-coin-observation'); methods.add(input.method);
    let result: unknown;
    switch (input.method) {
      case 'getblockchaininfo':
        assert.deepEqual(input.params, []);
        result = { chain: fault === 'chain' ? 'regtest' : network === 'mainnet' ? 'main' : 'signet',
          blocks: 100, bestblockhash: tip, pruned: fault === 'pruned', initialblockdownload: false }; break;
      case 'getindexinfo':
        assert.deepEqual(input.params, []); result = { txindex: { synced: fault !== 'index' } }; break;
      case 'getblockhash':
        assert(input.params.length === 1 && [0,95].includes(input.params[0] as number));
        result = input.params[0] === 0 ? fault === 'genesis' ? '66'.repeat(32) : genesisHash(network) : anchor; break;
      case 'getblockheader':
        assert.deepEqual(input.params, [anchor, true]); result = { hash: anchor, height: 95, confirmations: 6 }; break;
      case 'getrawtransaction':
        assert.deepEqual(input.params, [txid, true]); result = { txid, hex: parent.toHex(), blockhash: anchor, confirmations: 6 }; break;
      case 'gettxout': {
        assert(input.params.length === 3 && input.params[0] === txid && [0,1].includes(input.params[1] as number) &&
          typeof input.params[2] === 'boolean');
        const index = input.params[1] as number; const output = parent.outs[index]!;
        result = index === 1 && input.params[2] === true ? null : { bestblock: tip, confirmations: 6,
          value: Number(output.value) / 1e8, scriptPubKey: { hex: Buffer.from(output.script).toString('hex') }, coinbase: false }; break;
      }
      case 'gettxspendingprevout':
        assert.deepEqual(input.params, [[{ txid, vout: 1 }]]); result = [{ txid, vout: 1, spendingtxid: spender }]; break;
      default: throw new Error('only allowlisted read-only synthetic RPC methods are permitted');
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ result, id: input.id }));
  } catch {
    fixtureFailed = true;
    response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: -1 } }));
  }
});
server.requestTimeout = 5000; server.headersTimeout = 5000;

async function command(args: string[], successful: boolean) {
  commandCount++;
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('scripts/presigned-observe-coins.mts'), ...args],
    { cwd: process.cwd(), env: { PATH: dirname(process.execPath) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let exceeded = false;
  const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, 15_000);
  const collect = (kind: 'stdout' | 'stderr', value: Buffer) => {
    if (kind === 'stdout') stdout += value.toString(); else stderr += value.toString();
    if (stdout.length + stderr.length > 32_768) { exceeded = true; child.kill('SIGKILL'); }
  };
  child.stdout.on('data', value => collect('stdout', value)); child.stderr.on('data', value => collect('stderr', value));
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once('error', () => reject(new Error('synthetic observation CLI could not start')));
      child.once('close', (code, signal) => done({ code, signal }));
    });
    assert(!exceeded && result.signal === null, 'CLI exceeded a bound or opened the forbidden FIFO cookie');
    assert.equal(result.code, successful ? 0 : 1, 'actual observation CLI returned an unexpected exit status');
    assert(!stdout.includes(syntheticCookie) && !stderr.includes(syntheticCookie), 'synthetic credential was exposed');
    assert(!fixtureFailed, 'CLI violated its synthetic read-only RPC contract');
    if (successful) { assert.equal(stderr, ''); return JSON.parse(stdout); }
    assert.equal(stdout, ''); assert.match(stderr, /^Public coin observation failed;/u); negativeCases++; return null;
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}

try {
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert(address && typeof address !== 'string' && address.address === '127.0.0.1');
  const rpcUrl = `http://127.0.0.1:${address.port}/`;
  const argsFor = (output: string, protocol?: PresignedProtocol, cookie = cookiePath) => [
    '--network', network, ...(protocol ? ['--protocol', protocol] : []), '--rpc-url', rpcUrl, '--cookie-file', cookie,
    '--coin', `${txid}:0`, '--coin', `${txid}:1`, '--output', output ];
  for (const selectedNetwork of ['mainnet','signet'] as const) {
    network = selectedNetwork;
    for (const protocol of [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3]) {
      const { graph } = createPresignedFixture({ network, protocol });
      for (const explicit of protocol === PRESIGNED_PROTOCOL ? [false, true] : [true]) {
        const output = join(directory, `${network}-${protocol}-${explicit}.json`);
        const result = await command(argsFor(output, explicit ? protocol : undefined), true);
        assert.equal(result.version, presignedVersion(protocol)); assert.equal(result.protocol, protocol);
        assert.equal(result.network, network); assert.equal(result.signed, false); assert.equal(result.broadcast, false);
        assert.equal(statSync(output).mode & 0o777, 0o600);
        const report = validatePresignedCoinObservations(graph, JSON.parse(readFileSync(output, 'utf8')));
        assert.equal(report.protocol, protocol); assert.equal(report.version, graph.version);
        assert.deepEqual(report.availability, [{ txid, vout: 0, kind: 'available', spendingTxid: null },
          { txid, vout: 1, kind: 'mempool-spent', spendingTxid: spender }]);
        assert.equal(presignedObservedFeeCoin(report, txid, 0, null).valueSats, 12_000);
        assert.equal(presignedObservedFeeCoin(report, txid, 1, spender).valueSats, 13_000);
        assert.throws(() => presignedObservedFeeCoin(report, txid, 1, null), /another mempool/u);
        assert.throws(() => validatePresignedCoinObservations(graph, { ...report,
          protocol: protocol === PRESIGNED_PROTOCOL ? PRESIGNED_PROTOCOL_V3 : PRESIGNED_PROTOCOL,
          version: report.version === 2 ? 3 : 2 }));
      }
    }
  }
  const rejectedOutput = join(directory, 'must-not-exist.json');
  const base = argsFor(rejectedOutput, PRESIGNED_PROTOCOL_V3, blockedCookiePath);
  const without = (name: string) => base.filter((_item, index) => base[index] !== name && (index === 0 || base[index - 1] !== name));
  const malformed = [
    base.map(item => item === PRESIGNED_PROTOCOL_V3 ? 'presigned-graph-v4' : item),
    [...base, '--protocol', PRESIGNED_PROTOCOL_V3], [...base, '--protocol', PRESIGNED_PROTOCOL],
    [...without('--protocol'), '--protocol'], [...without('--protocol'), '--protocol', '--output', rejectedOutput],
    ...['--network','--rpc-url','--cookie-file','--output','--coin'].map(without),
    [...base, '--coin', `${txid}:0`], [...base, '--unknown', 'unrecognized'],
    ...['http://192.0.2.1/', 'https://user:password@example.invalid/', `${rpcUrl}wallet/test`, `${rpcUrl}?query=1`]
      .map(url => base.map(item => item === rpcUrl ? url : item)),
  ];
  for (const args of malformed) {
    const before = requests; await command(args, false);
    assert.equal(requests, before, 'invalid arguments performed RPC before rejection'); assert(!existsSync(rejectedOutput));
  }
  for (const cookie of ['unsafe.cookie', 'symlink.cookie', 'missing.cookie']) {
    const path = join(directory, cookie);
    if (cookie === 'unsafe.cookie') { writeFileSync(path, syntheticCookie, { mode: 0o600 }); chmodSync(path, 0o644); }
    if (cookie === 'symlink.cookie') symlinkSync(cookiePath, path);
    const before = requests; await command(argsFor(rejectedOutput, PRESIGNED_PROTOCOL_V3, path), false);
    assert.equal(requests, before); assert(!existsSync(rejectedOutput));
  }
  for (const failure of ['chain','genesis','pruned','index'] as const) {
    fault = failure; await command(argsFor(rejectedOutput, PRESIGNED_PROTOCOL_V3), false); assert(!existsSync(rejectedOutput));
  }
  fault = 'none';
  const retained = join(directory, 'existing-output.json'); const marker = 'preserve existing output';
  writeFileSync(retained, marker, { flag: 'wx', mode: 0o600 });
  await command(argsFor(retained, PRESIGNED_PROTOCOL_V3), false); assert.equal(readFileSync(retained, 'utf8'), marker);
  console.log(JSON.stringify({ passed: true, suite: 'presigned-observe-coins-actual-cli', commandCount, negativeCases,
    successfulProducerConsumerCases: 6, protocols: [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3], networks: ['mainnet','signet'],
    legacyV2DefaultPreserved: true, preCookieArgumentRejection: true, requests, readOnlyMethods: [...methods].sort(),
    evidence: 'loopback-synthetic-rpc-only', syntheticRpcFixture: true, productionRpcOrChainContact: false,
    actualChainEvidence: false, realCredentials: false, signed: false, broadcast: false }));
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  rmSync(directory, { recursive: true, force: true });
}
