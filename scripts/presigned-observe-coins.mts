import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPresignedCoreBackend, type PresignedCoreRpc } from '../src/presigned/core.js';
import { PRESIGNED_PROTOCOL } from '../src/presigned/types.js';
import { assert, genesisHash, sameCanonical } from '../src/presigned/validation.js';
import type { BitcoinNetworkName } from '../src/types.js';

// Read-only, provider-independent helper. Never reads application .env files,
// touches a wallet, signs, broadcasts or accepts an RPC secret on the command line.
async function main() {
  const args = process.argv.slice(2); const values = new Map<string, string>(); const coins: Array<{ txid: string; vout: number }> = [];
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!; const value = args[index + 1];
    assert(value && ['--network','--rpc-url','--cookie-file','--coin','--output'].includes(name),
      'usage: presigned-observe-coins --network mainnet|signet --rpc-url URL --cookie-file PATH --coin TXID:VOUT [--coin TXID:VOUT] --output NEW_JSON_FILE');
    if (name === '--coin') {
      const match = /^([0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/u.exec(value);
      assert(match && Number(match[2]) <= 0xffffffff, 'invalid observed outpoint');
      coins.push({ txid: match[1]!, vout: Number(match[2]) });
    } else { assert(!values.has(name), 'repeated observation option'); values.set(name, value); }
  }
  const network = values.get('--network');
  assert(network === 'mainnet' || network === 'signet', 'choose the exact network explicitly');
  assert(values.size === 4 && coins.length >= 1 && coins.length <= 16 && new Set(coins.map(coin => `${coin.txid}:${coin.vout}`)).size === coins.length,
    'specify one to sixteen distinct coins and all required connection/output options');
  const url = new URL(values.get('--rpc-url')!);
  assert(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/' &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))),
    'private RPC requires credential-free HTTPS or a loopback HTTP URL with no wallet path');
  const cookiePath = resolve(values.get('--cookie-file')!);
  const descriptor = openSync(cookiePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let cookie = '';
  try {
    const stat = fstatSync(descriptor);
    assert(stat.isFile() && stat.uid === process.getuid!() && (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= 4096,
      'RPC cookie must be an owner-only regular file belonging to this user');
    cookie = readFileSync(descriptor, 'utf8').trim();
    assert(/^[^:\r\n]+:[^\r\n]+$/u.test(cookie), 'RPC cookie has an invalid format');
  } finally { closeSync(descriptor); }
  const rpc: PresignedCoreRpc = async <T,>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(cookie).toString('base64')}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'presigned-public-coin-observation', method, params }) });
    const text = await response.text();
    assert(text.length <= 8_000_000, 'RPC observation response is too large');
    const parsed = JSON.parse(text) as { result?: T; error?: { code?: unknown } };
    if (parsed.error) throw Object.assign(new Error('private Core rejected observation request'), {
      code: Number.isSafeInteger(parsed.error.code) ? parsed.error.code : undefined });
    assert(response.ok && 'result' in parsed, 'private Core observation is unavailable');
    return parsed.result as T;
  };
  try {
    const backend = createPresignedCoreBackend({ network: network as BitcoinNetworkName, genesisHash: genesisHash(network), rpc });
    const before = await backend.getTip();
    const observed = [];
    const availability = [];
    for (const coin of coins) {
      const current = await backend.observeConfirmedCoin(coin);
      observed.push(current);
      const state = await backend.getOutputAvailability(current);
      assert(state.kind !== 'unknown' && state.kind !== 'chain-spent', 'a source coin is unavailable or already spent in the active chain');
      let spendingTxid: string | null = null;
      if (state.kind === 'mempool-spent') {
        const spending = await rpc<Array<{ txid: string; vout: number; spendingtxid?: string }>>('gettxspendingprevout', [[coin]]);
        assert(spending.length === 1 && spending[0]!.txid === coin.txid && spending[0]!.vout === coin.vout &&
          /^[0-9a-f]{64}$/u.test(spending[0]!.spendingtxid ?? ''), 'mempool spending observation changed');
        spendingTxid = spending[0]!.spendingtxid!;
      }
      availability.push({ ...coin, kind: state.kind, spendingTxid });
    }
    sameCanonical(before, await backend.getTip(), 'complete public observation tip');
    const report = { version: 2, protocol: PRESIGNED_PROTOCOL, format: 'presigned-private-core-observations-v1',
      network, genesisHash: genesisHash(network), tip: before, observedAt: new Date().toISOString(), coins: observed, availability };
    writeFileSync(resolve(values.get('--output')!), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ passed: true, network, coins: observed.length, publicObservationFileWritten: true,
      signed: false, broadcast: false, observedHeight: before.height }));
  } finally { cookie = ''; }
}
main().catch(() => { console.error('Public coin observation failed; no signing or broadcast was attempted. Check explicit arguments, owner-only cookie, private Core readiness, current UTXOs, and a new output filename.'); process.exitCode = 1; });
