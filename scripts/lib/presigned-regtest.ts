/** Isolated, network-disabled Bitcoin Core test host. Never reads app credentials. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import * as bitcoin from 'bitcoinjs-lib';

// An explicit binary path makes these drills reproducible on another private
// runner. Every invocation still checks the actual 31.1 runtime and records its
// SHA256; it never accepts a configured RPC endpoint or an existing datadir.
const CORE = process.env.BITCOIN_CORE_BIN ?? '/home/codex/.cache/btc-multiplayer-vault/bitcoin-core-31.1/bin/bitcoind';

export interface PresignedRegtestCoin {
  txid: string; vout: number; valueSats: number; scriptPubKeyHex: string;
  confirmationBlockHash: string; confirmations: number;
}

export interface PresignedRegtest {
  directory: string;
  coreVersion: number;
  rpc: (method: string, params?: unknown[]) => Promise<any>;
  walletRpc: (method: string, params?: unknown[]) => Promise<any>;
  mine: (blocks?: number) => Promise<string[]>;
  fundScripts: (outputs: Array<{ scriptPubKeyHex: string; valueSats: number }>) => Promise<PresignedRegtestCoin[]>;
  record: (name: string, value: unknown) => void;
}

export async function withPresignedRegtest<T>(run: (core: PresignedRegtest) => Promise<T>,
  options: { maxMempoolMb?: number; maximumMinutes?: number } = {}): Promise<T> {
  assert(existsSync(CORE), 'install the existing checksum-pinned Core 31.1 test runtime first');
  assert(options.maxMempoolMb === undefined || (Number.isSafeInteger(options.maxMempoolMb) &&
    options.maxMempoolMb >= 5 && options.maxMempoolMb <= 300), 'isolated mempool size must be 5-300 MB');
  const maximumMinutes = options.maximumMinutes ?? 15;
  // The complete sequential-capital drill performs substantially more signed
  // history audits. This bounds execution time, never confirmation depth or
  // any cryptographic, capital-conservation or acceptance requirement.
  assert(Number.isSafeInteger(maximumMinutes) && maximumMinutes >= 1 && maximumMinutes <= 90, 'isolated test deadline must be 1-90 minutes');
  const directory = mkdtempSync('/tmp/btc-presigned-core-');
  const datadir = `${directory}/core`;
  mkdirSync(datadir, { mode: 0o700 });
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const process = spawn(CORE, ['-regtest', `-datadir=${datadir}`, '-server=1', '-listen=0',
    '-networkactive=0', '-dnsseed=0', '-discover=0', '-txindex=1', '-fallbackfee=0.00002',
    '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${port}`, '-printtoconsole=0',
    ...(options.maxMempoolMb === undefined ? [] : [`-maxmempool=${options.maxMempoolMb}`])], { stdio: 'ignore' });
  let exited = false;
  let failure: Error | undefined;
  process.once('exit', () => { exited = true; });
  process.once('error', error => { failure = error; exited = true; });
  const deadline = setTimeout(() => process.kill('SIGTERM'), maximumMinutes * 60_000);
  const call = async (wallet: boolean, method: string, params: unknown[] = []): Promise<any> => {
    const cookie = readFileSync(`${datadir}/regtest/.cookie`, 'utf8').trim();
    const response = await fetch(`http://127.0.0.1:${port}${wallet ? '/wallet/presigned-test-faucet' : '/'}`, {
      method: 'POST', headers: { Authorization: `Basic ${Buffer.from(cookie).toString('base64')}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(45_000),
    });
    const value = await response.json() as { error?: { code: number; message: string }; result: unknown };
    if (value.error) throw Object.assign(new Error(`${method}: ${value.error.message}`), { rpcCode: value.error.code });
    return value.result;
  };
  const rpc = (method: string, params?: unknown[]) => call(false, method, params);
  const walletRpc = (method: string, params?: unknown[]) => call(true, method, params);
  const record = (name: string, value: unknown) => {
    assert(/^[a-z0-9-]+$/u.test(name), 'invalid evidence filename');
    writeFileSync(`${directory}/${name}.json`, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (exited) throw failure ?? new Error('isolated Core exited before readiness');
      if (existsSync(`${datadir}/regtest/.cookie`)) {
        try { ready = (await rpc('getblockchaininfo')).chain === 'regtest'; } catch { /* startup */ }
      }
      if (ready) break;
      await pause(100);
    }
    assert(ready, 'isolated Core startup timed out');
    const network = await rpc('getnetworkinfo');
    assert.equal(network.networkactive, false);
    assert.equal(network.connections, 0);
    assert.equal(network.version, 310100, 'test runtime differs from reviewed Core 31.1');
    record('runtime', { coreVersion: network.version, binarySha256: createHash('sha256').update(readFileSync(CORE)).digest('hex'),
      chain: 'regtest', networkactive: false, connections: 0, startedAt: new Date().toISOString(),
      maxMempoolMb: options.maxMempoolMb ?? 300, publicNetworkBroadcasts: 0 });
    await rpc('createwallet', ['presigned-test-faucet']);
    const miningAddress = await walletRpc('getnewaddress');
    const mine = async (blocks = 1): Promise<string[]> => {
      assert(Number.isSafeInteger(blocks) && blocks >= 1 && blocks <= 10_000, 'invalid isolated mining count');
      const hashes: string[] = [];
      // Bound each RPC even on a busy host. Wallet notification/fsync work for
      // one 101-block call can exceed the transport timeout without a Core fault.
      for (let remaining = blocks; remaining > 0; remaining -= 10) {
        hashes.push(...await rpc('generatetoaddress', [Math.min(10, remaining), miningAddress]) as string[]);
      }
      return hashes;
    };
    await mine(101);
    const fundScripts = async (outputs: Array<{ scriptPubKeyHex: string; valueSats: number }>): Promise<PresignedRegtestCoin[]> => {
      const amounts = Object.fromEntries(outputs.map(output => [bitcoin.address.fromOutputScript(Buffer.from(output.scriptPubKeyHex, 'hex'), bitcoin.networks.regtest), output.valueSats / 1e8]));
      assert.equal(Object.keys(amounts).length, outputs.length, 'fundScripts requires distinct scripts');
      const txid = await walletRpc('sendmany', ['', amounts]);
      const [block] = await mine();
      const raw = await rpc('getrawtransaction', [txid, true]);
      return outputs.map(output => {
        const found = raw.vout.find((vout: any) => vout.scriptPubKey.hex === output.scriptPubKeyHex && Math.round(vout.value * 1e8) === output.valueSats);
        assert(found, 'test faucet output missing');
        return { txid, vout: found.n, valueSats: output.valueSats, scriptPubKeyHex: output.scriptPubKeyHex,
          confirmationBlockHash: block!, confirmations: 1 };
      });
    };
    console.log(JSON.stringify({ stage: 'isolated-Core-ready', chain: 'regtest', coreVersion: network.version, evidence: directory }));
    return await run({ directory, coreVersion: network.version, rpc, walletRpc, mine, fundScripts, record });
  } finally {
    clearTimeout(deadline);
    try { if (!exited) await rpc('stop'); } catch { process.kill('SIGTERM'); }
    for (let attempt = 0; attempt < 200 && !exited; attempt++) await pause(100);
    if (!exited) { process.kill('SIGTERM'); throw new Error(`isolated Core did not stop; retained owner-only data at ${directory}`); }
  }
}
