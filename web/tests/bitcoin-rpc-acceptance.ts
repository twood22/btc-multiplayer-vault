import assert from 'node:assert/strict';
import { getBlockStatus, getRawTransaction } from '../../src/bitcoin-rpc.js';

const originalFetch = globalThis.fetch;
const previous = {
  backend: process.env.BITCOIN_BACKEND,
  esplora: process.env.BITCOIN_ESPLORA_URL,
  url: process.env.BITCOIN_RPC_URL,
  user: process.env.BITCOIN_RPC_USER,
  username: process.env.BITCOIN_RPC_USERNAME,
  password: process.env.BITCOIN_RPC_PASSWORD,
};
const methods: string[] = [];

try {
  delete process.env.BITCOIN_BACKEND;
  delete process.env.BITCOIN_ESPLORA_URL;
  delete process.env.BITCOIN_RPC_USER;
  delete process.env.BITCOIN_RPC_USERNAME;
  delete process.env.BITCOIN_RPC_PASSWORD;
  process.env.BITCOIN_RPC_URL = 'https://bitcoin-rpc-height.test';

  globalThis.fetch = (async (_resource, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    methods.push(request.method);
    const result = request.method === 'getblockchaininfo'
      ? { chain: 'main', blocks: 900_002, headers: 900_002 }
      : request.method === 'getrawtransaction'
        ? {
            txid: '11'.repeat(32),
            vin: [],
            vout: [],
            confirmations: 3,
            blockhash: '22'.repeat(32),
          }
        : request.method === 'getblockheader'
          ? {
              hash: String(request.params[0]),
              height: request.params[0] === '33'.repeat(32) ? 899_999 : 900_000,
              confirmations: request.params[0] === '33'.repeat(32) ? -1 : 3,
            }
          : null;
    assert.notEqual(result, null, `unexpected RPC method ${request.method}`);
    return Response.json({ result, error: null });
  }) as typeof fetch;

  const transaction = await getRawTransaction('11'.repeat(32), true);
  assert.equal(transaction.blockheight, 900_000);
  const active = await getBlockStatus('22'.repeat(32));
  const orphaned = await getBlockStatus('33'.repeat(32));
  assert.deepEqual(active, {
    hash: '22'.repeat(32),
    height: 900_000,
    confirmations: 3,
    inBestChain: true,
  });
  assert.equal(orphaned.inBestChain, false);
  assert.equal(orphaned.confirmations, -1);
  assert.deepEqual(methods, [
    'getblockchaininfo',
    'getrawtransaction',
    'getblockheader',
    'getblockheader',
    'getblockheader',
  ]);

  process.env.BITCOIN_BACKEND = 'esplora';
  process.env.BITCOIN_ESPLORA_URL = 'https://esplora-block-status.test';
  globalThis.fetch = (async (resource) => {
    const url = String(resource);
    if (url.endsWith('/block-height/0')) return new Response('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
    if (url.endsWith(`/block/${'44'.repeat(32)}/status`)) {
      return Response.json({ in_best_chain: true });
    }
    if (url.endsWith(`/block/${'44'.repeat(32)}`)) {
      return Response.json({ id: '44'.repeat(32), height: 900_001 });
    }
    if (url.endsWith('/blocks/tip/height')) return new Response('900002');
    throw new Error(`unexpected Esplora URL ${url}`);
  }) as typeof fetch;
  assert.deepEqual(await getBlockStatus('44'.repeat(32)), {
    hash: '44'.repeat(32),
    height: 900_001,
    confirmations: 2,
    inBestChain: true,
  });
} finally {
  globalThis.fetch = originalFetch;
  restore('BITCOIN_BACKEND', previous.backend);
  restore('BITCOIN_ESPLORA_URL', previous.esplora);
  restore('BITCOIN_RPC_URL', previous.url);
  restore('BITCOIN_RPC_USER', previous.user);
  restore('BITCOIN_RPC_USERNAME', previous.username);
  restore('BITCOIN_RPC_PASSWORD', previous.password);
}

console.log(JSON.stringify({
  passed: true,
  checks: [{
    name: 'Core and Esplora expose exact active-chain block anchors and orphan status',
    ok: true,
  }],
}, null, 2));

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
