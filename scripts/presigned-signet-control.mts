/** Resume/status/stop ONLY an already-created isolated acceptance node and its fresh wallet. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const [operation, filename] = process.argv.slice(2);
assert(['start', 'status', 'stop'].includes(operation ?? '') && filename?.startsWith('/tmp/btc-presigned-signet-') && filename.endsWith('/control.json'),
  'usage: tsx scripts/presigned-signet-control.mts start|status|stop /tmp/btc-presigned-signet-.../control.json');
const metadata = statSync(filename);
assert(metadata.isFile() && metadata.uid === process.getuid?.() && (metadata.mode & 0o077) === 0, 'control must be an owner-only file');
const control = JSON.parse(readFileSync(filename, 'utf8'));
assert(control.version === 2 && control.network === 'signet' && control.existingWalletsUsed === false &&
  control.publicListeners === false && control.directory === filename.slice(0, -'/control.json'.length) &&
  control.cookiePath === `${control.directory}/core/signet/.cookie` && control.walletName === 'presigned-v2-signet-acceptance',
  'not an isolated V2 acceptance host');
const endpoint = new URL(control.rpcUrl);
assert(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port &&
  !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'isolated RPC endpoint changed');
const rpc = async (method: string, params: unknown[] = [], wallet = false): Promise<any> => {
  const cookie = readFileSync(control.cookiePath, 'utf8').trim();
  const response = await fetch(`${control.rpcUrl}${wallet ? `/wallet/${control.walletName}` : '/'}`, {
    method: 'POST', headers: { authorization: `Basic ${Buffer.from(cookie).toString('base64')}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'signet-acceptance-control', method, params }),
    signal: AbortSignal.timeout(20_000), redirect: 'error',
  });
  const body = await response.json() as { result: any; error?: { code: number } };
  assert(response.ok && !body.error, `isolated Signet RPC failed (code ${body.error?.code ?? 'unavailable'})`);
  return body.result;
};
const identity = async () => {
  assert.equal((await rpc('getnetworkinfo')).version, 310100);
  assert.equal((await rpc('getblockchaininfo')).chain, 'signet');
  assert.equal(await rpc('getblockhash', [0]), '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6');
  assert.equal(await rpc('getblockhash', [1]), '00000086d6b2636cb2a392d45edc4ec544a10024d30141c9adf4bfd9de533b53');
  const wallets = await rpc('listwallets');
  assert(wallets.includes(control.walletName) && wallets.every((name: string) => name.startsWith('presigned-v2-')),
    'isolated host loaded an unexpected wallet');
  assert((await rpc('getaddressinfo', [control.address], true)).ismine === true, 'isolated receiving address no longer belongs to its fresh wallet');
};
if (operation === 'start') {
  let running = false;
  if (existsSync(control.cookiePath)) { try { await identity(); running = true; } catch { /* exact private host may be stopped */ } }
  if (!running) {
    const binary = '/home/codex/.cache/btc-multiplayer-vault/bitcoin-core-31.1/bin/bitcoind';
    assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), control.binarySha256);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, ['-signet', `-datadir=${control.directory}/core`, `-walletdir=${control.directory}/wallets`,
        `-wallet=${control.walletName}`, '-nosettings', '-daemonwait', '-server=1', '-listen=0', '-discover=0', '-txindex=1',
        '-dbcache=256', '-maxconnections=12', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${endpoint.port}`, '-printtoconsole=0'], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('isolated Signet startup failed; inspect only its private debug log')));
    });
    await identity();
    const pid = Number(readFileSync(`${control.directory}/core/signet/bitcoind.pid`, 'utf8').trim());
    assert(Number.isSafeInteger(pid) && pid > 1, 'isolated Core PID is unavailable');
    writeFileSync(filename, JSON.stringify({ ...control, pid, resumedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  }
}
await identity();
if (operation === 'stop') {
  await rpc('stop');
  console.log(JSON.stringify({ status: 'shutdown-requested', control: filename, walletAndCoinsRetained: true }));
} else {
  const info = await rpc('getblockchaininfo');
  const indexes = await rpc('getindexinfo');
  const balances = await rpc('getbalances', [], true);
  console.log(JSON.stringify({ status: 'running', network: 'default-Signet', blocks: info.blocks, headers: info.headers,
    initialBlockDownload: info.initialblockdownload, txindexSynced: indexes.txindex?.synced === true,
    confirmedTestSats: Math.round(balances.mine.trusted * 1e8), pendingTestSats: Math.round(balances.mine.untrusted_pending * 1e8),
    control: filename, publicListeners: false, reusedFreshWallet: true }));
}
