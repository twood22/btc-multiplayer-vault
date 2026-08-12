import assert from 'node:assert/strict';
import { getRawTransaction } from '../../src/bitcoin-rpc.js';

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
    const request = JSON.parse(String(init?.body)) as { method: string };
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
          ? { height: 900_000 }
          : null;
    assert.notEqual(result, null, `unexpected RPC method ${request.method}`);
    return Response.json({ result, error: null });
  }) as typeof fetch;

  const transaction = await getRawTransaction('11'.repeat(32), true);
  assert.equal(transaction.blockheight, 900_000);
  assert.deepEqual(methods, ['getblockchaininfo', 'getrawtransaction', 'getblockheader']);
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
    name: 'Bitcoin Core confirmed transactions use their actual block-header height',
    ok: true,
  }],
}, null, 2));

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
