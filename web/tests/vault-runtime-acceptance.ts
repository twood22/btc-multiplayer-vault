import assert from 'node:assert/strict';
import { observeVaultCoin } from '../lib/client/chain-observation.js';
import { MAINNET_GENESIS_HASH } from '../../src/network.js';
import { vaultCoinSnapshotDigest, type VaultCoinSnapshot } from '../../src/vault-runtime.js';
import {
  consumeCooperativeSecnonce,
  hasCooperativeSecnonce,
  storeCooperativeSecnonce,
} from '../lib/client/musig2-nonce-vault.js';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const coin: VaultCoinSnapshot = {
  vaultId: '11111111-2222-4333-8444-555555555555',
  rosterDigest: '11'.repeat(32),
  kind: 'vault',
  roundId: 'alicebobcarol',
  ownerParticipantId: null,
  txid: '22'.repeat(32),
  vout: 1,
  valueSats: 30_000,
  scriptPubKeyHex: `5120${'33'.repeat(32)}`,
};
const checks: Array<{ name: string; ok: boolean }> = [];
const originalFetch = globalThis.fetch;
const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
Object.defineProperty(globalThis, 'sessionStorage', {
  value: new MemoryStorage(),
  configurable: true,
});

try {
  await check('browser independently verifies mainnet, confirmation, outpoint, value, script, and unspent state', async () => {
    globalThis.fetch = fakeEsplora();
    const observed = await observeVaultCoin('https://chain.example', coin);
    assert.equal(observed.snapshotDigest, vaultCoinSnapshotDigest(coin));
    assert.equal(observed.confirmations, 2);
    assert.equal(observed.observedUnspent, true);
  });

  await check('a chain source reporting the exact output spent is rejected', async () => {
    globalThis.fetch = fakeEsplora({ spent: true });
    await assert.rejects(() => observeVaultCoin('https://chain.example', coin), /reports the vault output spent/);
  });

  await check('a chain source returning a changed amount is rejected', async () => {
    globalThis.fetch = fakeEsplora({ valueSats: coin.valueSats - 1 });
    await assert.rejects(() => observeVaultCoin('https://chain.example', coin), /differs from the committed value/);
  });

  await check('a non-mainnet chain identity is rejected before observation succeeds', async () => {
    globalThis.fetch = fakeEsplora({ genesisHash: '00'.repeat(32) });
    await assert.rejects(() => observeVaultCoin('https://chain.example', coin), /not Bitcoin mainnet/);
  });

  await check('an unconfirmed vault output is rejected', async () => {
    globalThis.fetch = fakeEsplora({ confirmed: false });
    await assert.rejects(() => observeVaultCoin('https://chain.example', coin), /not confirmed on mainnet/);
  });

  await check('browser secret nonces are encrypted, proposal-bound, and burned before use', async () => {
    const binding = {
      proposalId: '11111111-2222-4333-8444-555555555555',
      proposalDigest: '55'.repeat(32),
      participantId: 'alice',
      round: 'alicebobcarol',
      message: '66'.repeat(32),
      pubnonce: `02${'77'.repeat(32)}03${'88'.repeat(32)}`,
    };
    const secnonce = '99'.repeat(97);
    const secret = 'participant-secret-material-long-enough-for-the-test';
    await storeCooperativeSecnonce(binding, secnonce, secret);
    assert.equal(hasCooperativeSecnonce(binding.proposalId, binding.participantId), true);
    await assert.rejects(() => storeCooperativeSecnonce(binding, secnonce, secret), /already exists/);
    const consumed = await consumeCooperativeSecnonce(binding, secret);
    assert.equal(Buffer.from(consumed).toString('hex'), secnonce);
    consumed.fill(0);
    assert.equal(hasCooperativeSecnonce(binding.proposalId, binding.participantId), false);
    await assert.rejects(() => consumeCooperativeSecnonce(binding, secret), /absent/);
  });
} finally {
  globalThis.fetch = originalFetch;
  if (originalSessionStorage) {
    Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage);
  } else {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  }
}

console.log(JSON.stringify({ passed: checks.every((item) => item.ok), checks }, null, 2));

async function check(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks.push({ name, ok: true });
}

function fakeEsplora(overrides: {
  genesisHash?: string;
  spent?: boolean;
  valueSats?: number;
  confirmed?: boolean;
} = {}): typeof fetch {
  return (async (resource, options) => {
    assert.equal(options?.cache, 'no-store');
    assert.equal(options?.credentials, 'omit');
    const url = String(resource);
    if (url.endsWith('/block-height/0')) {
      return new Response(overrides.genesisHash ?? MAINNET_GENESIS_HASH);
    }
    if (url.endsWith(`/tx/${coin.txid}`)) {
      return Response.json({
        txid: coin.txid,
        vout: [
          { scriptpubkey: `5120${'44'.repeat(32)}`, value: 1 },
          {
            scriptpubkey: coin.scriptPubKeyHex,
            value: overrides.valueSats ?? coin.valueSats,
          },
        ],
        status: {
          confirmed: overrides.confirmed ?? true,
          block_height: 100,
        },
      });
    }
    if (url.endsWith(`/tx/${coin.txid}/outspend/${coin.vout}`)) {
      return Response.json({ spent: overrides.spent ?? false });
    }
    if (url.endsWith('/blocks/tip/height')) return new Response('101');
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}
