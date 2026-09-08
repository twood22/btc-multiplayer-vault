/** Actual default-Signet only. No app configuration, old wallets or fixture keys. */
import assert from 'node:assert/strict';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createPresignedCoreBackend, type PresignedCoreRpc } from '../src/presigned/core.js';
import { genesisHash } from '../src/presigned/validation.js';
import { presignedSourceDigest } from './presigned-build-identity.mjs';
import { advanceLiveLifecycle, fundLiveLifecycle, initializeLiveLifecycle, lifecycleFilesSummary,
  readLifecycleFile, verifyCompletedLiveLifecycle, type LiveLifecycleCore } from './lib/presigned-live-lifecycle.js';

process.umask(0o077);
const [operation, filename, capitalArgument, coinArgument] = process.argv.slice(2);
assert(process.argv.length === (operation === 'init' ? 6 : 4) && ['init', 'status', 'fund', 'advance', 'verify'].includes(operation ?? '') &&
  /^\/tmp\/btc-presigned-signet-[A-Za-z0-9]+\/control\.json$/u.test(filename ?? ''),
'usage: tsx scripts/presigned-signet-lifecycle.mts init|status|fund|advance|verify /tmp/btc-presigned-signet-.../control.json [init only: --capital-limit-sats=N --initial-outpoint=TXID:VOUT]');
const capitalMatch = /^--capital-limit-sats=([1-9][0-9]{0,6})$/u.exec(capitalArgument ?? '');
const coinMatch = /^--initial-outpoint=([0-9a-f]{64}):([0-9]{1,8})$/u.exec(coinArgument ?? '');
assert(operation !== 'init' || (capitalMatch && coinMatch), 'init requires an explicit capital limit and exact confirmed initial outpoint');
const directory = filename!.slice(0, -'/control.json'.length);
const metadata = lstatSync(directory);
assert(metadata.isDirectory() && metadata.uid === process.getuid?.() && (metadata.mode & 0o077) === 0);
const control = readLifecycleFile<any>(directory, 'control.json');
assert(control.version === 2 && control.network === 'signet' && control.existingWalletsUsed === false &&
  control.publicListeners === false && control.directory === directory && control.cookiePath === `${directory}/core/signet/.cookie` &&
  control.walletName === 'presigned-v2-signet-acceptance', 'not the fresh isolated V2 test host');
const endpoint = new URL(control.rpcUrl);
assert(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port && endpoint.pathname === '/' &&
  !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'isolated Core endpoint changed');
const call = async (method: string, params: unknown[] = [], wallet = false): Promise<any> => {
  const fd = openSync(control.cookiePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let cookie: string;
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size < 512, 'unsafe isolated RPC cookie');
    cookie = readFileSync(fd, 'utf8').trim();
  } finally { closeSync(fd); }
  const response = await fetch(`${endpoint.origin}${wallet ? `/wallet/${control.walletName}` : '/'}`, {
    method: 'POST', headers: { authorization: `Basic ${Buffer.from(cookie).toString('base64')}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'presigned-isolated-lifecycle', method, params }),
    signal: AbortSignal.timeout(20_000), redirect: 'error' });
  cookie = '';
  const body = await response.json() as { result: any; error?: { code: number } };
  if (!response.ok || body.error) throw Object.assign(new Error('isolated default-Signet RPC request failed; no private response logged'), { code: body.error?.code });
  return body.result;
};
const rpc: PresignedCoreRpc = async <T,>(method: string, params: unknown[] = []) => await call(method, params) as T;
assert.equal((await call('getnetworkinfo')).version, 310100);
const info = await call('getblockchaininfo');
assert(info.chain === 'signet' && info.initialblockdownload === false && info.pruned === false && info.blocks === info.headers, 'isolated node is not synchronized default-Signet');
assert.equal(await call('getblockhash', [0]), genesisHash('signet'));
assert.equal(await call('getblockhash', [1]), '00000086d6b2636cb2a392d45edc4ec544a10024d30141c9adf4bfd9de533b53');
assert.equal((await call('getindexinfo')).txindex?.synced, true);
assert.deepEqual(await call('listwallets'), [control.walletName], 'unexpected wallet on isolated acceptance host');
assert.equal((await call('getaddressinfo', [control.address], true)).ismine, true);
const backend = createPresignedCoreBackend({ network: 'signet', genesisHash: genesisHash('signet'), rpc });
await backend.getTip();
const core: LiveLifecycleCore = { rpc: call, walletRpc: (method, params) => call(method, params, true),
  observeCoin: outpoint => backend.observeConfirmedCoin(outpoint), chain: 'default-Signet',
  actualGenesisHash: genesisHash('signet'), sourceDigest: presignedSourceDigest() };
const runDirectory = `${directory}/lifecycle-v2`;
if (operation === 'verify') {
  console.log(JSON.stringify(await verifyCompletedLiveLifecycle(core, runDirectory)));
} else if (operation === 'status') {
  const balances = await core.walletRpc('getbalances');
  console.log(JSON.stringify({ initialized: existsSync(`${runDirectory}/run.json`), chain: core.chain,
    confirmedTestSats: Math.round(balances.mine.trusted * 1e8), pendingTestSats: Math.round(balances.mine.untrusted_pending * 1e8),
    ...(existsSync(`${runDirectory}/run.json`) ? lifecycleFilesSummary(runDirectory) : {}), publicListeners: false }));
} else {
  if (!existsSync(runDirectory)) mkdirSync(runDirectory, { mode: 0o700 });
  const lockFile = `${runDirectory}/active.lock`;
  if (existsSync(lockFile)) {
    const previous = readLifecycleFile<{ pid: number }>(runDirectory, 'active.lock');
    assert(Number.isSafeInteger(previous.pid) && previous.pid > 1);
    let gone = false;
    try { process.kill(previous.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') gone = true; else throw error; }
    assert(gone, 'another lifecycle process is live; do not start a second writer');
    unlinkSync(lockFile); // Exact stale process lock only; all keys and evidence retained.
  }
  const lock = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  writeFileSync(lock, JSON.stringify({ pid: process.pid })); closeSync(lock);
  try {
    const result = operation === 'init' ? await initializeLiveLifecycle(core, runDirectory, {
      capitalLimitSats: Number(capitalMatch![1]), initialOutpoint: { txid: coinMatch![1]!, vout: Number(coinMatch![2]) } })
      : operation === 'fund' ? await fundLiveLifecycle(core, runDirectory) : await advanceLiveLifecycle(core, runDirectory);
    console.log(JSON.stringify({ ...result, evidence: runDirectory }));
  } finally { unlinkSync(lockFile); }
}
