import assert from 'node:assert/strict';
import { observeVaultCoin } from '../lib/client/chain-observation.js';
import { MAINNET_GENESIS_HASH } from '../../src/network.js';
import { vaultCoinSnapshotDigest, type VaultCoinSnapshot } from '../../src/vault-runtime.js';

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
} finally {
  globalThis.fetch = originalFetch;
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
