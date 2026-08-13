import assert from 'node:assert/strict';
import { BitcoinTransactionNotFoundError } from '../../src/bitcoin-backend-errors.js';
import { getBlockStatus, getBlockchainInfo, getRawTransaction } from '../../src/bitcoin-rpc.js';

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
      ? { chain: 'main', blocks: 900_002, headers: 900_002, pruned: false, initialblockdownload: false }
      : request.method === 'getindexinfo'
        ? { txindex: { synced: true, best_block_height: 900_002 } }
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
  assert.equal(methods.filter((method) => method === 'getblockchaininfo').length, 4);
  assert.equal(methods.filter((method) => method === 'getindexinfo').length, 4);
  assert.equal(methods.filter((method) => method === 'getrawtransaction').length, 1);
  assert.equal(methods.filter((method) => method === 'getblockheader').length, 3);

  globalThis.fetch = (async (_resource, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    if (request.method === 'getblockchaininfo') {
      return Response.json({
        result: {
          chain: 'regtest', blocks: 103, headers: 103,
          pruned: false, initialblockdownload: false,
        },
        error: null,
      });
    }
    throw new Error(`unexpected RPC method ${request.method}`);
  }) as typeof fetch;
  await assert.rejects(
    () => getBlockStatus('22'.repeat(32)),
    /not mainnet/u,
  );

  process.env.BITCOIN_RPC_URL = 'https://bitcoin-rpc-pruned.test';
  globalThis.fetch = (async (_resource, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    if (request.method === 'getblockchaininfo') {
      return Response.json({
        result: {
          chain: 'main', blocks: 900_002, headers: 900_002,
          pruned: true, initialblockdownload: false,
        },
        error: null,
      });
    }
    throw new Error(`unexpected RPC method ${request.method}`);
  }) as typeof fetch;
  await assert.rejects(
    () => getBlockchainInfo(),
    /non-pruned/u,
  );

  process.env.BITCOIN_RPC_URL = 'https://bitcoin-rpc-no-index.test';
  globalThis.fetch = (async (_resource, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    if (request.method === 'getblockchaininfo') {
      return Response.json({
        result: {
          chain: 'main', blocks: 900_002, headers: 900_002,
          pruned: false, initialblockdownload: false,
        },
        error: null,
      });
    }
    if (request.method === 'getindexinfo') {
      return Response.json({ result: {}, error: null });
    }
    throw new Error(`unexpected RPC method ${request.method}`);
  }) as typeof fetch;
  await assert.rejects(
    () => getBlockStatus('22'.repeat(32)),
    /transaction index/u,
  );

  process.env.BITCOIN_RPC_URL = 'https://bitcoin-rpc-not-found.test';
  globalThis.fetch = (async (_resource, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    if (request.method === 'getblockchaininfo') {
      return Response.json({
        result: {
          chain: 'main', blocks: 900_002, headers: 900_002,
          pruned: false, initialblockdownload: false,
        },
        error: null,
      });
    }
    if (request.method === 'getindexinfo') {
      return Response.json({ result: { txindex: { synced: true } }, error: null });
    }
    return Response.json({ result: null, error: { code: -5, message: 'No such mempool or blockchain transaction' } });
  }) as typeof fetch;
  await assert.rejects(
    () => getRawTransaction('55'.repeat(32), true),
    (error) => error instanceof BitcoinTransactionNotFoundError,
  );

  process.env.BITCOIN_RPC_URL = 'https://bitcoin-rpc-offline.test';
  globalThis.fetch = (async () => {
    throw new Error('backend offline');
  }) as typeof fetch;
  await assert.rejects(
    () => getRawTransaction('55'.repeat(32), true),
    (error) => error instanceof Error && !(error instanceof BitcoinTransactionNotFoundError) &&
      /could not reach/u.test(error.message),
  );

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
  globalThis.fetch = (async (resource) => {
    const url = String(resource);
    if (url.endsWith('/block-height/0')) return new Response('regtest-genesis');
    throw new Error(`unexpected Esplora URL ${url}`);
  }) as typeof fetch;
  await assert.rejects(
    () => getBlockStatus('44'.repeat(32)),
    /not Bitcoin mainnet/u,
  );

  process.env.BITCOIN_ESPLORA_URL = 'https://esplora-not-found.test';
  globalThis.fetch = (async (resource) => {
    const url = String(resource);
    if (url.endsWith('/block-height/0')) return new Response('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
    if (url.includes(`/tx/${'66'.repeat(32)}`)) return new Response('not found', { status: 404 });
    throw new Error(`unexpected Esplora URL ${url}`);
  }) as typeof fetch;
  await assert.rejects(
    () => getRawTransaction('66'.repeat(32), true),
    (error) => error instanceof BitcoinTransactionNotFoundError,
  );

  process.env.BITCOIN_ESPLORA_URL = 'https://esplora-failed.test';
  globalThis.fetch = (async (resource) => {
    const url = String(resource);
    if (url.endsWith('/block-height/0')) return new Response('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
    if (url.includes(`/tx/${'77'.repeat(32)}`)) return new Response('failed', { status: 503 });
    throw new Error(`unexpected Esplora URL ${url}`);
  }) as typeof fetch;
  await assert.rejects(
    () => getRawTransaction('77'.repeat(32), true),
    (error) => error instanceof Error && !(error instanceof BitcoinTransactionNotFoundError) &&
      /failed \(503\)/u.test(error.message),
  );
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
    name: 'Core and Esplora distinguish authoritative absence from operational failure while exposing exact block status',
    ok: true,
  }],
}, null, 2));

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
