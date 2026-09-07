/** Private default-Signet acceptance host. Copies public chain data, never wallets. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

const binary = '/home/codex/.cache/btc-multiplayer-vault/bitcoin-core-31.1/bin/bitcoind';
const source = process.argv[2];
assert(source?.startsWith('/') && existsSync(`${source}/blocks`) && existsSync(`${source}/chainstate`),
  'usage: tsx scripts/presigned-signet-host.mts /absolute/stopped/chain-cache/signet');
const directory = mkdtempSync('/tmp/btc-presigned-signet-');
const datadir = `${directory}/core`;
mkdirSync(`${datadir}/signet`, { recursive: true, mode: 0o700 });
mkdirSync(`${directory}/wallets`, { mode: 0o700 });
for (const part of ['blocks', 'chainstate', 'indexes']) {
  if (!existsSync(`${source}/${part}`)) continue;
  await new Promise<void>((resolve, reject) => {
    const copy = spawn('cp', ['--reflink=auto', '--sparse=always', '-a', '--', `${source}/${part}`, `${datadir}/signet/`], { stdio: 'ignore' });
    copy.once('error', reject);
    copy.once('exit', code => code === 0 ? resolve() : reject(new Error(`public ${part} cache copy failed`)));
  });
}
const listener = createServer();
await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const cookiePath = `${datadir}/signet/.cookie`;
const rpcUrl = `http://127.0.0.1:${port}`;
const child = spawn(binary, ['-signet', `-datadir=${datadir}`, `-walletdir=${directory}/wallets`,
  '-nosettings', '-server=1', '-listen=0', '-discover=0', '-txindex=1', '-dbcache=256',
  '-maxconnections=12', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${port}`,
  '-printtoconsole=0'], { stdio: 'ignore' });
let exited = false;
let stopping = false;
child.once('exit', () => { exited = true; });
child.once('error', () => { exited = true; });
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
const rpc = async (method: string, params: unknown[] = [], wallet = false): Promise<any> => {
  const cookie = readFileSync(cookiePath, 'utf8').trim();
  const response = await fetch(`${rpcUrl}${wallet ? '/wallet/presigned-v2-signet-acceptance' : '/'}`, {
    method: 'POST', headers: { authorization: `Basic ${Buffer.from(cookie).toString('base64')}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'signet-acceptance', method, params }),
    signal: AbortSignal.timeout(30_000), redirect: 'error',
  });
  const body = await response.json() as { result: any; error?: { code: number } };
  assert(!body.error, `isolated Signet ${method} rejected request (code ${body.error?.code ?? 'none'})`);
  return body.result;
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 600 && !stopping; attempt++) {
    assert(!exited, 'isolated Signet Core exited before readiness');
    if (existsSync(cookiePath)) {
      try { ready = (await rpc('getblockchaininfo')).chain === 'signet'; } catch { /* startup */ }
    }
    if (ready) break;
    await pause(500);
  }
  assert(ready, 'isolated Signet Core startup timed out');
  const network = await rpc('getnetworkinfo');
  assert.equal(network.version, 310100);
  assert.equal(await rpc('getblockhash', [0]), '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6');
  assert.equal(await rpc('getblockhash', [1]), '00000086d6b2636cb2a392d45edc4ec544a10024d30141c9adf4bfd9de533b53');
  assert.deepEqual(await rpc('listwallets'), [], 'isolated host unexpectedly loaded a prior wallet');
  await rpc('createwallet', ['presigned-v2-signet-acceptance', false, false, '', false, true, false]);
  const address = await rpc('getnewaddress', ['isolated-signet-test-coins', 'bech32m'], true);
  const control = { version: 2, network: 'signet', genesisHash: await rpc('getblockhash', [0]),
    rpcUrl, cookiePath, walletName: 'presigned-v2-signet-acceptance', directory, address,
    coreVersion: network.version, pid: child.pid,
    binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
    startedAt: new Date().toISOString(), existingWalletsUsed: false, publicListeners: false };
  writeFileSync(`${directory}/control.json`, JSON.stringify(control, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ stage: 'isolated-default-Signet-host-ready', control: `${directory}/control.json`, address }));
  const deadline = Date.now() + 12 * 60 * 60_000;
  while (!stopping && !exited && Date.now() < deadline) {
    const info = await rpc('getblockchaininfo');
    const indexes = await rpc('getindexinfo');
    const balances = await rpc('getbalances', [], true);
    console.log(JSON.stringify({ stage: 'Signet-host-status', blocks: info.blocks, headers: info.headers,
      initialBlockDownload: info.initialblockdownload, txindexSynced: indexes.txindex?.synced === true,
      confirmedTestSats: Math.round(balances.mine.trusted * 1e8), pendingTestSats: Math.round(balances.mine.untrusted_pending * 1e8) }));
    await pause(30_000);
  }
} finally {
  try { if (!exited) await rpc('stop'); } catch { child.kill('SIGTERM'); }
  for (let attempt = 0; attempt < 600 && !exited; attempt++) await pause(100);
  assert(exited, `isolated Signet Core did not stop; retained private data at ${directory}`);
  console.log(JSON.stringify({ stage: 'isolated-Signet-host-stopped', retainedData: directory }));
}
